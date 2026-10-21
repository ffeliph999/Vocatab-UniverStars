// 画面側のエンジンの窓口。2 通り:
//   WebEngine    ブラウザの中（Web Worker の engine-worker.js）で動かす。GitHub Pages などの静的な配信ではこちら
//   ServerEngine 手元の Python のエンジン（engine/server.py）に問い合わせる。URL に ?engine=server を付けたとき（照らし合わせ用）
import { b64, type EngineInfo, unb64 } from "../engine";
import type { AnalyzeReq, AnalyzeResp, SynthReq, SynthResp, WorkerMsg, WorkerReply } from "./protocol";
import type { WebIndex } from "./types";

export interface EngineClient {
  /** ボイスバンクとボコーダの一覧。使えなければ null */
  info(): Promise<EngineInfo | null>;
  analyze(r: AnalyzeReq): Promise<AnalyzeResp>;
  synthesize(r: SynthReq): Promise<SynthResp>;
  /** モデルの読み込みの進み具合（読み終わったら null） */
  progress: { loaded: number; total: number } | null;
  onProgress: () => void;
}

export class WebEngine implements EngineClient {
  progress: { loaded: number; total: number } | null = null;
  onProgress = (): void => undefined;
  private worker: Worker;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; ng: (e: Error) => void }>();

  constructor() {
    this.worker = new Worker(new URL("./engine-worker.js", import.meta.url));
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === "progress") {
        this.progress = m.loaded >= m.total ? null : { loaded: m.loaded, total: m.total };
        this.onProgress();
        return;
      }
      const w = this.waiting.get(m.id);
      if (!w) return;
      this.waiting.delete(m.id);
      if (m.type === "result") w.ok(m.result);
      else w.ng(new Error(m.error));
    };
  }

  private call<T>(m: Omit<WorkerMsg, "id"> & { type: WorkerMsg["type"] }): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((ok, ng) => {
      this.waiting.set(id, { ok, ng });
      this.worker.postMessage({ ...m, id });
    });
  }

  async info(): Promise<EngineInfo | null> {
    try {
      // ページ（ui/index.html）の 1 つ上が svs_editor_browser の頭（web_index.json・voicebanks・vocoders がある所）
      const idx = await this.call<WebIndex>({ type: "init", base: new URL("../", location.href).href } as WorkerMsg);
      return { voicebanks: idx.voicebanks.map((v) => ({ key: v.key, name: v.name, language: v.language, singers: v.singers,
                                                        default_vocoder: v.default_vocoder })),
               vocoders: idx.vocoders.map((v) => ({ key: v.key, name: v.name, kind: v.kind, voice_params: v.voice_params })) };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  analyze(r: AnalyzeReq): Promise<AnalyzeResp> {
    return this.call<AnalyzeResp>({ type: "analyze", req: r } as WorkerMsg);
  }

  synthesize(r: SynthReq): Promise<SynthResp> {
    return this.call<SynthResp>({ type: "synthesize", req: r } as WorkerMsg);
  }
}

export class ServerEngine implements EngineClient {
  progress = null;
  onProgress = (): void => undefined;

  async info(): Promise<EngineInfo | null> {
    try {
      const r = await fetch("/api/info");
      return r.ok ? ((await r.json()) as EngineInfo) : null;
    } catch {
      return null;
    }
  }

  private async post(path: string, body: unknown): Promise<any> {
    const r = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error(await r.text());
    return r.json();
  }

  async analyze(r: AnalyzeReq): Promise<AnalyzeResp> {
    const j = await this.post("/api/analyze", r);
    return { frame_rate: j.frame_rate, phrases: j.phrases.map((q: any) => ({
      key: q.key, note_ids: q.note_ids, start_frame: q.start_frame, n_frames: q.n_frames, phonemes: q.phonemes,
      plain: unb64(q.plain_log2), vib: unb64(q.vib_log2), uv: unb64(q.uv), base: unb64(q.base_log2 ?? q.plain_log2) })) };
  }

  async synthesize(r: SynthReq): Promise<SynthResp> {
    const params: Record<string, string> = {};
    for (const k of Object.keys(r.params)) params[k] = b64(r.params[k]);
    const j = await this.post("/api/synthesize", { ...r, f0_log2: b64(r.f0_log2), params });
    return { n_frames: j.n_frames, wav: unb64(j.wav), mel_in: unb64(j.mel_in),
             mel_out: j.mel_out ? unb64(j.mel_out) : undefined, mel_plain: j.mel_plain ? unb64(j.mel_plain) : undefined };
  }
}

/** URL に ?engine=server があれば Python のエンジン、無ければブラウザの中のエンジン */
export function makeEngine(): EngineClient {
  return new URLSearchParams(location.search).get("engine") === "server" ? new ServerEngine() : new WebEngine();
}
