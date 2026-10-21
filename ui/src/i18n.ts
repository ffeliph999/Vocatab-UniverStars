// 画面の言語。文言は日本語で書き、t("…") で包む。日本語の文言をそのまま鍵にして、各言語の表（locales/）から引く。
// 表に無い文言は日本語のまま出す（どれが足りないかは missingKeys() で分かる）。
// 埋め込む値は {名前} で書き、t("書き出す（{n} ファイル）", { n }) のように渡す。
// 言語はブラウザに保存し、変えたら画面を読み込み直す（作ってある部品の文言を全部作り直すより確実なため）。
import { en } from "./locales/en";
import { ko } from "./locales/ko";
import { zh } from "./locales/zh";

export type Lang = "ja" | "en" | "zh" | "ko";
export const LANGS: Array<[Lang, string]> = [["ja", "日本語"], ["en", "English"], ["zh", "中文（简体）"], ["ko", "한국어"]];
const DICTS: Record<Exclude<Lang, "ja">, Record<string, string>> = { en, zh, ko };
const KEY = "svs-editor-lang";

/** URL の ?lang=（画面の確認用。保存しない）、保存した言語、ブラウザの言語（日本語・中国語・韓国語のほかは英語）の順。
 *  部品の中には読み込んだ時点で文言を作るものがあるので、ここで最初に決める。 */
function initial(): Lang {
  if (typeof location === "undefined") return "ja"; // ブラウザの外（node での試験など）
  const q = new URLSearchParams(location.search).get("lang");
  if (q && LANGS.some(([k]) => k === q)) return q as Lang;
  try {
    const s = localStorage.getItem(KEY);
    if (s && LANGS.some(([k]) => k === s)) return s as Lang;
  } catch {
    // 読めなければブラウザの言語
  }
  const nav = (navigator.language || "ja").toLowerCase();
  return nav.startsWith("ja") ? "ja" : nav.startsWith("zh") ? "zh" : nav.startsWith("ko") ? "ko" : "en";
}

let lang: Lang = initial();
const missing = new Set<string>();

export const getLang = (): Lang => lang;

/** 数や日付の書き方に使う言語の札（toLocaleString など）。 */
export const localeTag = (): string => ({ ja: "ja-JP", en: "en-US", zh: "zh-CN", ko: "ko-KR" })[lang];

/** 言語を決める。persist = false は保存しない（画面の確認用）。 */
export function setLang(l: Lang, persist = true): void {
  lang = l;
  document.documentElement.lang = l === "zh" ? "zh-CN" : l;
  if (!persist) return;
  try {
    localStorage.setItem(KEY, l);
  } catch {
    // 保存できなければ、この画面の間だけ
  }
}

export function t(ja: string, vars?: Record<string, string | number>): string {
  let s = ja;
  if (lang !== "ja") {
    const hit = DICTS[lang][ja];
    if (hit === undefined) missing.add(ja);
    else s = hit;
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
  return s;
}

/** 今の言語の表に無かった文言（確認用）。 */
export const missingKeys = (): string[] => [...missing];

/** index.html の文言: data-i18n（中の文字）・data-i18n-title（title）を今の言語にする。 */
export function translateStatic(root: ParentNode = document): void {
  document.documentElement.lang = lang === "zh" ? "zh-CN" : lang;
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n]")) el.textContent = t(el.dataset.i18n!);
  for (const el of root.querySelectorAll<HTMLElement>("[data-i18n-title]")) el.title = t(el.dataset.i18nTitle!);
}
