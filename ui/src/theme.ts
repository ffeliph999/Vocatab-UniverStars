// 配色: 差し色（使う人が選ぶ 1 色）から強調・音符・トラックの色を作り、CSS の変数に入れる。
// mel の配色（色の対応表）もここで持つ。設定はブラウザに保存する（プロジェクトには入れない）。
import { clearCssCache } from "./canvas";
import { t } from "./i18n";
import type { Project, Track } from "./model";

export const DEFAULT_ACCENT = "#909dff";
export const ACCENT_PRESETS = ["#909dff", "#ffa3cd", "#7fd0c6", "#f5c542", "#ff8a5c", "#ff5d73", "#b38cff", "#5b8cff"];

export type MelMapKey = "fuji" | "yozakura" | "ice" | "accent" | "inferno" | "viridis" | "sumi";
/** mel の配色: 名前と、低い値から高い値への色の並び（等間隔に置く）。"accent" は差し色から作る */
export const MEL_MAPS: Record<MelMapKey, { label: string; stops: string[] }> = {
  fuji: { label: t("藤"), stops: ["#0b0d16", "#1b1f4a", "#3f47a8", "#909dff", "#dfe3ff", "#ffffff"] },
  yozakura: { label: t("夜桜"), stops: ["#0b0d16", "#2a1440", "#74287a", "#d65f98", "#ffb3c9", "#fff4f6"] },
  ice: { label: t("氷"), stops: ["#0b0d16", "#0d2f4f", "#1f78a8", "#5fc8e8", "#c4f1ff", "#ffffff"] },
  accent: { label: t("差し色"), stops: [] },
  inferno: { label: "Inferno", stops: ["#000004", "#320a5e", "#781c6d", "#bc3754", "#ed6925", "#fbb61a", "#fcffa4"] },
  viridis: { label: "Viridis", stops: ["#440154", "#414487", "#2a788e", "#22a884", "#7ad151", "#fde725"] },
  sumi: { label: t("墨"), stops: ["#0b0d16", "#3a3d4c", "#8a8ea0", "#e8e9ee"] },
};

interface Settings {
  accent: string;
  melMap: MelMapKey;
}

const KEY = "svs-editor-settings";
let settings: Settings = { accent: DEFAULT_ACCENT, melMap: "fuji" };
const listeners: Array<() => void> = [];

export function loadSettings(): void {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "{}") as Partial<Settings>;
    if (s.accent && /^#[0-9a-f]{6}$/i.test(s.accent)) settings.accent = s.accent.toLowerCase();
    if (s.melMap && s.melMap in MEL_MAPS) settings.melMap = s.melMap;
  } catch {
    // 読めなければ既定のまま
  }
  applyTheme();
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // 保存できない環境（プライベートブラウズなど）では、この画面の間だけ効く
  }
}

export const getAccent = (): string => settings.accent;
export const getMelMap = (): MelMapKey => settings.melMap;

/** persist = false: 保存しない（画面の確認用。使う人の設定を変えないため） */
export function setAccent(hex: string, persist = true): void {
  settings.accent = hex.toLowerCase();
  if (persist) save();
  applyTheme();
}

export function setMelMap(k: MelMapKey, persist = true): void {
  settings.melMap = k;
  if (persist) save();
  applyTheme();
}

/** 色が変わったときに呼ぶ（canvas の描き直しなど）。 */
export function onThemeChange(fn: () => void): void {
  listeners.push(fn);
}

// ── 色の計算 ───────────────────────────────
type Rgb = [number, number, number];
const hexToRgb = (h: string): Rgb => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Rgb;
const rgbToHex = (c: Rgb): string =>
  "#" + c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, "0")).join("");

function rgbToHsl([r, g, b]: Rgb): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  const d = mx - mn;
  if (!d) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  let h = mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  h *= 60;
  return [h < 0 ? h + 360 : h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  h = ((h % 360) + 360) % 360;
  s = Math.max(0, Math.min(1, s));
  l = Math.max(0, Math.min(1, l));
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c]
    : h < 300 ? [x, 0, c] : [c, 0, x];
  return rgbToHex([(r + m) * 255, (g + m) * 255, (b + m) * 255]);
}

/** 色の明るさ（WCAG の相対輝度）。 */
function luminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** その色の上に載せる文字の色（明るい色には濃い字、暗い色には白い字）。 */
export const textOn = (hex: string): string => (luminance(hex) > 0.4 ? "#0b0d16" : "#ffffff");

/** 2 色を混ぜる（t = 0 で a、1 で b）。 */
function mix(a: string, b: string, t: number): string {
  const x = hexToRgb(a);
  const y = hexToRgb(b);
  return rgbToHex([0, 1, 2].map((i) => x[i] + (y[i] - x[i]) * t) as Rgb);
}

// トラックの色（自動）: 差し色から色相をずらして作る。1 本目は差し色そのもの
const HUE_STEPS = [0, 97, -60, 40, 180, -120, 140, -25];
/** 以前の既定の色（読み込んだときは自動の色として扱う） */
const LEGACY = new Set(["#86b43c", "#3d7bb5", "#c47a3a", "#9a5fc0", "#3aa6a0", "#c0566e", "#4f6f93"]);

function autoColor(i: number): string {
  if (i === 0) return settings.accent;
  const [h, s, l] = rgbToHsl(hexToRgb(settings.accent));
  let hue = (((h + HUE_STEPS[i % HUE_STEPS.length]) % 360) + 360) % 360;
  // 自動の色は黄緑〜緑（70〜160°）を避ける（ほかの歌声合成のエディタの色に寄らないように）。差し色に選んだときは別
  if (hue > 70 && hue < 160) hue = hue < 115 ? 45 : 175;
  return hslToHex(hue, Math.max(0.45, s), Math.min(0.78, Math.max(0.6, l)));
}

/** トラックの色。色を決めていなければ（空・以前の既定の色）、差し色から作った自動の色。 */
export function trackColor(p: Project, t: Track): string {
  if (t.color && /^#[0-9a-f]{6}$/i.test(t.color) && !LEGACY.has(t.color.toLowerCase())) return t.color;
  return autoColor(Math.max(0, p.tracks.indexOf(t)));
}

/** mel の色の対応表（256 色 × RGBA）。 */
export function melLut(): Uint8Array {
  const k = settings.melMap;
  const a = settings.accent;
  const stops = k === "accent" ? ["#0b0d16", mix("#0b0d16", a, 0.35), a, mix(a, "#ffffff", 0.6), "#ffffff"]
    : MEL_MAPS[k].stops;
  const out = new Uint8Array(256 * 4);
  for (let i = 0; i < 256; i++) {
    const x = (i / 255) * (stops.length - 1);
    const j = Math.min(stops.length - 2, Math.floor(x));
    const [r, g, b] = hexToRgb(mix(stops[j], stops[j + 1], x - j));
    out.set([r, g, b, 255], i * 4);
  }
  return out;
}

/** CSS のグラデーション（設定の画面の見本用）。 */
export function melGradient(k: MelMapKey): string {
  const a = settings.accent;
  const stops = k === "accent" ? ["#0b0d16", mix("#0b0d16", a, 0.35), a, mix(a, "#ffffff", 0.6), "#ffffff"]
    : MEL_MAPS[k].stops;
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}

/** 差し色から作る CSS の変数を入れ、canvas に描き直しを頼む。 */
export function applyTheme(): void {
  const a = settings.accent;
  const root = document.documentElement.style;
  root.setProperty("--accent", a);
  root.setProperty("--accent-hi", mix(a, "#ffffff", 0.25));
  root.setProperty("--accent-soft", a + "33");
  root.setProperty("--accent-faint", a + "14");
  root.setProperty("--on-accent", textOn(a));
  clearCssCache();
  for (const f of listeners) f();
}
