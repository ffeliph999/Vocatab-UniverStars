// 左の帯の「エフェクター」: 選んでいる（歌の）トラックのイコライザー・コンプレッサー・リバーブ。
// 値を変えると store.changed("mix") で再生中の音にすぐ効く（合成し直さない）。undo はつまみ・点を離したときに積む。
// イコライザーは「声の地図」: 合成した声の平均のスペクトルを後ろに描き、帯域に名前を付け、点は足した分だけ置く。
import { cssVar } from "./canvas";
import { EQ_MAX_BANDS, REVERB_PRESETS } from "./fx";
import { t } from "./i18n";
import { knob } from "./knob";
import { defaultFx, type ReverbPreset, type TrackFx } from "./model";
import { averageSpectrum } from "./spectrum";
import type { Store } from "./store";

const FMIN = 20;
const FMAX = 20000;
const GMAX = 18; // グラフの縦軸 ±dB
const SPEC_DB = 60; // スペクトルを描く幅（いちばん大きい所から −60 dB まで）

/** 声の帯域の名前（ボーカルの EQ でよく言う呼び方）。[下端 Hz, 上端 Hz, 名前] */
const ZONES: Array<[number, number, string]> = [
  [200, 400, t("濁り")], [400, 800, t("こもり")], [800, 1600, t("鼻")],
  [2500, 5000, t("抜け")], [5000, 10000, t("歯擦音")], [10000, 20000, t("空気")],
];
const zoneAt = (f: number): string => ZONES.find(([a, b]) => f >= a && f < b)?.[2] ?? "";

// 周波数特性を描くための部品（音は流さない）
let probe: { ctx: OfflineAudioContext; lc: BiquadFilterNode; pk: BiquadFilterNode } | null = null;
function filters() {
  if (!probe) {
    const ctx = new OfflineAudioContext(1, 1, 44100);
    const lc = ctx.createBiquadFilter();
    lc.type = "highpass";
    lc.Q.value = Math.SQRT1_2;
    const pk = ctx.createBiquadFilter();
    pk.type = "peaking";
    probe = { ctx, lc, pk };
  }
  return probe;
}

const fmtHz = (f: number): string => (f >= 1000 ? `${(f / 1000).toFixed(f >= 10000 ? 0 : 1)} kHz` : `${Math.round(f)} Hz`);
const fmtDb = (v: number): string => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)} dB`;

// 波形ごとの番号（スペクトルを計算し直すかどうかの判定に使う。合成し直すと波形の配列が変わる）
const ids = new WeakMap<Float32Array, number>();
let nextId = 1;
function wavId(w: Float32Array): number {
  let id = ids.get(w);
  if (!id) {
    id = nextId++;
    ids.set(w, id);
  }
  return id;
}

export class FxPanel {
  private sel = 0; // 選んでいるイコライザーの点（0 = 低域カット、1〜 = 山・谷）
  private before = "";
  private redrawEq: (() => void) | null = null;
  private specKey = "";

  /** voice: このトラックの合成済みの波形（44.1 kHz。句ごと） */
  constructor(private store: Store, private section: (title: string) => HTMLElement,
              private voice: () => Float32Array[] = () => []) {}

  /** 合成が進んだとき: 波形の組が変わっていれば、イコライザーの後ろのスペクトルを描き直す。 */
  refreshSpectrum(): void {
    const key = this.voice().map((w) => wavId(w)).join(",");
    if (key !== this.specKey) this.redrawEq?.();
  }

  private get fx(): TrackFx {
    const t = this.store.track;
    t.fx ??= defaultFx();
    return t.fx;
  }

  private begin = (): void => { this.before = this.store.snapshot(); };
  private end = (): void => {
    if (this.before) this.store.commit(this.before);
    this.before = "";
  };
  private changed = (): void => this.store.changed("mix");

  render(): void {
    this.renderEq();
    this.renderComp();
    this.renderReverb();
  }

  /** 見出しに入り切りのスイッチを付けた区切り。 */
  private block(title: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const sec = this.section(title);
    const sw = document.createElement("button");
    sw.className = "switch" + (get() ? " on" : "");
    sw.title = t("オン/オフ");
    sw.addEventListener("click", () => {
      this.begin();
      set(!get());
      this.end();
      sw.classList.toggle("on", get());
      sec.classList.toggle("off", !get());
      this.changed();
    });
    sec.querySelector("h3")!.appendChild(sw);
    sec.classList.toggle("off", !get());
    return sec;
  }

  private knobRow(sec: HTMLElement, items: Array<{ label: string; el: HTMLElement }>): void {
    const row = document.createElement("div");
    row.className = "knob-row";
    for (const it of items) {
      const cell = document.createElement("div");
      cell.className = "knob-cell";
      cell.appendChild(it.el);
      const l = document.createElement("span");
      l.className = "knob-label";
      l.textContent = it.label;
      cell.appendChild(l);
      row.appendChild(cell);
    }
    sec.appendChild(row);
  }

  // ── イコライザー ─────────────────────────────
  private renderEq(): void {
    const eq = this.fx.eq;
    if (this.sel > eq.bands.length) this.sel = eq.bands.length;
    const sec = this.block(t("イコライザー"), () => eq.on, (v) => { eq.on = v; });
    const cv = document.createElement("canvas");
    cv.className = "fx-graph";
    cv.tabIndex = 0; // Delete で選んだ点を消すため
    sec.appendChild(cv);
    const readout = document.createElement("div");
    readout.className = "eq-readout";
    sec.appendChild(readout);
    const W = 260;
    const H = 156;
    const TOP = 15; // 帯域の名前の段
    const AXIS = 13; // 周波数の目盛りの段
    const MID = (TOP + H - AXIS) / 2;
    const HALF = (H - AXIS - TOP) / 2 - 7;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = "100%";
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d")!;
    const fx = (f: number) => (Math.log(f / FMIN) / Math.log(FMAX / FMIN)) * W;
    const xf = (x: number) => FMIN * (FMAX / FMIN) ** (x / W);
    const gy = (g: number) => MID - (g / GMAX) * HALF;
    const yg = (y: number) => ((MID - y) / HALF) * GMAX;
    const pts = (): Array<[number, number]> => [[fx(eq.lowCut), gy(0)], ...eq.bands.map((b) => [fx(b.freq), gy(b.gain)] as [number, number])];
    const n = 200;
    const freqs = new Float32Array(n).map((_, i) => xf((i / (n - 1)) * W));
    let spec: Float32Array | null = null;
    let hover: number | null = null; // マウスの下の周波数
    const draw = () => {
      const wavs = this.voice();
      const key = wavs.map((w) => wavId(w)).join(",");
      if (key !== this.specKey) {
        this.specKey = key;
        spec = averageSpectrum(wavs, 44100, freqs);
      }
      const scale = cv.clientWidth / W || 1;
      ctx.setTransform(dpr * scale, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = cssVar("--pr-bg");
      ctx.fillRect(0, 0, W, H);
      // 帯域の名前（縞と、上の段の文字。帯の幅に収まらない名前は描かない。名前はマウスの下の 1 行（zoneAt）にも出る）
      ctx.font = "8px 'Hiragino Sans', sans-serif";
      ctx.textAlign = "center";
      ZONES.forEach(([a, b, name], i) => {
        const xa = fx(a);
        const xb = fx(b);
        ctx.fillStyle = cssVar("--accent");
        ctx.globalAlpha = i % 2 ? 0.07 : 0.035;
        ctx.fillRect(xa, TOP, xb - xa, H - AXIS - TOP);
        ctx.globalAlpha = 1;
        if (ctx.measureText(name).width > xb - xa - 2) return;
        ctx.fillStyle = cssVar("--muted");
        ctx.fillText(name, (xa + xb) / 2, 10);
      });
      ctx.font = "8.5px 'Hiragino Sans', sans-serif";
      // 合成した声の平均のスペクトル（下から塗る。いちばん大きい所が上から 1 割の高さ）
      const sy = (db: number) => TOP + 6 + (Math.min(SPEC_DB, -db) / SPEC_DB) * (H - AXIS - TOP - 6);
      if (spec) {
        ctx.beginPath();
        ctx.moveTo(0, H - AXIS);
        for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * W, sy(spec[i]));
        ctx.lineTo(W, H - AXIS);
        ctx.closePath();
        ctx.fillStyle = cssVar("--muted");
        ctx.globalAlpha = 0.22;
        ctx.fill();
        ctx.globalAlpha = 1;
      } else {
        ctx.fillStyle = cssVar("--muted");
        ctx.fillText(t("合成が完了すると、ここに声のスペクトルが表示されます"), W / 2, MID + HALF * 0.55);
      }
      // 周波数の目盛り（太線 100・1k・10k、細線 50・200・500・2k・5k・20k の手前まで）
      ctx.lineWidth = 1;
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
        const x = Math.round(fx(f)) + 0.5;
        ctx.strokeStyle = cssVar(f === 100 || f === 1000 || f === 10000 ? "--grid-bar" : "--grid-beat");
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, H - AXIS);
        ctx.stroke();
        if (f !== 50) {
          ctx.fillStyle = cssVar(f === 100 || f === 1000 || f === 10000 ? "--text" : "--muted");
          ctx.fillText(f >= 1000 ? `${f / 1000}k` : String(f), x, H - 3);
        }
      }
      ctx.textAlign = "left";
      ctx.strokeStyle = cssVar("--grid-beat");
      for (const g of [-12, -6, 0, 6, 12]) {
        const y = Math.round(gy(g)) + 0.5;
        ctx.globalAlpha = g === 0 ? 1 : 0.6;
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = cssVar("--muted");
      ctx.fillText("+12", 2, gy(12) - 2);
      ctx.fillText("−12", 2, gy(-12) - 2);
      // マウスの下の周波数の線
      if (hover !== null) {
        ctx.strokeStyle = cssVar("--cursor-line");
        ctx.setLineDash([2, 3]);
        ctx.beginPath();
        ctx.moveTo(Math.round(fx(hover)) + 0.5, TOP);
        ctx.lineTo(Math.round(fx(hover)) + 0.5, H - AXIS);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      // 合わせた周波数特性
      const mag = new Float32Array(n).fill(1);
      const tmp = new Float32Array(n);
      const ph = new Float32Array(n);
      const { lc, pk } = filters();
      if (eq.on) {
        lc.frequency.value = eq.lowCut;
        lc.getFrequencyResponse(freqs, tmp, ph);
        for (let i = 0; i < n; i++) mag[i] *= tmp[i];
        for (const b of eq.bands) {
          pk.frequency.value = b.freq;
          pk.gain.value = b.gain;
          pk.Q.value = b.q;
          pk.getFrequencyResponse(freqs, tmp, ph);
          for (let i = 0; i < n; i++) mag[i] *= tmp[i];
        }
      }
      ctx.strokeStyle = eq.on ? cssVar("--accent") : cssVar("--muted");
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const y = gy(Math.max(-GMAX - 6, 20 * Math.log10(Math.max(1e-6, mag[i]))));
        if (i) ctx.lineTo((i / (n - 1)) * W, y);
        else ctx.moveTo(0, y);
      }
      ctx.stroke();
      // 点（0 = 低域カット（⌐ の印）、1〜 = 山・谷（番号なし。選んでいる点は差し色））
      pts().forEach(([x, y], i) => {
        const on = i === this.sel;
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 7 : on ? 6 : 5, 0, Math.PI * 2);
        ctx.fillStyle = on ? cssVar("--accent") : cssVar("--muted");
        ctx.fill();
        if (on && i > 0) {
          ctx.strokeStyle = cssVar("--text");
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        if (i === 0) {
          ctx.fillStyle = cssVar("--on-accent");
          ctx.font = "bold 9px sans-serif";
          ctx.textAlign = "center";
          ctx.fillText("⌐", x, y + 3.2);
          ctx.textAlign = "left";
        }
      });
      showReadout();
    };
    this.redrawEq = draw;
    // グラフの下の 1 行: マウスの下の周波数（と帯域の名前）、無ければ選んでいる点
    const showReadout = () => {
      if (hover !== null) {
        const z = zoneAt(hover);
        readout.textContent = z ? `${fmtHz(hover)} · ${z}` : fmtHz(hover);
        return;
      }
      const b = this.sel > 0 ? eq.bands[this.sel - 1] : null;
      readout.textContent = b
        ? `${fmtHz(b.freq)} · ${fmtDb(b.gain)} · ${t("幅 {q}", { q: b.q.toFixed(2) })}`
        : t("ローカット: {f}", { f: fmtHz(eq.lowCut) });
    };
    let dragging = -1;
    const local = (e: MouseEvent) => {
      const r = cv.getBoundingClientRect();
      return [((e.clientX - r.left) / r.width) * W, e.clientY - r.top];
    };
    const nearest = (x: number, y: number) => {
      let best = -1;
      let bd = 14;
      pts().forEach(([px, py], i) => {
        const d = Math.hypot(px - x, py - y);
        if (d < bd) [best, bd] = [i, d];
      });
      return best;
    };
    const select = (i: number) => {
      this.sel = i;
      draw();
      refreshKnobs();
    };
    const removeBand = (i: number) => {
      if (i < 1 || i > eq.bands.length) return;
      this.begin();
      eq.bands.splice(i - 1, 1);
      this.end();
      select(Math.min(i, eq.bands.length));
      this.changed();
    };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = local(e);
      const i = nearest(x, y);
      if (i < 0) return;
      cv.setPointerCapture(e.pointerId);
      dragging = i;
      this.begin();
      select(i);
    });
    cv.addEventListener("pointermove", (e) => {
      const [x, y] = local(e);
      hover = xf(Math.max(0, Math.min(W, x)));
      if (dragging < 0) {
        cv.style.cursor = nearest(x, y) >= 0 ? "grab" : "copy";
        draw();
        return;
      }
      const f = Math.max(FMIN, Math.min(FMAX, hover));
      if (dragging === 0) eq.lowCut = Math.min(f, 1000);
      else {
        eq.bands[dragging - 1].freq = f;
        eq.bands[dragging - 1].gain = Math.round(Math.max(-GMAX, Math.min(GMAX, yg(y))) * 10) / 10;
      }
      draw();
      refreshKnobs();
      this.changed();
    });
    cv.addEventListener("pointerleave", () => {
      hover = null;
      draw();
    });
    cv.addEventListener("pointerup", () => {
      if (dragging >= 0) this.end();
      dragging = -1;
    });
    cv.addEventListener("dblclick", (e) => {
      // 何も無い所をダブルクリック: そこに山・谷の点を足す
      const [x, y] = local(e);
      if (nearest(x, y) >= 0) return;
      if (eq.bands.length >= EQ_MAX_BANDS) {
        readout.textContent = t("ポイントは {n} 個まで追加できます", { n: EQ_MAX_BANDS });
        return;
      }
      this.begin();
      const f = Math.max(FMIN, Math.min(FMAX, xf(x)));
      eq.bands.push({ freq: Math.round(f), gain: Math.round(Math.max(-GMAX, Math.min(GMAX, yg(y))) * 10) / 10, q: 1 });
      eq.on = true;
      this.end();
      sec.classList.remove("off");
      sec.querySelector(".switch")?.classList.add("on");
      select(eq.bands.length);
      this.changed();
    });
    cv.addEventListener("contextmenu", (e) => {
      // 点の上で右クリック: その点を消す
      e.preventDefault();
      const [x, y] = local(e);
      removeBand(nearest(x, y));
    });
    cv.addEventListener("keydown", (e) => {
      if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault();
        e.stopPropagation(); // ピアノロールの音符の削除に渡さない
        removeBand(this.sel);
      }
    });
    cv.addEventListener("wheel", (e) => {
      // 山・谷の点の上でホイール: 幅（Q）を変える
      const [x, y] = local(e);
      const i = nearest(x, y);
      if (i < 1) return;
      e.preventDefault();
      const b = eq.bands[i - 1];
      b.q = Math.max(0.2, Math.min(10, b.q * Math.exp(-e.deltaY * 0.004)));
      this.sel = i;
      draw();
      refreshKnobs();
      this.changed();
    }, { passive: false });

    // 選んでいる点のつまみ（周波数・増減・幅）と、点を消すボタン
    const knobs = document.createElement("div");
    sec.appendChild(knobs);
    const refreshKnobs = () => {
      knobs.innerHTML = "";
      const i = this.sel;
      const b = i > 0 ? eq.bands[i - 1] : null;
      const lf = (v: number) => Math.log2(v);
      this.knobRow(knobs, [
        { label: i === 0 ? t("ローカット") : t("周波数"), el: knob({
          title: t("周波数"), min: lf(FMIN), max: lf(i === 0 ? 1000 : FMAX), def: lf(i === 0 ? 40 : 1000),
          get: () => lf(b ? b.freq : eq.lowCut),
          set: (v) => { if (b) b.freq = 2 ** v; else eq.lowCut = 2 ** v; draw(); this.changed(); },
          fmt: (v) => fmtHz(2 ** v), onStart: this.begin, onEnd: this.end }) },
        { label: t("ゲイン"), el: b ? knob({
          title: t("ゲイン"), min: -GMAX, max: GMAX, def: 0, get: () => b.gain,
          set: (v) => { b.gain = Math.round(v * 10) / 10; draw(); this.changed(); },
          fmt: fmtDb, onStart: this.begin, onEnd: this.end })
          : disabledKnob("—") },
        { label: t("幅（Q）"), el: b ? knob({
          title: t("幅（Q）"), min: 0.2, max: 10, def: 1, get: () => b.q,
          set: (v) => { b.q = Math.round(v * 100) / 100; draw(); this.changed(); },
          fmt: (v) => v.toFixed(2), onStart: this.begin, onEnd: this.end })
          : disabledKnob("12 dB/oct") },
      ]);
      if (b) {
        const del = document.createElement("button");
        del.className = "small eq-del";
        del.textContent = t("このポイントを削除");
        del.addEventListener("click", () => removeBand(i));
        knobs.appendChild(del);
      }
    };
    sec.insertAdjacentHTML("beforeend", `<p class="hint">${t("空いている所をダブルクリックでポイントを追加。ドラッグで移動、ポイントの上でホイールを回すと幅（Q）を調整、右クリックまたは Delete で削除します。⌐ はローカットです。")}</p>`);
    requestAnimationFrame(draw);
    refreshKnobs();
  }

  // ── コンプレッサー ────────────────────────────
  private renderComp(): void {
    const c = this.fx.comp;
    const sec = this.block(t("コンプレッサー"), () => c.on, (v) => { c.on = v; });
    const cv = document.createElement("canvas");
    cv.className = "fx-graph";
    sec.appendChild(cv);
    const W = 260;
    const H = 110;
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = "100%";
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d")!;
    const draw = () => {
      // 入力（横）と出力（縦）の dB の関係。−60〜0 dB
      const scale = cv.clientWidth / W || 1;
      ctx.setTransform(dpr * scale, 0, 0, dpr, 0, 0);
      ctx.fillStyle = cssVar("--pr-bg");
      ctx.fillRect(0, 0, W, H);
      const x = (db: number) => ((db + 60) / 60) * W;
      const y = (db: number) => H - ((db + 60) / 60) * H;
      ctx.strokeStyle = cssVar("--grid-beat");
      ctx.beginPath();
      ctx.moveTo(0, H);
      ctx.lineTo(W, 0);
      ctx.stroke();
      ctx.strokeStyle = c.on ? cssVar("--accent") : cssVar("--muted");
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const knee = 6;
      for (let i = 0; i <= 120; i++) {
        const xin = -60 + i * 0.5;
        let out = xin;
        if (c.on) {
          const over = xin - c.threshold;
          if (over > knee / 2) out = c.threshold + over / c.ratio;
          else if (over > -knee / 2) out = xin + ((1 / c.ratio - 1) * (over + knee / 2) ** 2) / (2 * knee);
        }
        if (i) ctx.lineTo(x(xin), y(out));
        else ctx.moveTo(x(xin), y(out));
      }
      ctx.stroke();
      ctx.fillStyle = cssVar("--muted");
      ctx.font = "9px sans-serif";
      ctx.fillText(t("スレッショルド {db} dB", { db: c.threshold.toFixed(0) }), 6, 12);
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = cssVar("--grid-bar");
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x(c.threshold), 0);
      ctx.lineTo(x(c.threshold), H);
      ctx.stroke();
      ctx.setLineDash([]);
    };
    requestAnimationFrame(draw);
    const set = (fn: () => void) => { fn(); draw(); this.changed(); };
    this.knobRow(sec, [
      { label: t("スレッショルド"), el: knob({ title: t("スレッショルド"), min: -60, max: 0, def: -18, get: () => c.threshold,
        set: (v) => set(() => { c.threshold = Math.round(v * 10) / 10; }), fmt: (v) => `${v.toFixed(1)} dB`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("アタック"), el: knob({ title: t("アタック"), min: 0.001, max: 0.2, def: 0.01, get: () => c.attack,
        set: (v) => set(() => { c.attack = Math.round(v * 1000) / 1000; }), fmt: (v) => `${(v * 1000).toFixed(0)} ms`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("レシオ"), el: knob({ title: t("レシオ"), min: 1, max: 20, def: 3, get: () => c.ratio,
        set: (v) => set(() => { c.ratio = Math.round(v * 10) / 10; }), fmt: (v) => `${v.toFixed(1)} : 1`,
        onStart: this.begin, onEnd: this.end }) },
    ]);
  }

  // ── リバーブ ──────────────────────────────
  // 「残響の形」: 響きが時間とともにどう減っていくか（fx.ts の reverbIR と同じ式）を描き、その上の 3 つの点を動かす。
  //   始まり（下の左の点、左右）= プリディレイ、量（山の点、上下）= ドライ/ウェット、長さ（下の右の点、左右）= 残響の長さ
  private renderReverb(): void {
    const r = this.fx.reverb;
    const sec = this.block(t("リバーブ"), () => r.on, (v) => { r.on = v; draw(); });
    const preset = () => REVERB_PRESETS[r.preset] ?? REVERB_PRESETS.hall;
    // 種類: 選ぶと 3 つの値がその種類らしい値になる（その後で点を動かせる）
    const seg = document.createElement("div");
    seg.className = "seg";
    const segButtons = () => {
      seg.innerHTML = "";
      for (const [k, p] of Object.entries(REVERB_PRESETS)) {
        const b = document.createElement("button");
        b.textContent = p.label;
        b.classList.toggle("on", k === r.preset || (!(r.preset in REVERB_PRESETS) && k === "hall"));
        b.addEventListener("click", () => {
          this.begin();
          r.preset = k as ReverbPreset;
          r.decay = p.decay;
          r.preDelay = p.preDelay;
          r.wet = p.wet;
          this.end();
          segButtons();
          draw();
          this.changed();
        });
        seg.appendChild(b);
      }
    };
    sec.appendChild(seg);
    const cv = document.createElement("canvas");
    cv.className = "fx-graph";
    sec.appendChild(cv);
    const readout = document.createElement("div");
    readout.className = "eq-readout";
    sec.appendChild(readout);
    const W = 260;
    const H = 130;
    const TOP = 8;
    const AXIS = 13; // 時間の目盛りの段
    const BOT = H - AXIS;
    const TMAX = 8; // 残響の長さの上限（秒）
    const LP = 8;
    const PW = W - LP - 8;
    const DB = 60; // 縦軸 0〜−60 dB
    const dpr = window.devicePixelRatio || 1;
    cv.width = W * dpr;
    cv.height = H * dpr;
    cv.style.width = "100%";
    cv.style.height = `${H}px`;
    const ctx = cv.getContext("2d")!;
    // 横軸は時間の平方根（プリディレイの数十 ms と、数秒の尾を同じ幅に収める）
    const tx = (s: number) => LP + Math.sqrt(Math.max(0, s) / TMAX) * PW;
    const xt = (x: number) => TMAX * Math.max(0, (x - LP) / PW) ** 2;
    const dy = (db: number) => TOP + (Math.min(DB, Math.max(0, -db)) / DB) * (BOT - TOP);
    const yd = (y: number) => -((y - TOP) / (BOT - TOP)) * DB;
    const toDb = (a: number) => 20 * Math.log10(Math.max(1e-6, a));
    /** 尾の包絡（reverbIR と同じ: 立ち上がり × 指数の減衰）。始まりからの秒 → 振幅（量 1 のとき） */
    const env = (s: number) => (1 - Math.exp(-s / preset().build)) * Math.exp((-6.9 * s) / Math.max(0.05, r.decay));
    /** 山（包絡がいちばん大きい所）の、始まりからの秒と振幅 */
    const peak = () => {
      let best = 0;
      let bs = 0;
      const n = 200;
      const span = Math.min(r.decay, preset().build * 10 + 0.05);
      for (let i = 1; i <= n; i++) {
        const s = (i / n) * span;
        const v = env(s);
        if (v > best) [best, bs] = [v, s];
      }
      return { s: bs, a: best };
    };
    const pts = (): Array<[number, number]> => {
      const pre = r.preDelay / 1000;
      const pk = peak();
      return [[tx(pre), BOT], [tx(pre + pk.s), dy(toDb(r.wet * pk.a))], [tx(pre + r.decay), BOT]];
    };
    let hoverPt = -1;
    let dragging = -1;
    const draw = () => {
      const scale = cv.clientWidth / W || 1;
      ctx.setTransform(dpr * scale, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = cssVar("--pr-bg");
      ctx.fillRect(0, 0, W, H);
      // 目盛り（時間と、−20・−40 dB）
      ctx.lineWidth = 1;
      ctx.font = "8.5px 'Hiragino Sans', sans-serif";
      ctx.textAlign = "center";
      for (const s of [0.1, 0.5, 1, 2, 4, 8]) {
        const x = Math.round(tx(s)) + 0.5;
        ctx.strokeStyle = cssVar(s === 1 ? "--grid-bar" : "--grid-beat");
        ctx.beginPath();
        ctx.moveTo(x, TOP);
        ctx.lineTo(x, BOT);
        ctx.stroke();
        ctx.fillStyle = cssVar(s === 1 ? "--text" : "--muted");
        ctx.fillText(s === 8 ? "8 s" : String(s), Math.min(x, W - 9), H - 3);
      }
      ctx.strokeStyle = cssVar("--grid-beat");
      ctx.globalAlpha = 0.6;
      for (const db of [-20, -40]) {
        const y = Math.round(dy(db)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(LP, y);
        ctx.lineTo(W, y);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cssVar("--grid-bar");
      ctx.beginPath();
      ctx.moveTo(LP, BOT + 0.5);
      ctx.lineTo(W, BOT + 0.5);
      ctx.stroke();
      const on = r.on;
      const pre = r.preDelay / 1000;
      // 直接音（0 秒の縦線。リバーブを足すと少し下げる。fx.ts の dry と同じ）
      ctx.strokeStyle = cssVar("--text");
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(LP, BOT);
      ctx.lineTo(LP, dy(toDb(on ? 1 - r.wet * 0.5 : 1)));
      ctx.stroke();
      // 初期反射（種類ごとの並び。細い縦線）
      ctx.strokeStyle = cssVar("--muted");
      ctx.lineWidth = 1;
      for (const [ms, g] of preset().early) {
        const x = Math.round(tx(pre + ms / 1000)) + 0.5;
        ctx.beginPath();
        ctx.moveTo(x, BOT);
        ctx.lineTo(x, dy(toDb(r.wet * g)));
        ctx.stroke();
      }
      // 残響の尾（dB。始まりから、−60 dB に届く長さの所まで）
      const n = 160;
      ctx.beginPath();
      ctx.moveTo(tx(pre), BOT);
      for (let i = 1; i <= n; i++) {
        const s = r.decay * (i / n) ** 2; // 頭のほうを細かく
        ctx.lineTo(tx(pre + s), dy(toDb(r.wet * env(s))));
      }
      ctx.lineTo(tx(pre + r.decay), BOT);
      ctx.closePath();
      ctx.fillStyle = cssVar(on ? "--accent" : "--muted");
      ctx.globalAlpha = 0.18;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.strokeStyle = cssVar(on ? "--accent" : "--muted");
      ctx.lineWidth = 1.6;
      ctx.stroke();
      // 3 つの点（数字は出さない。値は下の 1 行）
      const p = pts();
      const labels = [t("始まり"), t("量"), t("長さ")];
      p.forEach(([x, y], i) => {
        const hot = i === dragging || (dragging < 0 && i === hoverPt);
        ctx.beginPath();
        ctx.arc(x, y, hot ? 6 : 5, 0, Math.PI * 2);
        if (i === 1) {
          ctx.fillStyle = cssVar(on ? "--accent" : "--muted");
          ctx.fill();
        } else {
          ctx.fillStyle = cssVar("--pr-bg");
          ctx.fill();
          ctx.strokeStyle = cssVar(on ? "--accent" : "--muted");
          ctx.lineWidth = 2;
          ctx.stroke();
        }
        if (hot && i === 1) {
          ctx.strokeStyle = cssVar("--text");
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
        ctx.fillStyle = cssVar(hot ? "--text" : "--muted");
        if (i === 0) {
          ctx.textAlign = "left";
          ctx.fillText(`${labels[0]} ↔`, x + 8, BOT - 6);
        } else if (i === 1) {
          ctx.textAlign = "left";
          ctx.fillText(`${labels[1]} ↕`, x + 9, Math.max(TOP + 8, y - 4));
        } else {
          ctx.textAlign = "right";
          ctx.fillText(`${labels[2]} ↔`, x - 8, BOT - 6);
        }
      });
      ctx.textAlign = "left";
      readout.textContent = t("長さ {d} 秒 · 量 {w} % · 始まり {p} ms",
        { d: r.decay.toFixed(1), w: Math.round(r.wet * 100), p: Math.round(r.preDelay) });
    };
    const local = (e: MouseEvent) => {
      const rc = cv.getBoundingClientRect();
      return [((e.clientX - rc.left) / rc.width) * W, e.clientY - rc.top];
    };
    const nearest = (x: number, y: number) => {
      let best = -1;
      let bd = 12;
      pts().forEach(([px, py], i) => {
        const d = Math.hypot(px - x, py - y);
        if (d < bd) [best, bd] = [i, d];
      });
      return best;
    };
    const apply = (i: number, x: number, y: number) => {
      if (i === 0) r.preDelay = Math.round(Math.max(0, Math.min(200, xt(x) * 1000)));
      else if (i === 2) r.decay = Math.round(Math.max(0.3, Math.min(TMAX, xt(x) - r.preDelay / 1000)) * 10) / 10;
      else {
        // 山の高さ = 量 × 包絡の山。下の縁まで下げると 0
        const db = yd(y) - toDb(peak().a);
        r.wet = y >= BOT - 1 ? 0 : Math.round(Math.max(0, Math.min(1, 10 ** (db / 20))) * 100) / 100;
      }
    };
    cv.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const [x, y] = local(e);
      const i = nearest(x, y);
      if (i < 0) return;
      cv.setPointerCapture(e.pointerId);
      dragging = i;
      this.begin();
      draw();
    });
    cv.addEventListener("pointermove", (e) => {
      const [x, y] = local(e);
      if (dragging < 0) {
        const h = nearest(x, y);
        cv.style.cursor = h < 0 ? "default" : h === 1 ? "ns-resize" : "ew-resize";
        if (h !== hoverPt) {
          hoverPt = h;
          draw();
        }
        return;
      }
      apply(dragging, x, y);
      draw();
      this.changed();
    });
    cv.addEventListener("pointerleave", () => {
      if (hoverPt >= 0 && dragging < 0) {
        hoverPt = -1;
        draw();
      }
    });
    cv.addEventListener("pointerup", () => {
      if (dragging >= 0) this.end();
      dragging = -1;
      draw();
    });
    cv.addEventListener("dblclick", (e) => {
      // 点をダブルクリック: その値を種類の値に戻す
      const [x, y] = local(e);
      const i = nearest(x, y);
      if (i < 0) return;
      const p = preset();
      this.begin();
      if (i === 0) r.preDelay = p.preDelay;
      else if (i === 1) r.wet = p.wet;
      else r.decay = p.decay;
      this.end();
      draw();
      this.changed();
    });
    segButtons();
    sec.insertAdjacentHTML("beforeend", `<p class="hint">${t("ポイントをドラッグして、プリディレイ・ミックス量・残響の長さを調整します。ダブルクリックで種類の値に戻ります。")}</p>`);
    requestAnimationFrame(draw);
  }
}

function disabledKnob(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "knob disabled";
  el.innerHTML = `<svg class="dial" viewBox="0 0 28 28" width="28" height="28"><circle cx="14" cy="14" r="8.5"/></svg>
    <span class="kval">${text}</span>`;
  return el;
}
