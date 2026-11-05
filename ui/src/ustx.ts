// OpenUtau の .ustx（YAML）の読み込みと書き出し。ブラウザだけで動く（YAML は vendor/js-yaml.mjs）。
//   読み込み: voice_parts の音符（position・duration・tone・lyric）をトラック（track_no）ごとにまとめる。
//            テンポは tempos の最初（無ければ bpm）、刻みは resolution で 480 に直す。歌詞は UST と同じ正規化
//            （連続音・カタカナ・伸ばし）に加えて、OpenUtau の書き方「+」「+~」（伸ばし）、「br」「br2」（ブレス）、
//            「か[k a]」の音素の指定（括弧の前だけ使う）を扱う。ピッチの線・表情は読まない。
//   書き出し: 歌のトラックごとに 1 トラック・1 パート。音符・歌詞・テンポ・拍子だけ（ピッチは OpenUtau に任せる）。
//            ひな形は OpenUtau 0.1.x の新規プロジェクト（ustx_version 0.10、既定の表情の一覧）。

import { load as yamlLoad, dump as yamlDump } from "./vendor/js-yaml.mjs";
import { t as tx } from "./i18n";
import { normalizeUstLyric, type ScoreResult, type ScoreTrack } from "./score";
import type { ManualVibrato, Project } from "./model";
import { importPitch } from "./pitchimport";
import { isAudioTrack } from "./model";

const TPQ = 480;

/** OpenUtau の歌詞 → VocaTab の歌詞。null = 休符（ブレスなら breath） */
function ustxLyric(raw: string): { lyric: string | null; breath: boolean } {
  let s = String(raw ?? "").trim();
  if (/^br\d*$/i.test(s)) return { lyric: null, breath: true };
  if (/^\+[~*]?$/.test(s)) return { lyric: "-", breath: false };          // 伸ばし（前の音符の母音のまま）
  const b = s.indexOf("[");
  if (b > 0) s = s.slice(0, b).trim();                                    // 「か[k a]」→「か」
  const u = normalizeUstLyric(s);
  if (u.breath) return { lyric: null, breath: true };
  if (u.rest) return { lyric: null, breath: false };
  return { lyric: u.lyric, breath: false };
}

interface UstxVibrato { length?: number; period?: number; depth?: number; in?: number; out?: number }
interface UstxNote { position: number; duration: number; tone: number; lyric: string; vibrato?: UstxVibrato }
interface UstxCurve { abbr?: string; xs?: number[]; ys?: number[] }
interface UstxPart { track_no?: number; position?: number; name?: string; notes?: UstxNote[]; curves?: UstxCurve[] }
interface UstxDoc {
  bpm?: number; resolution?: number; tempos?: Array<{ position: number; bpm: number }>;
  tracks?: Array<{ track_name?: string }>; voice_parts?: UstxPart[];
}

/** OpenUtau のビブラート（length = 音符に対する % ・period = ms ・depth = セント・in/out = %）→ 手のビブラート。length が 0 ならなし。 */
function ustxVibrato(v: UstxVibrato | undefined, dur: number, bpm: number): ManualVibrato | null {
  const length = Number(v?.length ?? 0);
  if (!v || !(length > 0) || !(Number(v.period) > 0)) return null;
  const len = Math.min(100, length) / 100;
  const sec = (dur * len * 60) / (bpm * TPQ);
  return { depth: Math.max(0, Math.min(200, Number(v.depth ?? 25))), rate: Math.max(2, Math.min(10, 1000 / Number(v.period))),
           start: Math.min(0.9, 1 - len), fadeIn: Math.min(1.5, (sec * Number(v.in ?? 0)) / 100),
           fadeOut: Math.min(1.5, (sec * Number(v.out ?? 0)) / 100) };
}

export function parseUstx(text: string): ScoreResult {
  const doc = yamlLoad(text) as UstxDoc;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.voice_parts)) throw new Error(tx("USTX として読めません"));
  const warnings: string[] = [];
  const scale = TPQ / (Number(doc.resolution) || TPQ);
  const tempos = (doc.tempos ?? []).filter((t) => Number(t.bpm) > 0);
  const bpm = Number(tempos[0]?.bpm ?? doc.bpm) || 120;
  if (new Set(tempos.map((t) => Number(t.bpm))).size > 1) {
    warnings.push(tx("テンポが途中で変わります（未対応）。最初の値 {bpm} を使います", { bpm }));
  }
  // トラック番号ごとに、パートの位置を足した絶対位置で音符を集める
  const byTrack = new Map<number, Array<{ onset: number; dur: number; pitch: number; raw: string; vib?: UstxVibrato }>>();
  const pitdByTrack = new Map<number, Array<[number, number]>>();
  for (const part of doc.voice_parts) {
    const k = Number(part.track_no ?? 0);
    const list = byTrack.get(k) ?? [];
    for (const n of part.notes ?? []) {
      list.push({ onset: (Number(part.position ?? 0) + Number(n.position)) * scale, dur: Number(n.duration) * scale,
                  pitch: Number(n.tone), raw: String(n.lyric ?? ""), vib: n.vibrato });
    }
    byTrack.set(k, list);
    // ピッチの線（pitd: 刻み・セント。パートの位置からの相対）
    for (const c of part.curves ?? []) {
      if (c.abbr !== "pitd" || !c.xs || !c.ys) continue;
      const arr = pitdByTrack.get(k) ?? [];
      for (let i = 0; i < c.xs.length; i++) arr.push([(Number(part.position ?? 0) + Number(c.xs[i])) * scale, Number(c.ys[i])]);
      pitdByTrack.set(k, arr);
    }
  }
  const tracks: ScoreTrack[] = [];
  let breaths = 0;
  for (const [k, list] of [...byTrack.entries()].sort((a, b) => a[0] - b[0])) {
    list.sort((a, b) => a.onset - b.onset);
    const notes: ScoreTrack["notes"] = [];
    let breath = false;
    for (const n of list) {
      const l = ustxLyric(n.raw);
      if (l.breath) {
        breath = true;
        breaths++;
        continue;
      }
      if (l.lyric === null || !(n.dur > 0)) continue;
      const vib = ustxVibrato(n.vib, n.dur, bpm);
      notes.push({ onset: Math.round(n.onset), dur: Math.max(1, Math.round(n.dur)), pitch: n.pitch, lyric: l.lyric,
                   ...(breath ? { breath: true } : {}), ...(vib ? { vib } : {}) });
      breath = false;
    }
    if (!notes.length) continue;
    const track: ScoreTrack = { name: doc.tracks?.[k]?.track_name ?? `Track${k + 1}`, notes };
    const pit = importPitch(notes, pitdByTrack.get(k) ?? [], bpm);
    if (pit) {
      track.params = { pitchDelta: pit.curve };
      for (const i of pit.traced) { notes[i].iMod = 0; notes[i].vMod = 0; }
      if (pit.traced.length) warnings.push(tx("ピッチの線を取り込みました（{n} 音符は AI の抑揚を切ってあります）", { n: pit.traced.length }));
    }
    tracks.push(track);
  }
  if (breaths) warnings.push(tx("ブレスの記号 {n} 個を休符にしました", { n: breaths }));
  return { bpm, tracks, warnings };
}

// ── 書き出し ───────────────────────────────────
// OpenUtau の新規プロジェクトの頭（表情の一覧は OpenUtau が読むときに要る）
const EXPRESSIONS: Record<string, unknown> = Object.fromEntries(([
  ["dyn", "dynamics (curve)", "Curve", -240, 120, 0, false, ""], ["pitd", "pitch deviation (curve)", "Curve", -1200, 1200, 0, false, ""],
  ["clr", "voice color", "Options", 0, -1, 0, false, null], ["eng", "resampler engine", "Options", 0, 1, 0, false, ["", "worldline"]],
  ["vel", "velocity", "Numerical", 0, 200, 100, false, ""], ["vol", "volume", "Numerical", 0, 200, 100, false, ""],
  ["atk", "attack", "Numerical", 0, 200, 100, false, ""], ["dec", "decay", "Numerical", 0, 100, 0, false, ""],
  ["gen", "gender", "Numerical", -100, 100, 0, true, "g"], ["genc", "gender (curve)", "Curve", -100, 100, 0, false, ""],
  ["bre", "breath", "Numerical", 0, 100, 0, true, "B"], ["brec", "breathiness (curve)", "Curve", -100, 100, 0, false, ""],
  ["lpf", "lowpass", "Numerical", 0, 100, 0, true, "H"], ["norm", "normalize", "Numerical", 0, 100, 86, true, "P"],
  ["mod", "modulation", "Numerical", 0, 100, 0, false, ""], ["mod+", "modulation plus", "Numerical", 0, 100, 0, false, ""],
  ["alt", "alternate", "Numerical", 0, 16, 0, false, ""], ["dir", "direct", "Options", 0, 1, 0, false, ["off", "on"]],
  ["shft", "tone shift", "Numerical", -36, 36, 0, false, ""], ["shfc", "tone shift (curve)", "Curve", -1200, 1200, 0, false, ""],
  ["tenc", "tension (curve)", "Curve", -100, 100, 0, false, ""], ["voic", "voicing (curve)", "Curve", 0, 100, 100, false, ""],
  ["clry", "voice color y", "Options", 0, -1, 0, false, null], ["xsy", "cross synthesis (curve)", "Curve", 0, 100, 0, false, ""],
  ["grwc", "growl (curve)", "Curve", 0, 100, 0, false, ""],
  ["rpit", "rendered pitch (masked curve)", "MaskedCurve", 2400, 10800, 6000, false, ""],
  ["pito", "pitch override (masked curve)", "MaskedCurve", 2400, 10800, 6000, false, ""],
] as Array<[string, string, string, number, number, number, boolean, string | string[] | null]>).map(
  ([abbr, name, type, min, max, def, isFlag, flagOrOptions]) => {
    const e: Record<string, unknown> = { name, abbr, type, min, max, default_value: def, is_flag: isFlag };
    if (type === "Options") e.options = Array.isArray(flagOrOptions) ? flagOrOptions : [];
    else e.flag = flagOrOptions ?? "";
    e.skip_output_if_default = false;
    return [abbr, e];
  }));

const COLORS = ["Blue", "Pink", "Yellow", "Green", "Purple", "Orange", "Teal", "Red"];

export function toUstx(p: Project, name: string): string {
  const vocals = p.tracks.filter((t) => !isAudioTrack(t));
  const bpm = Math.round(p.bpm * 1000) / 1000;
  const doc = {
    name, comment: "", output_dir: "Vocal", cache_dir: "UCache", ustx_version: "0.10",
    bpm, beat_per_bar: p.beatsPerBar, beat_unit: 4,
    expressions: EXPRESSIONS,
    exp_selectors: ["dyn", "pitd", "clr", "eng", "vel", "vol", "atk", "dec", "gen", "bre"],
    exp_primary: 0, exp_secondary: 1, key: 0,
    time_signatures: [{ bar_position: 0, beat_per_bar: p.beatsPerBar, beat_unit: 4 }],
    tempos: [{ position: 0, bpm }],
    tracks: vocals.map((t, i) => ({
      phonemizer: "OpenUtau.Core.DefaultPhonemizer", renderer_settings: {}, track_name: t.name || `Track${i + 1}`,
      track_color: COLORS[i % COLORS.length], mute: t.mute, solo: t.solo, volume: 0, pan: 0,
      track_expressions: [], voice_color_names: [""],
    })),
    voice_parts: vocals.map((t, i) => {
      const notes = [...t.notes].sort((a, b) => a.onset - b.onset);
      const end = notes.reduce((m, n) => Math.max(m, n.onset + n.dur), 0);
      const bar = p.beatsPerBar * TPQ;
      return {
        duration: Math.max(bar, Math.ceil(end / bar) * bar), name: t.name || `Track${i + 1}`, comment: "",
        track_no: i, position: 0,
        notes: notes.map((n) => ({
          position: n.onset, duration: n.dur, tone: n.pitch,
          lyric: n.lyric === "-" || n.lyric === "ー" ? "+" : n.lyric,   // 伸ばしは OpenUtau の「+」
          pitch: { data: [{ x: -25, y: 0, shape: "io" }, { x: 25, y: 0, shape: "io" }], snap_first: true },
          vibrato: { length: 0, period: 175, depth: 25, in: 10, out: 10, shift: 0, drift: 0, vol_link: 0 },
          tuning: 0, phoneme_expressions: [], phoneme_overrides: [],
        })),
        curves: [], masked_curves: [],
      };
    }),
    wave_parts: [],
  };
  return yamlDump(doc, { lineWidth: -1, noRefs: true, flowLevel: -1 });
}
