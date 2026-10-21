// ブラウザ版のエンジンの Web Worker（ui/dist/engine-worker.js になる）。本体は core.ts。
// 重い処理で画面が止まらないよう、画面とは別のスレッドで動かし、client.ts とメッセージでやり取りする。
import { Engine } from "./core";
import type { SynthResp, WorkerMsg, WorkerReply } from "./protocol";

declare const ort: any; // onnxruntime-web（下の importScripts で入る）
declare function importScripts(...urls: string[]): void;

const ORT_VERSION = "1.20.1";
const ORT_BASE = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
importScripts(`${ORT_BASE}ort.webgpu.min.js`); // WebGPU 入りの版（GPU が使えないときは WASM で動く。core.ts の GPU_MODELS）
ort.env.wasm.wasmPaths = ORT_BASE;
// 複数のスレッドは cross-origin isolated のときだけ使える（GitHub Pages では普通は 1 スレッド）
ort.env.wasm.numThreads = (self as any).crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const post = (m: WorkerReply, transfer: Transferable[] = []): void => (self as any).postMessage(m, transfer);
const engine = new Engine(ort, (loaded, total) => post({ type: "progress", loaded, total }));

(self as any).onmessage = async (e: MessageEvent<WorkerMsg>) => {
  const m = e.data;
  try {
    if (m.type === "init") post({ type: "result", id: m.id, result: await engine.init(m.base) });
    else if (m.type === "analyze") post({ type: "result", id: m.id, result: await engine.analyze(m.req) });
    else if (m.type === "synthesize") {
      const res: SynthResp = await engine.synthesize(m.req);
      // 大きい配列は写さずに渡す（どれも合成のたびに新しく作ったもので、エンジン側には残らない）
      const tr = [res.wav, res.mel_in, res.mel_out, res.mel_plain].filter((a): a is Float32Array => !!a).map((a) => a.buffer);
      post({ type: "result", id: m.id, result: res }, tr);
    }
  } catch (err) {
    post({ type: "error", id: m.id, error: err instanceof Error ? err.message : String(err) });
  }
};
