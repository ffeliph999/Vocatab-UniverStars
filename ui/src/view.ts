// 時間軸と音高の軸の表示の状態。ピアノロールと下のパネルで共有する（左の鍵盤の幅だけずらして x を揃える）。

export const KEY_W = 64;
export const RULER_H = 26;

export class View {
  pxPerTick = 0.15; // 1 拍 = 72 px
  scrollTick = 0;
  pxPerSemi = 20;
  topPitch = 78; // 画面の上端の音高（連続値）
  private listeners: Array<() => void> = [];

  tickToX(t: number): number {
    return KEY_W + (t - this.scrollTick) * this.pxPerTick;
  }
  xToTick(x: number): number {
    return (x - KEY_W) / this.pxPerTick + this.scrollTick;
  }
  /** 連続の音高 v の y（音符の行は p ± 0.5）。 */
  pitchToY(v: number): number {
    return RULER_H + (this.topPitch - v) * this.pxPerSemi;
  }
  yToPitch(y: number): number {
    return this.topPitch - (y - RULER_H) / this.pxPerSemi;
  }

  zoomX(factor: number, anchorX: number): void {
    const t = this.xToTick(anchorX);
    this.pxPerTick = Math.min(2, Math.max(0.01, this.pxPerTick * factor));
    this.scrollTick = Math.max(0, t - (anchorX - KEY_W) / this.pxPerTick);
    this.emit();
  }
  zoomY(factor: number, anchorY: number): void {
    const v = this.yToPitch(anchorY);
    this.pxPerSemi = Math.min(48, Math.max(6, this.pxPerSemi * factor));
    this.topPitch = v + (anchorY - RULER_H) / this.pxPerSemi;
    this.clampPitch();
    this.emit();
  }
  scrollBy(dTick: number, dPitch: number): void {
    this.scrollTick = Math.max(0, this.scrollTick + dTick);
    this.topPitch += dPitch;
    this.clampPitch();
    this.emit();
  }
  private clampPitch(): void {
    this.topPitch = Math.min(108, Math.max(30, this.topPitch));
  }

  on(fn: () => void): void {
    this.listeners.push(fn);
  }
  emit(): void {
    for (const fn of this.listeners) fn();
  }
}
