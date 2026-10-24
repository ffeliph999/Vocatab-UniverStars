// UST の読み込み（score.ts）の試験: UTAU の記法（連続音・音高の後置き・「息」・覚え書きの音符・カタカナ）と文字コード。node で動く。
//   npx esbuild@0.25.0 ui/test/ust.test.ts --bundle --platform=node --format=esm --outfile=<作業用>/t.mjs && node <作業用>/t.mjs
import { normalizeUstLyric, parseUst } from "../src/score";
import { done, same } from "./golden";

const note = (i: number, len: number, lyric: string, num: number) => `[#${String(i).padStart(4, "0")}]\nLength=${len}\nLyric=${lyric}\nNoteNum=${num}\n`;
const ust = "[#VERSION]\nUST Version1.2\n[#SETTING]\nTempo=120.00\nCharset=UTF-8\nTracks=1\n"
  + note(0, 480, "ust by someone", 60)   // 覚え書き → 休符
  + note(1, 480, "- か", 60)              // 連続音の頭
  + note(2, 480, "a き", 62)              // 連続音
  + note(3, 240, "a 息", 62)              // ブレス → 休符、次の音符に印
  + note(4, 240, "R", 0)                  // 休符
  + note(5, 480, "i くA#4", 70)           // 音高の後置き
  + note(6, 480, "u ・", 70)              // 「・」→ 伸ばし
  + note(7, 480, "a shi", 64)             // 連続音のローマ字
  + note(8, 480, "カ", 64)                // カタカナ
  + note(9, 480, "k a", 64)               // 音素を直接書いた歌詞はそのまま
  + "[#TRACKEND]\n";
const r = parseUst(new TextEncoder().encode(ust));
const ns = r.tracks[0].notes;
same("テンポ", r.bpm, 120);
same("歌詞", ns.map((n) => n.lyric), ["か", "き", "く", "-", "shi", "か", "k a"]);
same("頭（刻み）", ns.map((n) => n.onset), [480, 960, 1920, 2400, 2880, 3360, 3840]);
same("ブレスの印", ns.map((n) => !!n.breath), [false, false, true, false, false, false, false]);
same("注意の数", r.warnings.length, 3);

// 歌詞 1 つずつの正規化
same("連続音の母音", normalizeUstLyric("o ら").lyric, "ら");
same("連続音の n", normalizeUstLyric("n ぼ").lyric, "ぼ");
same("音素の列は連続音と見ない", normalizeUstLyric("a k a").lyric, "a k a");
same("息吸", normalizeUstLyric("a 息吸").breath, true);
same("息捨", normalizeUstLyric("u 息捨").rest, true);
same("br", normalizeUstLyric("br").breath, true);
same("音源の接尾辞", normalizeUstLyric("u うLR").lyric, "う");
same("矢印の接尾辞", normalizeUstLyric("か↑").lyric, "か");
same("＼ は伸ばし", normalizeUstLyric("o ＼").lyric, "-");
same("単独音はそのまま", normalizeUstLyric("りょ").lyric, "りょ");
same("ローマ字 1 語はそのまま", normalizeUstLyric("ka").lyric, "ka");
same("空は休符", normalizeUstLyric("").rest, true);
same("伸ばし棒は休符にしない", normalizeUstLyric("-").rest, false);

// Shift_JIS（Charset 無し）: 「か」= 82 A9
const enc = (s: string) => Array.from(new TextEncoder().encode(s));
const sj = new Uint8Array([...enc("[#SETTING]\nTempo=100\n[#0000]\nLength=480\nLyric="), 0x82, 0xa9, ...enc("\nNoteNum=60\n")]);
same("Shift_JIS の歌詞", parseUst(sj).tracks[0].notes[0].lyric, "か");

done();
