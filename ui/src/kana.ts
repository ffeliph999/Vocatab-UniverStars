// モック用の小さな「かな → 音素」の表（LeapSinger の日本語の音素の名前に合わせる）。
// 本物の G2P はエンジン側（PrettyPitch の dict/ja.mora）を使う。

const ROWS: Array<[string, string, string]> = [
  // [かな 5 つ, 子音, 母音の並び]
  ["あいうえお", "", "aiueo"],
  ["かきくけこ", "k", "aiueo"],
  ["がぎぐげご", "g", "aiueo"],
  ["さすせそ", "s", "aueo"],
  ["ざずぜぞ", "z", "aueo"],
  ["たてと", "t", "aeo"],
  ["だでど", "d", "aeo"],
  ["なにぬねの", "n", "aiueo"],
  ["はへほ", "h", "aeo"],
  ["ばびぶべぼ", "b", "aiueo"],
  ["ぱぴぷぺぽ", "p", "aiueo"],
  ["まみむめも", "m", "aiueo"],
  ["やゆよ", "y", "auo"],
  ["らりるれろ", "r", "aiueo"],
  ["わ", "w", "a"],
];

const TABLE: Record<string, string[]> = {
  し: ["sh", "i"], じ: ["j", "i"], ち: ["ch", "i"], ぢ: ["j", "i"], つ: ["ts", "u"], づ: ["z", "u"],
  ひ: ["h", "i"], ふ: ["f", "u"], を: ["o"], ん: ["N"], っ: ["cl"],
};
for (const [kana, c, vowels] of ROWS) {
  [...kana].forEach((k, i) => {
    TABLE[k] = c ? [c, vowels[i]] : [vowels[i]];
  });
}

const toHiragana = (s: string): string =>
  s.replace(/[ァ-ヶ]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0x60));

/** 歌詞 1 つを音素の並びにする。伸ばし（"-"・"ー"）は空（前の母音を続ける）。 */
export function g2p(lyric: string): string[] {
  const s = lyric.trim();
  if (s === "" || s === "-" || s === "ー" || s === "+") return [];
  if (s.includes(" ")) return s.split(/\s+/); // 音素を直に書いたもの
  const h = toHiragana(s);
  const out: string[] = [];
  for (const ch of h) {
    const p = TABLE[ch];
    if (p) out.push(...p);
  }
  return out.length ? out : [s];
}

export const VOWELS = new Set(["a", "i", "u", "e", "o", "N"]);

/** 子音の既定の長さ（秒）。モックの見た目用。 */
export function consonantSec(ph: string): number {
  if (["s", "sh", "ts", "ch", "f", "h", "z", "j"].includes(ph)) return 0.09;
  if (["k", "t", "p", "cl"].includes(ph)) return 0.05;
  return 0.06;
}
