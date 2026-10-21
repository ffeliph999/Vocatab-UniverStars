// 伴奏のトラックの音声。読み込んだ音声はここに置き、プロジェクトには参照（id・名前・指紋）だけを持たせる
// （undo の履歴にプロジェクト全体を積むので、音声そのものは入れない）。
// 保存のために元のファイルのバイト列と指紋（SHA-256）も持つ。指紋が同じなら同じ音声とみなす。
import { audioContext } from "./audio";

export interface AudioEntry {
  id: string;
  name: string; // 元のファイル名（拡張子つき）
  hash: string; // 中身の SHA-256（16 進）
  bytes: ArrayBuffer; // 元のファイルのまま
  buffer: AudioBuffer;
  peaks: Float32Array;
}

const entries = new Map<string, AudioEntry>();
export const PEAK_RATE = 200; // 波形の要約: 1 秒あたりの点の数（5 ms ごとの絶対値の最大）

export async function sha256(bytes: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makePeaks(buf: AudioBuffer): Float32Array {
  const n = Math.ceil(buf.duration * PEAK_RATE);
  const step = buf.sampleRate / PEAK_RATE;
  const pk = new Float32Array(n);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const x = buf.getChannelData(c);
    for (let i = 0; i < n; i++) {
      let m = pk[i];
      const end = Math.min(x.length, Math.floor((i + 1) * step));
      for (let k = Math.floor(i * step); k < end; k++) {
        const a = Math.abs(x[k]);
        if (a > m) m = a;
      }
      pk[i] = m;
    }
  }
  return pk;
}

/** バイト列から音声を登録する。id を渡せばその id で（保存したプロジェクトを開くとき）。同じ指紋なら使い回す。 */
export async function registerAudio(bytes: ArrayBuffer, name: string, id?: string, hash?: string): Promise<AudioEntry> {
  const h = hash ?? (await sha256(bytes));
  const same = [...entries.values()].find((e) => e.hash === h);
  if (same && (!id || same.id === id)) return same;
  // decodeAudioData はバイト列を手放すので、写しを渡す
  const buffer = await audioContext().decodeAudioData(bytes.slice(0));
  const e: AudioEntry = { id: id ?? `a${h.slice(0, 12)}`, name, hash: h, bytes, buffer, peaks: makePeaks(buffer) };
  entries.set(e.id, e);
  return e;
}

/** 音声のファイルを読み込む（wav・mp3・flac・m4a など、ブラウザが読めるもの）。 */
export async function loadAudioFile(file: File): Promise<AudioEntry> {
  return registerAudio(await file.arrayBuffer(), file.name);
}

export const audioEntry = (id: string): AudioEntry | undefined => entries.get(id);
export const audioBuffer = (id: string): AudioBuffer | undefined => entries.get(id)?.buffer;
export const audioPeaks = (id: string): Float32Array | undefined => entries.get(id)?.peaks;

export function isAudioFile(f: File): boolean {
  return f.type.startsWith("audio/") || /\.(wav|mp3|flac|ogg|m4a|aac|aiff?)$/i.test(f.name);
}
