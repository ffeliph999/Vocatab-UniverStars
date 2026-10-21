// 時間の縦線（小節・拍・スナップ）。ピアノロールと下のパネルで同じ線を引き、位置を揃えて見せる。
import { cssVar } from "./canvas";
import { TPQ } from "./model";
import { KEY_W, type View } from "./view";

export function drawTimeGrid(ctx: CanvasRenderingContext2D, view: View, beatsPerBar: number, snapTicks: number,
                             y0: number, y1: number, w: number): void {
  const t0 = view.xToTick(KEY_W);
  const t1 = view.xToTick(w);
  const bar = beatsPerBar * TPQ;
  const step = Math.max(snapTicks, 30);
  for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
    const x = Math.round(view.tickToX(t));
    if (x < KEY_W) continue;
    ctx.fillStyle = t % bar === 0 ? cssVar("--grid-bar") : t % TPQ === 0 ? cssVar("--grid-beat") : cssVar("--grid-sub");
    ctx.fillRect(x, y0, 1, y1 - y0);
  }
}

/** ピアノロールのスナップの幅（刻み）。自動のときは拡大の度合いで決める。 */
export function snapTicksFor(setting: string, pxPerTick: number): number {
  if (setting === "none") return 1;
  if (setting !== "auto") return Number(setting);
  for (const d of [30, 60, 120, 240, 480, 960, 1920]) if (d * pxPerTick >= 16) return d;
  return 1920;
}
