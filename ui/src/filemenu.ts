// 「ファイル」のメニュー: 新規・開く・保存・名前を付けて保存・音声も含めて書き出す、伴奏のつなぎ直し、自動保存。
// 保存のしかたは projectfile.ts。ここはブラウザでのファイルのやり取りと画面だけ。
// Chrome・Edge では File System Access API で同じファイルに上書きできる。ほかのブラウザではダウンロードになる。
import { localeTag, t as tx } from "./i18n";
import { defaultAttrs, defaultBase, isAudioTrack, type Project, TPQ, type Track, trackRegion } from "./model";
import {
  autosave, bundle, clearAutosave, migrate, missingAudio, openBundle, relink, serialize,
} from "./projectfile";
import { parseScoreFile, type ScoreResult } from "./score";
import { toUstx } from "./ustx";
import { addOrCycleBreath } from "./breath";
import type { BreathContext } from "./derive";
import type { Store } from "./store";

interface FsHandle {
  name: string;
  createWritable(): Promise<{ write(d: Blob | string): Promise<void>; close(): Promise<void> }>;
  getFile(): Promise<File>;
}
type PickerWindow = Window & {
  showSaveFilePicker?: (o: unknown) => Promise<FsHandle>;
  showOpenFilePicker?: (o: unknown) => Promise<FsHandle[]>;
};
const w = window as PickerWindow;
const PROJECT_TYPES = [{ description: tx("VocaTab のプロジェクト"), accept: { "application/json": [".svsproj"] } }];

export class FileMenu {
  private handle: FsHandle | null = null; // 開いた・保存したファイル（上書き保存の先）
  private menu: HTMLElement | null = null;
  private timer = 0;
  private dirty = false;
  /** 楽譜を読み込んで足したトラック（画面をそこへ動かすため） */
  onImport: (t: Track) => void = () => undefined;
  /** 楽譜のブレスの記号（UST の「息」など）を音符のブレスにするための、ブレスの束（main.ts が renderer のものを入れる） */
  breathContext: (t: Track) => BreathContext | undefined = () => undefined;
  /** 楽譜を読み込むとき、歌詞に合う歌い手を選ぶ（今の歌い手のままでよければ null）。main.ts がエンジンの一覧から決める */
  pickVoice: (lyrics: string[], cur: { voice: string; voicebank?: string }) => { voice: string; voicebank: string } | null =
    () => null;
  /** プロジェクトを開いたとき（今のトラックの音符が見えるように画面を動かすため） */
  onOpen: (t: Track) => void = () => undefined;

  constructor(private store: Store, button: HTMLElement, private state: HTMLElement,
              private hint: (s: string) => void, private fresh: () => Project, private autosaveOn: boolean) {
    button.addEventListener("click", (e) => {
      e.stopPropagation();
      if (this.menu) this.close();
      else this.open(button.getBoundingClientRect());
    });
    window.addEventListener("pointerdown", () => this.close());
    window.addEventListener("keydown", (e) => {
      if (!(e.metaKey || e.ctrlKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        void (e.shiftKey ? this.saveAs() : this.save());
      } else if (k === "o") {
        e.preventDefault();
        void this.openFile();
      }
    });
    // 編集のたびに少し待ってから自動保存する
    store.on((kind) => {
      if (kind !== "project" && kind !== "mix") return;
      this.dirty = true;
      this.showState();
      if (!this.autosaveOn) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.autosaveNow(), 1500);
    });
    this.showState();
  }

  private showState(saved?: string): void {
    const name = this.store.projectName + (this.handle ? "" : tx("（未保存）"));
    this.state.textContent = saved ? `${name}　${saved}` : `${name}${this.dirty && this.handle ? "　＊" : ""}`;
    this.state.title = this.autosaveOn ? tx("編集はブラウザの中に自動で保存しています（読み込み直しても続きから）") : "";
  }

  private async autosaveNow(): Promise<void> {
    try {
      await autosave(this.store.project, this.store.projectName);
      const d = new Date();
      this.showState(tx("自動保存 {time}", { time: d.toLocaleTimeString(localeTag(), { hour: "2-digit", minute: "2-digit" }) }));
    } catch (e) {
      this.state.textContent = tx("自動保存に失敗: {e}", { e: String(e) });
    }
  }

  /** 待っている自動保存をすぐ済ませる（画面を読み込み直す前に。言語を変えたときなど）。 */
  async flushAutosave(): Promise<void> {
    if (!this.autosaveOn) return;
    clearTimeout(this.timer);
    await this.autosaveNow();
  }

  // ── メニュー ───────────────────────────────
  private open(r: DOMRect): void {
    const m = document.createElement("div");
    m.className = "pop-menu";
    Object.assign(m.style, { left: `${r.left}px`, top: `${r.bottom + 4}px` });
    const items: Array<[string, string, () => void]> = [
      [tx("新規"), tx("サンプル曲から始める"), () => void this.newProject()],
      [tx("開く"), tx("⌘O　.svsproj か、音声も含めた .zip"), () => void this.openFile()],
      [tx("保存"), "⌘S", () => void this.save()],
      [tx("名前を付けて保存"), "⇧⌘S", () => void this.saveAs()],
      [tx("音声も含めて書き出す"), tx("伴奏の音声もまとめた .zip"), () => void this.saveBundle()],
      [tx("楽譜を読み込む"), tx("MusicXML（.musicxml・.xml・.mxl）・UST・USTX。新しい歌のトラックにする"), () => void this.importScore()],
      [tx("USTX に書き出す"), tx("OpenUtau のプロジェクト（音符・歌詞・テンポ）"), () => void this.exportUstx()],
    ];
    for (const [label, sub, fn] of items) {
      const b = document.createElement("button");
      b.innerHTML = `<span>${label}</span><span class="muted">${sub}</span>`;
      b.addEventListener("click", () => {
        this.close();
        fn();
      });
      m.appendChild(b);
    }
    m.addEventListener("pointerdown", (e) => e.stopPropagation());
    document.body.appendChild(m);
    this.menu = m;
  }

  private close(): void {
    this.menu?.remove();
    this.menu = null;
  }

  // ── 新規・開く ──────────────────────────────
  private async newProject(): Promise<void> {
    if (!window.confirm(tx("今のプロジェクトを閉じて、サンプル曲から始めますか？（保存していない変更は消えます）"))) return;
    this.handle = null;
    this.dirty = false;
    if (this.autosaveOn) await clearAutosave();
    this.store.load(this.fresh(), tx("無題"));
    this.hint(tx("新しいプロジェクトにしました"));
  }

  async openFile(): Promise<void> {
    let file: File | null = null;
    let handle: FsHandle | null = null;
    try {
      if (w.showOpenFilePicker) {
        [handle] = await w.showOpenFilePicker({
          types: [...PROJECT_TYPES, { description: tx("音声も含めたプロジェクト"), accept: { "application/zip": [".zip"] } }],
        });
        file = await handle.getFile();
      } else {
        file = await pickFile(".svsproj,.json,.zip");
      }
    } catch {
      return; // 選ばずに閉じた
    }
    if (!file) return;
    await this.loadFile(file, handle);
  }

  /** ファイルを開く（.svsproj または .zip）。 */
  async loadFile(file: File, handle: FsHandle | null = null): Promise<void> {
    try {
      const buf = await file.arrayBuffer();
      const isZip = new Uint8Array(buf, 0, 2).every((b, i) => b === [0x50, 0x4b][i]);
      const p = isZip ? await openBundle(buf) : migrate(new TextDecoder().decode(buf));
      this.handle = isZip ? null : handle; // zip は上書きしない（次の保存は名前を付けて）
      this.dirty = false;
      this.store.load(p, file.name.replace(/\.(svsproj|json|zip)$/i, ""));
      this.onOpen(this.store.track);
      this.hint(tx("開きました: {name}", { name: file.name }));
      this.checkMissing(p);
    } catch (e) {
      window.alert(tx("開けませんでした: {name}", { name: file.name }) + `\n${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** 開いた（自動保存から戻した）プロジェクトに足りない伴奏があれば、つなぎ直しの画面を出す。 */
  checkMissing(p: Project): void {
    if (missingAudio(p).length) this.relinkDialog(p);
  }

  /** 伴奏の音声が見つからないとき: ファイルを選んでもらい、指紋（なければファイル名）でつなぎ直す。 */
  private relinkDialog(p: Project): void {
    const back = document.createElement("div");
    back.className = "modal-back";
    const box = document.createElement("div");
    box.className = "modal";
    const render = () => {
      const miss = missingAudio(p);
      box.innerHTML = `<h3>${tx("伴奏の音声が見つかりません")}</h3>
        <p class="hint">${tx("プロジェクトファイルには伴奏の音声は含まれていません。元の音声ファイルを選択してください（複数選択可。内容で照合するため、移動や名前変更があっても問題ありません）。")}</p>
        <ul class="miss-list">${miss.map((m) => `<li>${m.fileName ?? m.name}</li>`).join("")}</ul>
        <div class="btn-row"><button class="small" id="rl-pick">${tx("ファイルを選ぶ")}</button>
          <button class="small" id="rl-later">${tx("あとで（音を出さずに続ける）")}</button></div><p class="hint" id="rl-msg"></p>`;
      box.querySelector("#rl-later")!.addEventListener("click", () => back.remove());
      box.querySelector("#rl-pick")!.addEventListener("click", () => void (async () => {
        const files = await pickFiles("audio/*,.wav,.mp3,.flac,.ogg,.m4a,.aac,.aif,.aiff");
        if (!files.length) return;
        const r = await relink(p, files);
        this.store.changed("project");
        if (!missingAudio(p).length) {
          back.remove();
          this.hint(tx("伴奏を再リンクしました: {names}", { names: r.linked.join(", ") }));
          return;
        }
        render();
        box.querySelector("#rl-msg")!.textContent = r.linked.length ? tx("リンクしました: {names}", { names: r.linked.join(", ") })
          : tx("一致するファイルが見つかりませんでした: {names}", { names: r.unmatched.join(", ") });
      })());
    };
    render();
    back.appendChild(box);
    document.body.appendChild(back);
  }

  // ── 楽譜の読み込み ────────────────────────────
  /** MusicXML・UST を読み、歌詞のあるパートごとに新しい歌のトラックを足す（最初の音符は 2 小節目より後ろに）。
   *  読み取りはブラウザの中（score.ts）。テンポは楽譜の値に合わせる。 */
  async importScore(file?: File): Promise<void> {
    const f = file ?? await pickFile(".musicxml,.xml,.mxl,.ust,.ustx");
    if (!f) return;
    let j: ScoreResult;
    try {
      j = await parseScoreFile(f.name, await f.arrayBuffer());
    } catch (e) {
      window.alert(tx("楽譜を読めませんでした: {name}", { name: f.name }) + `\n${e instanceof Error ? e.message : String(e)}`);
      return;
    }
    const st = this.store;
    const p = st.project;
    const before = st.snapshot();
    p.bpm = Math.round(j.bpm * 100) / 100;
    // 最初の子音を音符の頭より前に置けるよう、最初の音符が 2 小節目より前なら、そこまで後ろへずらす
    const first = Math.min(...j.tracks.flatMap((t) => t.notes.map((n) => n.onset)), Infinity);
    const offset = Number.isFinite(first) ? Math.max(0, p.beatsPerBar * TPQ - first) : 0;
    let nextId = st.nextId();
    let breaths = 0;
    const base = f.name.replace(/\.[^.]+$/, "");
    for (const t of j.tracks) {
      if (!t.notes.length) continue;
      // 歌い手は最初の歌のトラックから引き継ぐ。歌詞の言語が合わなければ（ハングルの楽譜を日本語の歌い手で、など）合うものへ
      const vocal = p.tracks.find((x) => !isAudioTrack(x));
      const cur = { voice: vocal?.voice ?? "ritsu", voicebank: vocal?.voicebank };
      const who = this.pickVoice(t.notes.map((n) => n.lyric), cur) ?? cur;
      const tr: Track = {
        id: Math.max(0, ...p.tracks.map((x) => x.id)) + 1, name: j.tracks.length > 1 ? `${base} ${t.name}` : base,
        voice: who.voice, voicebank: who.voicebank,
        color: "", mute: false, solo: false, base: defaultBase(),
        params: {}, notes: t.notes.map((n) => ({ id: nextId++, onset: n.onset + offset, dur: n.dur, pitch: n.pitch,
                                                  lyric: n.lyric, attrs: defaultAttrs() })),
      };
      tr.region = trackRegion(tr, p.beatsPerBar);
      // 楽譜のブレスの記号の後の音符にブレスを入れる（この歌い手のブレスの束が読めていれば）
      const ctx = this.breathContext(tr);
      if (ctx) {
        t.notes.forEach((n, i) => {
          if (n.breath && addOrCycleBreath(tr.notes[i], ctx)) breaths++;
        });
      }
      p.tracks.push(tr);
      p.activeTrack = p.tracks.length - 1;
    }
    st.selected.clear();
    st.commit(before);
    st.changed("project");
    this.onImport(st.track);
    const n = j.tracks.reduce((a, t) => a + t.notes.length, 0);
    const notes = j.warnings.concat(breaths ? [tx("ブレスを {n} 個入れました", { n: breaths })] : []);
    this.hint(tx("楽譜を読み込みました: {name}（{tracks} トラック、{notes} 音符、テンポ {bpm}）",
                 { name: f.name, tracks: j.tracks.length, notes: n, bpm: p.bpm }) +
      (notes.length ? tx("　注意: {w}", { w: notes.join(" / ") }) : ""));
  }

  // ── 保存 ────────────────────────────────
  async save(): Promise<void> {
    if (!this.handle) {
      await this.saveAs();
      return;
    }
    try {
      const wr = await this.handle.createWritable();
      await wr.write(serialize(this.store.project));
      await wr.close();
      this.dirty = false;
      this.showState(tx("保存しました"));
      this.hint(tx("保存しました: {name}", { name: this.handle.name }));
    } catch (e) {
      window.alert(tx("保存できませんでした: {e}", { e: String(e) }));
    }
  }

  async saveAs(): Promise<void> {
    const text = serialize(this.store.project);
    const name = `${this.store.projectName}.svsproj`;
    if (w.showSaveFilePicker) {
      try {
        const h = await w.showSaveFilePicker({ suggestedName: name, types: PROJECT_TYPES });
        const wr = await h.createWritable();
        await wr.write(text);
        await wr.close();
        this.handle = h;
        this.store.projectName = h.name.replace(/\.svsproj$/i, "");
        this.store.exportOpts.fileName = this.store.projectName;
        this.dirty = false;
        this.showState(tx("保存しました"));
        this.hint(tx("保存しました: {name}", { name: h.name }));
      } catch {
        // 選ばずに閉じた
      }
      return;
    }
    download(new Blob([text], { type: "application/json" }), name);
    this.dirty = false;
    this.showState(tx("ダウンロードしました"));
  }

  /** 歌のトラックを OpenUtau の .ustx に書き出す（音符・歌詞・テンポ・拍子。ピッチの線や表情は OpenUtau 側で付ける）。 */
  private async exportUstx(): Promise<void> {
    if (!this.store.project.tracks.some((t) => !isAudioTrack(t) && t.notes.length)) {
      window.alert(tx("書き出す音符がありません"));
      return;
    }
    const blob = new Blob([toUstx(this.store.project, this.store.projectName)], { type: "text/yaml" });
    const name = `${this.store.projectName}.ustx`;
    if (w.showSaveFilePicker) {
      try {
        const h = await w.showSaveFilePicker({ suggestedName: name,
                                               types: [{ description: tx("OpenUtau のプロジェクト"), accept: { "text/yaml": [".ustx"] } }] });
        const wr = await h.createWritable();
        await wr.write(blob);
        await wr.close();
        this.hint(tx("USTX に書き出しました: {name}", { name: h.name }));
      } catch {
        // 選ばずに閉じた
      }
      return;
    }
    download(blob, name);
    this.hint(tx("USTX に書き出しました: {name}", { name }));
  }

  private async saveBundle(): Promise<void> {
    const blob = bundle(this.store.project);
    const name = `${this.store.projectName}.zip`;
    if (w.showSaveFilePicker) {
      try {
        const h = await w.showSaveFilePicker({ suggestedName: name,
                                               types: [{ description: tx("音声も含めたプロジェクト"), accept: { "application/zip": [".zip"] } }] });
        const wr = await h.createWritable();
        await wr.write(blob);
        await wr.close();
        this.hint(tx("音声も含めて書き出しました: {name}（{mb} MB）", { name: h.name, mb: (blob.size / 1e6).toFixed(1) }));
      } catch {
        // 選ばずに閉じた
      }
      return;
    }
    download(blob, name);
  }
}

function download(blob: Blob, name: string): void {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function pickFiles(accept: string, multiple = true): Promise<File[]> {
  return new Promise((ok) => {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.accept = accept;
    inp.multiple = multiple;
    inp.addEventListener("change", () => ok([...(inp.files ?? [])]));
    inp.addEventListener("cancel", () => ok([]));
    inp.click();
  });
}

async function pickFile(accept: string): Promise<File | null> {
  return (await pickFiles(accept, false))[0] ?? null;
}
