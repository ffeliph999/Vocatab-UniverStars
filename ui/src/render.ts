// 自動の描画: 編集のたびに（少し待ってから）句ごとに解析し、最後の F0 が変わった句だけを合成し直す。
// エンジンは engine-web/client.ts の窓口（既定はブラウザの中、?engine=server で手元の Python）。
import { composeF0, type EngineInfo, type EPhrase, hashF32, phraseParams } from "./engine";
import { type EngineClient, makeEngine } from "./engine-web/client";
import type { RestoreEntry } from "./engine-web/protocol";
import { t as tx } from "./i18n";
import { activeNotes, type Track } from "./model";
import type { Store } from "./store";

const N_MELS = 128;
const MEL_FLOOR = -11.5;

/** 句ごとの mel を曲の時間軸に並べる（bin ごと [128 × N]）。句の端の pau が重なる所は大きい方。 */
export function assembleMel(phrases: EPhrase[], kind: "in" | "out" | "plain"): Float32Array | null {
  const pick = (p: EPhrase) => (kind === "in" ? p.melIn : kind === "plain" ? p.melPlain : p.melOut);
  const ready = phrases.filter(pick);
  if (!ready.length) return null;
  let n = 0;
  for (const p of phrases) n = Math.max(n, p.startFrame + p.nFrames);
  n += 172;
  const out = new Float32Array(N_MELS * n).fill(MEL_FLOOR);
  for (const p of ready) {
    const m = pick(p)!;
    for (let b = 0; b < N_MELS; b++) {
      for (let i = 0; i < p.nFrames; i++) {
        const g = p.startFrame + i;
        if (g < 0 || g >= n) continue;
        const k = b * n + g;
        out[k] = Math.max(out[k], m[b * p.nFrames + i]);
      }
    }
  }
  return out;
}

/** 句ごとの波形を曲の時間軸に並べる（44.1 kHz、hop 256）。合成済みの句が無ければ null。 */
export function assembleWav(phrases: EPhrase[]): Float32Array | null {
  const ready = phrases.filter((p) => p.wav);
  if (!ready.length) return null;
  let n = 0;
  for (const p of ready) n = Math.max(n, (p.startFrame + p.nFrames) * 256);
  const out = new Float32Array(Math.max(1, n));
  for (const p of ready) {
    const w = p.wav!;
    const o = p.startFrame * 256;
    for (let i = 0; i < w.length; i++) {
      const g = o + i;
      if (g >= 0 && g < n) out[g] += w[i];
    }
  }
  return out;
}

export class Renderer {
  info: EngineInfo | null = null;
  /** トラックの id → 句の列（最新の解析） */
  tracks = new Map<number, EPhrase[]>();
  rev = 0; // 句の中身が変わるたびに増える（表示の取り置きの鍵）
  error = "";
  /** mel の ② の行がオンか（オンのときだけ、ボイスパラメータを掛けない音の mel も頼む） */
  wantPlain: () => boolean = () => false;
  /** mel の ③ の行がオンか（オンのときだけ、出た音の mel を頼む。1 句で 35 ms ほど） */
  wantOut: () => boolean = () => false;
  readonly engine: EngineClient = makeEngine();
  private busy = false;
  private timer = 0;

  constructor(private store: Store, private onUpdate: () => void) {
    this.engine.onProgress = () => this.onUpdate(); // モデルの読み込みの進み具合
    this.engine.onState = () => this.onUpdate(); // 待機に入った・起きた
    // 待機から起きたエンジンへ、画面が持っている解析の結果を戻す（中身の変わっていない句を解析し直さないため）
    this.engine.collectRestore = () => {
      if (!this.info) return [];
      const out: RestoreEntry[] = [];
      for (const track of this.store.project.tracks) {
        const vb = this.voicebankOf(track).key;
        for (const ph of this.phrases(track)) {
          out.push({ key: ph.key, vb, singer: this.singerId(track), ids: ph.noteIds, phonemes: ph.phonemes,
                     start_sec: ph.startSec, plain: ph.plain, vib: ph.vib, uv: ph.uv, base: ph.base, seed: ph.seed });
        }
      }
      return out;
    };
  }

  async init(): Promise<void> {
    this.info = await this.engine.info();
    this.onUpdate();
    if (this.info) this.schedule(0);
  }

  get connected(): boolean {
    return this.info !== null && this.info.voicebanks.length > 0;
  }

  /** 選んでいるトラックのボイスバンク（状態の表示に使う） */
  get voicebank() {
    return this.voicebankOf(this.store.track);
  }

  /** トラックが歌うボイスバンク（key が一覧に無ければ先頭） */
  voicebankOf(track: Track) {
    const vbs = this.info!.voicebanks;
    return vbs.find((v) => v.key === track.voicebank) ?? vbs[0];
  }

  singerId(track: Track): number {
    return this.voicebankOf(track).singers.find((s) => s.name === track.voice)?.id ?? 0;
  }

  /** 選んでいるボコーダの鍵（NSF-HiFiGAN が無ければ NHVSing を使う）。 */
  vocoderKey(): string {
    const vocs = this.info?.vocoders ?? [];
    const want = this.store.vocoder === "nsf" ? "nsf" : "nhvsing";
    return (vocs.find((v) => v.kind.includes(want)) ?? vocs[0])?.key ?? "";
  }

  hasVocoder(kind: "nhv" | "nsf"): boolean {
    return (this.info?.vocoders ?? []).some((v) => v.kind.includes(kind === "nsf" ? "nsf" : "nhvsing"));
  }

  phrases(track: Track): EPhrase[] {
    return this.tracks.get(track.id) ?? [];
  }

  /** まだ合成が済んでいない句の数（書き出す前の確認に使う）。 */
  pending(): number {
    if (this.busy) return Math.max(1, this.countPending());
    return this.countPending();
  }

  private countPending(): number {
    let n = 0;
    for (const t of this.store.project.tracks) for (const ph of this.phrases(t)) if (ph.status !== "済み") n++;
    return n;
  }

  schedule(delay = 200): void {
    if (!this.connected) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.run(), delay);
  }

  private async run(): Promise<void> {
    if (this.busy) {
      this.schedule(100); // 走っている途中の編集は、終わってからもう一度
      return;
    }
    this.busy = true;
    const ver = this.store.version;
    const p = this.store.project;
    try {
      // 1. 解析（速い。中身が同じ句はエンジン側で取っておいたものを返す）
      for (const track of p.tracks) {
        // トラックの範囲で切った音符だけを歌わせる（端をまたぐ音符は端で終わる）
        const notes = activeNotes(track, p.beatsPerBar);
        if (!notes.length) {
          this.tracks.set(track.id, []);
          this.rev++;
          continue;
        }
        let j;
        try {
          j = await this.engine.analyze({
            voicebank: this.voicebankOf(track).key, singer: this.singerId(track), bpm: p.bpm, seed: 0,
            notes: notes.map((n) => ({ id: n.id, onset: n.onset, dur: n.dur, pitch: n.pitch, lyric: n.lyric,
                                       retake_f0: n.attrs.retakeF0 ?? 0, ph_shift: n.phShift ?? {} })),
          });
        } catch (e) {
          this.error = tx("解析に失敗: {e}", { e: e instanceof Error ? e.message : String(e) });
          this.onUpdate();
          continue;
        }
        this.error = "";
        // 中身の同じ句（鍵が同じ）は合成の結果（波形と 3 種の mel）を引き継ぐ。② を落とすと、② の行がオンのとき
        // 編集のたびに全部の句を合成し直してしまう
        const old = new Map(this.phrases(track).map((q) => [q.key, q]));
        const list: EPhrase[] = j.phrases.map((q) => {
          const prev = old.get(q.key);
          return {
            key: q.key, noteIds: q.note_ids, startFrame: q.start_frame, startSec: q.start_sec, nFrames: q.n_frames,
            phonemes: q.phonemes, plain: q.plain, vib: q.vib, uv: q.uv, base: q.base, seed: q.seed,
            status: prev?.status ?? "解析済み", f0Hash: prev?.f0Hash, wav: prev?.wav, melIn: prev?.melIn,
            melOut: prev?.melOut, melPlain: prev?.melPlain,
          };
        });
        this.tracks.set(track.id, list);
        this.rev++;
        this.onUpdate();
      }
      // 2. 合成（最後の F0・歌い手・ボコーダが変わった句だけ）
      const voc = this.vocoderKey();
      for (const track of p.tracks) {
        for (const ph of this.phrases(track)) {
          if (this.store.version !== ver) return; // 編集が入った: 最初からやり直す（finally で予約）
          const singer = this.singerId(track);
          const { log2 } = composeF0(ph, track, p);
          const params = phraseParams(ph, track, p);
          const ps = Object.keys(params).sort().map((k) => hashF32(params[k], k)).join(",");
          const plain = this.wantPlain();
          const out = this.wantOut();
          // AI リテイク（声）: この句の音符のうち取り直したものの種
          const byId = new Map(track.notes.map((n) => [n.id, n]));
          const retakeMel: Record<string, number> = {};
          for (const id of ph.noteIds) {
            const s = byId.get(id)?.attrs.retakeMel;
            if (s) retakeMel[String(id)] = s;
          }
          const h = hashF32(log2, `${voc}|${singer}|${ps}|${JSON.stringify(retakeMel)}`);
          // ②・③ の行をオンにしたばかりで mel が無い句は、同じ音でも頼み直す（エンジンの取り置きに当たるので速い）
          if (ph.f0Hash === h && ph.wav && (!plain || ph.melPlain) && (!out || ph.melOut)) continue;
          ph.status = "合成中";
          this.onUpdate();
          let j;
          try {
            // 句の鍵にボイスバンクが入っているので、ボイスバンクを替えた句は解析から作り直しになる
            j = await this.engine.synthesize({ voicebank: this.voicebankOf(track).key, singer, key: ph.key, f0_log2: log2, vocoder: voc, params,
                                               mel_out: out, mel_plain: plain, retake_mel: retakeMel });
          } catch (e) {
            ph.status = "失敗";
            this.error = tx("合成に失敗: {e}", { e: e instanceof Error ? e.message : String(e) });
            this.onUpdate();
            continue;
          }
          ph.wav = j.wav;
          ph.melIn = j.mel_in;
          ph.melOut = j.mel_out;
          ph.melPlain = j.mel_plain;
          ph.f0Hash = h;
          ph.status = "済み";
          this.rev++;
          this.onUpdate();
        }
      }
    } catch (e) {
      this.error = tx("エンジンとの通信に失敗: {e}", { e: String(e) });
      this.onUpdate();
    } finally {
      this.busy = false;
      if (this.store.version !== ver) this.schedule(50);
      else this.onUpdate(); // 全部済んだことを知らせる（書き出しのボタンなど）
    }
  }
}
