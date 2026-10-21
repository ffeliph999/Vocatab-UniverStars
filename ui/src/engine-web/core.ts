// ブラウザ版のエンジンの本体。engine/server.py・engine/pipeline.py と同じ順で、
// 楽譜 → 音素の長さ → F0（analyze）、最後の F0 → mel → 波形（synthesize）を行う。モデルは onnxruntime-web で動かす。
// ふだんは Web Worker（worker.ts）の中で動き、照らし合わせの試験（ui/test/e2e）ではページの中で直接動かす。
import { alignDurs, finishDurations, prepareDurations } from "./durations";
import { f0Feeds, finishF0, frameNoteIndex, prepareF0 } from "./f0host";
import { fetchCached } from "./fetchcache";
import { wavToMel } from "./melspec";
import type { AnalyzeReq, AnalyzeResp, SynthReq, SynthResp } from "./protocol";
import { applyRetakes, normalNoise } from "./rng";
import { phrasesFromNotes } from "./score";
import { acousticFeeds, finishSynth, melPostprocess, nhvFeeds, nsfFeeds } from "./synthhost";
import type { Feeds, Phrase, VoicebankWeb, VocoderWeb, WebIndex } from "./types";

// ── 取り置き（engine/pipeline.py の _LRU と同じ） ──
class LRU<V> {
  private d = new Map<string, V>();
  constructor(private size: number) {}
  get(k: string): V | undefined {
    const v = this.d.get(k);
    if (v !== undefined) {
      this.d.delete(k);
      this.d.set(k, v);
    }
    return v;
  }
  put(k: string, v: V): void {
    this.d.delete(k);
    this.d.set(k, v);
    while (this.d.size > this.size) this.d.delete(this.d.keys().next().value as string);
  }
}

/** 値の並びの指紋（FNV-1a を 2 本。取り置きの鍵） */
function digest(...parts: unknown[]): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995;
  const feed = (x: number) => {
    h1 = Math.imul(h1 ^ x, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ x, 0x5bd1e995) >>> 0;
  };
  for (const p of parts) {
    if (ArrayBuffer.isView(p)) {
      const v = p as ArrayBufferView;
      const u = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      for (let i = 0; i < u.length; i++) feed(u[i]);
    } else {
      const s = JSON.stringify(p, (_, x) => (ArrayBuffer.isView(x) ? Array.from(x as unknown as ArrayLike<number>) : x));
      for (let i = 0; i < s.length; i++) feed(s.charCodeAt(i));
    }
    feed(0x7c);
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** Python の round（ちょうど半分は偶数へ） */
export const roundHalfEven = (x: number): number => {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
};

interface Analysis {
  phonemes: string[];
  phDurs: Int32Array;
  startSec: number;
  plainLog2: Float32Array;
  vibLog2: Float32Array;
  uv: Float32Array;
  baseLog2: Float32Array;
  noteIndex: number[];
  seed: number;
  shifts: number[];
}

/**
 * 照らし合わせの試験用: 乱数の代わりに使う雑音（Python 版と同じ雑音を入れて、同じ結果になるかを見る）。
 * 返した配列はそのまま使う（AI リテイクの差し替えもしない。Python の雑音には差し替え済みのものを渡す）
 */
export interface NoiseHook {
  f0?(T: number): Float32Array | null;
  exc?(T: number): Float32Array | null;
  voc?(T: number): Float32Array | null;
}

export class Engine {
  private base = "";
  private index!: WebIndex;
  private vbs = new Map<string, VoicebankWeb>();
  private sessions = new Map<string, Promise<any>>();
  private analyses = new LRU<{ vb: string; an: Analysis; ids: number[] }>(256);
  private acCache = new LRU<{ melIn: Float32Array; uvHard: Float32Array; cons: Uint8Array; f0: Float32Array }>(64);
  private vocCache = new LRU<Record<string, Float32Array>>(48);
  private loading = new Map<string, { loaded: number; total: number }>();
  noise: NoiseHook = {};

  /** ort: onnxruntime-web。onProgress: モデルの読み込みの進み具合（全部の合計） */
  constructor(private ort: any, private onProgress: (loaded: number, total: number) => void = () => undefined) {}

  /** base: svs_editor_browser の頭の URL（web_index.json・voicebanks・vocoders がある所） */
  async init(base: string, preload = true): Promise<WebIndex> {
    this.base = base;
    this.index = await (await fetch(this.url("web_index.json"))).json();
    for (const v of this.index.voicebanks) this.vbs.set(v.key, await (await fetch(this.url(v.web))).json());
    if (preload) {
      // 解析に使う小さいモデル（子音の長さ・F0）を先に、合成の大きいモデルを後ろで読み始める
      for (const v of this.index.voicebanks) {
        void this.session(v.key, "cons_dur").catch(() => undefined);
        void this.session(v.key, "f0").catch(() => undefined);
      }
      for (const v of this.index.voicebanks) {
        void this.session(v.key, "acoustic").catch(() => undefined);
        const voc = this.index.vocoders.find((x) => x.key === v.default_vocoder);
        if (voc) void this.vocoderSession(voc).catch(() => undefined);
      }
    }
    return this.index;
  }

  private url(rel: string): string {
    return new URL(rel, this.base).href;
  }

  private progress(key: string, loaded: number, total: number): void {
    this.loading.set(key, { loaded, total });
    let l = 0, t = 0;
    for (const v of this.loading.values()) {
      l += v.loaded;
      t += v.total;
    }
    this.onProgress(l, t);
  }

  private load(key: string, rel: string, bytes: number): Promise<any> {
    let s = this.sessions.get(key);
    if (!s) {
      s = (async () => {
        const data = await fetchCached(this.url(rel), bytes, (l, t) => this.progress(key, l, t));
        return this.ort.InferenceSession.create(data, { executionProviders: ["wasm"], graphOptimizationLevel: "all",
                                                        enableMemPattern: false });
      })();
      s.catch(() => this.sessions.delete(key)); // 失敗したら、次に頼まれたときに読み直す
      this.sessions.set(key, s);
    }
    return s;
  }

  private session(vbKey: string, model: "cons_dur" | "f0" | "acoustic"): Promise<any> {
    const vi = this.index.voicebanks.find((v) => v.key === vbKey)!;
    return this.load(`${vbKey}/${model}`, this.vbs.get(vbKey)!.models[model], vi.bytes[model]);
  }

  private vocoderSession(v: VocoderWeb): Promise<any> {
    return this.load(`voc/${v.key}`, v.onnx, v.bytes);
  }

  private async run(sess: any, feeds: Feeds, names?: string[]): Promise<Record<string, Float32Array>> {
    const inputs: Record<string, any> = {};
    for (const [k, f] of Object.entries(feeds)) inputs[k] = new this.ort.Tensor(f.type, f.data, f.dims);
    const out = names ? await sess.run(inputs, names) : await sess.run(inputs);
    const r: Record<string, Float32Array> = {};
    for (const [k, t] of Object.entries(out)) r[k] = (t as any).data as Float32Array;
    return r;
  }

  // ── 解析（engine/server.py の analyze と PrettyPitchLeapSinger.analyze） ──
  async analyze(r: AnalyzeReq): Promise<AnalyzeResp> {
    const vb = this.vbs.get(r.voicebank);
    if (!vb) throw new Error(`ボイスバンクがありません: ${r.voicebank}`);
    const fr = vb.frame_rate;
    const phrases = phrasesFromNotes(vb, r.notes, r.bpm);
    const retake = new Map(r.notes.map((n) => [n.id, n.retake_f0 ?? 0]));
    const shift = new Map(r.notes.map((n) => [n.id, Object.fromEntries(Object.entries(n.ph_shift ?? {})
      .filter(([, v]) => v).map(([k, v]) => [Number(k), Number(v)]))]));
    const out: AnalyzeResp["phrases"] = [];
    for (const { phrase, ids } of phrases) {
      // 句の中の音符の番号ごとの取り直しの種・手で動かした音素の頭（engine/server.py と同じ）
      const f0Rt: Record<number, number> = {};
      const sh: Record<number, Record<number, number>> = {};
      ids.forEach((nid, i) => {
        if (retake.get(nid)) f0Rt[i] = retake.get(nid)!;
        const s = shift.get(nid);
        if (s && Object.keys(s).length) sh[i] = s;
      });
      const key = digest(r.voicebank, r.singer, r.seed, phrase, f0Rt, sh);
      let hit = this.analyses.get(key);
      if (!hit) {
        hit = { vb: r.voicebank, an: await this.analyzePhrase(vb, phrase, r.singer, r.seed, f0Rt, sh), ids };
        this.analyses.put(key, hit);
      }
      const an = hit.an;
      out.push({
        key, note_ids: ids, start_frame: roundHalfEven(an.startSec * fr), n_frames: an.phDurs.reduce((a, b) => a + b, 0),
        phonemes: an.phonemes.map((p, j) => ({ ph: p, frames: an.phDurs[j], shift: an.shifts[j] ?? 0,
          note: an.noteIndex[j] >= 0 && ids.length ? ids[Math.min(an.noteIndex[j], ids.length - 1)] : null })),
        plain: an.plainLog2, vib: an.vibLog2, uv: an.uv, base: an.baseLog2,
      });
    }
    return { frame_rate: fr, phrases: out };
  }

  private async analyzePhrase(vb: VoicebankWeb, phrase: Phrase, spk: number, seed: number,
                              f0Rt: Record<number, number>, sh: Record<number, Record<number, number>>): Promise<Analysis> {
    // ① 子音の自然長 → ② 長さの後処理（と手で動かした頭）
    const prep = prepareDurations(vb, phrase, spk);
    const pred = prep.feeds ? (await this.run(await this.session(vb.key, "cons_dur"), prep.feeds, ["dur_sec"])).dur_sec : null;
    const dur = finishDurations(vb, prep, pred, spk, sh);
    // ③ F0（拡散の雑音は句の種から。取り直した音符の所だけ別の種の雑音） → ④ ピッチ補正
    const fp = prepareF0(vb, dur.seq, spk);
    let noise = this.noise.f0?.(fp.T) ?? null;
    if (!noise) {
      noise = normalNoise(Number(vb.f0.n_noise) * 2 * fp.T, seed);
      if (Object.keys(f0Rt).length && dur.noteIndex.length === fp.phDurs.length) {
        applyRetakes(noise, frameNoteIndex(dur.noteIndex, fp.phDurs, fp.T), f0Rt, 3);
      }
    }
    const o = await this.run(await this.session(vb.key, "f0"), f0Feeds(vb, fp, spk, noise), ["plain", "vibrato", "vuv"]);
    const f = finishF0(vb, fp, { plain: o.plain, vibrato: o.vibrato, vuv: o.vuv });
    return { phonemes: dur.seq.phonemes, phDurs: alignDurs(dur.phDurs, f.T), startSec: dur.startSec,
             plainLog2: f.plainLog2, vibLog2: f.vibLog2, uv: f.uv, baseLog2: f.baseLog2,
             noteIndex: dur.noteIndex, seed, shifts: dur.applied };
  }

  // ── 合成（engine/server.py の synthesize と PrettyPitchLeapSinger.synthesize） ──
  async synthesize(r: SynthReq): Promise<SynthResp> {
    const hit = this.analyses.get(r.key);
    if (!hit) throw new Error("解析の結果がありません（解析からやり直してください）");
    const vb = this.vbs.get(hit.vb)!;
    const voc = this.index.vocoders.find((v) => v.key === r.vocoder);
    if (!voc) throw new Error(`ボコーダがありません: ${r.vocoder}`);
    const an = hit.an;
    const T = an.phDurs.reduce((a, b) => a + b, 0);
    // engine/server.py: f0_hz = 2 ** f0_log2（float64 で計算して float32 に）
    const f0Hz = new Float32Array(r.f0_log2.length);
    for (let i = 0; i < f0Hz.length; i++) f0Hz[i] = Math.pow(2, r.f0_log2[i]);
    // 声のリテイク: 音符の id → 句の中の番号
    const pos = new Map(hit.ids.map((nid, i) => [String(nid), i]));
    const rt: Record<number, number> = {};
    for (const [k, s] of Object.entries(r.retake_mel ?? {})) if (pos.has(k) && Number(s)) rt[pos.get(k)!] = Number(s);

    // ⑤ 音響 → ⑥ mel の後処理（F0・歌い手・取り直しが同じなら使い回す）
    const acKey = digest(an.seed, r.singer, an.phonemes, an.phDurs, f0Hz.subarray(0, T), rt);
    let ac = this.acCache.get(acKey);
    if (!ac) {
      let exc = this.noise.exc?.(T) ?? null;
      if (!exc) {
        exc = normalNoise(T * 256, an.seed, 1);
        if (Object.keys(rt).length) {
          const fn = frameNoteIndex(an.noteIndex, an.phDurs, T);
          const fs = new Int32Array(T * 256);
          for (let i = 0; i < fs.length; i++) fs[i] = fn[(i / 256) | 0];
          applyRetakes(exc, fs, rt, 1);
        }
      }
      const a = acousticFeeds(vb, { phonemes: an.phonemes, phDurs: an.phDurs, uv: an.uv, noteIndex: an.noteIndex }, f0Hz, r.singer, exc);
      const mel = (await this.run(await this.session(vb.key, "acoustic"), a.feeds, ["mel"])).mel;
      ac = { melIn: melPostprocess(mel, T, a.uvHard, vb.frame_rate), uvHard: a.uvHard, cons: a.cons, f0: a.f0 };
      this.acCache.put(acKey, ac);
    }
    // ⑦ ボコーダ（さらにボコーダが同じなら使い回す）。ボイスパラメータはこの後で掛けるので、動かしても混ぜ直すだけ
    const vocKey = digest(acKey, voc.key);
    let vo = this.vocCache.get(vocKey);
    if (!vo) {
      const sess = await this.vocoderSession(voc);
      vo = voc.kind === "nhvsing"
        ? await this.run(sess, nhvFeeds(ac.melIn, T, ac.f0, ac.uvHard, this.noise.voc?.(T) ?? normalNoise(T * 256, an.seed, 2)))
        : await this.run(sess, nsfFeeds(ac.melIn, T, ac.f0), ["waveform"]);
      this.vocCache.put(vocKey, vo);
    }
    const fin = finishSynth(voc, T, vo, r.params, ac.uvHard, ac.cons, r.mel_plain);
    // 出た音の mel（engine/server.py の mel_of: 足りなければ ln(1e-5) で埋めて T に揃える）
    const melOf = (w: Float32Array): Float32Array => {
      const { mel, frames } = wavToMel(w);
      const m = new Float32Array(128 * T).fill(Math.fround(Math.log(1e-5)));
      for (let b = 0; b < 128; b++) for (let i = 0; i < Math.min(T, frames); i++) m[b * T + i] = mel[b * frames + i];
      return m;
    };
    return { n_frames: T, wav: fin.wav, mel_in: ac.melIn.slice(0, 128 * T),
             mel_out: r.mel_out ? melOf(fin.wav) : undefined,
             mel_plain: r.mel_plain && fin.wavPlain ? melOf(fin.wavPlain) : undefined };
  }
}
