// 画面側のエンジンの窓口。2 通り:
//   WebEngine    ブラウザの中（Web Worker の engine-worker.js）で動かす。GitHub Pages などの静的な配信ではこちら
//   ServerEngine 手元の Python のエンジン（engine/server.py）に問い合わせる。URL に ?engine=server を付けたとき（照らし合わせ用）
import { b64, type EngineInfo, unb64 } from "../engine";
import { getGpu } from "../theme";
import type { AnalyzeReq, AnalyzeResp, RestoreEntry, SynthReq, SynthResp, WorkerCall, WorkerReply } from "./protocol";
import type { WebIndex } from "./types";

/** これだけの秒数、エンジンへの呼び出しが無ければ Worker ごと手放す（?idle=<秒> で変えられる。0 なら手放さない） */
const IDLE_SEC = 180;

export interface EngineClient {
  /** ボイスバンクとボコーダの一覧。使えなければ null */
  info(): Promise<EngineInfo | null>;
  analyze(r: AnalyzeReq): Promise<AnalyzeResp>;
  synthesize(r: SynthReq): Promise<SynthResp>;
  /** モデルの読み込みの進み具合（読み終わったら null） */
  progress: { loaded: number; total: number } | null;
  onProgress: () => void;
  /** 待機中か（しばらく呼び出しが無く、計算の部分を手放している。次の呼び出しで起こす） */
  sleeping: boolean;
  /** 待機に入った・起きたときに呼ぶ（状態の表示用） */
  onState: () => void;
  /** 起こすときにエンジンへ戻す、画面が持っている解析の結果（render.ts が入れる。無ければ解析し直すだけ） */
  collectRestore: (() => RestoreEntry[]) | null;
}

export class WebEngine implements EngineClient {
  progress: { loaded: number; total: number } | null = null;
  onProgress = (): void => undefined;
  onState = (): void => undefined;
  sleeping = false;
  collectRestore: (() => RestoreEntry[]) | null = null;
  private worker: Worker | null = null;
  private seq = 0;
  private waiting = new Map<number, { ok: (v: any) => void; ng: (e: Error) => void }>();
  private initMsg: { base: string; gpu: boolean } | null = null; // 起こすときに同じ設定で init し直す
  private idleSec: number;
  private idleTimer = 0;
  private waking: Promise<void> | null = null; // 起こしている途中（init と restore が済むまで、ほかの呼び出しはこれを待つ）

  constructor() {
    const q = new URLSearchParams(location.search).get("idle");
    this.idleSec = q && Number.isFinite(Number(q)) ? Number(q) : IDLE_SEC; // 空（?idle だけ）は既定のまま
    this.spawn();
  }

  private spawn(): void {
    const w = new Worker(new URL("./engine-worker.js", import.meta.url));
    w.onmessage = (e: MessageEvent<WorkerReply>) => {
      const m = e.data;
      if (m.type === "progress") {
        this.progress = m.loaded >= m.total ? null : { loaded: m.loaded, total: m.total };
        this.onProgress();
        return;
      }
      const wt = this.waiting.get(m.id);
      if (!wt) return;
      this.waiting.delete(m.id);
      if (m.type === "result") wt.ok(m.result);
      else wt.ng(new Error(m.error));
      this.armIdle();
    };
    // Worker 自体が落ちた（読み込めない・中で例外）: 待っている呼び出しを全部失敗にして手放す。次の呼び出しで作り直す
    w.onerror = (e: ErrorEvent) => {
      console.error(e);
      const err = new Error(`engine worker: ${e.message || "error"}`);
      for (const wt of this.waiting.values()) wt.ng(err);
      this.waiting.clear();
      w.terminate();
      if (this.worker === w) {
        this.worker = null;
        this.progress = null;
      }
    };
    this.worker = w;
  }

  /** Worker へ 1 つ送って返事を待つ（Worker は居るものとして） */
  private send<T>(m: WorkerCall): Promise<T> {
    const w = this.worker;
    if (!w) return Promise.reject(new Error("engine worker is not running"));
    const id = ++this.seq;
    clearTimeout(this.idleTimer); // 呼び出しの途中では手放さない
    return new Promise<T>((ok, ng) => {
      this.waiting.set(id, { ok, ng });
      w.postMessage({ ...m, id });
    });
  }

  /** 呼び出しが全部済んだら、待機の時計を掛け直す */
  private armIdle(): void {
    clearTimeout(this.idleTimer);
    if (this.waiting.size || this.waking || !this.initMsg || !(this.idleSec > 0)) return;
    this.idleTimer = window.setTimeout(() => this.sleep(), this.idleSec * 1000);
  }

  /** 待機: Worker ごと手放す（WASM のメモリと読み込んだモデルが解放される）。途中の呼び出しがあれば何もしない */
  private sleep(): void {
    if (this.waiting.size || this.waking || !this.worker) return;
    if (this.progress) { // モデルの読み込み（先読み）の途中なら、済んでから（時計を掛け直す）
      this.armIdle();
      return;
    }
    this.worker.terminate();
    this.worker = null;
    this.progress = null;
    this.sleeping = true;
    this.onState();
  }

  /**
   * 待機中なら起こす: Worker を作り直し、同じ設定で init し、画面が持っている解析の結果を戻す（中身の変わっていない句を
   * 解析し直さないため）。起こしている途中に来た呼び出しは同じ約束を待つ。失敗したら待っている呼び出しも失敗にし、
   * Worker を手放したままにして次の呼び出しで起こし直す
   */
  private wake(): Promise<void> {
    if (this.waking) return this.waking; // 起こしている途中（Worker は居るが init が済んでいない）は同じ約束を待つ
    if (this.worker) return Promise.resolve();
    this.waking = (async () => {
      this.spawn();
      try {
        await this.send({ type: "init", ...this.initMsg! });
        const entries = this.collectRestore?.() ?? [];
        if (entries.length) await this.send({ type: "restore", entries });
      } catch (e) {
        this.worker?.terminate();
        this.worker = null;
        throw e;
      } finally {
        this.waking = null;
      }
      this.sleeping = false;
      this.onState();
    })();
    return this.waking;
  }

  private async call<T>(m: WorkerCall): Promise<T> {
    await this.wake();
    return this.send<T>(m);
  }

  async info(): Promise<EngineInfo | null> {
    try {
      // ページ（ui/index.html）の 1 つ上が svs_editor_browser の頭（web_index.json・voicebanks・vocoders がある所）。
      // GPU（WebGPU）は設定（既定はオフ）か URL で決める: ?gpu=1 で使う、?gpu=0 で使わない
      const g = new URLSearchParams(location.search).get("gpu");
      this.initMsg = { base: new URL("../", location.href).href, gpu: g === "1" ? true : g === "0" ? false : getGpu() };
      if (!this.worker) this.spawn();
      const idx = await this.send<WebIndex>({ type: "init", ...this.initMsg });
      this.sleeping = false;
      return { voicebanks: idx.voicebanks.map((v) => ({ key: v.key, name: v.name, language: v.language, singers: v.singers,
                                                        default_vocoder: v.default_vocoder })),
               vocoders: idx.vocoders.map((v) => ({ key: v.key, name: v.name, kind: v.kind, voice_params: v.voice_params })) };
    } catch (e) {
      console.error(e);
      return null;
    }
  }

  analyze(r: AnalyzeReq): Promise<AnalyzeResp> {
    return this.call<AnalyzeResp>({ type: "analyze", req: r });
  }

  synthesize(r: SynthReq): Promise<SynthResp> {
    return this.call<SynthResp>({ type: "synthesize", req: r });
  }
}

export class ServerEngine implements EngineClient {
  progress = null;
  onProgress = (): void => undefined;
  onState = (): void => undefined;
  sleeping = false;
  collectRestore = null;

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
      key: q.key, note_ids: q.note_ids, start_frame: q.start_frame, start_sec: q.start_sec ?? q.start_frame / j.frame_rate,
      n_frames: q.n_frames, phonemes: q.phonemes, seed: q.seed ?? r.seed,
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
