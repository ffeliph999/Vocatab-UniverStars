// 楽譜の読み込み（UST・MusicXML・.mxl）。ブラウザだけで読む（エンジンは要らない）。
// PrettyPitch の svs/score_io.py と同じ規則で読む（結果が一致することを確かめてある）:
//   UST: [#xxxx] の Length（480 = 4 分音符）・Lyric・NoteNum、Tempo=。文字コードは cp932（Charset=UTF-8 や BOM があれば UTF-8）
//   MusicXML: 歌詞のあるパートごと。和音の構成音・装飾音は飛ばす。タイは 1 つの音符にまとめる。
//            テンポは <sound tempo> か <metronome>。複数の声部・backup/forward・繰り返し・途中のテンポ変更は未対応（注意を出す）
// 休符・メリスマの記号は日本語の言語パック（PrettyPitch の dict/ja.yaml の score:）と同じ。言語を増やすときはここを差し替える。

import { t as tx } from "./i18n";

export interface ScoreTrack {
  name: string;
  notes: Array<{ onset: number; dur: number; pitch: number; lyric: string }>; // 刻み（4 分音符 = 480）
}
export interface ScoreResult {
  bpm: number;
  tracks: ScoreTrack[];
  warnings: string[];
}

const TPQ = 480;
const REST_LYRICS = new Set(["R", "r", "pau", "sil", "sp", "AP", "SP", "", "ー", "ｰ", "-", "+"]);
const MELISMA_LYRICS = new Set(["ー", "ｰ", "-", "+"]);
const STEP: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

interface RawNote {
  beats: number;
  midi: number;
  lyric: string | null;
  rest: boolean;
}

/** 休符を除き、刻みに直す。歌詞の無い音符は「-」（メリスマ）にする。 */
function toTrack(name: string, notes: RawNote[]): ScoreTrack {
  const out: ScoreTrack["notes"] = [];
  let beat = 0;
  for (const n of notes) {
    if (!n.rest && n.midi > 0) {
      out.push({ onset: Math.round(beat * TPQ), dur: Math.max(1, Math.round(n.beats * TPQ)), pitch: n.midi,
                 lyric: (n.lyric ?? "-").trim() || "-" });
    }
    beat += n.beats;
  }
  return { name, notes: out };
}

// ── UST ─────────────────────────────────────
/** UST の文字コード: BOM か Charset=UTF-8 があれば UTF-8。無ければ UTF-8 → Shift_JIS → EUC-KR（CP949）の順に、
 * 読み損ないの無いものを使う（Shift_JIS の日本語が UTF-8 として通ることはまず無い）。どれも駄目なら Shift_JIS。 */
function decodeUst(bytes: Uint8Array): string {
  const head = new TextDecoder("latin1").decode(bytes.subarray(0, 4096));
  if ((bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) || /Charset\s*=\s*UTF-8/i.test(head)) {
    return new TextDecoder("utf-8").decode(bytes);
  }
  for (const enc of ["utf-8", "shift_jis", "euc-kr"]) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch {
      // 次の文字コードを試す
    }
  }
  return new TextDecoder("shift_jis").decode(bytes);
}

export function parseUst(bytes: Uint8Array): ScoreResult {
  const txt = decodeUst(bytes);
  const tm = /^Tempo=([\d.]+)/m.exec(txt);
  const bpm = tm ? Number(tm[1]) : 120;
  const notes: RawNote[] = [];
  const re = /\[#(\d+|PREV|NEXT)\]([\s\S]*?)(?=\[#|$)/g;
  for (let m = re.exec(txt); m; m = re.exec(txt)) {
    const f: Record<string, string> = {};
    for (const line of m[2].split(/\r?\n/)) {
      const kv = /^([A-Za-z0-9]+)=(.*)$/.exec(line);
      if (kv) f[kv[1]] = kv[2];
    }
    if (!("Length" in f)) continue;
    const lyric = (f.Lyric ?? "").trim();
    const rest = REST_LYRICS.has(lyric) && !MELISMA_LYRICS.has(lyric);
    notes.push({ beats: Number(f.Length) / TPQ, midi: Number(f.NoteNum || 0) || 0, lyric, rest });
  }
  return { bpm, tracks: [toTrack("", notes)], warnings: [] };
}

// ── MusicXML ──────────────────────────────────
const local = (e: Element): string => e.localName;
const kids = (e: Element, name: string): Element[] => [...e.children].filter((c) => local(c) === name);
const kid = (e: Element, name: string): Element | undefined => kids(e, name)[0];
const all = (e: Element | Document, name: string): Element[] => [...e.getElementsByTagNameNS("*", name)];

export function parseMusicXml(text: string): ScoreResult {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.getElementsByTagName("parsererror").length) throw new Error(tx("MusicXML として読めません（XML が壊れています）"));
  const warnings: string[] = [];
  const names = new Map<string, string>();
  for (const sp of all(doc, "score-part")) names.set(sp.getAttribute("id") ?? "", kid(sp, "part-name")?.textContent?.trim() ?? "");
  const parts = all(doc, "part");
  if (!parts.length) throw new Error(tx("<part> がありません"));
  const withLyric = parts.filter((p) => all(p, "lyric").length);
  const chosen = withLyric.length ? withLyric : parts.slice(0, 1);
  if (parts.length > chosen.length) {
    warnings.push(tx("{all} パートのうち、歌詞のある {n} パートを読みました", { all: parts.length, n: chosen.length }));
  }
  let bpm = 0;
  const tracks: ScoreTrack[] = [];
  for (const part of chosen) {
    const pid = part.getAttribute("id") ?? "";
    const label = names.get(pid) || pid;
    const warn = (msg: string) => warnings.push(chosen.length > 1 ? `${label}: ${msg}` : msg);
    // 未対応の記法を知らせる（黙って違う音を出さない）
    const voices = new Set(all(part, "voice").map((v) => v.textContent?.trim()).filter(Boolean));
    if (voices.size > 1) warn(tx("声部が {n} つあります（未対応）。全部つなげて読むので譜面と違う音になります", { n: voices.size }));
    if (all(part, "backup").length || all(part, "forward").length) warn(tx("<backup>/<forward> があります（未対応）。時刻がずれます"));
    if (all(part, "repeat").length) warn(tx("繰り返し記号があります（未対応）。展開せず、書かれた順に 1 回だけ歌います"));
    const divs = all(part, "divisions").map((d) => Number(d.textContent)).filter((v) => v > 0);
    if (new Set(divs).size > 1) warn(tx("divisions が途中で変わります（未対応）。最初の値を使います"));
    const divisions = divs[0] ?? 1;
    let tempos = all(part, "sound").map((s) => Number(s.getAttribute("tempo"))).filter((v) => v > 0);
    if (!tempos.length) {
      tempos = all(part, "metronome").map((m) => Number(kid(m, "per-minute")?.textContent?.trim())).filter((v) => v > 0);
    }
    if (new Set(tempos).size > 1) warn(tx("テンポが途中で変わります（未対応）。最初の値 {bpm} を使います", { bpm: tempos[0] }));
    if (!bpm && tempos.length) bpm = tempos[0];
    // 音符
    const notes: RawNote[] = [];
    let tiedIn = false; // 直前の音符から tie で続いているか
    for (const n of all(part, "note")) {
      if (kid(n, "chord") || kid(n, "grace")) continue; // 和音の構成音・装飾音（単旋律として読む）
      const durEl = kid(n, "duration");
      if (!durEl) continue;
      const beats = Number(durEl.textContent) / divisions;
      if (kid(n, "rest")) {
        notes.push({ beats, midi: 0, lyric: null, rest: true });
        tiedIn = false;
        continue;
      }
      const p = kid(n, "pitch");
      const midi = p ? (Number(kid(p, "octave")?.textContent ?? 4) + 1) * 12
        + (STEP[(kid(p, "step")?.textContent ?? "C").trim().toUpperCase()] ?? 0)
        + Math.trunc(Number(kid(p, "alter")?.textContent ?? 0)) : 0;
      const ties = new Set(kids(n, "tie").map((t) => t.getAttribute("type")));
      const last = notes[notes.length - 1];
      if (tiedIn && last && !last.rest && last.midi === midi) {
        last.beats += beats; // タイは 1 つの音符にまとめる
        tiedIn = ties.has("start");
        continue;
      }
      const t = all(n, "text")[0]?.textContent?.trim();
      notes.push({ beats, midi, lyric: t || null, rest: false });
      tiedIn = ties.has("start");
    }
    tracks.push(toTrack(label, notes));
  }
  if (!bpm) warnings.push(tx("テンポの指定がありません。120 とみなします"));
  return { bpm: bpm || 120, tracks, warnings };
}

// ── .mxl（zip）────────────────────────────────
/** zip の中身を読む（無圧縮と deflate）。deflate はブラウザの DecompressionStream で展開する。 */
async function readZip(buf: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const v = new DataView(buf);
  let e = buf.byteLength - 22;
  while (e >= 0 && v.getUint32(e, true) !== 0x06054b50) e--;
  if (e < 0) throw new Error(tx("zip として読めません"));
  const n = v.getUint16(e + 10, true);
  let p = v.getUint32(e + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let i = 0; i < n; i++) {
    const method = v.getUint16(p + 10, true);
    const csize = v.getUint32(p + 20, true);
    const nlen = v.getUint16(p + 28, true);
    const name = new TextDecoder().decode(new Uint8Array(buf, p + 46, nlen));
    const lh = v.getUint32(p + 42, true);
    const start = lh + 30 + v.getUint16(lh + 26, true) + v.getUint16(lh + 28, true);
    const raw = new Uint8Array(buf, start, csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) {
      const ds = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      out.set(name, new Uint8Array(await new Response(ds).arrayBuffer()));
    }
    p += 46 + nlen + v.getUint16(p + 30, true) + v.getUint16(p + 32, true);
  }
  return out;
}

async function mxlText(buf: ArrayBuffer): Promise<string> {
  const files = await readZip(buf);
  const dec = new TextDecoder();
  const cont = files.get("META-INF/container.xml");
  let name: string | null = null;
  if (cont) {
    const d = new DOMParser().parseFromString(dec.decode(cont), "application/xml");
    name = all(d, "rootfile")[0]?.getAttribute("full-path") ?? null;
  }
  name ??= [...files.keys()].find((k) => /\.(xml|musicxml)$/i.test(k) && !k.startsWith("META-INF/")) ?? null;
  const body = name ? files.get(name) : undefined;
  if (!body) throw new Error(tx(".mxl の中に楽譜の XML が見つかりません"));
  return dec.decode(body);
}

/** ファイル名の拡張子で形式を決めて読む。 */
export async function parseScoreFile(name: string, buf: ArrayBuffer): Promise<ScoreResult> {
  const ext = name.toLowerCase().replace(/^.*(\.[^.]+)$/, "$1");
  if (ext === ".ust") return parseUst(new Uint8Array(buf));
  if (ext === ".mxl") return parseMusicXml(await mxlText(buf));
  if (ext === ".musicxml" || ext === ".xml") return parseMusicXml(new TextDecoder().decode(buf));
  throw new Error(tx("読める楽譜は UST と MusicXML（.musicxml・.xml・.mxl）です: {name}", { name }));
}
