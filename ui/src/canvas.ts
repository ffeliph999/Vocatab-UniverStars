// Retina を考えた canvas の大きさ合わせと、描き直しのまとめ（1 フレームに 1 回）。

export class HiDpiCanvas {
  readonly ctx: CanvasRenderingContext2D;
  w = 0; // CSS の画素
  h = 0;

  constructor(readonly canvas: HTMLCanvasElement, private draw: () => void) {
    this.ctx = canvas.getContext("2d")!;
    // 最初の描画も ResizeObserver の最初の知らせで行う（作った側の準備が済んでから描くため）
    new ResizeObserver(() => this.resize()).observe(canvas);
  }

  resize(): void {
    const r = this.canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = r.width;
    this.h = r.height;
    this.canvas.width = Math.max(1, Math.round(r.width * dpr));
    this.canvas.height = Math.max(1, Math.round(r.height * dpr));
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }
}

let pending = new Set<() => void>();
let scheduled = false;
/** 同じフレームの中の描き直しを 1 回にまとめる。 */
export function requestDraw(fn: () => void): void {
  pending.add(fn);
  if (scheduled) return;
  scheduled = true;
  requestAnimationFrame(() => {
    const fns = pending;
    pending = new Set();
    scheduled = false;
    for (const f of fns) f();
  });
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  const rr = Math.max(0, Math.min(r, w / 2, h / 2));
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

const colorCache = new Map<string, string>();
/** 色を変えたとき（差し色など）: 覚えている色を捨てる。 */
export function clearCssCache(): void {
  colorCache.clear();
}
/** CSS の変数から色を読む（色は style.css にまとめてある）。 */
export function cssVar(name: string): string {
  let c = colorCache.get(name);
  if (c === undefined) {
    c = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    colorCache.set(name, c);
  }
  return c;
}
