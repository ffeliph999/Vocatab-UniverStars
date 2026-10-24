// 書き出し: トラックごとの音・全トラックをまとめたミックスを WAV にする。
// 混ぜ方は再生と同じ（音量 → パン）で、OfflineAudioContext で 44.1 kHz に作る（伴奏の音声の周波数が違っても変換される）。
// 画面（dialogs.ts の「書き出し」）とは分けてあるので、仕様や見た目を変えるときはここの ExportOptions を足し引きする。
// 音はいつも再生と同じ（ミュート・ソロ、トラックの音量とパン、エフェクターを反映）。それらを外す選択肢は置かない。
import { audioBuffer } from "./audiofiles";
import { buildFxChain } from "./fx";
import { t as tx } from "./i18n";
import { isAudioTrack, type Project, secPerTick, type Track, trackRegion } from "./model";

export const SAMPLE_RATE = 44100;

export interface ExportOptions {
  fileName: string; // 拡張子なし。トラックごとのファイルは「名前_トラック名.wav」
  trackIds: number[]; // 「トラックを別々に書き出す」で選んでいるトラック
  channels: 1 | 2;
  bitDepth: 16 | 24 | 32; // 32 は浮動小数
}

/** 何を書き出すか: ミックス 1 本か、選んだトラックを別々にか。 */
export type ExportWhat = "mix" | "tracks";

export function defaultExportOptions(): ExportOptions {
  return { fileName: tx("無題"), trackIds: [], channels: 2, bitDepth: 16 };
}

/** 書き出すファイルの名前。ミックスは「名前.wav」、トラックは「名前_トラック名.wav」（ファイル名に使えない文字は _）。 */
export function exportFileName(base: string, track?: Track): string {
  const safe = (s: string) => s.replace(/[\\/:*?"<>|]/g, "_");
  return track ? `${safe(base)}_${safe(track.name)}.wav` : `${safe(base)}.wav`;
}

/** 歌のトラックの、曲の頭からの合成済みの波形（44.1 kHz）。 */
export type VocalWav = (t: Track) => Float32Array | null;

/** 書き出す長さ（秒）: いちばん遅く終わる音まで ＋ 0.5 秒（リバーブを掛けているトラックがあれば、その残響の長さも）。 */
function songSeconds(p: Project, tracks: Track[], vocal: VocalWav): number {
  let end = 0;
  let tail = 0.5;
  for (const t of tracks) {
    if (isAudioTrack(t)) end = Math.max(end, trackRegion(t, p.beatsPerBar).end * secPerTick(p.bpm));
    else end = Math.max(end, (vocal(t)?.length ?? 0) / SAMPLE_RATE);
    if (t.fx?.reverb.on) tail = Math.max(tail, t.fx.reverb.decay + t.fx.reverb.preDelay / 1000);
  }
  return end + tail;
}

/** トラックを混ぜて、チャンネルごとの波形にする。 */
async function mix(p: Project, tracks: Track[], vocal: VocalWav, o: ExportOptions, sec: number): Promise<Float32Array[]> {
  const ctx = new OfflineAudioContext(o.channels, Math.ceil(sec * SAMPLE_RATE), SAMPLE_RATE);
  const spt = secPerTick(p.bpm);
  for (const t of tracks) {
    let src: AudioBufferSourceNode | null = null;
    if (isAudioTrack(t)) {
      const buf = t.audio && audioBuffer(t.audio.id);
      if (!buf || !t.audio) continue;
      const r = trackRegion(t, p.beatsPerBar);
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.start(r.start * spt, t.audio.offsetSec, (r.end - r.start) * spt);
    } else {
      const w = vocal(t);
      if (!w) continue;
      const buf = ctx.createBuffer(1, w.length, SAMPLE_RATE);
      buf.copyToChannel(w, 0);
      src = ctx.createBufferSource();
      src.buffer = buf;
      src.start(0);
    }
    let out: AudioNode = src;
    if (t.fx && !isAudioTrack(t)) {
      const fx = buildFxChain(ctx);
      fx.update(t.fx);
      out.connect(fx.input);
      out = fx.output;
    }
    const g = ctx.createGain();
    const db = t.gain ?? 0;
    g.gain.value = db > -24 ? 10 ** (db / 20) : 0;
    out = out.connect(g);
    if (o.channels === 2) {
      const pan = ctx.createStereoPanner();
      pan.pan.value = t.pan ?? 0;
      out = out.connect(pan);
    }
    out.connect(ctx.destination);
  }
  const res = await ctx.startRendering();
  return Array.from({ length: res.numberOfChannels }, (_, c) => res.getChannelData(c));
}

/** WAV（16・24 bit の整数、32 bit の浮動小数）。 */
export function encodeWav(chs: Float32Array[], bitDepth: 16 | 24 | 32, sr = SAMPLE_RATE): Blob {
  const nch = chs.length;
  const n = chs[0]?.length ?? 0;
  const bps = bitDepth / 8;
  const data = new ArrayBuffer(44 + n * nch * bps);
  const v = new DataView(data);
  const str = (o: number, s: string) => { for (let k = 0; k < 4; k++) v.setUint8(o + k, s.charCodeAt(k)); };
  str(0, "RIFF"); v.setUint32(4, 36 + n * nch * bps, true); str(8, "WAVE"); str(12, "fmt ");
  v.setUint32(16, 16, true); v.setUint16(20, bitDepth === 32 ? 3 : 1, true); v.setUint16(22, nch, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * nch * bps, true); v.setUint16(32, nch * bps, true);
  v.setUint16(34, bitDepth, true); str(36, "data"); v.setUint32(40, n * nch * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < nch; c++) {
      const x = chs[c][i];
      if (bitDepth === 32) v.setFloat32(o, x, true);
      else {
        const y = Math.max(-1, Math.min(1, x));
        if (bitDepth === 16) v.setInt16(o, Math.round(y * 32767), true);
        else {
          const q = Math.round(y * 8388607);
          v.setUint8(o, q & 0xff);
          v.setUint8(o + 1, (q >> 8) & 0xff);
          v.setUint8(o + 2, (q >> 16) & 0xff);
        }
      }
      o += bps;
    }
  }
  return new Blob([data], { type: "audio/wav" });
}

/** 書き出すファイルを作る。"mix" は全トラックをまとめた 1 本（ミュート・ソロに従う）、"tracks" は o.trackIds のトラックを別々に。 */
export async function buildExports(p: Project, vocal: VocalWav, o: ExportOptions, what: ExportWhat): Promise<Array<{ name: string; blob: Blob }>> {
  const files: Array<{ name: string; blob: Blob }> = [];
  const sec = songSeconds(p, p.tracks, vocal);
  if (what === "mix") {
    const anySolo = p.tracks.some((t) => t.solo);
    const audible = p.tracks.filter((t) => !t.mute && (!anySolo || t.solo));
    files.push({ name: exportFileName(o.fileName), blob: encodeWav(await mix(p, audible, vocal, o, sec), o.bitDepth) });
  } else {
    for (const t of p.tracks.filter((x) => o.trackIds.includes(x.id))) {
      files.push({ name: exportFileName(o.fileName, t), blob: encodeWav(await mix(p, [t], vocal, o, sec), o.bitDepth) });
    }
  }
  return files;
}

/** ブラウザのダウンロードとして保存する。 */
export function download(files: Array<{ name: string; blob: Blob }>): void {
  for (const f of files) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(f.blob);
    a.download = f.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  }
}
