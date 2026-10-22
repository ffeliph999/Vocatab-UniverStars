// 再生の AudioContext と、音高を耳で確かめるための短い打鍵音（WebAudio）。最初の操作のときに AudioContext を作る。
//
// AudioContext は止まったまま戻らなくなることがある（Safari のスリープ明けや、ほかのアプリが音を使った後の
// "interrupted"、閉じられた "closed"、状態は "running" でも時刻が進まない）。そのままだと何を鳴らしても無音なので、
// 再生の前に readyAudioContext() で確かめ、起こせなければ作り直す（音声のバッファは別の AudioContext でも使える）。

let ctx: AudioContext | null = null;
// 最後に見た AudioContext の時刻と壁時計（"running" なのに時刻が進まないのを見つける）
let seen = { ctxTime: -1, wall: 0 };

function create(): AudioContext {
  ctx = new AudioContext();
  seen = { ctxTime: -1, wall: 0 };
  return ctx;
}

export function audioContext(): AudioContext {
  if (!ctx || ctx.state === "closed") create();
  if (ctx!.state !== "running") ctx!.resume().catch(() => { /* 次の操作でもう一度起こす */ });
  return ctx!;
}

const within = (p: Promise<unknown>, ms: number): Promise<unknown> =>
  Promise.race([p.catch(() => undefined), new Promise((r) => setTimeout(r, ms))]);

/** 時刻が進んでいないか（"running" のまま 0.5 秒以上たっても currentTime が同じ）。 */
function stalled(a: AudioContext): boolean {
  const now = performance.now();
  const bad = a.state === "running" && seen.ctxTime === a.currentTime && now - seen.wall > 500;
  seen = { ctxTime: a.currentTime, wall: now };
  return bad;
}

/**
 * 再生の前に呼ぶ: 動いている AudioContext を返す。止まっていれば起こし（0.5 秒まで待つ）、起きなければ閉じて作り直す。
 * resume は操作（クリック・キー）の中で呼ぶ必要があるので、最初の resume はこの関数の中ですぐ呼ぶ。
 */
export async function readyAudioContext(): Promise<AudioContext> {
  let a = audioContext();
  const wasRunning = a.state === "running";
  if (!wasRunning) await within(a.resume(), 500);
  // 時刻が進まないかは、もともと動いていたときだけ見る（止まっていた間は時刻が進まないのが正しい）
  if (a.state !== "running" || (wasRunning && stalled(a))) {
    console.warn(`AudioContext を作り直します（状態: ${a.state}）`);
    a.close().catch(() => { /* 閉じられなくても捨てる */ });
    a = create();
    await within(a.resume(), 500);
  }
  stalled(a); // 今の時刻を覚えておく
  return a;
}

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** 短い打鍵音を鳴らす（0.3 秒ほどで消える）。 */
export function pluck(midi: number): void {
  const a = audioContext();
  const t = a.currentTime;
  const gain = a.createGain();
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(0.18, t + 0.005);
  gain.gain.exponentialRampToValueAtTime(0.0005, t + 0.35);
  const lp = a.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(Math.min(8000, hz(midi) * 8), t);
  lp.frequency.exponentialRampToValueAtTime(Math.max(200, hz(midi) * 1.5), t + 0.3);
  for (const [type, mul, level] of [["triangle", 1, 1], ["sine", 2, 0.25]] as const) {
    const osc = a.createOscillator();
    const g = a.createGain();
    osc.type = type;
    osc.frequency.value = hz(midi) * mul;
    g.gain.value = level;
    osc.connect(g).connect(lp);
    osc.start(t);
    osc.stop(t + 0.4);
  }
  lp.connect(gain).connect(a.destination);
}
