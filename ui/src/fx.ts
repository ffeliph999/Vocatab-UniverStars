// トラックのエフェクト（イコライザー → コンプレッサー → リバーブ）を WebAudio の部品で組む。歌（モノ）を受けてステレオで出す。
// 再生（AudioContext）と書き出し（OfflineAudioContext）で同じ組み立てを使うので、聞こえる音とファイルが一致する。
// 切っている所は「何もしない値」にする（つなぎ替えないので、再生中に入り切りしても音が途切れない）。
import { t } from "./i18n";
import { defaultFx, type ReverbPreset, type TrackFx } from "./model";

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  update(fx: TrackFx | undefined): void;
}

/**
 * リバーブの種類。選ぶと残響の形の 3 つの点（残響の長さ・プリディレイ・ドライ/ウェット）がその種類らしい値になり、
 * 響きの作り（初期反射の並び・残響の立ち上がり・明るさ）も種類ごとに変わる。
 *   damp: 残響の最初の明るさ（高域を丸める一極の低域通過の目安 Hz。時間とともにさらに下がる）
 *   build: 残響が立ち上がるまでの時間（秒）。大きい空間ほどゆっくり
 *   early: 初期反射 [ms, 大きさ]（壁からの最初のはっきりした跳ね返り）
 */
export const REVERB_PRESETS: Record<ReverbPreset, { label: string; decay: number; preDelay: number; wet: number;
                                                    damp: number; build: number; early: Array<[number, number]> }> = {
  room: { label: t("部屋"), decay: 0.6, preDelay: 5, wet: 0.25, damp: 6000, build: 0.004,
          early: [[3, 0.6], [5, 0.5], [8, 0.45], [11, 0.4], [14, 0.35], [18, 0.3], [23, 0.25], [27, 0.2], [33, 0.15]] },
  hall: { label: t("ホール"), decay: 2.4, preDelay: 25, wet: 0.22, damp: 3200, build: 0.04,
          early: [[17, 0.35], [29, 0.3], [43, 0.25], [61, 0.2], [79, 0.15]] },
  plate: { label: t("プレート"), decay: 1.5, preDelay: 0, wet: 0.2, damp: 11000, build: 0.001, early: [] },
  cathedral: { label: t("大聖堂"), decay: 4.5, preDelay: 40, wet: 0.25, damp: 2200, build: 0.1,
               early: [[31, 0.25], [57, 0.2], [89, 0.18], [121, 0.14]] },
};

/** 残響のインパルス応答（ステレオ）: 白色雑音 × 立ち上がり × 指数の減衰（decay 秒で −60 dB）、種類ごとに高域を丸め、初期反射を足す。 */
export function reverbIR(ctx: BaseAudioContext, preset: ReverbPreset, decay: number): AudioBuffer {
  const sr = ctx.sampleRate;
  const len = Math.max(1, Math.floor(sr * Math.min(9, decay * 1.1)));
  const buf = ctx.createBuffer(2, len, sr);
  const pr = REVERB_PRESETS[preset] ?? REVERB_PRESETS.hall; // 古い保存（"bright"）はホールとして読む
  let seed = 12345;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff; // 毎回同じ残響になるよう、決まった乱数
    return seed / 0x3fffffff - 1;
  };
  for (let c = 0; c < 2; c++) {
    const x = buf.getChannelData(c);
    let lp = 0;
    for (let i = 0; i < len; i++) {
      const t = i / sr;
      // 時間がたつほど高域を強く丸める（実際の部屋のように）
      const fc = pr.damp * Math.exp(-t / Math.max(0.2, decay));
      const a = Math.exp((-2 * Math.PI * fc) / sr);
      lp = (1 - a) * rnd() + a * lp; // 左右は別々の雑音（広がり）
      x[i] = lp * (1 - Math.exp(-t / pr.build)) * Math.exp((-6.9 * t) / decay);
    }
    // 初期反射（左右で少しずらし、符号も変えて広がりを出す）
    for (const [ms, g] of pr.early) {
      const k = Math.floor(((ms + c * 1.7) / 1000) * sr);
      if (k < len) x[k] += g * (c === 0 ? 1 : -1) * 0.5;
    }
  }
  return buf;
}

const KNEE = 6;
/** イコライザーの山・谷の点の最大数。部品は最初にこの数だけ作り、使わない分は増減 0 にする（つなぎ替えない） */
export const EQ_MAX_BANDS = 8;

/** WebAudio の DynamicsCompressorNode が自動で掛ける持ち上げ（倍率）。仕様: 0 dBFS を入れたときの出力の逆数の 0.6 乗。 */
function autoMakeup(threshold: number, ratio: number): number {
  // 0 dBFS がひざより上にあれば、出力は threshold + (0 − threshold)/ratio（ひざの丸みは 0 dBFS では効かない近似）
  const out0 = -threshold > KNEE / 2 ? threshold - threshold / ratio : 0;
  return 10 ** ((-out0 * 0.6) / 20);
}

export function buildFxChain(ctx: BaseAudioContext): FxChain {
  const input = ctx.createGain();
  const lowCut = ctx.createBiquadFilter();
  lowCut.type = "highpass";
  lowCut.Q.value = Math.SQRT1_2;
  const bands = Array.from({ length: EQ_MAX_BANDS }, () => {
    const b = ctx.createBiquadFilter();
    b.type = "peaking";
    return b;
  });
  const comp = ctx.createDynamicsCompressor();
  comp.knee.value = KNEE;
  comp.release.value = 0.2;
  // コンプは切っているとき部品を通さない（compPath と through を 0/1 で切り替える）。
  // WebAudio のコンプは自動で持ち上げを掛けるので、compPath でそれを打ち消す（大きい所を縮めるだけにする）
  const compPath = ctx.createGain();
  const through = ctx.createGain();
  const sum = ctx.createGain();
  const dry = ctx.createGain();
  const pre = ctx.createDelay(0.5);
  const conv = ctx.createConvolver();
  const wet = ctx.createGain();
  const output = ctx.createGain();
  // 歌は常にモノなので、組み立ての中はモノに固定する（コンプなどがステレオを出しても、合流点で左右に同じ音として広がらないように）
  for (const g of [input, sum]) {
    g.channelCount = 1;
    g.channelCountMode = "explicit";
  }
  input.connect(lowCut);
  let node: AudioNode = lowCut;
  for (const b of bands) node = node.connect(b);
  node.connect(comp).connect(compPath).connect(sum);
  node.connect(through).connect(sum);
  // リバーブ（Convolver）は常にステレオを出すので、そのまま合流させるとモノの歌が「左右に同じ音」になり 3 dB 大きくなる。
  // 素通しの側もパン 0 の部品でステレオにしておく（モノは等パワーで左右 −3 dB、ステレオはそのまま）。モノの書き出しでは不要
  if (ctx.destination.channelCount >= 2) {
    const center = ctx.createStereoPanner();
    sum.connect(center).connect(dry).connect(output);
  } else {
    sum.connect(dry).connect(output);
  }
  sum.connect(pre).connect(conv).connect(wet).connect(output);
  let irKey = "";

  const update = (f: TrackFx | undefined): void => {
    const fx = f ?? defaultFx();
    const eqOn = !!f && fx.eq.on;
    lowCut.frequency.value = eqOn ? fx.eq.lowCut : 10;
    bands.forEach((b, i) => {
      const s = fx.eq.bands[i];
      b.frequency.value = s?.freq ?? 1000;
      b.Q.value = s?.q ?? 1;
      b.gain.value = eqOn ? s?.gain ?? 0 : 0;
    });
    const compOn = !!f && fx.comp.on;
    comp.threshold.value = fx.comp.threshold;
    comp.ratio.value = fx.comp.ratio;
    comp.attack.value = fx.comp.attack;
    compPath.gain.value = compOn ? 1 / autoMakeup(fx.comp.threshold, fx.comp.ratio) : 0;
    through.gain.value = compOn ? 0 : 1;
    const revOn = !!f && fx.reverb.on;
    pre.delayTime.value = Math.max(0, fx.reverb.preDelay) / 1000;
    wet.gain.value = revOn ? fx.reverb.wet : 0;
    dry.gain.value = revOn ? 1 - fx.reverb.wet * 0.5 : 1;
    const key = `${fx.reverb.preset}|${fx.reverb.decay.toFixed(2)}`;
    if (revOn && key !== irKey) {
      irKey = key;
      conv.buffer = reverbIR(ctx, fx.reverb.preset, fx.reverb.decay);
    }
  };
  return { input, output, update };
}
