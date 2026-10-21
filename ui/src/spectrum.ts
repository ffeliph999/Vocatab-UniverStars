// 合成した声の平均のスペクトル（イコライザーのグラフの後ろに描く）。
// 句の波形ごとにパワーの和を覚えておき（合成し直すと波形が変わるので WeakMap）、表示のたびに合わせるだけにする。
const N = 4096; // 44.1 kHz で 10.8 Hz 刻み
const BITS = 12;
const SILENT = 1e-3; // この RMS（約 −60 dBFS）より小さい区間は数えない（句の前後の無音）

const rev = new Uint32Array(N);
for (let i = 0; i < N; i++) {
  let r = 0;
  for (let b = 0; b < BITS; b++) r |= ((i >> b) & 1) << (BITS - 1 - b);
  rev[i] = r;
}
const cosT = new Float64Array(N / 2);
const sinT = new Float64Array(N / 2);
for (let i = 0; i < N / 2; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N);
  sinT[i] = -Math.sin((2 * Math.PI * i) / N);
}
const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N));
const re = new Float64Array(N);
const im = new Float64Array(N);

/** 窓を掛けた N 点の FFT のパワーを acc に足す。無音なら足さずに false。 */
function addFrame(x: Float32Array, off: number, acc: Float64Array): boolean {
  let e = 0;
  for (let i = 0; i < N; i++) e += x[off + i] * x[off + i];
  if (Math.sqrt(e / N) < SILENT) return false;
  for (let i = 0; i < N; i++) {
    re[rev[i]] = x[off + i] * win[i];
    im[rev[i]] = 0;
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let s = 0; s < N; s += size) {
      for (let k = 0; k < half; k++) {
        const a = s + k;
        const b = a + half;
        const c = cosT[k * step];
        const d = sinT[k * step];
        const tr = re[b] * c - im[b] * d;
        const ti = re[b] * d + im[b] * c;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
  for (let k = 0; k <= N / 2; k++) acc[k] += re[k] * re[k] + im[k] * im[k];
  return true;
}

const perWav = new WeakMap<Float32Array, { acc: Float64Array; n: number }>();

function wavPower(w: Float32Array): { acc: Float64Array; n: number } {
  let v = perWav.get(w);
  if (!v) {
    v = { acc: new Float64Array(N / 2 + 1), n: 0 };
    for (let off = 0; off + N <= w.length; off += N) if (addFrame(w, off, v.acc)) v.n++;
    perWav.set(w, v);
  }
  return v;
}

/**
 * 波形の組の平均のスペクトルを、freqs の周波数（Hz）ごとの dB（いちばん大きい所を 0 dB）で返す。
 * 各点は前後 1/6 オクターブ（幅 1/3 オクターブ）の平均で、倍音の 1 本ずつの山をならす。声が無ければ null。
 */
export function averageSpectrum(wavs: Float32Array[], sampleRate: number, freqs: Float32Array): Float32Array | null {
  const acc = new Float64Array(N / 2 + 1);
  let n = 0;
  for (const w of wavs) {
    const p = wavPower(w);
    for (let k = 0; k <= N / 2; k++) acc[k] += p.acc[k];
    n += p.n;
  }
  if (!n) return null;
  const hz = sampleRate / N;
  const out = new Float32Array(freqs.length);
  let top = -Infinity;
  freqs.forEach((f, i) => {
    const a = Math.max(1, Math.floor((f * 2 ** (-1 / 6)) / hz));
    const b = Math.min(N / 2, Math.max(a, Math.ceil((f * 2 ** (1 / 6)) / hz)));
    let s = 0;
    for (let k = a; k <= b; k++) s += acc[k];
    out[i] = 10 * Math.log10(s / (b - a + 1) / n + 1e-20);
    top = Math.max(top, out[i]);
  });
  for (let i = 0; i < out.length; i++) out[i] -= top;
  return out;
}
