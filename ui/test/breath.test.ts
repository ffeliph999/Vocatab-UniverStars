// ブレスの置き方と混ぜ方（breath.ts）の試験（node。エンジンは要らない）。
//   npx esbuild@0.25.0 ui/test/breath.test.ts --bundle --platform=node --format=esm --outfile=<作業用>/t.mjs && node <作業用>/t.mjs
import { BREATH_LEAD_SEC, breathPart, breathSlots, nextBreath, pickBreath, SR } from "../src/breath";
import type { PhoneSeg } from "../src/derive";
import type { Note, Project, Track } from "../src/model";
import { close, done, same } from "./golden";

const note = (id: number, onsetSec: number, durSec: number, breath?: { index: number }): Note =>
  ({ id, onset: onsetSec * 1000, dur: durSec * 1000, pitch: 60, lyric: "あ", attrs: { vMod: 1 }, breath });
// 秒 → 刻みを 1000 倍にしているので、noteSec はそのまま秒で作る
const secOf = (ns: Note[]) => new Map(ns.map((n) => [n.id, { start: n.onset / 1000, end: (n.onset + n.dur) / 1000 }]));
const seg = (ph: string, start: number, end: number, noteId: number, idx: number): PhoneSeg =>
  ({ ph, start, end, noteId, idx, vowel: idx > 0, baseStart: start, movable: false, edited: false });

const clips = [
  { id: "a1", singer: 0, frames: 86, sec: 0.5 }, { id: "a2", singer: 0, frames: 52, sec: 0.3 },
  { id: "b1", singer: 1, frames: 43, sec: 0.25 },
];
const ofSinger = (s: number) => clips.map((c, i) => (c.singer === s ? i : -1)).filter((i) => i >= 0);

// ── 入れられる所 ──
{
  // 音符 1: 曲頭 0.6 秒から。音符 2: 1.0 秒（隙間 0.0 → 入れない）。音符 3: 2.0 秒（隙間 0.6）。音符 4: 2.55（隙間 0.05 → 入れない）
  const ns = [note(1, 0.6, 0.4, { index: 0 }), note(2, 1.0, 0.4), note(3, 2.0, 0.5, { index: 1 }), note(4, 2.55, 0.3)];
  const phones = [seg("k", 0.55, 0.6, 1, 0), seg("a", 0.6, 1.0, 1, 1), seg("a", 1.0, 1.4, 2, 0),
                  seg("s", 1.9, 2.0, 3, 0), seg("a", 2.0, 2.5, 3, 1), seg("a", 2.55, 2.85, 4, 0)];
  const slots = breathSlots(ns, phones, secOf(ns), clips, 0);
  same("入れられる所の音符", slots.map((s) => s.noteId), [1, 3]);
  const s1 = slots[0];
  close("曲頭: 終わり = 最初の音素の頭 − 隙間", [s1.end], [0.55 - BREATH_LEAD_SEC]);
  same("曲頭: 置ける頭は 0 から", s1.roomStart, 0);
  same("曲頭: パターンと長さ", [s1.index, s1.sec], [0, 0.5]);
  close("曲頭: 頭 = 終わり − 長さ", [s1.start], [0.55 - BREATH_LEAD_SEC - 0.5]);
  close("曲頭: はみ出しは切る", [s1.cut], [0]);
  const s3 = slots[1];
  close("途中: 置ける頭 = 前の音符の最後の音素の終わり", [s3.roomStart], [1.4]);
  close("途中: 頭を切らない（1.9 − 隙間 − 0.3 > 1.4）", [s3.cut], [0]);
  // 長いパターンを選んでいるときは頭を切る
  const ns2 = [note(1, 0.0, 0.4), note(3, 0.9, 0.5, { index: 0 })];
  const ph2 = [seg("a", 0.0, 0.4, 1, 0), seg("s", 0.85, 0.9, 3, 0), seg("a", 0.9, 1.4, 3, 1)];
  const sl2 = breathSlots(ns2, ph2, secOf(ns2), clips, 0);
  same("頭を切る: 音符", sl2.map((s) => s.noteId), [3]); // 音符 1 は曲頭 0 秒なので置けない
  close("頭を切る: cut = roomStart − start", [sl2[0].cut], [0.4 - (0.85 - BREATH_LEAD_SEC - 0.5)]);
  // まだ入れていない所も出る（index null）。歌い手が違うパターンは無いものと同じ
  const ns3 = [note(1, 1.0, 0.4), note(2, 2.0, 0.4, { index: 2 })];
  const ph3 = [seg("a", 1.0, 1.4, 1, 0), seg("a", 2.0, 2.4, 2, 0)];
  const sl3 = breathSlots(ns3, ph3, secOf(ns3), clips, 0);
  same("まだ入れていない所", sl3.map((s) => [s.noteId, s.index]), [[1, null], [2, null]]);
  // 残りが短すぎる所は出ない（0.05 秒の隙間だが、音符の隙間は 0.1 以上 → 音素で判定）
  const ns4 = [note(1, 0.0, 0.5), note(2, 0.62, 0.4, { index: 1 })];
  const ph4 = [seg("a", 0.0, 0.58, 1, 0), seg("a", 0.62, 1.0, 2, 0)];
  same("残りが 0.06 秒未満なら入れない", breathSlots(ns4, ph4, secOf(ns4), clips, 0).length, 0);
}

// ── パターンの決め方 ──
{
  same("同じ音符の id なら同じパターン", pickBreath(123, ofSinger(0)), pickBreath(123, ofSinger(0)));
  same("その歌い手のパターンから選ぶ", ofSinger(1).includes(pickBreath(7, ofSinger(1))!), true);
  same("パターンが無ければ null", pickBreath(1, []), null);
  same("次のパターンは一つ進む", [nextBreath(0, ofSinger(0)), nextBreath(1, ofSinger(0))], [1, 0]);
}

// ── 混ぜ方（頭切り・フェード・音量の曲線） ──
{
  const project = { bpm: 120 } as Project;
  const base = { loudness: 0, tension: 0, breathiness: 0, gender: 0, voicing: 1, consonant: 0, resonance: 0, growl: 0 };
  const track = { base: { ...base }, params: {} } as unknown as Track;
  const wav = new Float32Array(SR).fill(0.5); // 1 秒
  const slot = { noteId: 1, end: 2.0, roomStart: 1.2, index: 0, start: 1.0, cut: 0.2, sec: 1.0 };
  const p = breathPart(slot, wav, track, project);
  same("頭を切った分だけ短い", p.wav.length, SR - Math.round(0.2 * SR));
  same("置く位置 = 頭 + 切った分", p.start, Math.round(1.2 * SR));
  close("頭を切った所のフェードインの最初は 0", [p.wav[0]], [0], 1e-6);
  close("フェードインの途中（25 ms）は半分", [p.wav[Math.round(0.025 * SR)]], [0.25], 1e-3);
  close("フェードイン（50 ms）の後はそのまま", [p.wav[Math.round(0.08 * SR)]], [0.5]);
  const t2 = { base: { ...base, loudness: -6 }, params: {} } as unknown as Track;
  const q = breathPart(slot, wav, t2, project);
  close("音量 −6 dB が掛かる", [q.wav[Math.round(0.08 * SR)]], [0.5 * 10 ** (-6 / 20)], 1e-6);
  const noCut = { ...slot, cut: 0, start: 1.2 };
  close("頭を切らなければフェードインは掛けない（エンジンの窓のまま）", [breathPart(noCut, wav, track, project).wav[0]], [0.5]);
  const t3 = { base: { ...base }, params: { loudness: { pts: [[0, 0], [100000, 0]], interp: "linear" } } } as unknown as Track;
  const r = breathPart(slot, wav, t3, project);
  close("曲線が 0 なら変わらない", [r.wav[Math.round(0.08 * SR)]], [0.5]);
}

done();
