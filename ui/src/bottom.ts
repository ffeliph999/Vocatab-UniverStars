// 下のパネル: 最下段のタブで開け閉めし、開いたものはピアノロールの下に積み重なる。
// 「音素のタイミング」は音素の境界を動かすほか、ブレス（息継ぎ）を入れる所でもある: 入れられる休符には「＋ 息」の印が出て、
// クリックで入る（パターンは音符ごとに決まる）。入れてある所はクリックで別のパターンに、右クリックで消す。
import { addOrCycleBreath, type BreathSlot } from "./breath";
import { cssVar, HiDpiCanvas, requestDraw } from "./canvas";
import type { BreathContext, Derived, PhoneSeg } from "./derive";
import { drawTimeGrid } from "./grid";
import { t } from "./i18n";
import { secPerTick } from "./model";
import type { Store } from "./store";
import { KEY_W, type View, wheelScrollX } from "./view";

export class PhonemePanel {
  readonly hc: HiDpiCanvas;
  private drag: { noteId: number; idx: number; baseStart: number; before: string } | null = null;

  /** breathCtx: ブレスの束と歌い手（エンジンがつながっていて束があるときだけ。無ければブレスの所は出ない） */
  constructor(private store: Store, private view: View, private derived: () => Derived, canvas: HTMLCanvasElement,
              private snapTicks: () => number, private hint: (s: string) => void,
              private breathCtx: () => BreathContext | undefined = () => undefined) {
    this.hc = new HiDpiCanvas(canvas, () => this.draw());
    canvas.addEventListener("pointerdown", (e) => this.onDown(e));
    canvas.addEventListener("pointermove", (e) => this.onMove(e));
    canvas.addEventListener("pointerup", () => this.onUp());
    canvas.addEventListener("dblclick", (e) => this.onDbl(e));
    canvas.addEventListener("contextmenu", (e) => this.onContext(e));
    canvas.addEventListener("wheel", (e) => wheelScrollX(this.view, e), { passive: false });
  }

  redraw(): void {
    requestDraw(() => this.draw());
  }

  private secToX(sec: number): number {
    return this.view.tickToX(sec / secPerTick(this.store.project.bpm));
  }

  /** x の近くの、動かせる境界（音素の頭）。 */
  private boundaryAt(x: number): PhoneSeg | null {
    let best: PhoneSeg | null = null;
    let bd = 6;
    for (const s of this.derived().phones) {
      if (!s.movable) continue;
      const d = Math.abs(this.secToX(s.start) - x);
      if (d < bd) {
        bd = d;
        best = s;
      }
    }
    return best;
  }

  /** x の下のブレスの区画（入れてある所と、入れられる所）。 */
  private breathAt(x: number): BreathSlot | null {
    for (const b of this.derived().breaths) {
      if (x >= this.secToX(b.start + b.cut) && x <= this.secToX(b.end)) return b;
    }
    return null;
  }

  private onDown(e: PointerEvent): void {
    const s = this.boundaryAt(e.offsetX);
    if (s) {
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      this.drag = { noteId: s.noteId, idx: s.idx, baseStart: s.baseStart, before: this.store.snapshot() };
      return;
    }
    if (e.button !== 0) return;
    const b = this.breathAt(e.offsetX);
    if (!b) return;
    // 入れていなければ入れる、入れてあれば別のパターンに替える
    const n = this.store.track.notes.find((q) => q.id === b.noteId);
    const ctx = this.breathCtx();
    if (!n || !ctx) return;
    const before = this.store.snapshot();
    if (!addOrCycleBreath(n, ctx)) return;
    this.store.commit(before);
    this.store.changed("project");
  }

  /** 右クリック: 入れてあるブレスを消す */
  private onContext(e: MouseEvent): void {
    e.preventDefault();
    const b = this.breathAt(e.offsetX);
    const n = b && b.index !== null ? this.store.track.notes.find((q) => q.id === b.noteId) : undefined;
    if (!n?.breath) return;
    const before = this.store.snapshot();
    delete n.breath;
    this.store.commit(before);
    this.store.changed("project");
  }

  private onMove(e: PointerEvent): void {
    const d = this.drag;
    if (!d) {
      const s = this.boundaryAt(e.offsetX);
      const b = s ? null : this.breathAt(e.offsetX);
      this.hc.canvas.style.cursor = s ? "ew-resize" : b ? "pointer" : "default";
      this.hint(s ? t("ドラッグ: 音素の境界を移動（休符の後の先頭は前の休符の中まで伸ばせます。フレーズの終わりは動きません）　ダブルクリック: 元に戻す")
        : b ? (b.index === null ? t("クリック: ここにブレスを入れる") : t("クリック: 別のブレスに替える　右クリック: 消す")) : "");
      return;
    }
    const n = this.store.track.notes.find((q) => q.id === d.noteId);
    if (!n) return;
    const sec = this.view.xToTick(e.offsetX) * secPerTick(this.store.project.bpm);
    n.phShift = { ...(n.phShift ?? {}), [d.idx]: sec - d.baseStart };
    this.store.changed("project");
  }

  private onUp(): void {
    if (this.drag) this.store.commit(this.drag.before);
    this.drag = null;
  }

  private onDbl(e: MouseEvent): void {
    const s = this.boundaryAt(e.offsetX);
    const n = s && this.store.track.notes.find((q) => q.id === s.noteId);
    if (!s || !n?.phShift?.[s.idx]) return;
    const before = this.store.snapshot();
    const rest = { ...n.phShift };
    delete rest[s.idx];
    n.phShift = Object.keys(rest).length ? rest : undefined;
    this.store.commit(before);
    this.store.changed("project");
  }

  draw(): void {
    const { ctx, w, h } = this.hc;
    const v = this.view;
    ctx.fillStyle = cssVar("--pr-bg");
    ctx.fillRect(0, 0, w, h);
    // 半透明の箱の下にピアノロールと同じ縦線を通す（位置関係を見やすくする）
    drawTimeGrid(ctx, v, this.store.project.beatsPerBar, this.snapTicks(), 0, h, w);
    ctx.font = "12px 'Hiragino Sans', sans-serif";
    const top = 8;
    const bh = h - 16;
    // ブレス（音素名 br）: 入れてある所はアクセントカラーの塗り、入れられる所は点線の枠と「+ br」（音素の下に描く）
    for (const b of this.derived().breaths) {
      const x0 = this.secToX(b.start + b.cut);
      const x1 = this.secToX(b.end);
      if (x1 < KEY_W || x0 > w) continue;
      const bw = Math.max(2, x1 - x0 - 1);
      const label = b.index === null ? "+ br" : "br";
      if (b.index === null) {
        ctx.save();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = cssVar("--accent");
        ctx.globalAlpha = 0.7;
        ctx.lineWidth = 1;
        ctx.strokeRect(Math.round(x0) + 0.5, top + 0.5, Math.round(bw), bh - 1);
        ctx.restore();
      } else {
        ctx.fillStyle = cssVar("--accent-soft");
        ctx.fillRect(x0, top, bw, bh);
      }
      // 名前はほかの音素と同じ位置（左上）に
      const tw = ctx.measureText(label).width;
      if (bw > tw + 4) {
        ctx.fillStyle = b.index === null ? cssVar("--accent") : cssVar("--text");
        ctx.fillText(label, x0 + 5, top + 15);
      }
    }
    for (const seg of this.derived().phones) {
      const x0 = this.secToX(seg.start);
      const x1 = this.secToX(seg.end);
      if (x1 < KEY_W || x0 > w) continue;
      ctx.fillStyle = seg.vowel ? cssVar("--ph-vowel") : cssVar("--ph-cons");
      ctx.fillRect(x0, top, Math.max(1, x1 - x0 - 1), bh);
      ctx.fillStyle = seg.movable ? cssVar("--ph-edge") : cssVar("--ph-edge-fixed");
      ctx.fillRect(Math.round(x0), top - 4, seg.movable ? 1 : 2, bh + 8);
      const tw = ctx.measureText(seg.ph).width;
      if (x1 - x0 > tw + 4) {
        ctx.fillStyle = seg.edited ? cssVar("--ph-edited") : cssVar("--text");
        ctx.fillText(seg.ph, x0 + 5, top + 15);
      }
    }
    const px = v.tickToX(this.store.playTick);
    if (px >= KEY_W) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.fillRect(Math.round(px), 0, 1, h);
    }
    ctx.fillStyle = cssVar("--panel");
    ctx.fillRect(0, 0, KEY_W, h);
    ctx.fillStyle = cssVar("--muted");
    ctx.font = "11px 'Hiragino Sans', sans-serif";
    ctx.fillText(t("音素"), 10, h / 2 + 4);
  }
}

interface PanelDef {
  key: string;
  label: string;
  el: HTMLElement;
}

export interface SizeOpts {
  min: () => number; // 縮められる下限（px）
  max?: number;
  onResize?: (h: number) => void; // 高さを変えたあとに呼ぶ（mel の行の高さを覚えるため）
}

export class BottomPanels {
  private defs: PanelDef[] = [];
  constructor(private container: HTMLElement, private tabbar: HTMLElement, private onLayout: () => void) {}

  add(key: string, label: string, el: HTMLElement, open: boolean, size?: SizeOpts): void {
    el.classList.add("bpanel");
    el.hidden = !open;
    if (size) this.addHandle(el, size);
    this.container.appendChild(el);
    this.defs.push({ key, label, el });
    this.renderTabs();
  }

  /** パネルの上の縁をドラッグして高さを変える（上へ引くと高くなる）。 */
  private addHandle(el: HTMLElement, size: SizeOpts): void {
    const handle = document.createElement("div");
    handle.className = "resize-handle";
    handle.title = t("ドラッグで高さを変える");
    el.appendChild(handle);
    let startY = 0;
    let startH = 0;
    handle.addEventListener("pointerdown", (e) => {
      handle.setPointerCapture(e.pointerId);
      startY = e.clientY;
      startH = el.getBoundingClientRect().height;
      handle.classList.add("dragging");
      this.container.style.maxHeight = "calc(100dvh - 300px)"; // 自分で広げるときは、既定の上限を超えてよい
    });
    handle.addEventListener("pointermove", (e) => {
      if (!handle.classList.contains("dragging")) return;
      const h = Math.min(size.max ?? 600, Math.max(size.min(), startH - (e.clientY - startY)));
      el.style.height = `${Math.round(h)}px`;
      size.onResize?.(h);
    });
    handle.addEventListener("pointerup", () => handle.classList.remove("dragging"));
  }

  private renderTabs(): void {
    this.tabbar.innerHTML = "";
    for (const d of this.defs) {
      const b = document.createElement("button");
      b.className = "tab" + (d.el.hidden ? "" : " on");
      b.innerHTML = `<span>${d.label}</span>`;
      b.addEventListener("click", () => {
        d.el.hidden = !d.el.hidden;
        this.renderTabs();
        this.onLayout();
      });
      this.tabbar.appendChild(b);
    }
  }
}
