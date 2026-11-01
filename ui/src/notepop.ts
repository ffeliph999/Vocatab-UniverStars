// 音符の小窓: すでにある音符をクリックすると、その横（入らなければ上下）に出る。抑揚とビブラートの倍率、AI リテイク。
// 描いたばかりの音符・範囲で選んだ音符には出さない（範囲で選んだ後に、その中の音符をクリックすればまとめて出る）。
// 地はすりガラス（後ろをぼかした半透明）、つまみ・ボタン・文字ははっきり見せる。
// 音符をドラッグしている間・歌詞を入力している間は隠す。同じ音符をもう一度クリック（動かさずに離す）・× ・Esc で、
// 次に音符をクリックするまで閉じる。
import type { Derived } from "./derive";
import { t } from "./i18n";
import type { Note } from "./model";
import { defaultVibrato, pitchName, TPQ } from "./model";
import type { PianoRoll } from "./pianoroll";
import { slider } from "./side";
import type { Store } from "./store";
import { KEY_W, RULER_H } from "./view";

const W = 276;
const SIDE_GAP = 16; // 横に置くとき、選んだ音符とその線から空ける幅（px）
const V_GAP = 32; // 上下に置くとき、選んだ音符とその線から空ける高さ（px）

export class NotePopover {
  readonly el: HTMLElement;
  private dismissed = true;
  private dragging = false;
  private key = ""; // 中身を作ったときの選択（変わったら作り直す）

  constructor(private store: Store, private pr: PianoRoll, private derived: () => Derived, host: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "note-pop";
    this.el.hidden = true;
    // 小窓の上の操作がピアノロールに伝わらないように
    for (const ev of ["pointerdown", "wheel", "dblclick", "contextmenu"]) {
      this.el.addEventListener(ev, (e) => e.stopPropagation());
    }
    host.appendChild(this.el);
    store.on((kind) => {
      if (kind === "selection") {
        this.dismissed = !pr.clickedNote;
        this.key = "";
      }
      if (kind === "selection" || kind === "project") this.update();
    });
    window.addEventListener("pointerup", () => requestAnimationFrame(() => this.update()));
    window.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && !this.el.hidden) {
        this.dismissed = true;
        this.update();
      }
    });
  }

  /** 選んでいる音符に小窓を開く（音符をクリックしたのと同じ。画面の確認用の ?select= から使う）。 */
  open(): void {
    this.dismissed = false;
    this.update();
  }

  /** 閉じる（次に音符をクリックするまで）。 */
  close(): void {
    this.dismissed = true;
    this.update();
  }

  private selected(): Note[] {
    const s = this.store;
    return s.track.notes.filter((n) => s.selected.has(n.id)).sort((a, b) => a.onset - b.onset);
  }

  /** 中身を（必要なら作り直して）置き直す。表示の移動・拡大のたびにも呼ぶ。 */
  update(): void {
    const notes = this.selected();
    if (!notes.length || this.dismissed || this.pr.busy) {
      this.el.hidden = true;
      return;
    }
    const key = notes.map((n) => n.id).join(",") + "|" + this.store.version;
    if (key !== this.key && !this.dragging) {
      this.key = key;
      this.render(notes);
    }
    this.el.hidden = false;
    this.place(notes);
  }

  /**
   * 置き場所。「選んだ音符とその所のピッチの線」（keep）には重ねない。
   *   1. 横（右・左）を先に考える。keep から SIDE_GAP 離し、高さは音符の真ん中・keep の上端に揃える・下端に揃える・
   *      画面のいちばん上・いちばん下の 5 通り
   *   2. 横に入らなければ上下。keep から V_GAP 離す
   *   同じ側の中では、ほかの所のピッチの線・ほかの音符になるべく重ならない所を選ぶ。
   *   どこにも入らないときは、keep への重なりがいちばん少ない所（画面の端で止めた位置）に置く。
   */
  private place(notes: Note[]): void {
    const host = this.el.parentElement!;
    const hw = host.clientWidth;
    const hh = host.clientHeight;
    const ph = this.el.offsetHeight;
    const LABEL = 16; // 音符の上の音素の文字の高さ
    type Box = { x0: number; x1: number; y0: number; y1: number };
    const boxes = notes.map((n) => this.pr.noteBox(n));
    const sel: Box = { x0: Math.min(...boxes.map((b) => b.x0)), x1: Math.max(...boxes.map((b) => b.x1)),
                       y0: Math.min(...boxes.map((b) => b.y0)) - LABEL, y1: Math.max(...boxes.map((b) => b.y1)) };
    // 選んだ音符が画面の外なら隠す
    if (sel.x1 < KEY_W || sel.x0 > hw || sel.y1 < RULER_H || sel.y0 > hh) {
      this.el.hidden = true;
      return;
    }
    // ピッチの線: 選んだ音符の所（keep に含める）と、それ以外（なるべくよける）
    const line = this.pr.pitchPoints(KEY_W, hw);
    const own = line.filter(([x]) => x >= sel.x0 - 8 && x <= sel.x1 + 8);
    const rest = line.filter(([x]) => x < sel.x0 - 8 || x > sel.x1 + 8);
    const keep: Box = { ...sel };
    for (const [, y] of own) {
      keep.y0 = Math.min(keep.y0, Math.max(RULER_H, y - 4));
      keep.y1 = Math.max(keep.y1, Math.min(hh, y + 4));
    }
    const cx = (Math.max(sel.x0, KEY_W) + Math.min(sel.x1, sel.x0 + 400, hw)) / 2;
    const cy = (sel.y0 + sel.y1) / 2;
    const ids = new Set(notes.map((n) => n.id));
    const others: Box[] = [];
    for (const n of this.store.track.notes) {
      if (ids.has(n.id)) continue;
      const b = this.pr.noteBox(n);
      if (b.x1 < 0 || b.x0 > hw || b.y1 < 0 || b.y0 - LABEL > hh) continue;
      others.push({ ...b, y0: b.y0 - LABEL });
    }
    const overlap = (a: Box, b: Box) =>
      Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
    const minX = KEY_W + 6;
    const minY = RULER_H + 6;
    const clampX = (x: number) => Math.max(minX, Math.min(hw - W - 8, x));
    const clampY = (y: number) => Math.max(minY, Math.min(hh - ph - 8, y));
    const sideYs = [cy - ph / 2, keep.y0, keep.y1 - ph, minY, hh - ph - 8];
    // [向き, x, y, 向きの順位（横 = 0、上下 = 1）]
    const cands: Array<[string, number, number, number]> = [
      ...sideYs.map((y): [string, number, number, number] => ["right", keep.x1 + SIDE_GAP, y, 0]),
      ...sideYs.map((y): [string, number, number, number] => ["left", keep.x0 - SIDE_GAP - W, y, 0]),
      ["below", cx - W / 2, keep.y1 + V_GAP, 1],
      ["above", cx - W / 2, keep.y0 - V_GAP - ph, 1],
    ];
    // keep に少し余白を付けたもの（端で止めて寄ってきたときに、すぐ脇に貼りつかないように）
    const keepPad: Box = { x0: keep.x0 - 6, x1: keep.x1 + 6, y0: keep.y0 - 6, y1: keep.y1 + 6 };
    const area = W * ph;
    let best = { side: "below", x: 0, y: 0, score: Infinity };
    cands.forEach(([side, x0, y0, rank], i) => {
      const x = clampX(x0);
      const y = clampY(y0);
      const r: Box = { x0: x, x1: x + W, y0: y, y1: y + ph };
      const onLine = rest.filter(([px, py]) => px >= r.x0 && px <= r.x1 && py >= r.y0 && py <= r.y1).length;
      const score = 100 * overlap(r, keepPad) / area                           // 選んだ音符とその線には重ねない
        + rank                                                                  // 横を先に
        + 0.8 * onLine / (W / 3)                                                // ほかの所のピッチの線をなるべくよける
        + 0.3 * others.reduce((s, o) => s + overlap(r, o), 0) / area           // ほかの音符もなるべくよける
        + (Math.abs(x - x0) + Math.abs(y - y0)) / 2000                          // 端で止めて離れすぎない
        + i * 0.001;
      if (score < best.score) best = { side, x, y, score };
    });
    this.el.style.left = `${best.x}px`;
    this.el.style.top = `${best.y}px`;
    this.el.classList.toggle("up", best.side === "above");
    this.el.classList.toggle("side", best.side === "left" || best.side === "right");
    // 矢印は音符の真ん中を指す（横に出したときは出さない）
    this.el.style.setProperty("--arrow-x", `${Math.max(16, Math.min(W - 16, cx - best.x))}px`);
  }

  private render(notes: Note[]): void {
    const s = this.store;
    const n0 = notes[0];
    const el = this.el;
    el.innerHTML = "";
    const phs = this.derived().phones.filter((p) => p.noteId === n0.id).map((p) => p.ph).join(" ") || t("（伸ばし）");
    const head = document.createElement("div");
    head.className = "np-head";
    const beats = n0.dur / TPQ;
    head.innerHTML = `<b class="np-lyric"></b><span class="np-sub"></span><button class="icon-btn np-x" title="${t("閉じる（Esc）")}">✕</button>`;
    head.querySelector(".np-lyric")!.textContent = notes.length === 1 ? n0.lyric : t("{n} 個", { n: notes.length });
    head.querySelector(".np-sub")!.textContent = notes.length === 1
      ? t("{ph} · {pitch} · {beats} 拍", { ph: phs, pitch: pitchName(n0.pitch), beats: Number.isInteger(beats) ? beats : beats.toFixed(2) })
      : t("{lyric} ほか（まとめて変える）", { lyric: n0.lyric });
    head.querySelector(".np-x")!.addEventListener("click", () => {
      this.dismissed = true;
      this.update();
    });
    el.appendChild(head);

    const body = document.createElement("div");
    body.className = "np-body";
    slider(s, body, {
      label: t("抑揚"), min: 0, max: 2, step: 0.01, def: 1, get: () => n0.attrs.iMod ?? 1,
      set: (v) => { for (const n of notes) n.attrs.iMod = v; }, fmt: (v) => `× ${v.toFixed(2)}`,
    }, (on) => { this.dragging = on; });
    body.lastElementChild!.setAttribute("title",
      t("AI が付けた抑揚（しゃくり・こぶし・音の移り方など、音符の高さからのずれ）の倍率（0 で音符の高さどおり）。ダブルクリックで 1 に戻す"));
    slider(s, body, {
      label: t("ビブラート"), min: 0, max: 2, step: 0.01, def: 1, get: () => n0.attrs.vMod,
      set: (v) => { for (const n of notes) n.attrs.vMod = v; }, fmt: (v) => `× ${v.toFixed(2)}`,
      disabled: !!n0.attrs.vib,
    }, (on) => { this.dragging = on; });
    body.lastElementChild!.setAttribute("title", t("AI が付けたビブラートの幅の倍率（0 で消える）。ダブルクリックで 1 に戻す"));

    // 手で付けるビブラート（付けると AI のビブラートの代わりになる）
    const vrow = document.createElement("label");
    vrow.className = "np-check";
    vrow.title = t("音符に自分でビブラートを付ける。付けると AI のビブラートは使わない");
    const vcb = document.createElement("input");
    vcb.type = "checkbox";
    vcb.checked = !!n0.attrs.vib;
    vcb.addEventListener("change", () => {
      const before = s.snapshot();
      for (const n of notes) {
        if (vcb.checked) n.attrs.vib ??= { ...(n0.attrs.vib ?? defaultVibrato()) };
        else delete n.attrs.vib;
      }
      s.commit(before);
      s.changed("project");
    });
    vrow.append(vcb, t("ビブラートを手で付ける"));
    body.appendChild(vrow);
    if (n0.attrs.vib) {
      const v0 = n0.attrs.vib;
      const vs = (label: string, key: "depth" | "rate" | "start" | "fadeIn" | "fadeOut", min: number, max: number, step: number,
                  fmt: (v: number) => string, tip: string): void => {
        slider(s, body, {
          label, min, max, step, def: defaultVibrato()[key], get: () => v0[key],
          set: (v) => { for (const n of notes) if (n.attrs.vib) n.attrs.vib[key] = v; }, fmt,
        }, (on) => { this.dragging = on; });
        body.lastElementChild!.setAttribute("title", tip);
      };
      vs(t("振れ幅"), "depth", 0, 200, 1, (v) => `±${v} ct`, t("ビブラートの振れ幅（中心から片側、セント）。ダブルクリックで戻す"));
      vs(t("速さ"), "rate", 2, 10, 0.1, (v) => `${v.toFixed(1)} Hz`, t("ビブラートの速さ（1 秒あたりの揺れ）"));
      vs(t("開始位置"), "start", 0, 0.9, 0.01, (v) => `${Math.round(v * 100)}%`, t("音符のどこからビブラートを始めるか（音符の長さに対する割合）"));
      vs(t("入りの長さ"), "fadeIn", 0, 1.5, 0.05, (v) => (v === 0 ? t("なし") : `${v.toFixed(2)} s`), t("始めをなだらかに大きくする長さ（0 でなだらかにしない）"));
      vs(t("抜きの長さ"), "fadeOut", 0, 1.5, 0.05, (v) => (v === 0 ? t("なし") : `${v.toFixed(2)} s`), t("終わりをなだらかに小さくする長さ（0 でなだらかにしない）"));
    }

    const rows: Array<["retakeF0" | "retakeMel", "retakeF0Prev" | "retakeMelPrev", string, string]> = [
      ["retakeF0", "retakeF0Prev", t("ピッチ"), t("抑揚とビブラートを取り直す")],
      ["retakeMel", "retakeMelPrev", t("声"), t("息づかいや音色の細部を取り直す")],
    ];
    for (const [key, prevKey, label, tip] of rows) {
      const taken = notes.filter((n) => n.attrs[key]).length;
      const hasPrev = notes.some((n) => n.attrs[prevKey]?.length);
      const takes = Math.max(...notes.map((n) => (n.attrs[prevKey]?.length ?? 0) + (n.attrs[key] ? 1 : 0)));
      const state = taken === 0 ? t("最初のテイク") : notes.length === 1 ? t("{n} 回目", { n: takes })
        : t("{n} 個をリテイクしました", { n: taken });
      const row = document.createElement("div");
      row.className = "retake-row";
      row.title = tip;
      row.innerHTML = `<div class="retake-head"><span>${label}</span><span class="muted">${state}</span></div>
        <button class="small primary" title="${t("この音符だけ AI の生成をやり直す")}">${t("リテイク")}</button>
        <button class="small" title="${t("一つ前のテイクに戻す")}" ${hasPrev ? "" : "disabled"}>${t("一つ前")}</button>
        <button class="small" title="${t("最初のテイク（初期の乱数）に戻す")}" ${taken ? "" : "disabled"}>${t("最初")}</button>`;
      const [again, prev, first] = row.querySelectorAll("button");
      const apply = (fn: (n: Note) => void) => {
        const before = s.snapshot();
        for (const n of notes) fn(n);
        s.commit(before);
        s.changed("project");
      };
      // 新しいテイクへ移るときは、今のテイクを履歴に積む（「一つ前」で戻れるように）
      const moveTo = (n: Note, seed: number) => {
        const cur = n.attrs[key] ?? 0;
        if (cur === seed) return;
        n.attrs[prevKey] = [...(n.attrs[prevKey] ?? []), cur].slice(-50);
        n.attrs[key] = seed;
      };
      again.addEventListener("click", () => apply((n) => moveTo(n, 1 + Math.floor(Math.random() * 2 ** 31))));
      prev.addEventListener("click", () => apply((n) => {
        const h = n.attrs[prevKey];
        if (!h?.length) return;
        n.attrs[key] = h[h.length - 1];
        n.attrs[prevKey] = h.slice(0, -1);
      }));
      first.addEventListener("click", () => apply((n) => moveTo(n, 0)));
      body.appendChild(row);
    }
    el.appendChild(body);
  }
}
