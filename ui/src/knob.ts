// 小さな回すつまみ（トラックの音量・パン）。上下にドラッグで回す（⇧ で細かく）、ダブルクリックで既定値。
// 向きが一目で分かるよう、明るい針と、既定値（真上）から今の値までの円弧を描き、真下に値を数字で出す。
import { t } from "./i18n";

export interface KnobOpts {
  title: string;
  min: number;
  max: number;
  def: number; // 既定値（つまみが真上を向く値）
  get: () => number;
  set: (v: number) => void;
  fmt: (v: number) => string; // 下に出す値
  onStart?: () => void; // ドラッグを始めたとき（undo の snapshot を取る）
  onEnd?: () => void;
}

const C = 14; // 中心
const R_ARC = 12; // 円弧の半径
const SWEEP = 135; // 真上から左右に回せる角度（度）

/** 角度（ラジアン、真上 0・時計回り）の、半径 r の点。 */
const at = (a: number, r: number): string => `${(C + r * Math.sin(a)).toFixed(2)} ${(C - r * Math.cos(a)).toFixed(2)}`;
/** a0 から a1 までの円弧。 */
function arc(a0: number, a1: number, r: number): string {
  if (Math.abs(a1 - a0) < 1e-4) return "";
  const large = Math.abs(a1 - a0) > Math.PI ? 1 : 0;
  const sweep = a1 > a0 ? 1 : 0;
  return `M ${at(a0, r)} A ${r} ${r} 0 ${large} ${sweep} ${at(a1, r)}`;
}

export function knob(o: KnobOpts): HTMLElement {
  const el = document.createElement("div");
  el.className = "knob";
  const full = (SWEEP * Math.PI) / 180;
  el.innerHTML = `<svg class="dial" viewBox="0 0 28 28" width="28" height="28">
      <path class="track" d="${arc(-full, full, R_ARC)}" />
      <path class="value" d="" />
      <circle cx="${C}" cy="${C}" r="8.5" />
      <line x1="${C}" y1="${C}" x2="${C}" y2="${C - 8}" /></svg>
    <span class="kval"></span>`;
  const valuePath = el.querySelector<SVGPathElement>("path.value")!;
  const line = el.querySelector("line")!;
  const text = el.querySelector<HTMLElement>(".kval")!;
  // つまみの位置 p（−1〜1、0 が真上 = 既定値）と値の対応。既定値の左右で別の直線
  const pos = (v: number): number => (v < o.def ? -(o.def - v) / (o.def - o.min) : (v - o.def) / (o.max - o.def));
  const val = (p: number): number => (p < 0 ? o.def + p * (o.def - o.min) : o.def + p * (o.max - o.def));
  const show = (): void => {
    const v = o.get();
    const a = pos(v) * full;
    valuePath.setAttribute("d", arc(0, a, R_ARC));
    const [x2, y2] = at(a, 8).split(" ");
    line.setAttribute("x2", x2);
    line.setAttribute("y2", y2);
    text.textContent = o.fmt(v);
    el.title = t("{name}: {value}（上下にドラッグで回す、⇧ で細かく、ダブルクリックで戻す）", { name: o.title, value: o.fmt(v) });
  };
  show();
  let y0 = 0;
  let p0 = 0;
  el.addEventListener("pointerdown", (e) => {
    e.stopPropagation();
    el.setPointerCapture(e.pointerId);
    y0 = e.clientY;
    p0 = pos(o.get());
    el.classList.add("drag");
    o.onStart?.();
  });
  el.addEventListener("pointermove", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    const per = 2 / (e.shiftKey ? 600 : 150); // 150 px で端から端まで
    o.set(val(Math.max(-1, Math.min(1, p0 + (y0 - e.clientY) * per))));
    show();
  });
  el.addEventListener("pointerup", (e) => {
    if (!el.hasPointerCapture(e.pointerId)) return;
    el.releasePointerCapture(e.pointerId);
    el.classList.remove("drag");
    o.onEnd?.();
  });
  el.addEventListener("click", (e) => e.stopPropagation());
  el.addEventListener("dblclick", (e) => {
    e.stopPropagation();
    o.onStart?.();
    o.set(o.def);
    show();
    o.onEnd?.();
  });
  return el;
}
