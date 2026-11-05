// 他のソフトのピッチの線（OpenUtau の pitd・Synthesizer V の pitchDelta）を VocaTab のピッチのずれ（pitchDelta、セント）にする。
//   線が音符ごとに細かく描いてある（なぞったピッチ。元の音符の「階段」からのずれ）ときは、AI の抑揚・ビブラートを切って、
//   階段 + 線 がそのまま聞こえるようにする（VocaTab の土台は階段を σ 20 ms でならしたものなので、その差を足す）。
//   まばらな直しだけのときは、線をそのままピッチのずれにして AI の抑揚はそのまま残す。
import type { Curve } from "./model";

type Pt = [number, number];

export interface ImportedPitch {
  curve: Curve;
  /** 抑揚・ビブラートを切る音符（notes の並びの番号） */
  traced: number[];
}

const BASELINE_SIGMA_SEC = 0.02; // derive.ts の BASELINE_SIGMA と同じ
const PAD_TICKS = 30;
const EPS_CENT = 2; // 間引きの許容（セント）
const MAX_CENT = 1200;

/** 刻みの順の点を、許容 eps 以内で間引く（Ramer–Douglas–Peucker、再帰なし）。 */
function simplify(p: Pt[], eps: number): Pt[] {
  if (p.length < 3) return p;
  const keep = new Uint8Array(p.length);
  keep[0] = keep[p.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, p.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let wi = -1;
    const [x0, y0] = p[a];
    const [x1, y1] = p[b];
    for (let i = a + 1; i < b; i++) {
      const y = y0 + ((y1 - y0) * (p[i][0] - x0)) / (x1 - x0 || 1);
      const d = Math.abs(p[i][1] - y);
      if (d > worst) { worst = d; wi = i; }
    }
    if (worst > eps) {
      keep[wi] = 1;
      stack.push([a, wi], [wi, b]);
    }
  }
  return p.filter((_, i) => keep[i]);
}

/**
 * notes: 刻み（480/4 分音符）の音符。raw: [刻み, セント] の点（刻みの順）。bpm: 音符の階段をならすのに使う。
 */
export function importPitch(notes: Array<{ onset: number; dur: number; pitch: number }>, raw: Pt[], bpm: number,
                            interp: Curve["interp"] = "linear"): ImportedPitch | null {
  const pts = raw.filter(([x, y]) => Number.isFinite(x) && Number.isFinite(y)).sort((a, b) => a[0] - b[0]);
  if (pts.length < 2 || !notes.length) return null;
  const clamp = (v: number) => Math.max(-MAX_CENT, Math.min(MAX_CENT, v));

  // 各音符の所に、ゼロでない値があるか（= 直してある音符）と、点の数
  const edited: number[] = [];
  let ptsInNotes = 0;
  let j = 0;
  notes.forEach((n, i) => {
    while (j < pts.length && pts[j][0] < n.onset) j++;
    let k = j;
    let nz = false;
    while (k < pts.length && pts[k][0] < n.onset + n.dur) {
      if (Math.abs(pts[k][1]) > 0.5) nz = true;
      k++;
    }
    ptsInNotes += k - j;
    if (nz) edited.push(i);
  });
  const traced = edited.length >= 1 && ptsInNotes / notes.length >= 10;
  if (!traced) return { curve: { pts: simplify(pts.map(([x, y]) => [x, clamp(y)] as Pt), 0.5), interp }, traced: [] };

  // ── なぞった線: 階段 + 線 を作る ──
  const t0 = Math.max(0, Math.floor(Math.min(...edited.map((i) => notes[i].onset)) - PAD_TICKS - 200));
  const t1 = Math.ceil(Math.max(...edited.map((i) => notes[i].onset + notes[i].dur)) + PAD_TICKS + 200);
  const n = t1 - t0 + 1;
  const step = new Float32Array(n).fill(NaN);
  for (const nt of notes) {
    for (let t = Math.max(t0, Math.round(nt.onset)); t < Math.min(t1 + 1, Math.round(nt.onset + nt.dur)); t++) step[t - t0] = nt.pitch;
  }
  const sigma = BASELINE_SIGMA_SEC * (bpm * 480) / 60; // 刻み
  const R = Math.ceil(4 * sigma);
  const ker = Array.from({ length: 2 * R + 1 }, (_, k) => Math.exp(-0.5 * ((k - R) / sigma) ** 2));
  // 直した音符（と前後の PAD）だけを対象にする
  const active = new Uint8Array(n);
  for (const i of edited) {
    const a = Math.max(t0, Math.round(notes[i].onset) - PAD_TICKS);
    const b = Math.min(t1, Math.round(notes[i].onset + notes[i].dur) + PAD_TICKS);
    for (let t = a; t <= b; t++) active[t - t0] = 1;
  }
  // 近い区間はつなぐ（点が前後しないように）
  for (let i = 0, last = -1e9; i < n; i++) {
    if (!active[i]) continue;
    if (i - last > 1 && i - last <= 8 && last >= 0) for (let k = last + 1; k < i; k++) active[k] = 1;
    last = i;
  }
  const rawAt = (x: number): number => {
    let lo = 0;
    let hi = pts.length - 1;
    if (x <= pts[0][0] || x >= pts[hi][0]) return 0;
    while (hi - lo > 1) {
      const m = (lo + hi) >> 1;
      if (pts[m][0] <= x) lo = m;
      else hi = m;
    }
    return pts[lo][1] + ((pts[hi][1] - pts[lo][1]) * (x - pts[lo][0])) / (pts[hi][0] - pts[lo][0] || 1);
  };
  const out: Pt[] = [];
  let inRun = false;
  let lastT = -1;
  for (let i = 0; i < n; i++) {
    if (!active[i]) {
      if (inRun) { out.push([lastT + 3, 0]); inRun = false; }
      continue;
    }
    const t = t0 + i;
    let corr = 0;
    if (!Number.isNaN(step[i])) {
      let s = 0;
      let w = 0;
      for (let k = -R; k <= R; k++) {
        const v = step[i + k];
        if (v === undefined || Number.isNaN(v)) continue;
        s += ker[k + R] * v;
        w += ker[k + R];
      }
      corr = (step[i] - s / w) * 100;
    }
    if (!inRun) { out.push([t - 3, 0]); inRun = true; }
    out.push([t, clamp(rawAt(t) + corr)]);
    lastT = t;
  }
  if (inRun) out.push([lastT + 3, 0]);
  return { curve: { pts: simplify(out, EPS_CENT), interp: "linear" }, traced: edited };
}
