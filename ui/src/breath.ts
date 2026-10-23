// ブレス（息継ぎ）: 入れられる所の判定と置き方、トラックの波形への混ぜ方。
// 音そのものはエンジン（engine-web/core.ts・engine/pipeline.py の breath）が、ボイスバンクに入れたブレスの mel を
// ボコーダで鳴らして作る。画面はそれを「音量」の曲線（パラメータ）で増減して、エフェクトの前の波形に足す。
// 入れるかどうかは音符ごとにユーザーが決める（音素のタイミングのパネルの「＋ 息」）。パターンは音符の id から決まる
// （保存・読み込みで変わらない）。
import type { BreathContext, PhoneSeg } from "./derive";
import { toSamples } from "./engine-web/voiceparams";
import { FPS, type Note, type Project, secPerTick, type Track } from "./model";
import { evalCurve, paramDef } from "./params";

export const SR = 44100;
/** 直前の音符の終わりからこの秒数以上空いている音符の前に入れられる */
export const BREATH_GAP_SEC = 0.1;
/**
 * ブレスの終わり = 音符の最初の音素の頭のこれだけ前（短い休みを挟む）。
 * 音響モデルの音は先頭の pau に少し漏れる（正解データ 4 フレーズの実測: ピーク −50 dB 以上の漏れは頭の 29 ms 前まで、
 * −60 dB でも 35 ms 前まで）ので、それと重ならないように 40 ms 空ける。素材の端にも 20 ms の余白とフェードがある
 */
export const BREATH_LEAD_SEC = 0.04;
/** 置ける所がこれより短ければ入れない（頭を切った残り） */
export const BREATH_MIN_SEC = 0.06;
/** まだ入れていない所に出す印の、仮の長さ（秒） */
const MARK_SEC = 0.3;
/** 頭を切って置くときのフェードイン（秒）。エンジンがブレスの両端に掛ける Tukey 窓と同じ長さ */
export const BREATH_FADE_SEC = 0.05;

export interface BreathClipInfo {
  id: string;
  singer: number;
  frames: number;
  sec: number;
}

/** ブレスを入れられる所（音符の前）。index があれば入れてある */
export interface BreathSlot {
  noteId: number;
  /** 終わり（秒）= 最初の音素の頭 − BREATH_LEAD_SEC */
  end: number;
  /** これより前には置けない（前の音符の最後の音素の終わり。曲頭は 0） */
  roomStart: number;
  /** 入れてあるパターン（ブレスの束の中の番号）。null = まだ入れていない */
  index: number | null;
  /** 頭（秒）。index があればパターンの長さから、無ければ印の仮の長さから */
  start: number;
  /** 頭を切る秒数（roomStart より前にはみ出す分） */
  cut: number;
  /** パターンの長さ（index が無ければ仮の長さ） */
  sec: number;
}

/** 音符の id から決まる最初のパターン（FNV-1a）。n はその歌い手のパターンの数 */
export function pickBreath(noteId: number, clipsOfSinger: number[]): number | null {
  if (!clipsOfSinger.length) return null;
  let h = 0x811c9dc5;
  for (const ch of String(noteId)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return clipsOfSinger[h % clipsOfSinger.length];
}

/** 今のパターンの次（その歌い手のパターンの中で一つ進める）。今のが一覧に無ければ最初 */
export function nextBreath(current: number, clipsOfSinger: number[]): number | null {
  if (!clipsOfSinger.length) return null;
  const i = clipsOfSinger.indexOf(current);
  return clipsOfSinger[(i + 1) % clipsOfSinger.length];
}

/** その歌い手のパターン（束の中の番号） */
export const clipIndicesOf = (ctx: BreathContext): number[] =>
  ctx.clips.map((c, i) => (c.singer === ctx.singer ? i : -1)).filter((i) => i >= 0);

/** 音符にブレスを入れる（無ければ id から決めたパターン、あれば次のパターンに替える）。パターンが無ければ false */
export function addOrCycleBreath(note: Note, ctx: BreathContext): boolean {
  const own = clipIndicesOf(ctx);
  const next = note.breath ? nextBreath(note.breath.index, own) : pickBreath(note.id, own);
  if (next === null) return false;
  note.breath = { index: next };
  return true;
}

/**
 * 入れられる所と、入れてあるブレスの置き方。
 * notes: トラックの範囲で切った音符（頭の順）。phones: 音素のタイミング（エンジンの結果かモック）。
 * clips: ブレスの束の一覧（全歌い手）。singer: このトラックの歌い手の id
 */
export function breathSlots(notes: Note[], phones: PhoneSeg[], noteSec: Map<number, { start: number; end: number }>,
                            clips: BreathClipInfo[], singer: number): BreathSlot[] {
  const first = new Map<number, number>(); // 音符 → 最初の音素の頭
  const last = new Map<number, number>(); // 音符 → 最後の音素の終わり
  for (const s of phones) {
    if (s.idx === 0 || !first.has(s.noteId)) first.set(s.noteId, Math.min(first.get(s.noteId) ?? Infinity, s.start));
    last.set(s.noteId, Math.max(last.get(s.noteId) ?? -Infinity, s.end));
  }
  const out: BreathSlot[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const sec = noteSec.get(n.id);
    if (!sec) continue;
    const prev = i > 0 ? notes[i - 1] : null;
    const prevEnd = prev ? noteSec.get(prev.id)!.end : -Infinity;
    if (sec.start - prevEnd < BREATH_GAP_SEC) continue;
    const head = first.get(n.id) ?? sec.start;
    const end = head - BREATH_LEAD_SEC;
    const roomStart = prev ? Math.max(last.get(prev.id) ?? prevEnd, prevEnd) : 0;
    if (end - roomStart < BREATH_MIN_SEC) continue;
    const idx = n.breath?.index ?? null;
    const clip = idx !== null ? clips[idx] : undefined;
    const index = clip && clip.singer === singer ? idx : null; // 歌い手を替えたら元のパターンは使えない
    const len = index !== null ? clips[index].sec : MARK_SEC;
    const start = end - len;
    const cut = Math.max(0, roomStart - start);
    if (index !== null && len - cut < BREATH_MIN_SEC) continue;
    out.push({ noteId: n.id, end, roomStart, index, start, cut, sec: len });
  }
  return out;
}

/**
 * ブレスの波形を、トラックの波形に足す形（絶対のサンプル位置と波形）にする。
 * 頭を切った分は 10 ms のフェードイン。「音量」の曲線（トラック全体の値 + 曲線、−48〜+12 dB）を声と同じ式
 * （engine/voiceparams.py の finish: 3 フレームの移動平均 → サンプルに補間 → 10^(dB/20)）で掛ける。リミッタは掛けない
 */
export function breathPart(slot: BreathSlot, wav: Float32Array, track: Track, project: Project): { start: number; wav: Float32Array } {
  const cutN = Math.min(wav.length, Math.round(slot.cut * SR));
  const w = wav.slice(cutN);
  if (cutN > 0) {
    // 頭を切った所は、エンジンが掛けた Tukey 窓の立ち上がりも切れているので、同じ長さの余弦のフェードインを掛ける
    const fade = Math.min(w.length, Math.round(BREATH_FADE_SEC * SR));
    for (let i = 0; i < fade; i++) w[i] *= 0.5 * (1 - Math.cos((Math.PI * (i + 0.5)) / fade));
  }
  const startSec = slot.start + slot.cut;
  const start = Math.round(startSec * SR);
  // 音量の曲線（フレームごと → サンプルごと）
  const d = paramDef("loudness");
  const curve = track.params.loudness;
  const base = track.base.loudness;
  if (curve || base !== d.def) {
    const spt = secPerTick(project.bpm);
    const f0 = Math.floor(startSec * FPS);
    const T = Math.max(1, Math.ceil(w.length / 256) + 1);
    const db = new Float32Array(T);
    let any = false;
    for (let i = 0; i < T; i++) {
      const v = Math.min(d.max, Math.max(d.min, base + evalCurve(curve, (f0 + i) / FPS / spt, d.def)));
      db[i] = v;
      if (v !== 0) any = true;
    }
    if (any) {
      const s = toSamples(db, w.length);
      for (let i = 0; i < w.length; i++) w[i] = Math.fround(w[i] * Math.fround(10 ** (s[i] / 20)));
    }
  }
  return { start, wav: w };
}
