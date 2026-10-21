// 音高を耳で確かめるための短い打鍵音（WebAudio）。最初の操作のときに AudioContext を作る。

let ctx: AudioContext | null = null;

export function audioContext(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}
const audio = audioContext;

const hz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

/** 短い打鍵音を鳴らす（0.3 秒ほどで消える）。 */
export function pluck(midi: number): void {
  const a = audio();
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
