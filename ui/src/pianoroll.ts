// ピアノロール: 音符・歌詞・音素・ピッチの線を描き、音符の編集と歌詞の入力を受け持つ。
import { cssVar, HiDpiCanvas, requestDraw, roundRect } from "./canvas";
import { pluck } from "./audio";
import type { Derived, PhoneSeg } from "./derive";
import { defaultAttrs, growRegion, isBlackKey, type Note, pitchName, secPerTick, TPQ, trackRegion } from "./model";
import { drawTimeGrid, snapTicksFor } from "./grid";
import { EraseStroke, ensureCurve, PenStroke } from "./params";
import type { Store } from "./store";
import { t } from "./i18n";
import { textOn, trackColor } from "./theme";
import { KEY_W, RULER_H, type View } from "./view";

export type Tool = "select" | "draw" | "pitch";

const NOTE_ALPHA = "c0"; // 選んでいない音符はトラックの色を少し沈める
const BAND_H = 14; // トラックの範囲の帯（目盛りのすぐ下）

const WAVE_H = 64; // 波形の帯の高さ（px）
const WAVE_PAD = 6; // 帯の下の余白（px）
const WAVE_BLOCK = 64; // 波形の振れ幅を先にまとめておく区切り（サンプル。44.1 kHz で約 1.5 ms）

// 波形ごとの、区切りごとの振れ幅の最大（合成し直すと波形の配列が変わるので WeakMap）
const peakCache = new WeakMap<Float32Array, { peaks: Float32Array; max: number }>();
function wavePeaks(wav: Float32Array): { peaks: Float32Array; max: number } {
  let c = peakCache.get(wav);
  if (!c) {
    const peaks = new Float32Array(Math.ceil(wav.length / WAVE_BLOCK));
    let max = 0;
    for (let k = 0; k < peaks.length; k++) {
      let m = 0;
      const end = Math.min(wav.length, (k + 1) * WAVE_BLOCK);
      for (let i = k * WAVE_BLOCK; i < end; i++) m = Math.max(m, Math.abs(wav[i]));
      peaks[k] = m;
      max = Math.max(max, m);
    }
    c = { peaks, max };
    peakCache.set(wav, c);
  }
  return c;
}

type Drag =
  | { kind: "move"; startTick: number; startPitch: number; orig: Map<number, { onset: number; pitch: number }>;
      before: string; moved: boolean; anchor: number; again: boolean }
  | { kind: "key" }
  // connected: 直前の位置から線でつなぐか（声の無い所を通ったら false にして、次は飛ばした所から描き直す）
  | { kind: "pitchpen"; pen: PenStroke | null; eraser: EraseStroke | null; connected: boolean; before: string }
  // again: 小窓が開いている選択中の音符を押した（動かさずに離したら小窓を閉じる）
  | { kind: "resize"; id: number; before: string; moved: boolean; again: boolean }
  | { kind: "create"; id: number; anchor: number; before: string }
  | { kind: "box"; x0: number; y0: number; x1: number; y1: number; base: Set<number> }
  | { kind: "region"; side: "left" | "right"; before: string }
  | { kind: "ruler" };

export class PianoRoll {
  readonly hc: HiDpiCanvas;
  tool: Tool = "select";
  snapSetting = "auto";
  showPitch = true;
  showPhonemes = true;
  showWave = true;
  /** 波形の元（main.ts でつなぐ）: 選んでいるトラックの句ごとの合成済みの波形（エフェクトの前、44.1 kHz）と、その頭の秒 */
  waveSource: () => Array<{ start: number; wav: Float32Array }> = () => [];
  private drag: Drag | null = null;
  private editingId: number | null = null;
  private pressed: number | null = null; // 光らせている鍵盤（音高）
  /** 今の選択の知らせが、すでにある音符のクリックから来たか（音符の小窓はそのときだけ開く）。 */
  clickedNote = false;
  /** 音符の小窓が開いているか・閉じる（main.ts でつなぐ）。開いている音符をもう一度クリックしたら閉じる。 */
  popOpen: () => boolean = () => false;
  closePop: () => void = () => {};

  /** 鍵盤を光らせて短い打鍵音を鳴らす（同じ音高が続くときは鳴らし直さない）。 */
  private press(p: number): void {
    if (p === this.pressed) return;
    this.pressed = p;
    pluck(p);
    this.redraw();
  }

  constructor(private store: Store, private view: View, private derived: () => Derived,
              canvas: HTMLCanvasElement, private input: HTMLInputElement, private hint: (s: string) => void) {
    this.hc = new HiDpiCanvas(canvas, () => this.draw());
    canvas.addEventListener("pointerdown", (e) => { if (!this.touchDown(e)) this.onDown(e); });
    canvas.addEventListener("pointermove", (e) => { if (!this.touchMove(e)) this.onMove(e); });
    canvas.addEventListener("pointerup", (e) => { if (!this.touchUp(e)) this.onUp(); });
    canvas.addEventListener("pointercancel", (e) => { if (!this.touchUp(e)) this.onUp(); });
    canvas.addEventListener("dblclick", (e) => this.onDbl(e));
    canvas.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    canvas.addEventListener("contextmenu", (e) => e.preventDefault());
    input.addEventListener("keydown", (e) => this.onInputKey(e));
    input.addEventListener("blur", () => this.commitLyric(false));
  }

  redraw(): void {
    requestDraw(() => this.draw());
  }

  snapTicks(): number {
    return snapTicksFor(this.snapSetting, this.view.pxPerTick);
  }

  // ── 当たり判定 ─────────────────────────────
  private noteRect(n: Note): { x0: number; x1: number; y0: number; y1: number } {
    const v = this.view;
    return { x0: v.tickToX(n.onset), x1: v.tickToX(n.onset + n.dur), y0: v.pitchToY(n.pitch + 0.5),
             y1: v.pitchToY(n.pitch - 0.5) };
  }

  private hitNote(x: number, y: number): { note: Note; edge: boolean } | null {
    const notes = this.store.track.notes;
    for (let i = notes.length - 1; i >= 0; i--) {
      const r = this.noteRect(notes[i]);
      if (x >= r.x0 && x <= r.x1 && y >= r.y0 && y <= r.y1) {
        return { note: notes[i], edge: x > r.x1 - Math.min(7, (r.x1 - r.x0) / 3) };
      }
    }
    return null;
  }

  /** 音符を描いている間（ドラッグ中）か。音符の小窓はその間は隠す。 */
  get busy(): boolean {
    return this.drag !== null || this.editingId !== null;
  }

  /** 音符の画面の上の位置（音符の小窓を寄せるため）。 */
  noteBox(n: Note): { x0: number; x1: number; y0: number; y1: number } {
    return this.noteRect(n);
  }

  /** 画面のピッチの線の点 [x, y]（x が xa〜xb の所を、約 step px おきに。音符の小窓が線をよけるため）。 */
  pitchPoints(xa: number, xb: number, step = 3): Array<[number, number]> {
    if (!this.showPitch) return [];
    const der = this.derived();
    const v = this.view;
    const spt = secPerTick(this.store.project.bpm);
    const i0 = Math.max(0, Math.floor(v.xToTick(xa) * spt * der.fps));
    const i1 = Math.min(der.pitch.length, Math.ceil(v.xToTick(xb) * spt * der.fps) + 1);
    const di = Math.max(1, Math.floor(step / (v.pxPerTick / spt / der.fps)));
    const out: Array<[number, number]> = [];
    for (let i = i0; i < i1; i += di) {
      const val = der.pitch[i];
      if (!Number.isNaN(val)) out.push([v.tickToX(i / der.fps / spt), v.pitchToY(val)]);
    }
    return out;
  }

  /** トラックの範囲の左右の端（ドラッグで範囲を変えられる所）。 */
  private regionEdge(x: number, y: number): "left" | "right" | null {
    if (y < RULER_H || x < KEY_W) return null;
    const r = trackRegion(this.store.track, this.store.project.beatsPerBar);
    if (Math.abs(x - this.view.tickToX(r.end)) <= 5) return "right";
    if (Math.abs(x - this.view.tickToX(r.start)) <= 5) return "left";
    return null;
  }

  // ── 操作 ─────────────────────────────────
  /** ピッチのペン: マウスの高さにピッチの線を合わせるための「ピッチのずれ」（セント）。声の無い所は null。 */
  private devAt(x: number, y: number): { t: number; v: number } | null {
    const t = this.view.xToTick(x);
    const der = this.derived();
    const i = Math.round(t * secPerTick(this.store.project.bpm) * der.fps);
    if (i < 0 || i >= der.noDev.length || Number.isNaN(der.noDev[i])) return null;
    return { t, v: Math.max(-1200, Math.min(1200, (this.view.yToPitch(y) - der.noDev[i]) * 100)) };
  }

  private onDown(e: PointerEvent): void {
    if (this.tool === "pitch" && e.button === 2 && e.offsetX > KEY_W && e.offsetY > RULER_H) {
      (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
      const before = this.store.snapshot();
      const eraser = new EraseStroke(ensureCurve(this.store.track.params, "pitchDelta"), 0);
      eraser.add(this.view.xToTick(e.offsetX));
      this.drag = { kind: "pitchpen", pen: null, eraser, connected: false, before };
      this.store.changed("project");
      return;
    }
    if (e.button !== 0) return;
    if (this.editingId !== null) this.commitLyric(false);
    const x = e.offsetX;
    const y = e.offsetY;
    (e.currentTarget as HTMLCanvasElement).setPointerCapture(e.pointerId);
    const s = this.store;
    if (y < RULER_H) {
      if (x > KEY_W) {
        this.drag = { kind: "ruler" };
        this.setPlayhead(x);
      }
      return;
    }
    if (x < KEY_W) {
      this.drag = { kind: "key" };
      this.press(Math.round(this.view.yToPitch(y)));
      return;
    }
    if (this.tool === "pitch") {
      const before = s.snapshot();
      const pen = new PenStroke(ensureCurve(s.track.params, "pitchDelta"), 0, 3 / this.view.pxPerTick);
      this.drag = { kind: "pitchpen", pen, eraser: null, connected: false, before };
      const p = this.devAt(x, y);
      if (p) this.penTo(p.t, p.v);
      return;
    }
    const hit = this.hitNote(x, y);
    const edge = hit ? null : this.regionEdge(x, y);
    if (edge) {
      this.drag = { kind: "region", side: edge, before: s.snapshot() };
      return;
    }
    if (hit) {
      const id = hit.note.id;
      const again = !e.shiftKey && s.selected.has(id) && this.popOpen();
      this.press(hit.note.pitch);
      if (e.shiftKey) {
        if (s.selected.has(id)) s.selected.delete(id);
        else s.selected.add(id);
      } else if (!s.selected.has(id)) {
        s.selected.clear();
        s.selected.add(id);
      }
      this.clickedNote = true;
      s.changed("selection");
      this.clickedNote = false;
      const before = s.snapshot();
      if (hit.edge) {
        this.drag = { kind: "resize", id, before, moved: false, again };
        return;
      }
      const orig = new Map<number, { onset: number; pitch: number }>();
      for (const n of s.track.notes) if (s.selected.has(n.id)) orig.set(n.id, { onset: n.onset, pitch: n.pitch });
      this.drag = { kind: "move", startTick: this.view.xToTick(x), startPitch: this.view.yToPitch(y), orig, before,
                    moved: false, anchor: id, again };
      return;
    }
    if (this.tool === "draw") {
      const before = s.snapshot();
      const d = this.snapTicks();
      const onset = Math.max(0, Math.floor(this.view.xToTick(x) / d) * d);
      const note: Note = { id: s.nextId(), onset, dur: Math.max(d, 120), pitch: Math.round(this.view.yToPitch(y)),
                           lyric: "ら", attrs: defaultAttrs() };
      s.track.notes.push(note);
      growRegion(s.track, note, s.project.beatsPerBar); // 範囲の外に描いたら範囲を広げる
      s.selected.clear();
      s.selected.add(note.id);
      this.press(note.pitch);
      this.drag = { kind: "create", id: note.id, anchor: onset, before };
      s.changed("project");
      return;
    }
    const base = e.shiftKey ? new Set(s.selected) : new Set<number>();
    if (!e.shiftKey && s.selected.size) {
      s.selected.clear();
      s.changed("selection");
    }
    this.drag = { kind: "box", x0: x, y0: y, x1: x, y1: y, base };
  }

  private onMove(e: PointerEvent): void {
    const x = e.offsetX;
    const y = e.offsetY;
    const d = this.drag;
    const s = this.store;
    if (!d) {
      this.updateHover(x, y);
      return;
    }
    const snap = this.snapTicks();
    switch (d.kind) {
      case "ruler":
        this.setPlayhead(x);
        break;
      case "key":
        this.press(Math.round(this.view.yToPitch(y)));
        break;
      case "pitchpen": {
        if (d.eraser) {
          d.eraser.add(this.view.xToTick(x));
          s.changed("project");
          break;
        }
        const p = this.devAt(x, y);
        if (p) this.penTo(p.t, p.v);
        else d.connected = false; // 声の無い所は飛ばす（次に声のある所から描き直す）
        break;
      }
      case "move": {
        const dt = Math.round((this.view.xToTick(x) - d.startTick) / snap) * snap;
        const dp = Math.round(this.view.yToPitch(y) - d.startPitch);
        if (dt === 0 && dp === 0 && !d.moved) return;
        d.moved = true;
        const minOnset = Math.min(...[...d.orig.values()].map((o) => o.onset));
        const dtc = Math.max(dt, -minOnset);
        for (const n of s.track.notes) {
          const o = d.orig.get(n.id);
          if (!o) continue;
          n.onset = o.onset + dtc;
          n.pitch = Math.min(108, Math.max(24, o.pitch + dp));
        }
        const a = d.orig.get(d.anchor);
        if (a) this.press(Math.min(108, Math.max(24, a.pitch + dp)));
        s.changed("project");
        break;
      }
      case "resize": {
        const n = s.track.notes.find((q) => q.id === d.id);
        if (!n) return;
        const end = Math.round(this.view.xToTick(x) / snap) * snap;
        const dur = Math.max(Math.max(snap, 30), end - n.onset);
        if (dur === n.dur) return;
        n.dur = dur;
        d.moved = true;
        s.changed("project");
        break;
      }
      case "create": {
        const n = s.track.notes.find((q) => q.id === d.id);
        if (!n) return;
        const end = Math.round(this.view.xToTick(x) / snap) * snap;
        n.dur = Math.max(Math.max(snap, 30), end - d.anchor);
        growRegion(s.track, n, s.project.beatsPerBar);
        s.changed("project");
        break;
      }
      case "region": {
        // トラックの範囲の端: 拍に吸着（⌥ で吸着なし）。中身は動かさない
        const r = trackRegion(s.track, s.project.beatsPerBar);
        const g = e.altKey ? 1 : TPQ;
        const tk = Math.round(this.view.xToTick(x) / g) * g;
        s.track.region = d.side === "right" ? { start: r.start, end: Math.max(tk, r.start + TPQ) }
          : { start: Math.max(0, Math.min(tk, r.end - TPQ)), end: r.end };
        s.changed("project");
        break;
      }
      case "box": {
        d.x1 = x;
        d.y1 = y;
        const [bx0, bx1] = [Math.min(d.x0, x), Math.max(d.x0, x)];
        const [by0, by1] = [Math.min(d.y0, y), Math.max(d.y0, y)];
        s.selected = new Set(d.base);
        for (const n of s.track.notes) {
          const r = this.noteRect(n);
          if (r.x1 >= bx0 && r.x0 <= bx1 && r.y1 >= by0 && r.y0 <= by1) s.selected.add(n.id);
        }
        s.changed("selection");
        break;
      }
    }
  }

  private onUp(): void {
    const d = this.drag;
    this.drag = null;
    this.pressed = null;
    if (d && (d.kind === "move" || d.kind === "resize" || d.kind === "create" || d.kind === "pitchpen" ||
              d.kind === "region")) {
      const c = this.store.track.params.pitchDelta;
      if (c && c.pts.length === 0) delete this.store.track.params.pitchDelta;
      this.store.commit(d.before);
    }
    if ((d?.kind === "move" || d?.kind === "resize") && d.again && !d.moved) this.closePop();
    this.redraw();
  }

  /** ピッチのペン: 一筆の範囲だけを書き換える（外側の曲線は描き始めの前のまま。params.ts の PenStroke）。 */
  private penTo(t: number, v: number): void {
    const d = this.drag;
    if (d?.kind !== "pitchpen" || !d.pen) return;
    d.pen.add(t, v, d.connected);
    d.connected = true;
    this.store.changed("project");
  }

  private onDbl(e: MouseEvent): void {
    const hit = this.hitNote(e.offsetX, e.offsetY);
    if (hit) this.startLyricEdit(hit.note);
  }

  // ── タッチ（スマートフォン）: 1 本指はふだんの道具。2 本指でドラッグするとスクロール、つまむと横の拡大縮小。
  // 音符をダブルタップすると歌詞。2 本目の指が来たら、1 本目で始めた編集は取り消す ─────────
  private touches = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; mx: number; my: number } | null = null;
  private lastTap = { t: 0, x: 0, y: 0 };

  private pinchState(): { dist: number; mx: number; my: number } {
    const [a, b] = [...this.touches.values()];
    return { dist: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }

  /** true = タッチの操作としてここで扱った（ふだんの onDown は呼ばない） */
  private touchDown(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    this.touches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (this.touches.size >= 2) {
      if (!this.pinch) {
        const d = this.drag;
        if (d && "before" in d) {
          this.store.project = JSON.parse(d.before);
          this.store.changed("project");
        }
        this.drag = null;
        this.pressed = null;
        this.clickedNote = false;
        this.closePop();               // 1 本目の指が音符に触れて開いた小窓も閉じる
      }
      this.pinch = this.pinchState();   // 指を置き直したときも、今の 2 本から測り直す
      return true;
    }
    const now = performance.now();
    if (now - this.lastTap.t < 320 && Math.hypot(e.offsetX - this.lastTap.x, e.offsetY - this.lastTap.y) < 24) {
      const hit = this.hitNote(e.offsetX, e.offsetY);
      if (hit) {
        this.lastTap.t = 0;
        this.startLyricEdit(hit.note);
        return true;
      }
    }
    this.lastTap = { t: now, x: e.offsetX, y: e.offsetY };
    return false;
  }

  private touchMove(e: PointerEvent): boolean {
    if (e.pointerType !== "touch" || !this.touches.has(e.pointerId)) return false;
    this.touches.set(e.pointerId, { x: e.offsetX, y: e.offsetY });
    if (!this.pinch) return false;
    if (this.touches.size < 2) return true;
    const p = this.pinchState();
    const v = this.view;
    v.scrollBy(-(p.mx - this.pinch.mx) / v.pxPerTick, (p.my - this.pinch.my) / v.pxPerSemi);
    v.zoomX(p.dist / this.pinch.dist, Math.max(KEY_W, p.mx));
    this.pinch = p;
    return true;
  }

  private touchUp(e: PointerEvent): boolean {
    if (e.pointerType !== "touch") return false;
    this.touches.delete(e.pointerId);
    if (!this.pinch) return false;
    if (this.touches.size === 0) this.pinch = null;
    return true;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const v = this.view;
    if (e.ctrlKey || e.metaKey) {
      v.zoomX(Math.exp(-e.deltaY * 0.003), Math.max(KEY_W, e.offsetX));
      return;
    }
    if (e.altKey) {
      v.zoomY(Math.exp(-e.deltaY * 0.003), e.offsetY);
      return;
    }
    const dx = e.shiftKey ? e.deltaY : e.deltaX;
    const dy = e.shiftKey ? 0 : e.deltaY;
    v.scrollBy(dx / v.pxPerTick, -dy / v.pxPerSemi);
  }

  private setPlayhead(x: number): void {
    this.store.playTick = Math.max(0, this.view.xToTick(x));
    this.store.changed("playhead");
  }

  private updateHover(x: number, y: number): void {
    const c = this.hc.canvas;
    if (y < RULER_H) {
      c.style.cursor = "pointer";
      this.hint(t("クリック・ドラッグ: 再生位置を移動"));
      return;
    }
    if (this.tool === "pitch" && x > KEY_W) {
      c.style.cursor = "crosshair";
      this.hint(t("ドラッグ: ピッチの線を描く（ピッチのずれに書き込む）　右ドラッグ: 消去して元に戻す"));
      return;
    }
    const hit = x > KEY_W ? this.hitNote(x, y) : null;
    if (!hit && this.regionEdge(x, y)) {
      c.style.cursor = "ew-resize";
      this.hint(t("ドラッグ: トラックの範囲を変更（範囲の外の音符は歌わない、端をまたぐ音符は端で切れる）　⌥: スナップしない"));
      return;
    }
    if (hit) {
      c.style.cursor = hit.edge ? "ew-resize" : "move";
      this.hint(hit.edge ? t("ドラッグ: 長さを変更") : t("ドラッグ: 移動（Shift で選択に追加）　ダブルクリック: 歌詞を入力"));
      return;
    }
    c.style.cursor = this.tool === "draw" ? "crosshair" : "default";
    this.hint(this.tool === "draw" ? t("ドラッグ: 音符を描く") :
      t("ドラッグ: 範囲選択　ホイール: 上下　Shift+ホイール: 左右　⌘+ホイール: 横の拡大　⌥+ホイール: 縦の拡大"));
  }

  // ── 歌詞の入力 ─────────────────────────────
  startLyricEdit(n: Note): void {
    const r = this.noteRect(n);
    this.editingId = n.id;
    Object.assign(this.input.style, {
      left: `${Math.max(KEY_W, r.x0)}px`, top: `${r.y0 - 3}px`, width: `${Math.max(72, r.x1 - r.x0)}px`,
      height: `${this.view.pxPerSemi + 6}px`,
    });
    this.input.value = n.lyric;
    this.input.hidden = false;
    this.input.focus();
    this.input.select();
  }

  private commitLyric(moveNext: boolean): void {
    if (this.editingId === null) return;
    const id = this.editingId;
    this.editingId = null;
    const text = this.input.value.trim();
    this.input.hidden = true;
    const s = this.store;
    const sorted = [...s.track.notes].sort((a, b) => a.onset - b.onset);
    const idx = sorted.findIndex((n) => n.id === id);
    if (idx < 0) return;
    // かなをスペースで区切ると続く音符に振り分ける。英字だけなら音素の直書きとしてそのまま
    const words = /^[\x00-\x7f]*$/.test(text) ? [text] : text.split(/\s+/).filter(Boolean);
    const before = s.snapshot();
    words.forEach((w, k) => {
      if (sorted[idx + k] && w) sorted[idx + k].lyric = w;
    });
    s.commit(before);
    s.changed("project");
    if (moveNext) {
      const nx = sorted[idx + Math.max(1, words.length)];
      if (nx) {
        s.selected = new Set([nx.id]);
        s.changed("selection");
        this.startLyricEdit(nx);
      }
    }
  }

  private onInputKey(e: KeyboardEvent): void {
    e.stopPropagation();
    if (e.key === "Enter" && !e.isComposing) this.commitLyric(false);
    else if (e.key === "Tab") {
      e.preventDefault();
      this.commitLyric(true);
    } else if (e.key === "Escape") {
      this.editingId = null;
      this.input.hidden = true;
    }
  }

  // ── 描画 ─────────────────────────────────
  /**
   * 波形: 句ごとの合成済みの波形（エフェクトの前）を、窓の下端の帯に真ん中から上下へ描く。
   * 縦は絶対値: 振幅 1.0（0 dBFS）を帯の高さに合わせる（トラックや曲を替えても大きさを比べられる）。
   */
  private drawWave(ctx: CanvasRenderingContext2D, w: number, h: number, bpm: number): void {
    const src = this.waveSource();
    if (!src.length) return;
    const v = this.view;
    const spt = secPerTick(bpm);
    const sr = 44100;
    const bottom = h - WAVE_PAD;
    const mid = bottom - WAVE_H / 2;
    const parts = src.map((s) => ({ ...s, pk: wavePeaks(s.wav) }));
    const ref = 1.0; // 0 dBFS
    // 帯の地（上端をぼかして、下ほど少し暗く）
    const g = ctx.createLinearGradient(0, bottom - WAVE_H - 16, 0, h);
    g.addColorStop(0, "rgba(0,0,0,0)");
    g.addColorStop(1, "rgba(0,0,0,0.35)");
    ctx.fillStyle = g;
    ctx.fillRect(KEY_W, bottom - WAVE_H - 16, w - KEY_W, h - (bottom - WAVE_H - 16));
    ctx.fillStyle = cssVar("--accent");
    ctx.globalAlpha = 0.42;
    for (const q of parts) {
      const xa = Math.max(KEY_W, Math.floor(v.tickToX(q.start / spt)));
      const xb = Math.min(w, Math.ceil(v.tickToX((q.start + q.wav.length / sr) / spt)));
      const n = q.pk.peaks.length;
      for (let x = xa; x < xb; x++) {
        const a0 = Math.floor(((v.xToTick(x) * spt - q.start) * sr) / WAVE_BLOCK);
        const a1 = Math.ceil(((v.xToTick(x + 1) * spt - q.start) * sr) / WAVE_BLOCK);
        let m = 0;
        for (let k = Math.max(0, a0); k < Math.min(n, Math.max(a1, a0 + 1)); k++) m = Math.max(m, q.pk.peaks[k]);
        if (m < 0.002) continue;
        const a = Math.min(1, m / ref) * (WAVE_H / 2);
        ctx.fillRect(x, mid - a, 1, 2 * a);
      }
    }
    ctx.globalAlpha = 0.25;
    ctx.fillRect(KEY_W, Math.round(mid), w - KEY_W, 1);
    ctx.globalAlpha = 1;
  }

  draw(): void {
    const { ctx, w, h } = this.hc;
    const v = this.view;
    const s = this.store;
    const p = s.project;
    const track = s.track;
    ctx.fillStyle = cssVar("--pr-bg");
    ctx.fillRect(0, 0, w, h);

    // 行（黒鍵の行は暗く）
    const pHi = Math.ceil(v.topPitch) + 1;
    const pLo = Math.floor(v.yToPitch(h)) - 1;
    for (let pp = pLo; pp <= pHi; pp++) {
      const y0 = v.pitchToY(pp + 0.5);
      ctx.fillStyle = isBlackKey(pp) ? cssVar("--pr-row-black") : cssVar("--pr-row-white");
      ctx.fillRect(KEY_W, y0, w - KEY_W, v.pxPerSemi);
      if (((pp % 12) + 12) % 12 === 0) {
        ctx.fillStyle = cssVar("--pr-octave");
        ctx.fillRect(KEY_W, Math.round(v.pitchToY(pp - 0.5)) - 1, w - KEY_W, 1);
      }
    }

    // 縦の線（小節・拍・スナップ）
    const t0 = v.xToTick(KEY_W);
    const t1 = v.xToTick(w);
    const bar = p.beatsPerBar * TPQ;
    drawTimeGrid(ctx, v, p.beatsPerBar, this.snapTicks(), RULER_H, h, w);

    const region = trackRegion(track, p.beatsPerBar);
    const rx0 = v.tickToX(region.start);
    const rx1 = v.tickToX(region.end);

    // 他のトラックの音符（そのトラックの色の、薄い細い帯）
    for (const t of p.tracks) {
      if (t === track) continue;
      ctx.fillStyle = trackColor(p, t) + "66";
      for (const n of t.notes) {
        const x0 = v.tickToX(n.onset);
        const x1 = v.tickToX(n.onset + n.dur);
        if (x1 < KEY_W || x0 > w) continue;
        ctx.fillRect(x0, v.pitchToY(n.pitch) - 1.5, x1 - x0, 3);
      }
    }
    const col = trackColor(p, track);
    const ink = textOn(col);

    // 選んでいるトラックの声の波形（下端に固定・半透明。音符より奥に描き、当たり判定は持たない）
    if (this.showWave) this.drawWave(ctx, w, h, p.bpm);

    // 音符・歌詞・音素
    const der = this.derived();
    const phonesByNote = new Map<number, PhoneSeg[]>();
    for (const ph of der.phones) {
      const a = phonesByNote.get(ph.noteId);
      if (a) a.push(ph);
      else phonesByNote.set(ph.noteId, [ph]);
    }
    for (const n of track.notes) {
      const r = this.noteRect(n);
      if (r.x1 < KEY_W || r.x0 > w || r.y1 < RULER_H || r.y0 > h) continue;
      const sel = s.selected.has(n.id);
      ctx.fillStyle = col + (sel ? "" : NOTE_ALPHA);
      roundRect(ctx, r.x0 + 0.5, r.y0 + 1, Math.max(3, r.x1 - r.x0 - 1), v.pxPerSemi - 2, 4);
      ctx.fill();
      if (sel) {
        ctx.strokeStyle = cssVar("--note-sel");
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (this.showPhonemes) {
        const phs = phonesByNote.get(n.id);
        if (phs && phs.length) {
          ctx.fillStyle = phs.some((q) => q.edited) ? cssVar("--ph-edited") : cssVar("--phoneme-text");
          ctx.font = "11px 'Hiragino Sans', sans-serif";
          ctx.fillText(phs.map((q) => q.ph).join(" "), r.x0 + 2, r.y0 - 4);
        }
      }
    }

    // ピッチの線
    if (this.showPitch) {
      const spt = secPerTick(p.bpm);
      const i0 = Math.max(0, Math.floor(t0 * spt * der.fps) - 1);
      const i1 = Math.min(der.pitch.length, Math.ceil(t1 * spt * der.fps) + 2);
      ctx.beginPath();
      let pen = false;
      for (let i = i0; i < i1; i++) {
        const val = der.pitch[i];
        if (Number.isNaN(val)) {
          pen = false;
          continue;
        }
        const x = v.tickToX(i / der.fps / spt);
        const y = v.pitchToY(val);
        if (pen) ctx.lineTo(x, y);
        else ctx.moveTo(x, y);
        pen = true;
      }
      ctx.strokeStyle = cssVar("--pitch");
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // 歌詞（ピッチの線より上に描いて読めるようにする）
    ctx.font = `${Math.min(13, v.pxPerSemi - 4)}px 'Hiragino Sans', sans-serif`;
    for (const n of track.notes) {
      const r = this.noteRect(n);
      if (r.x1 < KEY_W || r.x0 > w || r.y1 < RULER_H || r.y0 > h) continue;
      const tw = Math.min(ctx.measureText(n.lyric).width + 6, r.x1 - r.x0 - 2);
      ctx.fillStyle = col + (s.selected.has(n.id) ? "" : NOTE_ALPHA);
      ctx.fillRect(r.x0 + 2, r.y0 + 3, Math.max(0, tw), v.pxPerSemi - 6);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x0, r.y0, r.x1 - r.x0, v.pxPerSemi);
      ctx.clip();
      ctx.fillStyle = ink;
      ctx.fillText(n.lyric, r.x0 + 5, r.y0 + v.pxPerSemi / 2 + 4.5);
      ctx.restore();
    }

    // トラックの範囲: 外は暗くし（そこにある音符は歌わない）、目盛りのすぐ下の細い帯に範囲を出す。
    // 帯の左右の端に細い縦線を通して、ピアノロールの中でも範囲の端が分かるようにする
    ctx.fillStyle = cssVar("--outside");
    if (rx0 > KEY_W) ctx.fillRect(KEY_W, RULER_H, Math.min(rx0, w) - KEY_W, h - RULER_H);
    if (rx1 < w) ctx.fillRect(Math.max(KEY_W, rx1), RULER_H, w - Math.max(KEY_W, rx1), h - RULER_H);
    ctx.save();
    ctx.beginPath();
    ctx.rect(KEY_W, RULER_H, w - KEY_W, h - RULER_H);
    ctx.clip();
    ctx.fillStyle = cssVar("--band-bg");
    ctx.fillRect(KEY_W, RULER_H, w - KEY_W, BAND_H);
    ctx.fillStyle = col + "40";
    roundRect(ctx, rx0, RULER_H + 2, Math.max(0, rx1 - rx0), BAND_H - 4, 4);
    ctx.fill();
    ctx.fillStyle = col;
    ctx.fillRect(rx0, RULER_H + 2, 2, BAND_H - 4);
    ctx.fillRect(rx1 - 2, RULER_H + 2, 2, BAND_H - 4);
    ctx.fillStyle = col + "55";
    ctx.fillRect(Math.round(rx0), RULER_H + BAND_H, 1, h - RULER_H - BAND_H);
    ctx.fillRect(Math.round(rx1) - 1, RULER_H + BAND_H, 1, h - RULER_H - BAND_H);
    ctx.font = "600 10px 'Hiragino Sans', sans-serif";
    ctx.fillStyle = cssVar("--text");
    ctx.fillText(track.name, Math.max(rx0, KEY_W) + 8, RULER_H + BAND_H - 3.5);
    ctx.restore();

    // 範囲選択の枠
    if (this.drag?.kind === "box") {
      const d = this.drag;
      ctx.fillStyle = cssVar("--accent-faint");
      ctx.strokeStyle = cssVar("--accent");
      ctx.lineWidth = 1;
      ctx.fillRect(Math.min(d.x0, d.x1), Math.min(d.y0, d.y1), Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
      ctx.strokeRect(Math.min(d.x0, d.x1) + 0.5, Math.min(d.y0, d.y1) + 0.5, Math.abs(d.x1 - d.x0),
                     Math.abs(d.y1 - d.y0));
    }

    // 再生位置
    const px = v.tickToX(s.playTick);
    if (px >= KEY_W && px <= w) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.fillRect(Math.round(px), RULER_H, 1, h - RULER_H);
    }

    this.drawKeyboard(pLo, pHi);
    this.drawRuler(t0, t1, bar, px);
  }

  private drawKeyboard(pLo: number, pHi: number): void {
    const { ctx, h } = this.hc;
    const v = this.view;
    ctx.fillStyle = cssVar("--key-gap");
    ctx.fillRect(0, RULER_H, KEY_W, h - RULER_H);
    // 白鍵: 1 オクターブ（12 行）を 7 等分した高さで描き、境目に隙間を空けて境界を見せる
    const WHITE_IDX = [0, -1, 1, -1, 2, 3, -1, 4, -1, 5, -1, 6];
    const pr = this.pressed;
    const pressedWhite = pr !== null && WHITE_IDX[((pr % 12) + 12) % 12] >= 0
      ? [Math.floor(pr / 12), WHITE_IDX[((pr % 12) + 12) % 12]] : null;
    const W = KEY_W - 4;
    ctx.font = "10px 'Hiragino Sans', sans-serif";
    ctx.textAlign = "right";
    for (let o = Math.floor(pLo / 12) - 1; o <= Math.floor(pHi / 12) + 1; o++) {
      for (let i = 0; i < 7; i++) {
        const yTop = v.pitchToY(o * 12 - 0.5 + ((i + 1) * 12) / 7);
        const yBot = v.pitchToY(o * 12 - 0.5 + (i * 12) / 7);
        if (yBot < RULER_H || yTop > h) continue;
        const lit = pressedWhite !== null && pressedWhite[0] === o && pressedWhite[1] === i;
        ctx.fillStyle = lit ? cssVar("--accent") : cssVar("--key-white");
        roundRect(ctx, -4, yTop + 0.75, W + 4, yBot - yTop - 1.5, 4);
        ctx.fill();
        if (i === 0) {
          ctx.fillStyle = cssVar("--key-text");
          ctx.fillText(pitchName(o * 12), W - 4, yBot - 5);
        }
      }
    }
    ctx.textAlign = "left";
    // 黒鍵（白鍵の上に重ねる）
    for (let pp = pLo; pp <= pHi; pp++) {
      if (!isBlackKey(pp)) continue;
      ctx.fillStyle = pp === pr ? cssVar("--accent") : cssVar("--key-black");
      roundRect(ctx, -4, v.pitchToY(pp + 0.5) + 0.5, KEY_W * 0.6 + 4, v.pxPerSemi - 1, 4);
      ctx.fill();
    }
    ctx.fillStyle = cssVar("--line");
    ctx.fillRect(KEY_W - 1, RULER_H, 1, h - RULER_H);
  }

  private drawRuler(t0: number, t1: number, bar: number, px: number): void {
    const { ctx, w } = this.hc;
    const v = this.view;
    ctx.fillStyle = cssVar("--ruler-bg");
    ctx.fillRect(0, 0, w, RULER_H);
    ctx.font = "11px 'Hiragino Sans', sans-serif";
    for (let t = Math.floor(t0 / TPQ) * TPQ; t <= t1; t += TPQ) {
      const x = Math.round(v.tickToX(t));
      if (x < KEY_W) continue;
      if (t % bar === 0) {
        ctx.fillStyle = cssVar("--ruler-text");
        ctx.fillRect(x, 6, 1, RULER_H - 6);
        ctx.fillText(String(t / bar + 1), x + 4, 15);
      } else {
        ctx.fillStyle = cssVar("--grid-bar");
        ctx.fillRect(x, RULER_H - 6, 1, 6);
      }
    }
    if (px >= KEY_W && px <= w) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.beginPath();
      ctx.moveTo(px - 5, RULER_H - 9);
      ctx.lineTo(px + 5, RULER_H - 9);
      ctx.lineTo(px, RULER_H);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = cssVar("--panel");
    ctx.fillRect(0, 0, KEY_W, RULER_H);
    ctx.fillStyle = cssVar("--line");
    ctx.fillRect(0, RULER_H - 1, w, 1);
  }
}
