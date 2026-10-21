// 合成のホスト側の処理（engine/pipeline.py の PrettyPitchLeapSinger.synthesize・_acoustic・_vocode と、
// PrettyPitch の svs/render.py の mel_postprocess）。音響モデルとボコーダ（ONNX）の前後だけを受け持つ純粋な関数。
//   acousticFeeds   ⑤ 音響モデルへの入力（synthesize の前半 + _acoustic のモデルの前）
//   melPostprocess  ⑥ mel の後処理（mel[0].T → R.mel_postprocess）
//   nhvFeeds・nsfFeeds  ⑦ ボコーダへの入力（_vocode の種類ごとの形の違い）
//   finishSynth     ⑦ の後（float16 の包絡・VP.spectral・VP.branch_mix・利得・VP.finish）
import { PhoneSet } from "./phoneset";
import { f32, i64 } from "./types";
import type { Feeds, VoicebankWeb } from "./types";
import * as VP from "./voiceparams";

const PAU = "pau";
const HOP = 256;
const N_MELS = 128;
const fr32 = Math.fround;

const psCache = new WeakMap<VoicebankWeb, PhoneSet>();
const phoneSetOf = (vb: VoicebankWeb): PhoneSet => {
  let ps = psCache.get(vb);
  if (!ps) psCache.set(vb, (ps = new PhoneSet(vb.phoneset)));
  return ps;
};

/** synthesize の前半と _acoustic のモデルの前: 音響モデルへの入力、T に詰めた F0、無声・有声（uv_hard）、子音のフレーム。
 * excNoise は励振の雑音 [T·256]（リテイクを当てた後のもの。モデルが exc_noise を持たなければ null） */
export function acousticFeeds(
  vb: VoicebankWeb,
  an: { phonemes: string[]; phDurs: ArrayLike<number>; uv: ArrayLike<number>; noteIndex: number[] },
  f0Hz: Float32Array, spk: number, excNoise: Float32Array | null,
): { feeds: Feeds; f0: Float32Array; uvHard: Float32Array; cons: Uint8Array; T: number } {
  const N = an.phonemes.length;
  let T = 0;
  for (let j = 0; j < N; j++) T += Number(an.phDurs[j]);
  // F0 は T に切り、短ければ最後の値を延ばす（np.pad mode="edge"）
  const f0 = new Float32Array(T);
  const nf = Math.min(T, f0Hz.length);
  f0.set(f0Hz.subarray(0, nf));
  for (let i = nf; i < T; i++) f0[i] = nf > 0 ? f0Hz[nf - 1] : 0;
  // 音素の id は speakers.json の phonemes の並び（ph2id）
  const ph2id = new Map(vb.speakers.phonemes.map((p, i) => [p, i] as [string, number]));
  const tokens = an.phonemes.map((p) => {
    const id = ph2id.get(p);
    if (id === undefined) throw new Error(`音響モデルの知らない音素: ${p}`);
    return id;
  });
  // フレームごとの音素 → uv_hard（有声 かつ pau でない）・子音のフレーム（pau でも核でもない）
  const ps = phoneSetOf(vb);
  const uvHard = new Float32Array(T);
  const cons = new Uint8Array(T);
  let t = 0;
  for (let j = 0; j < N && t < T; j++) {
    const p = an.phonemes[j];
    const isPau = p === PAU;
    const c = !(isPau || ps.isNucleus(p)) ? 1 : 0;
    const d = Number(an.phDurs[j]);
    for (let k = 0; k < d && t < T; k++, t++) {
      uvHard[t] = !isPau && t < an.uv.length && an.uv[t] > 0.5 ? 1 : 0;
      cons[t] = c;
    }
  }
  const emb = vb.speakers.speakers[String(spk)];
  if (!emb) throw new Error(`歌い手がいません: ${spk}`);
  const feeds: Feeds = {
    tokens: i64(tokens, [1, N]),
    durations: i64(an.phDurs, [1, N]),
    f0: f32(f0, [1, T]),
    spk_embed: f32(Float32Array.from(emb), [1, emb.length]),
  };
  if (excNoise) feeds.exc_noise = f32(excNoise, [1, excNoise.length]);
  return { feeds, f0, uvHard, cons, T };
}

// ── ⑥ mel の後処理（PrettyPitch の svs/render.py） ──
const MEL_FRAME_CLIP_THR = 0.23; // 1 フレームの mean exp(ln-mel) の上限
const MEL_LIMIT_ATTACK_MS = 20.0;
const MEL_LIMIT_RELEASE_MS = 250.0;
const TARGET_MEL_MAG = 0.0738; // 有声フレームの mean exp(ln-mel) の目標
const MEL_OFFSET_CLAMP: [number, number] = [-1.0, 1.2];

/** Python の round（偶数への丸め） */
function pyRound(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** render._mel_loudness_offset: ボコーダを学習基準の音量で駆動するための ln-mel への定数オフセット */
function melLoudnessOffset(mel: Float32Array, T: number, uv: ArrayLike<number>): number {
  const Tu = Math.min(T, uv.length);
  let anyV = false;
  for (let t = 0; t < Tu; t++) if (uv[t] > 0.5) { anyV = true; break; }
  let s = 0;
  let cnt = 0;
  for (let b = 0; b < N_MELS; b++) {
    const row = b * T;
    for (let t = 0; t < Tu; t++) {
      if (anyV && !(uv[t] > 0.5)) continue;
      s += Math.exp(mel[row + t]);
      cnt++;
    }
  }
  const mag = s / cnt;
  if (!(mag >= 1e-6)) return 0.0;
  const d = Math.log(TARGET_MEL_MAG / mag);
  return Math.min(Math.max(d, MEL_OFFSET_CLAMP[0]), MEL_OFFSET_CLAMP[1]);
}

/** scipy.ndimage.minimum_filter1d(mode="nearest")（大きさは奇数、中心に置く） */
function minimumFilter1d(x: Float64Array, size: number): Float64Array {
  const n = x.length;
  const h = size >> 1;
  const out = new Float64Array(n);
  // 端は最も近い値で延ばす。単調な列（deque）で O(n)
  const at = (i: number): number => x[Math.min(Math.max(i, 0), n - 1)];
  const dq = new Int32Array(n + 2 * h);
  let qh = 0;
  let qt = 0;
  for (let i = -h; i < n + h; i++) {
    const v = at(i);
    while (qt > qh && at(dq[qt - 1]) >= v) qt--;
    dq[qt++] = i;
    const c = i - h; // この位置の窓は [c − h, c + h]
    if (c >= 0) {
      while (dq[qh] < c - h) qh++;
      out[c] = at(dq[qh]);
    }
  }
  return out;
}

/** scipy.ndimage.uniform_filter1d(mode="nearest")。scipy の C の実装と同じく、走る和に (入る − 出る)/size を足していく */
function uniformFilter1d(x: Float64Array, size: number): Float64Array {
  const n = x.length;
  const size1 = size >> 1;
  const at = (i: number): number => x[Math.min(Math.max(i, 0), n - 1)];
  const out = new Float64Array(n);
  let tmp = 0.0;
  for (let l = 0; l < size; l++) tmp += at(l - size1);
  tmp /= size;
  out[0] = tmp;
  for (let l = 1; l < n; l++) {
    tmp += (at(l - size1 + size - 1) - at(l - size1 - 1)) / size;
    out[l] = tmp;
  }
  return out;
}

/** render._mel_frame_limit: mean exp(mel) が閾値を超えるフレームだけ下げる（ボコーダの内部クリップを防ぐ） */
function melFrameLimit(mel: Float32Array, T: number, frameRate: number): Float32Array {
  const e = new Float64Array(T);
  for (let b = 0; b < N_MELS; b++) {
    const row = b * T;
    for (let t = 0; t < T; t++) e[t] += Math.exp(mel[row + t]);
  }
  let d = new Float64Array(T);
  let any = false;
  for (let t = 0; t < T; t++) {
    d[t] = Math.min(0.0, Math.log(MEL_FRAME_CLIP_THR / Math.max(e[t] / N_MELS, 1e-9)));
    if (d[t] < -1e-4) any = true;
  }
  if (!any) return mel;
  const atk = Math.max(1, pyRound(MEL_LIMIT_ATTACK_MS * 1e-3 * frameRate));
  const rel = Math.max(1, pyRound(MEL_LIMIT_RELEASE_MS * 1e-3 * frameRate));
  d = minimumFilter1d(d, 2 * atk + 1); // 手前から下げ始める
  d = uniformFilter1d(d, 2 * rel + 1); // ゆっくり戻す
  const out = new Float32Array(mel.length);
  for (let b = 0; b < N_MELS; b++) {
    const row = b * T;
    for (let t = 0; t < T; t++) out[row + t] = mel[row + t] + d[t];
  }
  return out;
}

/** ⑥ mel の後処理: 音響モデルの出力 [1, T, 128] → mel [128, T]（行優先・float32）。
 * _acoustic の mel[0].T と render.mel_postprocess（ラウドネス合わせ → フレームリミッタ） */
export function melPostprocess(melModelOut: Float32Array, T: number, uvHard: ArrayLike<number>,
                               frameRate: number): Float32Array {
  if (melModelOut.length < N_MELS * T) throw new Error("音響モデルの mel が短い");
  const mel = new Float32Array(N_MELS * T);
  for (let t = 0; t < T; t++) {
    const src = t * N_MELS;
    for (let b = 0; b < N_MELS; b++) mel[b * T + t] = melModelOut[src + b];
  }
  // float32 の配列 + Python の数 → float32 のまま足す
  const off = fr32(melLoudnessOffset(mel, T, uvHard));
  for (let i = 0; i < mel.length; i++) mel[i] = mel[i] + off;
  return melFrameLimit(mel, T, frameRate);
}

/** mel [128, T] → [T, 128]（ボコーダの入力の形） */
function transposeMel(melIn: Float32Array, T: number, cols = T): Float32Array {
  const m = new Float32Array(T * N_MELS);
  for (let b = 0; b < N_MELS; b++) {
    const row = b * cols;
    for (let t = 0; t < T; t++) m[t * N_MELS + b] = melIn[row + t];
  }
  return m;
}

/** _vocode の NHVSing: mel [1,T,128]・f0 [1,1,T]・uv [1,1,T]（1 = 無声）・noise [1,1,T,256] */
export function nhvFeeds(melIn: Float32Array, T: number, f0: Float32Array, uvHard: Float32Array,
                         noise: Float32Array | null): Feeds {
  const uv = new Float32Array(T);
  for (let t = 0; t < T; t++) uv[t] = 1.0 - uvHard[t];
  const feeds: Feeds = {
    mel: f32(transposeMel(melIn, T), [1, T, N_MELS]),
    f0: f32(f0.slice(0, T), [1, 1, T]),
    uv: f32(uv, [1, 1, T]),
  };
  if (noise) feeds.noise = f32(noise, [1, 1, T, HOP]);
  return feeds;
}

/** _vocode の NSF-HiFiGAN（hop 512）: 隣の 2 フレームを平均（ln-mel の平均、F0 は log2 の平均）。奇数なら最後を繰り返す。
 * numpy では float32 の配列の演算なので、各段で float32 に丸める */
export function nsfFeeds(melIn: Float32Array, T: number, f0: Float32Array): Feeds {
  const T2 = Math.ceil(T / 2);
  const col = (t: number): number => Math.min(t, T - 1);
  const m2 = new Float32Array(T2 * N_MELS);
  const f2 = new Float32Array(T2);
  for (let i = 0; i < T2; i++) {
    const a = col(2 * i);
    const b = col(2 * i + 1);
    for (let k = 0; k < N_MELS; k++) m2[i * N_MELS + k] = fr32(0.5 * fr32(melIn[k * T + a] + melIn[k * T + b]));
    const la = fr32(Math.log2(Math.max(f0[a], 1.0)));
    const lb = fr32(Math.log2(Math.max(f0[b], 1.0)));
    f2[i] = fr32(2 ** fr32(0.5 * fr32(la + lb)));
  }
  return { mel: f32(m2, [1, T2, N_MELS]), f0: f32(f2, [1, T2]) };
}

/** float32 → float16 への丸め（最近接・偶数への丸め。numpy の astype(np.float16) と同じ）を float の値で返す */
export function roundFloat16(x: number): number {
  if (!Number.isFinite(x) || x === 0) return x;
  const a = Math.abs(x);
  if (a >= 65520) return x > 0 ? Infinity : -Infinity;
  let q: number;
  if (a < 6.103515625e-5) q = 5.9604644775390625e-8; // 非正規数: 2^-24 刻み
  else {
    let e = Math.floor(Math.log2(a));
    if (2 ** e > a) e--;
    else if (2 ** (e + 1) <= a) e++;
    q = 2 ** (e - 10);
  }
  const y = a / q;
  const f = Math.floor(y);
  const r = y - f;
  const m = r > 0.5 ? f + 1 : r < 0.5 ? f : f % 2 === 0 ? f : f + 1;
  const v = m * q;
  return x < 0 ? -v : v;
}

function toFloat16Values(a: Float32Array): Float32Array {
  const o = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = roundFloat16(a[i]);
  return o;
}

/** synthesize のボコーダの後: ボイスパラメータ（枝のあるボコーダだけ）・利得・うなり・音量・リミッタ。
 * out はボコーダの出力（NHVSing: waveform・harmonic・noise_out・env_h・env_n、NSF-HiFiGAN: waveform）。
 * wantPlain: ボイスパラメータを掛けない音（mel の ② 用）も返す */
export function finishSynth(
  voc: { kind: string; voice_params: boolean; gain_db: number }, T: number,
  out: { harmonic?: Float32Array; noise_out?: Float32Array; env_h?: Float32Array; env_n?: Float32Array; waveform?: Float32Array },
  params: Record<string, Float32Array>, uvHard: Float32Array, cons: Uint8Array, wantPlain: boolean,
): { wav: Float32Array; wavPlain: Float32Array | null } {
  const N = T * HOP;
  const g = voc.gain_db ? fr32(10 ** (voc.gain_db / 20)) : 1.0;
  const harm = voc.kind === "nhvsing" ? out.harmonic : undefined;
  const noise = voc.kind === "nhvsing" ? out.noise_out : undefined;
  let wav: Float32Array;
  let plain: Float32Array | null = null;
  if (harm && noise && voc.voice_params) {
    if (wantPlain) {
      // ② 用はボイスパラメータを掛けない音: clip(harm + noise, −1, 1)[:N]·g
      const n = Math.min(N, harm.length);
      plain = new Float32Array(n);
      for (let i = 0; i < n; i++) plain[i] = Math.min(Math.max(fr32(harm[i] + noise[i]), -1.0), 1.0) * g;
    }
    // 取り置きを小さくするため Python は包絡を float16 で持つ。同じ丸めをしてから使う
    const envH = out.env_h ? toFloat16Values(out.env_h) : null;
    const envN = out.env_n ? toFloat16Values(out.env_n) : null;
    const [h, z] = VP.spectral(harm, noise, envH, envN, params, T); // テンション・ジェンダー・響き
    wav = VP.branchMix(h, z, uvHard, params, cons); // 枝ごとの音量（ブレシネスなど）
    if (g !== 1) for (let i = 0; i < wav.length; i++) wav[i] = wav[i] * g;
  } else {
    let wav0 = out.waveform;
    if (!wav0) {
      if (!harm || !noise) throw new Error("ボコーダの出力に波形がありません");
      wav0 = new Float32Array(harm.length);
      for (let i = 0; i < harm.length; i++) wav0[i] = Math.min(Math.max(fr32(harm[i] + noise[i]), -1.0), 1.0);
    }
    wav = new Float32Array(wav0.length); // 枝の無いボコーダ（NSF-HiFiGAN）
    for (let i = 0; i < wav0.length; i++) wav[i] = wav0[i] * g;
    if (wantPlain) plain = wav.slice(0, N);
  }
  const fin = VP.finish(wav.subarray(0, N), params, T); // うなり・音量・リミッタ
  // 画面へ buffer ごと渡すので、長い配列の一部（NSF-HiFiGAN は 512 の倍数で長い）なら詰め直す
  const compact = fin.byteOffset === 0 && fin.byteLength === fin.buffer.byteLength ? fin : fin.slice();
  return { wav: compact, wavPlain: plain };
}
