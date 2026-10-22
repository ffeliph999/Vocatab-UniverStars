// 曲の地図と、左の帯のトラックの一覧。
// 地図: ピアノロールの上の細い欄に、曲全体のトラックの範囲の箱と、ピアノロールで見えている範囲の枠を描く。
// 箱をドラッグすると、範囲・音符・パラメータの曲線をまとめて動かす。箱の左右の端をドラッグすると範囲だけを変える。
// 一覧: 左の帯に、トラックごとの名前・音量とパンのつまみ・消音とソロ。「＋」で歌のトラックか伴奏のトラック（音声ファイル）を足す。
// 表示: ホイールで上下、Shift+ホイール（トラックパッドの横の動き）で左右、⌘/Ctrl+ホイール（ピンチ）で時間方向の拡大縮小。
import { type AudioEntry, audioPeaks, isAudioFile, loadAudioFile, PEAK_RATE } from "./audiofiles";
import { cssVar, HiDpiCanvas, requestDraw, roundRect } from "./canvas";
import { t as tr } from "./i18n";
import { knob } from "./knob";
import {
  type AudioRef, type Curve, defaultBase, isAudioTrack, type ParamKey, type Region, secPerTick, type Track, TPQ,
  trackRegion,
} from "./model";
import type { Store } from "./store";
import { trackColor } from "./theme";
import type { View } from "./view";

const HEAD = 16;
const LANE = 26;
const SB = 6; // 下の横のスクロールバーの高さ
const EDGE = 6; // 箱の端をつかめる幅（画素）

type Grab = "move" | "left" | "right";
type RegionDrag = { kind: "region"; grab: Grab; track: Track; x0: number; before: string; region: Region;
                    onsets: Map<number, number>; curves: Partial<Record<ParamKey, Curve>>; audio?: AudioRef;
                    moved: boolean };
type ArrDrag = { kind: "ruler" } | { kind: "view" } | { kind: "hbar"; x0: number; t0: number } | RegionDrag;

/** トラックの中身（音符・パラメータの曲線・範囲）を dt 刻みだけ動かす。元の値から作り直す。 */
function placeTrack(d: RegionDrag, dt: number): void {
  const t = d.track;
  t.region = { start: d.region.start + dt, end: d.region.end + dt };
  for (const n of t.notes) n.onset = (d.onsets.get(n.id) ?? n.onset) + dt;
  for (const [k, c] of Object.entries(d.curves) as Array<[ParamKey, Curve]>) {
    t.params[k] = { interp: c.interp, pts: c.pts.map(([tk, v]) => [tk + dt, v] as [number, number]) };
  }
}

export class Arrangement {
  readonly hc: HiDpiCanvas;
  private drag: ArrDrag | null = null;
  private scrollY = 0; // トラックが多いときの上下のスクロール（画素）
  private x0 = 0; // 左端の刻み
  private pxPerTick = 0; // 0 = まだ決めていない（初めて描くときに曲全体が収まるようにする）
  private rows: HTMLElement;
  private body: HTMLElement; // 地図の欄（高さを変える）
  private menu: HTMLElement | null = null;
  private filePick: HTMLInputElement;

  constructor(private store: Store, private view: View, list: HTMLElement, canvas: HTMLCanvasElement,
              private visibleTicks: () => number, private hint: (s: string) => void = () => undefined,
              addButton?: HTMLElement, resizer?: HTMLElement) {
    this.hc = new HiDpiCanvas(canvas, () => this.draw());
    this.body = canvas.parentElement!;
    // 一覧は左の帯の中で、トラックが多ければそれだけでスクロールする（地図の行とは揃えない）
    this.rows = list;
    // 音声ファイルを選ぶ（伴奏のトラック）
    this.filePick = document.createElement("input");
    this.filePick.type = "file";
    this.filePick.accept = "audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff";
    this.filePick.hidden = true;
    document.body.appendChild(this.filePick);
    this.filePick.addEventListener("change", () => {
      const f = this.filePick.files?.[0];
      this.filePick.value = "";
      if (f) void this.addAudioTrack(f, this.barAtPlayhead());
    });
    addButton?.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.menu) this.closeMenu();
      else this.openMenu(addButton.getBoundingClientRect(), [
        [tr("歌のトラック"), tr("音符を描いて歌わせる"), () => this.addVocalTrack()],
        [tr("伴奏のトラック"), tr("音声ファイルを選ぶ（画面に落としても足せる）"), () => this.filePick.click()],
      ]);
    });
    if (resizer) this.hookResizer(resizer);

    canvas.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      canvas.setPointerCapture(e.pointerId);
      if (e.offsetY < HEAD) {
        // 目盛りの所: 再生位置を動かす
        this.drag = { kind: "ruler" };
        this.setPlayhead(e.offsetX);
        return;
      }
      if (e.offsetY > this.hc.h - SB) {
        // 下のスクロールバー: つかんで左右に動かす（つまみの外なら、そこへ跳ぶ）
        const { a, b } = this.hbar();
        if (e.offsetX < a || e.offsetX > b) this.setX0(this.x0 + ((e.offsetX - (a + b) / 2) / this.hc.w) * this.extent());
        this.drag = { kind: "hbar", x0: e.offsetX, t0: this.x0 };
        return;
      }
      const lane = this.laneAt(e.offsetY);
      const tracks = this.store.project.tracks;
      if (lane >= 0 && lane < tracks.length) this.activate(lane);
      const hit = this.hitBox(e.offsetX, e.offsetY);
      if (hit) {
        const t = hit.track;
        this.drag = {
          kind: "region", grab: hit.grab, track: t, x0: e.offsetX, before: this.store.snapshot(),
          region: { ...trackRegion(t, this.store.project.beatsPerBar) },
          onsets: new Map(t.notes.map((n) => [n.id, n.onset])),
          curves: JSON.parse(JSON.stringify(t.params)) as Partial<Record<ParamKey, Curve>>,
          audio: t.audio ? { ...t.audio } : undefined, moved: false,
        };
        return;
      }
      // 箱の外: ピアノロールで見る所を動かす
      this.drag = { kind: "view" };
      this.scrollTo(e.offsetX);
    });
    canvas.addEventListener("pointermove", (e) => {
      const d = this.drag;
      if (d?.kind === "ruler") this.setPlayhead(e.offsetX);
      else if (d?.kind === "view") this.scrollTo(e.offsetX);
      else if (d?.kind === "hbar") this.setX0(d.t0 + ((e.offsetX - d.x0) / this.hc.w) * this.extent());
      else if (d?.kind === "region") this.dragRegion(d, e);
      else this.hover(e.offsetX, e.offsetY);
    });
    canvas.addEventListener("pointerup", () => {
      const d = this.drag;
      this.drag = null;
      if (d?.kind === "region" && d.moved) this.store.commit(d.before);
    });
    canvas.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const t = this.store.project.tracks[this.laneAt(e.offsetY)];
      if (t && e.offsetY >= HEAD) this.trackMenu(t, e.clientX, e.clientY);
    });
    // ホイール: 上下（トラック）、Shift か横の動きで左右、⌘/Ctrl（トラックパッドのピンチを含む）で拡大縮小
    canvas.addEventListener("wheel", (e) => {
      e.preventDefault();
      if (e.ctrlKey || e.metaKey) {
        this.zoomAt(Math.exp(-e.deltaY * 0.01), e.offsetX);
        return;
      }
      const dx = e.shiftKey ? e.deltaY : e.deltaX;
      const dy = e.shiftKey ? 0 : e.deltaY;
      if (dx) this.setX0(this.x0 + dx / this.pxPerTick);
      if (dy) this.scrollLanes(dy);
    }, { passive: false });
    // 音声ファイルを落とすと、落とした所に伴奏のトラックを足す
    for (const el of [canvas, list]) {
      el.addEventListener("dragover", (e) => {
        if ([...(e.dataTransfer?.items ?? [])].some((it) => it.kind === "file")) {
          e.preventDefault();
          this.hint(tr("離す: 音声ファイルを伴奏のトラックとして、ここに足す"));
        }
      });
      el.addEventListener("drop", (e) => {
        e.preventDefault();
        const files = [...(e.dataTransfer?.files ?? [])].filter(isAudioFile);
        const tick = el === canvas ? Math.max(0, Math.round(this.xToTick(e.offsetX))) : this.barAtPlayhead();
        for (const f of files) void this.addAudioTrack(f, tick);
        if (!files.length) this.hint(tr("音声ファイル（wav・mp3・flac など）を落としてください"));
      });
    }
    window.addEventListener("pointerdown", () => this.closeMenu());
    this.renderList();
  }

  // ── 時間軸の表示（左右のスクロールと拡大縮小）────────────
  private tickToX(t: number): number {
    return (t - this.x0) * this.pxPerTick;
  }

  private xToTick(x: number): number {
    return this.x0 + x / this.pxPerTick;
  }

  /** 内容の長さ（刻み）。左右のスクロールの範囲になる。 */
  private extent(): number {
    if (this.drag?.kind === "region" && this.frozenExtent) return this.frozenExtent; // ドラッグ中は変えない
    const p = this.store.project;
    let end = 0;
    for (const t of p.tracks) {
      end = Math.max(end, trackRegion(t, p.beatsPerBar).end);
      for (const n of t.notes) end = Math.max(end, n.onset + n.dur);
    }
    const bar = p.beatsPerBar * TPQ;
    this.frozenExtent = (Math.ceil(end / bar) + 4) * bar;
    return this.frozenExtent;
  }
  private frozenExtent = 0;

  /** 曲全体が収まる縮尺に戻す（別のプロジェクトを開いたとき）。 */
  fitAll(): void {
    this.pxPerTick = 0;
    this.x0 = 0;
    this.scrollY = 0;
    this.redraw();
  }

  private ensureScale(): void {
    if (!this.pxPerTick && this.hc.w > 0) this.pxPerTick = this.hc.w / this.extent(); // 初めは曲全体が収まる
  }

  private setX0(t: number): void {
    const vis = this.hc.w / this.pxPerTick;
    this.x0 = Math.max(0, Math.min(t, Math.max(0, this.extent() - vis * 0.5)));
    this.redraw();
  }

  private zoomAt(f: number, x: number): void {
    const t = this.xToTick(x);
    const fit = this.hc.w / this.extent();
    this.pxPerTick = Math.max(fit * 0.5, Math.min(0.5, this.pxPerTick * f)); // 曲全体の半分 〜 1 拍 240 px
    this.setX0(t - x / this.pxPerTick);
  }

  /** 下のスクロールバーのつまみの左右の端（画素）。 */
  private hbar(): { a: number; b: number } {
    const w = this.hc.w;
    const ext = Math.max(this.extent(), this.x0 + w / this.pxPerTick);
    return { a: (this.x0 / ext) * w, b: Math.min(w, ((this.x0 + w / this.pxPerTick) / ext) * w) };
  }

  // ── 上下のスクロールと、欄の高さ ─────────────────────
  private lanesH(): number {
    return Math.max(0, this.hc.h - HEAD - SB);
  }

  private maxScroll(): number {
    return Math.max(0, this.store.project.tracks.length * LANE - this.lanesH());
  }

  private scrollLanes(dy: number): void {
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY + dy));
    this.applyScroll();
  }

  private applyScroll(): void {
    this.redraw();
  }

  /** トラックを足したとき: 4 本ぶんまでは欄を広げて全部見せる（それより多ければスクロール）。 */
  private growToFit(): void {
    const want = HEAD + Math.min(4, this.store.project.tracks.length) * LANE + SB + 2;
    if (this.body.getBoundingClientRect().height < want) this.body.style.height = `${want}px`;
  }

  /** 今のトラックの数に合わせた欄の高さ（最初に 1 回）。 */
  fitHeight(): void {
    const n = Math.max(1, Math.min(4, this.store.project.tracks.length));
    this.body.style.height = `${HEAD + n * LANE + SB + 2}px`;
  }

  /** トラックが見えるように欄を広げ（4 本まで）、スクロールする。 */
  reveal(t: Track): void {
    const i = this.store.project.tracks.indexOf(t);
    if (i >= 0) this.scrollToLane(i);
  }

  private scrollToLane(i: number): void {
    this.growToFit();
    const top = i * LANE;
    const vis = this.lanesH();
    if (top < this.scrollY) this.scrollY = top;
    else if (top + LANE > this.scrollY + vis) this.scrollY = top + LANE - vis;
    this.scrollY = Math.max(0, Math.min(this.maxScroll(), this.scrollY));
    this.applyScroll();
  }

  /** ピアノロールの上辺（つまみ）を上下にドラッグして、編曲の欄の高さを変える。 */
  private hookResizer(el: HTMLElement): void {
    const body = this.body;
    let y0 = 0;
    let h0 = 0;
    el.addEventListener("pointerdown", (e) => {
      el.setPointerCapture(e.pointerId);
      y0 = e.clientY;
      h0 = body.getBoundingClientRect().height;
      el.classList.add("drag");
    });
    el.addEventListener("pointermove", (e) => {
      if (!el.hasPointerCapture(e.pointerId)) return;
      const max = Math.max(HEAD + LANE + SB, window.innerHeight * 0.6);
      body.style.height = `${Math.max(HEAD + LANE + SB + 2, Math.min(max, h0 + e.clientY - y0))}px`;
      this.scrollLanes(0);
    });
    el.addEventListener("pointerup", (e) => {
      el.releasePointerCapture(e.pointerId);
      el.classList.remove("drag");
    });
    el.addEventListener("dblclick", () => {
      // ダブルクリック: トラックが全部見える高さ（最大 6 本ぶん）に戻す
      const n = Math.max(1, Math.min(6, this.store.project.tracks.length));
      body.style.height = `${HEAD + n * LANE + SB + 2}px`;
      this.scrollLanes(0);
    });
  }

  private laneAt(y: number): number {
    return Math.floor((y - HEAD + this.scrollY) / LANE);
  }

  // ── メニュー・トラックを足す・消す・名前を変える ────────────
  private openMenu(at: { left: number; bottom: number }, items: Array<[string, string, () => void]>): void {
    this.closeMenu();
    const m = document.createElement("div");
    m.className = "pop-menu";
    Object.assign(m.style, { left: `${at.left}px`, top: `${at.bottom + 4}px` });
    for (const [label, sub, fn] of items) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${label}</span>${sub ? `<span class="muted">${sub}</span>` : ""}`;
      b.addEventListener("click", () => {
        this.closeMenu();
        fn();
      });
      m.appendChild(b);
    }
    m.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(m);
    this.menu = m;
  }

  private closeMenu(): void {
    this.menu?.remove();
    this.menu = null;
  }

  private trackMenu(t: Track, x: number, y: number): void {
    this.openMenu({ left: x, bottom: y - 4 }, [
      [tr("名前を変える"), "", () => this.startRename(t)],
      [tr("トラックを消す"), tr("⌘Z で戻せます"), () => this.deleteTrack(t)],
    ]);
  }

  private deleteTrack(t: Track): void {
    const s = this.store;
    const p = s.project;
    const vocals = p.tracks.filter((x) => !isAudioTrack(x));
    if (!isAudioTrack(t) && vocals.length <= 1) {
      this.hint(tr("歌のトラックは 1 本は残す必要があります（ピアノロールで使うため）"));
      return;
    }
    const before = s.snapshot();
    const active = s.track;
    p.tracks = p.tracks.filter((x) => x !== t);
    // ピアノロールの対象: 消したのが今のトラックなら、残っている最初の歌のトラックへ
    const keep = active === t ? p.tracks.find((x) => !isAudioTrack(x))! : active;
    p.activeTrack = p.tracks.indexOf(keep);
    s.selected.clear();
    s.commit(before);
    s.changed("project");
    this.renderList();
    this.hint(tr("トラックを消しました: {name}（⌘Z で戻せます）", { name: t.name }));
  }

  private startRename(t: Track): void {
    const i = this.store.project.tracks.indexOf(t);
    const nameEl = this.rows.children[i]?.querySelector<HTMLElement>(".name");
    if (nameEl) this.rows.children[i].scrollIntoView({ block: "nearest" });
    if (!nameEl) return;
    const input = document.createElement("input");
    input.className = "rename";
    input.value = t.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== t.name) {
        const before = this.store.snapshot();
        t.name = v;
        this.store.commit(before);
        this.store.changed("project");
      }
      this.renderList();
    };
    input.addEventListener("keydown", (e) => {
      e.stopPropagation();
      if (e.key === "Enter" && !e.isComposing) finish(true);
      else if (e.key === "Escape") finish(false);
    });
    input.addEventListener("blur", () => finish(true));
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    input.addEventListener("click", (e) => e.stopPropagation());
  }

  private barAtPlayhead(): number {
    const bar = this.store.project.beatsPerBar * TPQ;
    return Math.floor(this.store.playTick / bar) * bar;
  }

  /** 新しいトラック。色は空（差し色から作る自動の色）。 */
  private newTrackBase(name: string): Track {
    const p = this.store.project;
    const vocal = p.tracks.find((t) => !isAudioTrack(t));
    return { id: Math.max(0, ...p.tracks.map((t) => t.id)) + 1, name,
             voice: vocal?.voice ?? "ritsu", voicebank: vocal?.voicebank,
             color: "", notes: [], mute: false, solo: false, base: defaultBase(), params: {} };
  }

  private addVocalTrack(): void {
    const s = this.store;
    const p = s.project;
    const before = s.snapshot();
    const n = p.tracks.filter((t) => !isAudioTrack(t)).length + 1;
    const t = this.newTrackBase(tr("トラック {n}", { n }));
    const start = this.barAtPlayhead();
    t.region = { start, end: start + 4 * p.beatsPerBar * TPQ };
    p.tracks.push(t);
    p.activeTrack = p.tracks.length - 1;
    s.selected.clear();
    s.commit(before);
    s.changed("project");
    this.renderList();
    this.scrollToLane(p.tracks.length - 1);
  }

  async addAudioTrack(file: File, startTick: number): Promise<void> {
    const s = this.store;
    this.hint(tr("読み込み中: {name}", { name: file.name }));
    let loaded: AudioEntry;
    try {
      loaded = await loadAudioFile(file);
    } catch (e) {
      this.hint(tr("音声ファイルを読めませんでした: {name}（{e}）", { name: file.name, e: String(e) }));
      return;
    }
    const p = s.project;
    const before = s.snapshot();
    const name = file.name.replace(/\.[^.]+$/, "");
    const t = this.newTrackBase(name);
    const dur = loaded.buffer.duration;
    t.kind = "audio";
    t.audio = { id: loaded.id, name, fileName: file.name, hash: loaded.hash, durationSec: dur, offsetSec: 0 };
    t.region = { start: startTick, end: startTick + Math.round(dur / secPerTick(p.bpm)) };
    p.tracks.push(t);
    s.commit(before);
    s.changed("project");
    this.renderList();
    this.scrollToLane(p.tracks.length - 1);
    this.hint(tr("伴奏のトラックを足しました: {name}（{sec} 秒）", { name: file.name, sec: dur.toFixed(1) }));
  }

  // ── 箱の操作 ───────────────────────────────
  /** 箱の当たり判定: 左右の端（範囲を変える）か中（動かす）か。 */
  private hitBox(x: number, y: number): { track: Track; grab: Grab } | null {
    if (y < HEAD || y > this.hc.h - SB) return null;
    const t = this.store.project.tracks[this.laneAt(y)];
    if (!t) return null;
    const r = trackRegion(t, this.store.project.beatsPerBar);
    const x0 = this.tickToX(r.start);
    const x1 = this.tickToX(r.end);
    if (x < x0 - EDGE || x > x1 + EDGE) return null;
    if (Math.abs(x - x0) <= EDGE) return { track: t, grab: "left" };
    if (Math.abs(x - x1) <= EDGE) return { track: t, grab: "right" };
    return x > x0 && x < x1 ? { track: t, grab: "move" } : null;
  }

  private hover(x: number, y: number): void {
    const c = this.hc.canvas;
    if (y < HEAD) {
      c.style.cursor = "pointer";
      this.hint(tr("クリック・ドラッグ: 再生位置を動かす"));
      return;
    }
    if (y > this.hc.h - SB) {
      c.style.cursor = "default";
      this.hint(tr("ドラッグ: 左右に動かす　⌘/Ctrl+ホイール・ピンチ: 時間方向の拡大縮小"));
      return;
    }
    const hit = this.hitBox(x, y);
    const audio = hit && isAudioTrack(hit.track);
    if (hit?.grab === "move") {
      c.style.cursor = "grab";
      this.hint(audio ? tr("ドラッグ: 伴奏を動かす（拍に吸着しない）　右クリック: 名前を変える・消す")
        : tr("ドラッグ: トラックを動かす（音符とパラメータの曲線も一緒に）　⌥+ドラッグ: 拍に吸着させない　右クリック: 名前を変える・消す"));
    } else if (hit) {
      c.style.cursor = "ew-resize";
      this.hint(audio ? tr("ドラッグ: 伴奏の鳴らす範囲を詰める・戻す（拍に吸着しない）")
        : tr("ドラッグ: トラックの範囲を変える（範囲の外の音符は歌わない）　⌥+ドラッグ: 拍に吸着させない"));
    } else {
      c.style.cursor = "default";
      this.hint(tr("クリック・ドラッグ: ピアノロールで見る所を動かす　ホイール: 上下　Shift+ホイール: 左右　⌘/Ctrl+ホイール・ピンチ: 拡大縮小　音声ファイルを落とす: 伴奏のトラックを足す"));
    }
  }

  private dragRegion(d: RegionDrag, e: PointerEvent): void {
    const raw = (e.offsetX - d.x0) / this.pxPerTick;
    // 歌のトラックは拍に吸着（⌥ で吸着なし）。伴奏は吸着させない
    const snap = e.altKey || d.audio ? 1 : TPQ;
    const t = d.track;
    const spt = secPerTick(this.store.project.bpm);
    if (d.grab === "move") {
      const dt = Math.max(-d.region.start, Math.round(raw / snap) * snap);
      if (dt === 0 && !d.moved) return;
      placeTrack(d, dt);
    } else if (d.grab === "left") {
      let s = Math.round((d.region.start + raw) / snap) * snap;
      s = Math.max(0, Math.min(s, d.region.end - (d.audio ? 1 : TPQ)));
      if (d.audio && t.audio) {
        // 伴奏: 左の端を詰めた分だけ、音声の頭を飛ばす（音声の頭より前には戻せない）
        s = Math.max(s, Math.ceil(d.region.start - d.audio.offsetSec / spt));
        t.audio.offsetSec = Math.max(0, d.audio.offsetSec + (s - d.region.start) * spt);
      }
      t.region = { start: s, end: d.region.end };
    } else {
      let en = Math.round((d.region.end + raw) / snap) * snap;
      en = Math.max(en, d.region.start + (d.audio ? 1 : TPQ));
      if (d.audio) en = Math.min(en, d.region.start + Math.floor((d.audio.durationSec - d.audio.offsetSec) / spt));
      t.region = { start: d.region.start, end: en };
    }
    d.moved = true;
    this.store.changed("project");
  }

  private setPlayhead(x: number): void {
    this.store.playTick = Math.max(0, this.xToTick(x));
    this.store.changed("playhead");
  }

  private scrollTo(x: number): void {
    this.view.scrollTick = Math.max(0, this.xToTick(x) - this.visibleTicks() / 2);
    this.view.emit();
  }

  /** トラックを選ぶ。伴奏のトラックはピアノロールに出さない（歌のトラックのまま）。 */
  private activate(i: number): void {
    const t = this.store.project.tracks[i];
    if (!t || isAudioTrack(t) || i === this.store.project.activeTrack) return;
    this.store.project.activeTrack = i;
    this.store.selected.clear();
    this.store.changed("project");
  }

  renderList(): void {
    this.rows.innerHTML = "";
    this.store.project.tracks.forEach((t, i) => {
      const audio = isAudioTrack(t);
      const row = document.createElement("div");
      row.className = "track-row" + (i === this.store.project.activeTrack ? " active" : "") + (audio ? " audio" : "");
      const sub = audio ? `<span class="wave-icon">〰</span>${t.audio?.name ?? ""}` : t.voice;
      row.innerHTML = `<div class="strip" style="background:${trackColor(this.store.project, t)}"></div>
        <div class="names"><div class="name" title="${tr("ダブルクリック: 名前を変える")}"></div><div class="voice">${sub}</div></div>`;
      row.querySelector<HTMLElement>(".name")!.textContent = t.name;
      row.querySelector<HTMLElement>(".name")!.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        this.startRename(t);
      });
      // 音量とパンのつまみ（再生のときの混ぜ方だけ。合成し直さない）
      let before = "";
      const start = () => { before = this.store.snapshot(); };
      const end = () => { if (before) this.store.commit(before); before = ""; };
      row.appendChild(knob({
        title: tr("音量"), min: -24, max: 6, def: 0, get: () => t.gain ?? 0,
        set: (v) => { t.gain = Math.round(v * 10) / 10; this.store.changed("mix"); },
        fmt: (v) => (v <= -24 ? "−∞ dB" : `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} dB`),
        onStart: start, onEnd: end,
      }));
      row.appendChild(knob({
        title: tr("パン"), min: -1, max: 1, def: 0, get: () => t.pan ?? 0,
        set: (v) => { t.pan = Math.round(v * 100) / 100; this.store.changed("mix"); },
        fmt: (v) => (Math.abs(v) < 0.005 ? tr("中央") : `${v < 0 ? tr("左") : tr("右")} ${Math.abs(v).toFixed(2)}`),
        onStart: start, onEnd: end,
      }));
      const ms = document.createElement("div");
      ms.className = "ms-col";
      for (const key of ["mute", "solo"] as const) {
        const b = document.createElement("button");
        b.className = "ms" + (t[key] ? " on" : "");
        b.textContent = key === "mute" ? "M" : "S";
        b.title = key === "mute" ? tr("消音") : tr("このトラックだけ");
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const b0 = this.store.snapshot();
          t[key] = !t[key];
          this.store.commit(b0);
          this.store.changed("mix");
          this.renderList();
        });
        ms.appendChild(b);
      }
      row.appendChild(ms);
      row.addEventListener("click", () => this.activate(i));
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        this.trackMenu(t, e.clientX, e.clientY);
      });
      this.rows.appendChild(row);
    });
    this.rows.querySelector(".track-row.active")?.scrollIntoView({ block: "nearest" });
    this.scrollY = Math.min(this.scrollY, this.maxScroll());
    this.applyScroll();
  }

  redraw(): void {
    requestDraw(() => this.draw());
  }

  draw(): void {
    const { ctx, w, h } = this.hc;
    this.ensureScale();
    if (!this.pxPerTick) return;
    const p = this.store.project;
    const bar = p.beatsPerBar * TPQ;
    const spt = secPerTick(p.bpm);
    const sx = this.pxPerTick;
    ctx.fillStyle = cssVar("--pr-bg");
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = cssVar("--ruler-bg");
    ctx.fillRect(0, 0, w, HEAD);
    // 小節の目盛り（見えている所だけ。拡大したら拍の線も）
    ctx.font = "10px 'Hiragino Sans', sans-serif";
    const every = Math.max(1, Math.ceil(40 / (bar * sx)));
    const b0 = Math.max(0, Math.floor(this.x0 / bar));
    const b1 = Math.ceil(this.xToTick(w) / bar);
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(this.tickToX(b * bar));
      ctx.fillStyle = cssVar("--grid-beat");
      ctx.fillRect(x, HEAD, 1, h - HEAD - SB);
      if (b % every === 0) {
        ctx.fillStyle = cssVar("--ruler-text");
        ctx.fillText(String(b + 1), x + 3, 12);
      }
      if (TPQ * sx > 14) {
        ctx.fillStyle = cssVar("--grid-sub");
        for (let k = 1; k < p.beatsPerBar; k++) ctx.fillRect(Math.round(this.tickToX(b * bar + k * TPQ)), HEAD, 1, h - HEAD - SB);
      }
    }
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, HEAD, w, h - HEAD - SB);
    ctx.clip();
    // トラックの範囲の箱と中身（歌: 範囲の中の音符、伴奏: 鳴らす所の波形）
    p.tracks.forEach((t, i) => {
      const y = HEAD + i * LANE - this.scrollY;
      if (y + LANE < HEAD || y > h) return;
      const r = trackRegion(t, p.beatsPerBar);
      const x0 = this.tickToX(r.start);
      const x1 = this.tickToX(r.end);
      if (x1 < 0 || x0 > w) return;
      // 箱は薄く塗り、中身（音符・波形）をトラックの色で濃く描く。今のトラックは縁取りする
      const col = trackColor(p, t);
      const active = i === p.activeTrack;
      ctx.fillStyle = col + (active ? "38" : "22");
      roundRect(ctx, x0 + 1, y + 2, Math.max(2, x1 - x0 - 2), LANE - 4, 5);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = col + "aa";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.fillStyle = col;
      ctx.fillRect(x0 + 1, y + 4, 2, LANE - 8);
      ctx.fillRect(x1 - 3, y + 4, 2, LANE - 8);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0 + 1, y + 2, Math.max(0, x1 - x0 - 2), LANE - 4);
      ctx.clip();
      if (isAudioTrack(t) && t.audio) {
        const pk = audioPeaks(t.audio.id);
        const mid = y + LANE / 2 + 3;
        ctx.fillStyle = col + "cc";
        if (pk) {
          for (let x = Math.max(0, Math.floor(x0)); x < Math.min(w, x1); x++) {
            // この画素が受け持つ音声の区間の最大
            const ta = Math.floor((t.audio.offsetSec + (this.xToTick(x) - r.start) * spt) * PEAK_RATE);
            const tb = Math.max(ta + 1, Math.floor((t.audio.offsetSec + (this.xToTick(x + 1) - r.start) * spt) * PEAK_RATE));
            let m = 0;
            for (let k = Math.max(0, ta); k < Math.min(pk.length, tb); k++) m = Math.max(m, pk[k]);
            const hh = Math.max(0.5, m * (LANE - 14) / 2);
            ctx.fillRect(x, mid - hh, 1, hh * 2);
          }
        }
      } else if (t.notes.length) {
        // 音符: 箱の下の方（名前の下）に、音高の高さを詰めて描く
        const lo = Math.min(...t.notes.map((n) => n.pitch));
        const hi = Math.max(...t.notes.map((n) => n.pitch));
        ctx.fillStyle = col;
        for (const n of t.notes) {
          const ny = y + LANE - 6 - ((n.pitch - lo) / Math.max(1, hi - lo)) * (LANE - 18);
          ctx.fillRect(this.tickToX(n.onset), ny, Math.max(1, n.dur * sx - 1), 2);
        }
      }
      ctx.font = "600 10px 'Hiragino Sans', sans-serif";
      ctx.fillStyle = cssVar("--text");
      ctx.fillText(t.name, Math.max(x0, 0) + 8, y + 12);
      ctx.restore();
    });
    // ピアノロールで見えている範囲
    const vx = this.tickToX(this.view.scrollTick);
    ctx.fillStyle = cssVar("--accent-faint");
    ctx.fillRect(vx, HEAD, this.visibleTicks() * sx, h - HEAD - SB);
    ctx.strokeStyle = cssVar("--accent");
    ctx.lineWidth = 1;
    roundRect(ctx, vx + 0.5, HEAD + 0.5, this.visibleTicks() * sx, h - HEAD - SB - 1, 4);
    ctx.stroke();
    ctx.restore();
    // 再生位置（目盛りの所に印）
    const px = Math.round(this.tickToX(this.store.playTick));
    if (px >= -6 && px <= w + 6) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.fillRect(px, HEAD, 1, h - HEAD - SB);
      ctx.beginPath();
      ctx.moveTo(px - 5, HEAD - 9);
      ctx.lineTo(px + 5, HEAD - 9);
      ctx.lineTo(px, HEAD);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = cssVar("--line");
    ctx.fillRect(0, HEAD - 1, w, 1);
    // 下の横のスクロールバー
    const { a, b } = this.hbar();
    ctx.fillStyle = cssVar("--sb-bg");
    ctx.fillRect(0, h - SB, w, SB);
    ctx.fillStyle = cssVar("--sb-thumb");
    roundRect(ctx, a + 1, h - SB + 2, Math.max(16, b - a - 2), SB - 4, 2);
    ctx.fill();
  }
}
