// 画面とエンジンのやり取りの形（engine/server.py の /api/analyze・/api/synthesize と同じ中身。配列は base64 にせずそのまま）。
import type { EPhoneme } from "../engine";
import type { WebIndex } from "./types";

export interface AnalyzeReq {
  voicebank: string;
  singer: number;
  bpm: number;
  seed: number;
  notes: Array<{ id: number; onset: number; dur: number; pitch: number; lyric: string; retake_f0?: number;
                 ph_shift?: Record<string, number> }>;
}

export interface AnalyzedPhrase {
  key: string;
  note_ids: number[];
  start_frame: number;
  n_frames: number;
  phonemes: EPhoneme[];
  plain: Float32Array;
  vib: Float32Array;
  uv: Float32Array;
  base: Float32Array;
}

export interface AnalyzeResp {
  frame_rate: number;
  phrases: AnalyzedPhrase[];
}

export interface SynthReq {
  voicebank: string;
  singer: number;
  key: string;
  f0_log2: Float32Array;
  vocoder: string;
  params: Record<string, Float32Array>;
  mel_out: boolean;
  mel_plain: boolean;
  retake_mel: Record<string, number>;
}

export interface SynthResp {
  n_frames: number;
  wav: Float32Array;
  mel_in: Float32Array;
  mel_out?: Float32Array;
  mel_plain?: Float32Array;
}

export type WorkerMsg =
  | { type: "init"; id: number; base: string; gpu: boolean }
  | { type: "analyze"; id: number; req: AnalyzeReq }
  | { type: "synthesize"; id: number; req: SynthReq };

export type WorkerReply =
  | { type: "result"; id: number; result: WebIndex | AnalyzeResp | SynthResp }
  | { type: "error"; id: number; error: string }
  | { type: "progress"; loaded: number; total: number };
