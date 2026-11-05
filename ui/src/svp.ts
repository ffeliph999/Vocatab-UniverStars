// Synthesizer V の .svp（JSON）の読み込み。音符（歌詞・音高）、テンポ、ピッチのずれ（pitchDelta）と、
// 音量・テンション・ブレシネス・ジェンダー・ビブラートの強さの曲線を取り込む。時間は blick（705600000 = 4 分音符）→ 刻み（480）。
import { t as tx } from "./i18n";
import type { Curve, Interp, ParamKey } from "./model";
import { importPitch } from "./pitchimport";
import { normalizeUstLyric, type ScoreResult, type ScoreTrack } from "./score";

const BLICK_PER_TICK = 705600000 / 480;
const MAPPED: ParamKey[] = ["vibratoEnv", "loudness", "tension", "breathiness", "gender"];

interface SvpPoints { mode?: string; points?: number[] }
interface SvpNote { onset: number; duration: number; lyrics?: string; pitch: number; musicalType?: string }
interface SvpGroup { uuid?: string; notes?: SvpNote[]; parameters?: Record<string, SvpPoints> }
interface SvpRef { groupID?: string; blickAbsoluteBegin?: number; blickOffset?: number; pitchOffset?: number }
interface SvpDoc {
  time?: { tempo?: Array<{ position: number; bpm: number }> };
  library?: SvpGroup[];
  tracks?: Array<{ name?: string; mainGroup?: SvpGroup; mainRef?: SvpRef; groups?: SvpRef[] }>;
}

const toInterp = (m?: string): Interp => (m === "linear" || m === "cosine" ? m : "cubic");

function toPts(p: SvpPoints | undefined, shift: number): Array<[number, number]> {
  const a = p?.points ?? [];
  const out: Array<[number, number]> = [];
  for (let i = 0; i + 1 < a.length; i += 2) out.push([(Number(a[i]) + shift) / BLICK_PER_TICK, Number(a[i + 1])]);
  return out;
}

export function parseSvp(text: string): ScoreResult {
  let doc: SvpDoc;
  try {
    doc = JSON.parse(text.replace(/^\uFEFF/, "").replace(/[\0\s]+$/, "")) as SvpDoc;
  } catch {
    throw new Error(tx("SVP として読めません"));
  }
  if (!doc || !Array.isArray(doc.tracks)) throw new Error(tx("SVP として読めません"));
  const warnings: string[] = [];
  const tempos = (doc.time?.tempo ?? []).filter((x) => Number(x.bpm) > 0);
  const bpm = Number(tempos[0]?.bpm) || 120;
  if (new Set(tempos.map((x) => Number(x.bpm))).size > 1) {
    warnings.push(tx("テンポが途中で変わります（未対応）。最初の値 {bpm} を使います", { bpm }));
  }
  const lib = new Map((doc.library ?? []).map((g) => [g.uuid, g] as const));
  const tracks: ScoreTrack[] = [];
  let breaths = 0;
  (doc.tracks).forEach((tr, ti) => {
    // メインのグループと、ライブラリのグループの参照（位置のずれ・移調つき）
    const parts: Array<{ g: SvpGroup; shift: number; tone: number }> = [];
    if (tr.mainGroup) parts.push({ g: tr.mainGroup, shift: 0, tone: Number(tr.mainRef?.pitchOffset ?? 0) });
    for (const r of tr.groups ?? []) {
      const g = lib.get(r.groupID);
      if (g) parts.push({ g, shift: Number(r.blickAbsoluteBegin ?? 0) - Number(r.blickOffset ?? 0), tone: Number(r.pitchOffset ?? 0) });
    }
    const raw: Array<{ onset: number; dur: number; pitch: number; lyric: string; breath?: boolean }> = [];
    for (const { g, shift, tone } of parts) {
      for (const n of g.notes ?? []) {
        if (n.musicalType && n.musicalType !== "singing") continue;
        raw.push({ onset: (Number(n.onset) + shift) / BLICK_PER_TICK, dur: Number(n.duration) / BLICK_PER_TICK,
                   pitch: Number(n.pitch) + tone, lyric: String(n.lyrics ?? "") });
      }
    }
    raw.sort((a, b) => a.onset - b.onset);
    const notes: ScoreTrack["notes"] = [];
    let breath = false;
    for (const n of raw) {
      const u = normalizeUstLyric(n.lyric);
      if (u.breath) { breath = true; breaths++; continue; }
      if (u.rest || !(n.dur > 0)) continue;
      notes.push({ onset: Math.round(n.onset), dur: Math.max(1, Math.round(n.dur)), pitch: n.pitch, lyric: u.lyric,
                   ...(breath ? { breath: true } : {}) });
      breath = false;
    }
    if (!notes.length) return;
    const track: ScoreTrack = { name: tr.name || `Track${ti + 1}`, notes };
    const params: Partial<Record<ParamKey, Curve>> = {};
    const main = tr.mainGroup?.parameters ?? {};
    const pit = importPitch(notes, toPts(main.pitchDelta, 0), bpm, toInterp(main.pitchDelta?.mode));
    if (pit) {
      params.pitchDelta = pit.curve;
      for (const i of pit.traced) { notes[i].iMod = 0; notes[i].vMod = 0; }
      if (pit.traced.length) warnings.push(tx("ピッチの線を取り込みました（{n} 音符は AI の抑揚を切ってあります）", { n: pit.traced.length }));
    }
    for (const k of MAPPED) {
      const pts = toPts(main[k], 0);
      if (pts.length) params[k] = { pts, interp: toInterp(main[k]?.mode) };
    }
    if (Object.keys(params).length) track.params = params;
    tracks.push(track);
  });
  if (breaths) warnings.push(tx("ブレスの記号 {n} 個を休符にしました", { n: breaths }));
  return { bpm, tracks, warnings };
}
