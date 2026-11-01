// mel のパネル: 3 種の mel を、それぞれオンオフできる行として縦に並べる。オフの行は計算もしない。
// 描画は WebGL2。生の値（本来の 172 fps）を texture に入れ、見えている範囲だけを Retina の解像度で色付けする。
//   拡大したとき: 時間は補間せずフレームをそのまま見せ、周波数は隣の bin と線形補間する
//   縮小したとき: 1 画素に入る複数のフレームの最大値を見せる（細い子音が消えないように）
import { cssVar, HiDpiCanvas, requestDraw } from "./canvas";
import type { Derived } from "./derive";
import { binToHz, MEL_FLOOR, type MelKind, N_MELS, synthMel } from "./fakemel";
import { drawTimeGrid } from "./grid";
import { FPS, secPerTick } from "./model";
import type { Store } from "./store";
import { t } from "./i18n";
import { melLut, onThemeChange } from "./theme";
import { KEY_W, type View, wheelScrollX } from "./view";

const VS = `#version 300 es
in vec2 p;
out vec2 uv;
void main() { uv = p * 0.5 + 0.5; gl_Position = vec4(p, 0.0, 1.0); }`;

const FS = `#version 300 es
precision highp float;
precision highp sampler2D;
uniform sampler2D tex;
uniform float frame0;   // 左端のフレーム
uniform float span;     // 横幅ぶんのフレーム数
uniform float perPx;    // 1 画素あたりのフレーム数
uniform float nFrames;
uniform float chunkW;   // 折り返しの幅（texture の 1 段のフレーム数）
uniform float vmin;
uniform float vmax;
uniform sampler2D lut;  // 色の対応表（256 × 1、theme.ts の melLut）
uniform vec3 bg;        // 値の無い所の色
in vec2 uv;
out vec4 o;
float at(float fr, float bin) {
  if (fr < 0.0 || fr >= nFrames) return -99.0;
  // 長い曲は chunkW フレームごとに折り返して、128 bin ずつ縦に積んである
  float chunk = floor(fr / chunkW);
  int x = int(fr - chunk * chunkW);
  int y0 = int(chunk) * ${N_MELS};
  float b0 = floor(bin);
  float a = texelFetch(tex, ivec2(x, y0 + int(b0)), 0).r;
  float c = texelFetch(tex, ivec2(x, y0 + min(int(b0) + 1, ${N_MELS - 1})), 0).r;
  return mix(a, c, bin - b0);
}
void main() {
  float fr = frame0 + uv.x * span;
  float bin = uv.y * ${(N_MELS - 1).toFixed(1)};
  float v = -99.0;
  if (perPx <= 1.0) {
    v = at(fr, bin);
  } else {
    float n = min(ceil(perPx), 16.0);
    for (int k = 0; k < 16; k++) {
      if (float(k) >= n) break;
      v = max(v, at(fr + float(k) * perPx / n, bin));
    }
  }
  if (v < -98.0) { o = vec4(bg, 1.0); return; }
  float t = clamp((v - vmin) / (vmax - vmin), 0.0, 1.0);
  o = vec4(texture(lut, vec2((t * 255.0 + 0.5) / 256.0, 0.5)).rgb, 1.0);
}`;

/** "#rrggbb" → [0..1] ×3（値の無い所の色を CSS の変数から取る）。 */
function rgb01(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return [0.06, 0.07, 0.11];
  const n = parseInt(m[1], 16);
  return [(n >> 16) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

// 配色を変えたら、各行が次に描くときに色の対応表を入れ直す
let lutVersion = 1;
onThemeChange(() => { lutVersion++; });

class MelRow {
  readonly el: HTMLElement;
  private gl: WebGL2RenderingContext | null;
  private prog: WebGLProgram | null = null;
  private tex: WebGLTexture | null = null;
  private nFrames = 0;
  private chunkW = 1;
  private overlay: HiDpiCanvas;
  private glCanvas: HTMLCanvasElement;
  private hover: { x: number; y: number } | null = null;
  data: Float32Array | null = null;

  constructor(private title: string, private store: Store, private view: View, private snapTicks: () => number) {
    this.el = document.createElement("div");
    this.el.className = "mel-row";
    this.glCanvas = document.createElement("canvas");
    const ov = document.createElement("canvas");
    this.el.append(this.glCanvas, ov);
    this.gl = this.glCanvas.getContext("webgl2", { antialias: false, premultipliedAlpha: false });
    if (this.gl) this.initGl(this.gl);
    this.overlay = new HiDpiCanvas(ov, () => this.draw());
    ov.addEventListener("pointermove", (e) => {
      this.hover = { x: e.offsetX, y: e.offsetY };
      this.redraw();
    });
    ov.addEventListener("pointerleave", () => {
      this.hover = null;
      this.redraw();
    });
    ov.addEventListener("wheel", (e) => wheelScrollX(this.view, e), { passive: false }); // 横スクロールと横の拡大縮小
  }

  private initGl(gl: WebGL2RenderingContext): void {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error(gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) console.error(gl.getProgramInfoLog(prog));
    this.prog = prog;
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, "p");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    this.lutTex = gl.createTexture();
  }
  private lutTex: WebGLTexture | null = null;
  private lutLoaded = 0;

  private uploadLut(gl: WebGL2RenderingContext): void {
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, melLut());
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.activeTexture(gl.TEXTURE0);
    this.lutLoaded = lutVersion;
  }

  setData(data: Float32Array | null): void {
    this.data = data;
    const gl = this.gl;
    if (!gl || !data) return;
    // texture の幅には上限がある（多くは 16384 フレーム ≈ 95 秒）。長い曲は上限の幅で折り返し、
    // 128 bin ずつ縦に積む（段の数も上限まで。16384 なら 128 段 ≈ 3 時間。それより先は切る）
    const n = data.length / N_MELS;
    const maxW = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number;
    const cw = Math.min(n, maxW);
    const rows = Math.min(Math.ceil(n / cw), Math.floor(maxW / N_MELS));
    let buf = data;
    if (rows > 1) {
      buf = new Float32Array(cw * N_MELS * rows).fill(MEL_FLOOR);
      for (let r = 0; r < rows; r++) {
        const s = r * cw;
        const len = Math.min(cw, n - s);
        for (let b = 0; b < N_MELS; b++) buf.set(data.subarray(b * n + s, b * n + s + len), (r * N_MELS + b) * cw);
      }
    }
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, cw, N_MELS * rows, 0, gl.RED, gl.FLOAT, buf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.nFrames = Math.min(n, cw * rows);
    this.chunkW = cw;
    this.redraw();
  }

  redraw(): void {
    requestDraw(() => this.draw());
  }

  private framesAt(x: number): number {
    return this.view.xToTick(x) * secPerTick(this.store.project.bpm) * FPS;
  }

  draw(): void {
    const { ctx, w, h } = this.overlay;
    const dpr = window.devicePixelRatio || 1;
    const gl = this.gl;
    if (gl && this.prog) {
      const W = Math.round(w * dpr);
      const H = Math.round(h * dpr);
      if (this.glCanvas.width !== W || this.glCanvas.height !== H) {
        this.glCanvas.width = W;
        this.glCanvas.height = H;
      }
      const bg = rgb01(cssVar("--pr-bg"));
      gl.clearColor(bg[0], bg[1], bg[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (this.lutLoaded !== lutVersion) this.uploadLut(gl);
      if (this.data && this.nFrames) {
        const x0 = Math.round(KEY_W * dpr);
        gl.viewport(x0, 0, W - x0, H);
        gl.useProgram(this.prog);
        const f0 = this.framesAt(KEY_W);
        const span = this.framesAt(w) - f0;
        const u = (name: string) => gl.getUniformLocation(this.prog!, name);
        gl.uniform1f(u("frame0"), f0);
        gl.uniform1f(u("span"), span);
        gl.uniform1f(u("perPx"), span / (W - x0));
        gl.uniform1f(u("nFrames"), this.nFrames);
        gl.uniform1f(u("chunkW"), this.chunkW);
        gl.uniform1f(u("vmin"), MEL_FLOOR);
        gl.uniform1f(u("vmax"), 2.0);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.tex);
        gl.uniform1i(u("tex"), 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.lutTex);
        gl.uniform1i(u("lut"), 1);
        gl.uniform3f(u("bg"), bg[0], bg[1], bg[2]);
        gl.activeTexture(gl.TEXTURE0);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    // 重ね書き（2D）: 縦線は薄く、再生位置、左の欄の周波数、カーソルの値
    ctx.clearRect(0, 0, w, h);
    ctx.globalAlpha = 0.35;
    drawTimeGrid(ctx, this.view, this.store.project.beatsPerBar, Math.max(480, this.snapTicks()), 0, h, w);
    ctx.globalAlpha = 1;
    const px = this.view.tickToX(this.store.playTick);
    if (px >= KEY_W) {
      ctx.fillStyle = cssVar("--playhead");
      ctx.fillRect(Math.round(px), 0, 1, h);
    }
    ctx.fillStyle = cssVar("--panel");
    ctx.fillRect(0, 0, KEY_W, h);
    ctx.font = "10px 'Hiragino Sans', sans-serif";
    ctx.fillStyle = cssVar("--muted");
    ctx.textAlign = "right";
    let lastY = Infinity; // 低い方から描き、近すぎる目盛りの文字は省く（行を縮めたとき）
    for (const f of [250, 500, 1000, 2000, 4000, 8000, 16000]) {
      const b = (Math.log10(1 + f / 700) - Math.log10(1 + 40 / 700)) / (Math.log10(1 + 16000 / 700) - Math.log10(1 + 40 / 700));
      const y = h - b * h;
      ctx.fillRect(KEY_W - 4, y, 4, 1);
      const ty = Math.min(h - 2, Math.max(10, y + 3));
      if (lastY - ty < 11) continue;
      ctx.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, KEY_W - 6, ty);
      lastY = ty;
    }
    ctx.textAlign = "left";
    ctx.fillStyle = cssVar("--text");
    ctx.font = "11px 'Hiragino Sans', sans-serif";
    ctx.fillText(this.title, KEY_W + 8, 14);
    if (!this.data) {
      ctx.fillStyle = cssVar("--muted");
      ctx.fillText(t("計算中…（フレーズの合成が終わると表示されます）"), KEY_W + 8, h / 2 + 4);
    }
    const hv = this.hover;
    if (hv && hv.x > KEY_W && this.data) {
      const fr = Math.floor(this.framesAt(hv.x));
      const bin = Math.max(0, Math.min(N_MELS - 1, Math.round(((h - hv.y) / h) * (N_MELS - 1))));
      const n = this.data.length / N_MELS;
      const val = fr >= 0 && fr < n ? this.data[bin * n + fr] : NaN;
      const text = t("{sec} s（{fr} フレーム）　{hz} Hz（bin {bin}）　{val}", {
        sec: (fr / FPS).toFixed(3), fr, hz: Math.round(binToHz(bin)), bin, val: Number.isNaN(val) ? "—" : val.toFixed(2) });
      ctx.fillStyle = cssVar("--tip-bg");
      const tw = ctx.measureText(text).width + 12;
      const bx = Math.min(w - tw - 4, hv.x + 12);
      ctx.fillRect(bx, Math.max(2, hv.y - 22), tw, 18);
      ctx.fillStyle = cssVar("--text");
      ctx.fillText(text, bx + 6, Math.max(2, hv.y - 22) + 13);
      ctx.fillStyle = cssVar("--cursor-line");
      ctx.fillRect(Math.round(hv.x), 0, 1, h);
    }
  }
}

const KINDS: Array<[MelKind, string, string]> = [
  ["acoustic", t("① ボコーダに入れる mel（postfilter 後）"), "①"],
  ["vocoder", t("② ボコーダの出力の mel（声の調整なし）"), "②"],
  ["final", t("③ 声の調整を掛けた音の mel"), "③"],
];
const HEAD_H = 32;
const MIN_ROW = 30;

export class MelPanel {
  private rowH = 96; // 1 行の高さ（パネルの縁をドラッグすると変わる。行のオンオフでは保つ）
  readonly el: HTMLElement;
  private rows: MelRow[];
  private on = [true, false, false];
  private keys: string[] = ["", "", ""]; // 計算したときの状態（変わっていなければ計算し直さない）
  private timer = 0;
  private head: HTMLElement;
  private body: HTMLElement;

  /** エンジンの mel（kind ごと）: 版と、中身を作る関数。エンジンにつながっていなければ null（見せかけの mel を作る）。
   *  data() は曲全体の配列を作り直す（4 分の曲で 20 MB ほど）ので、版が変わったときだけ呼ぶ。 */
  engineMel: ((kind: MelKind) => { data: () => Float32Array | null; rev: number } | null) | null = null;

  constructor(private store: Store, view: View, private derived: () => Derived, snapTicks: () => number) {
    this.el = document.createElement("div");
    this.el.className = "mel-panel";
    this.head = document.createElement("div");
    this.head.className = "pp-head";
    this.body = document.createElement("div");
    this.body.className = "mel-body";
    this.el.append(this.head, this.body);
    this.rows = KINDS.map(([, title]) => new MelRow(title, store, view, snapTicks));
    this.renderHead();
    this.layout();
    this.schedule();
  }

  private renderHead(): void {
    this.head.innerHTML = `<span>mel</span>` + KINDS.map(([, title, short], i) =>
      `<button class="chip ${this.on[i] ? "on" : ""}" data-i="${i}" title="${title}">${short} ${
        [t("ボコーダの入力"), t("ボコーダの出力"), t("声の調整後")][i]}</button>`).join("") +
      `<span class="muted pp-value">${this.engineMel
        ? t("エンジンの mel。② は声の調整を掛けない音（②③ はオンのときだけ作る）")
        : t("仮のデータです（エンジン未接続）。オフの行は計算しません")}</span>`;
    for (const b of this.head.querySelectorAll<HTMLButtonElement>(".chip")) {
      b.addEventListener("click", () => {
        const i = Number(b.dataset.i);
        this.on[i] = !this.on[i];
        this.renderHead();
        this.layout();
        this.schedule();
        this.onToggle();
      });
    }
  }

  private layout(): void {
    this.body.innerHTML = "";
    this.rows.forEach((r, i) => {
      if (this.on[i]) this.body.appendChild(r.el);
    });
    this.el.style.height = `${HEAD_H + this.rowH * this.count()}px`;
  }

  private count(): number {
    return this.on.filter(Boolean).length;
  }

  /** パネルの高さの下限（見出し＋各行 30 px）。 */
  minHeight(): number {
    return HEAD_H + MIN_ROW * this.count();
  }

  /** パネルの縁をドラッグしたとき: 行の高さを覚え直す。 */
  onResize(h: number): void {
    if (this.count()) this.rowH = Math.max(MIN_ROW, (h - HEAD_H) / this.count());
  }

  setEngine(fn: (kind: MelKind) => { data: () => Float32Array | null; rev: number } | null): void {
    this.engineMel = fn;
    this.keys = ["", "", ""];
    this.renderHead();
    this.schedule();
  }

  isOn(i: number): boolean {
    return this.on[i];
  }

  /** 行をオンオフしたとき（エンジンに ② を頼み直すため） */
  onToggle: () => void = () => undefined;

  setOn(on: boolean[]): void {
    this.on = on.slice(0, 3);
    this.renderHead();
    this.layout();
    this.schedule();
  }

  /** 編集のたびに呼ぶ。少し待ってから、オンの行だけを計算する。 */
  schedule(): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.compute(), 120);
  }

  private compute(): void {
    const s = this.store;
    const nsf = s.vocoderNsf;
    // パネルごと閉じている（下のタブ）間は計算しない。開いたときに main.ts が schedule() を呼ぶ
    if (this.el.hidden) return;
    KINDS.forEach(([kind], i) => {
      if (!this.on[i]) return;
      const eng = this.engineMel?.(kind) ?? null;
      if (eng) {
        // エンジンの mel（① ボコーダの入力、②③ 出た音の mel）。版が変わったときだけ曲全体の配列を作る
        const key = `eng|${eng.rev}|${s.project.activeTrack}`;
        if (key === this.keys[i]) return;
        this.keys[i] = key;
        this.rows[i].setData(eng.data());
        return;
      }
      const key = `${s.version}|${s.project.activeTrack}|${kind === "final" ? s.vocoder : ""}`;
      if (key === this.keys[i]) return;
      this.keys[i] = key;
      this.rows[i].setData(synthMel(s.project, s.track, this.derived(), kind, nsf));
    });
  }

  redraw(): void {
    this.rows.forEach((r, i) => {
      if (this.on[i]) r.redraw();
    });
  }
}
