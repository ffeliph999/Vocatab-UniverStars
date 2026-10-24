// 見本の曲「さくらさくら」（日本の古謡。著作権は切れている）。旋律は手で起こした近似。
import { t as tx } from "./i18n";
import { defaultAttrs, defaultBase, type Note, type Project, TPQ, trackRegion } from "./model";

// [歌詞, MIDI, 拍]。歌詞が空なら休符
const MELODY: Array<[string, number, number]> = [
  ["さ", 69, 1], ["く", 69, 1], ["ら", 71, 2],
  ["さ", 69, 1], ["く", 69, 1], ["ら", 71, 2],
  ["や", 69, 1], ["よ", 71, 1], ["い", 72, 1], ["の", 71, 1],
  ["そ", 69, 1], ["ら", 71, 0.5], ["-", 69, 0.5], ["わ", 65, 1.5], ["", 0, 0.5], // 助詞の「は」は「わ」と歌う
  ["み", 64, 1], ["わ", 60, 1], ["た", 64, 1], ["す", 65, 1],
  ["か", 64, 1], ["ぎ", 64, 0.5], ["-", 60, 0.5], ["り", 59, 1.5], ["", 0, 0.5],
  ["か", 69, 1], ["す", 71, 1], ["み", 72, 1], ["か", 71, 1],
  ["く", 69, 1], ["も", 71, 0.5], ["-", 69, 0.5], ["か", 65, 1.5], ["", 0, 0.5],
  ["に", 64, 1], ["お", 60, 1], ["い", 64, 1], ["ぞ", 65, 1],
  ["い", 64, 1], ["ず", 64, 0.5], ["-", 60, 0.5], ["る", 59, 1.5], ["", 0, 0.5],
  ["い", 69, 1], ["ざ", 69, 1], ["や", 71, 2],
  ["い", 69, 1], ["ざ", 69, 1], ["や", 71, 2],
  ["み", 64, 1], ["に", 65, 1], ["ゆ", 71, 0.5], ["-", 69, 0.5], ["か", 65, 1],
  ["ん", 64, 4],
];

function build(melody: Array<[string, number, number]>, startBeat: number, shift: number, firstId: number): Note[] {
  const notes: Note[] = [];
  let beat = startBeat;
  let id = firstId;
  for (const [lyric, pitch, beats] of melody) {
    if (lyric !== "") {
      notes.push({ id: id++, onset: Math.round(beat * TPQ), dur: Math.round(beats * TPQ), pitch: pitch + shift,
                   lyric, attrs: defaultAttrs() });
    }
    beat += beats;
  }
  return notes;
}

// 今は描画の時間を短くするため、「さくらさくら　やよいのそらは」までだけを使う
const OPENING = MELODY.slice(0, 15);

export function sampleProject(): Project {
  const lead = build(OPENING, 4, 0, 1);
  const p: Project = {
    bpm: 80,
    beatsPerBar: 4,
    activeTrack: 0,
    tracks: [
      { id: 1, name: tx("メロディ"), voice: "ritsu", color: "", notes: lead, mute: false, solo: false,
        base: defaultBase(), params: {} },
    ],
  };
  for (const t of p.tracks) t.region = trackRegion(t, p.beatsPerBar); // 範囲は音符を含む小節まで
  return p;
}
