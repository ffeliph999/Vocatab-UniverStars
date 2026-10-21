// 左の帯の「音作り」: 選んでいる（歌の）トラックのイコライザー・コンプレッサー・リバーブ。
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
    sw.title = t("入り切り");
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
      // 帯域の名前（縞と、上の段の文字）
      ctx.font = "8.5px 'Hiragino Sans', sans-serif";
      ctx.textAlign = "center";
      ZONES.forEach(([a, b, name], i) => {
        const xa = fx(a);
        const xb = fx(b);
        ctx.fillStyle = cssVar("--accent");
        ctx.globalAlpha = i % 2 ? 0.07 : 0.035;
        ctx.fillRect(xa, TOP, xb - xa, H - AXIS - TOP);
        ctx.globalAlpha = 1;
        ctx.fillStyle = cssVar("--muted");
        ctx.fillText(name, (xa + xb) / 2, 10);
      });
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
        ctx.fillText(t("合成が済むと、声のスペクトルがここに出ます"), W / 2, MID + HALF * 0.55);
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
        : t("低域カット: {f}", { f: fmtHz(eq.lowCut) });
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
        readout.textContent = t("点は {n} 個までです", { n: EQ_MAX_BANDS });
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
        { label: i === 0 ? t("低域カット") : t("周波数"), el: knob({
          title: t("周波数"), min: lf(FMIN), max: lf(i === 0 ? 1000 : FMAX), def: lf(i === 0 ? 40 : 1000),
          get: () => lf(b ? b.freq : eq.lowCut),
          set: (v) => { if (b) b.freq = 2 ** v; else eq.lowCut = 2 ** v; draw(); this.changed(); },
          fmt: (v) => fmtHz(2 ** v), onStart: this.begin, onEnd: this.end }) },
        { label: t("増減"), el: b ? knob({
          title: t("増減"), min: -GMAX, max: GMAX, def: 0, get: () => b.gain,
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
        del.textContent = t("この点を消す");
        del.addEventListener("click", () => removeBand(i));
        knobs.appendChild(del);
      }
    };
    sec.insertAdjacentHTML("beforeend", `<p class="hint">${t("何も無い所をダブルクリックで点を足す。点をドラッグで動かし、点の上でホイールで幅、右クリックか Delete で消す。⌐ は低域カット。")}</p>`);
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
      ctx.fillText(t("しきい値 {db} dB", { db: c.threshold.toFixed(0) }), 6, 12);
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
      { label: t("しきい値"), el: knob({ title: t("しきい値"), min: -60, max: 0, def: -18, get: () => c.threshold,
        set: (v) => set(() => { c.threshold = Math.round(v * 10) / 10; }), fmt: (v) => `${v.toFixed(1)} dB`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("アタック"), el: knob({ title: t("アタック"), min: 0.001, max: 0.2, def: 0.01, get: () => c.attack,
        set: (v) => set(() => { c.attack = Math.round(v * 1000) / 1000; }), fmt: (v) => `${(v * 1000).toFixed(0)} ms`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("比"), el: knob({ title: t("比"), min: 1, max: 20, def: 3, get: () => c.ratio,
        set: (v) => set(() => { c.ratio = Math.round(v * 10) / 10; }), fmt: (v) => `${v.toFixed(1)} : 1`,
        onStart: this.begin, onEnd: this.end }) },
    ]);
    sec.insertAdjacentHTML("beforeend", `<p class="hint">${t("下がった分は大まかに持ち上げます（音量が下がりすぎないように）。")}</p>`);
  }

  // ── リバーブ ──────────────────────────────
  private renderReverb(): void {
    const r = this.fx.reverb;
    const sec = this.block(t("リバーブ"), () => r.on, (v) => { r.on = v; });
    const sel = document.createElement("select");
    sel.className = "fx-select";
    for (const [k, p] of Object.entries(REVERB_PRESETS)) {
      sel.insertAdjacentHTML("beforeend", `<option value="${k}">${t("{name}（{sec} 秒）", { name: p.label, sec: p.decay })}</option>`);
    }
    sel.value = r.preset in REVERB_PRESETS ? r.preset : "hall";
    const box = document.createElement("div");
    sel.addEventListener("change", () => {
      // 種類を選ぶと、つまみもその種類らしい値にする（その後で好みに回せる）
      this.begin();
      const p = REVERB_PRESETS[sel.value as ReverbPreset];
      r.preset = sel.value as ReverbPreset;
      r.decay = p.decay;
      r.preDelay = p.preDelay;
      r.wet = p.wet;
      this.end();
      drawKnobs();
      this.changed();
    });
    sec.appendChild(sel);
    sec.appendChild(box);
    const drawKnobs = () => {
      box.innerHTML = "";
      this.knobKnobs(box, r);
    };
    drawKnobs();
    sec.insertAdjacentHTML("beforeend", `<p class="hint">${t("種類を選ぶと、つまみがその種類の値になります。")}</p>`);
  }

  private knobKnobs(box: HTMLElement, r: TrackFx["reverb"]): void {
    const p = REVERB_PRESETS[r.preset] ?? REVERB_PRESETS.hall;
    // つまみの真上（ダブルクリックで戻る値）は、選んでいる種類の値
    this.knobRow(box, [
      { label: t("プリディレイ"), el: knob({ title: t("プリディレイ"), min: 0, max: 200, def: p.preDelay, get: () => r.preDelay,
        set: (v) => { r.preDelay = Math.round(v); this.changed(); }, fmt: (v) => `${v.toFixed(0)} ms`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("残響の長さ"), el: knob({ title: t("残響の長さ"), min: 0.3, max: 8, def: p.decay, get: () => r.decay,
        set: (v) => { r.decay = Math.round(v * 10) / 10; this.changed(); }, fmt: (v) => `${v.toFixed(1)} s`,
        onStart: this.begin, onEnd: this.end }) },
      { label: t("ドライ/ウェット"), el: knob({ title: t("ドライ/ウェット"), min: 0, max: 1, def: p.wet, get: () => r.wet,
        set: (v) => { r.wet = Math.round(v * 100) / 100; this.changed(); }, fmt: (v) => `${Math.round(v * 100)} %`,
        onStart: this.begin, onEnd: this.end }) },
    ]);
  }
}

function disabledKnob(text: string): HTMLElement {
  const el = document.createElement("div");
  el.className = "knob disabled";
  el.innerHTML = `<svg class="dial" viewBox="0 0 28 28" width="28" height="28"><circle cx="14" cy="14" r="8.5"/></svg>
    <span class="kval">${text}</span>`;
  return el;
}
