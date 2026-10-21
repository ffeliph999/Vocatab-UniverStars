// モック用の「見せかけの mel」。ピッチの線・音素・ボイスパラメータから倍音の模様を作る（エンジンをつなぐまでの代わり）。
// 格子は本番と同じ: 44.1 kHz・hop 256（172.27 フレーム/秒）、128 bin、40〜16000 Hz、自然対数の振幅。
import type { Derived } from "./derive";
import { FPS, type ParamKey, type Project, secPerTick, type Track } from "./model";
import { evalCurve, paramDef } from "./params";

export const N_MELS = 128;
export const MEL_FLOOR = -11.5;
const FMIN = 40;
const FMAX = 16000;
const toMel = (f: number): number => 2595 * Math.log10(1 + f / 700);
const M0 = toMel(FMIN);
const M1 = toMel(FMAX);
export const binToHz = (b: number): number => 700 * (10 ** ((M0 + (b / (N_MELS - 1)) * (M1 - M0)) / 2595) - 1);
const hzToBin = (f: number): number => ((toMel(f) - M0) / (M1 - M0)) * (N_MELS - 1);
const BIN_HZ = Array.from({ length: N_MELS }, (_, b) => binToHz(b));
const BIN_BW = Array.from({ length: N_MELS }, (_, b) => binToHz(b + 0.5) - binToHz(b - 0.5));

const FORMANTS: Record<string, Array<[number, number]>> = {
  a: [[800, 90], [1250, 110], [2600, 160]],
  i: [[300, 60], [2300, 120], [3000, 200]],
  u: [[350, 70], [1300, 120], [2400, 170]],
  e: [[480, 80], [1900, 110], [2600, 170]],
  o: [[480, 80], [850, 100], [2600, 170]],
  N: [[260, 60], [1100, 200], [2500, 250]],
};
const VOICED_CONS = new Set(["n", "m", "r", "y", "w", "g", "z", "j", "d", "b", "ny", "my", "ry", "gy", "by"]);
const FRICATIVE: Record<string, number> = { s: 6500, sh: 3800, ts: 6000, ch: 4000, z: 6000, j: 4000, f: 5000, h: 3000 };

/** 声道の包絡（dB）。warp > 1 でフォルマントが下がる。 */
function envDb(f: number, vowel: string, warp: number): number {
  const fw = f * warp;
  let s = 0;
  for (const [F, B] of FORMANTS[vowel] ?? FORMANTS.a) s += 1 / (1 + ((fw - F) / B) ** 2);
  return 10 * Math.log10(s + 0.02) - 12 * Math.max(0, Math.log2(f / 400));
}

/** 決まった乱数（同じ入力で同じ値。描き直しても模様が揺れないように）。 */
const hash = (i: number, b: number): number => {
  const x = Math.sin(i * 12.9898 + b * 78.233) * 43758.5453;
  return x - Math.floor(x) - 0.5;
};

export type MelKind = "acoustic" | "vocoder" | "final";

/**
 * acoustic: 音響モデルの出力（postfilter 後）。vocoder: それをボコーダに通した音の mel（ボイスパラメータなし）。
 * final: ボイスパラメータを掛けた音の mel。NSF-HiFiGAN のときは音量だけを掛ける。
 * 戻り値は bin ごとに並べた [128 × フレーム数]（WebGL の texture にそのまま渡せる並び）。
 */
export function synthMel(project: Project, track: Track, der: Derived, kind: MelKind, nsf: boolean): Float32Array {
  const n = der.pitch.length;
  const out = new Float32Array(N_MELS * n).fill(MEL_FLOOR);
  const spt = secPerTick(project.bpm);
  const phones = der.phones;
  const pw = new Float64Array(N_MELS);
  const vp = kind === "final" && !nsf;
  const curve = (key: ParamKey, tick: number) => evalCurve(track.params[key], tick, paramDef(key).def);
  let p = 0;
  for (let i = 0; i < n; i++) {
    const t = i / FPS;
    while (p < phones.length && phones[p].end <= t) p++;
    const seg = p < phones.length && phones[p].start <= t ? phones[p] : null;
    pw.fill(0);
    if (seg) {
      const tick = t / spt;
      const b = track.base;
      let warp = 1;
      let harmGain = 0;
      let noiseGain = 0;
      let tension = 0;
      let voicing = 1;
      if (kind === "final") {
        const loud = b.loudness + curve("loudness", tick);
        harmGain += loud;
        noiseGain += loud;
      }
      if (vp) {
        const br = b.breathiness + curve("breathiness", tick);
        tension = b.tension + curve("tension", tick);
        warp *= 2 ** (0.25 * (b.gender + curve("gender", tick)));
        voicing = Math.max(0, b.voicing * curve("voicing", tick));
        harmGain -= 5.5 * Math.max(0, br);
        noiseGain += 7.5 * br;
      }
      const f0 = 440 * 2 ** ((der.pitch[i] - 69) / 12);
      const voiced = (seg.vowel || VOICED_CONS.has(seg.ph)) && Number.isFinite(f0);
      if (voiced) {
        const vowel = seg.vowel ? seg.ph : "N";
        const lvl = seg.vowel ? 0 : -8;
        for (let k = 1; k * f0 < FMAX && k <= 120; k++) {
          const f = k * f0;
          const tilt = vp ? Math.max(-18, Math.min(18, 10 * tension * Math.log2(f / 500))) : 0;
          const pow = voicing * voicing * 10 ** ((envDb(f, vowel, warp) + lvl + harmGain + tilt) / 10);
          const pos = hzToBin(f);
          const b0 = Math.floor(pos);
          const fr = pos - b0;
          if (b0 >= 0 && b0 < N_MELS) pw[b0] += pow * (1 - fr);
          if (b0 + 1 >= 0 && b0 + 1 < N_MELS) pw[b0 + 1] += pow * fr;
        }
        for (let bb = 0; bb < N_MELS; bb++) {
          pw[bb] += 10 ** ((envDb(BIN_HZ[bb], vowel, warp) - 52 + noiseGain) / 10) * Math.min(1, BIN_BW[bb] / f0);
        }
      } else {
        // 無声子音: 摩擦は帯域の雑音、破裂は頭の短い雑音
        const center = FRICATIVE[seg.ph];
        const sinceStart = t - seg.start;
        for (let bb = 0; bb < N_MELS; bb++) {
          const f = BIN_HZ[bb];
          let db = -60;
          if (center) db = (seg.ph === "h" || seg.ph === "f" ? -30 : -18) - 8 * Math.log2(f / center) ** 2;
          else if (sinceStart < 0.025) db = -22 - 4 * Math.abs(Math.log2(f / 2500));
          pw[bb] += 10 ** ((db + noiseGain) / 10);
        }
      }
    }
    for (let bb = 0; bb < N_MELS; bb++) {
      out[bb * n + i] = Math.max(MEL_FLOOR, 0.5 * Math.log(pw[bb] + 1e-12));
    }
  }
  if (kind !== "acoustic") {
    // ボコーダを通した音の mel らしく: 時間方向に少しにじませ、細かい揺らぎを足す
    const tmp = new Float32Array(out);
    for (let bb = 0; bb < N_MELS; bb++) {
      const row = bb * n;
      for (let i = 1; i < n - 1; i++) {
        const v = 0.25 * tmp[row + i - 1] + 0.5 * tmp[row + i] + 0.25 * tmp[row + i + 1];
        out[row + i] = Math.max(MEL_FLOOR, v + (v > MEL_FLOOR + 1 ? 0.25 * hash(i, bb) : 0));
      }
    }
  }
  return out;
}
