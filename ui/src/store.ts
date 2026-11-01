// プロジェクトと選択の入れ物。undo はプロジェクト全体の JSON を積む（モックなので素朴に）。
import { defaultExportOptions, type ExportOptions } from "./export";
import { t as tx } from "./i18n";
import { growRegion, type Note, type Project, type Track } from "./model";

// mix: トラックの音量・パン・消音（再生の混ぜ方だけ。合成し直さない）
export type ChangeKind = "project" | "selection" | "playhead" | "view" | "settings" | "mix";

export class Store {
  project: Project;
  selected = new Set<number>();
  playTick = 0;
  version = 0; // プロジェクトが変わるたびに増える（計算の結果の取り置きに使う）
  /** chave do vocoder escolhido (pasta em vocoders/); "" = padrão */
  vocoder = "";
  /** o vocoder escolhido não tem ramos de harmônicos/ruído (tipo NSF-HiFiGAN): só volume e rouquidão valem */
  vocoderNsf = false;
  /** 書き出しの設定（プロジェクトの外。undo に積まない） */
  exportOpts: ExportOptions = defaultExportOptions();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private listeners: Array<(kind: ChangeKind) => void> = [];

  /** プロジェクトの名前（保存するファイルの名前。拡張子なし） */
  projectName = tx("無題");

  constructor(project: Project) {
    this.project = project;
  }

  /** 別のプロジェクトに入れ替える（開いたとき・新規のとき）。undo の履歴は消す。 */
  load(project: Project, name: string): void {
    this.project = project;
    this.projectName = name;
    this.exportOpts.fileName = name;
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this.selected.clear();
    this.playTick = 0;
    this.changed("project");
    this.changed("selection");
  }

  get track(): Track {
    return this.project.tracks[this.project.activeTrack];
  }

  snapshot(): string {
    return JSON.stringify(this.project);
  }

  /** 編集の前に取った snapshot を渡すと、中身が変わっていれば undo に積む。 */
  commit(before: string): void {
    if (before === this.snapshot()) return;
    this.undoStack.push(before);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): void {
    const s = this.undoStack.pop();
    if (s === undefined) return;
    this.redoStack.push(this.snapshot());
    this.project = JSON.parse(s) as Project;
    this.pruneSelection();
    this.changed("project");
  }

  redo(): void {
    const s = this.redoStack.pop();
    if (s === undefined) return;
    this.undoStack.push(this.snapshot());
    this.project = JSON.parse(s) as Project;
    this.pruneSelection();
    this.changed("project");
  }

  nextId(): number {
    let m = 0;
    for (const t of this.project.tracks) for (const n of t.notes) m = Math.max(m, n.id);
    return m + 1;
  }

  pruneSelection(): void {
    const ids = new Set(this.track.notes.map((n) => n.id));
    for (const id of [...this.selected]) if (!ids.has(id)) this.selected.delete(id);
  }

  // ── コピーと貼り付け ──
  /** コピーした音符（頭を 0 に寄せた相対の位置で持つ。プロジェクトの外なので undo に積まない）。トラックをまたいで貼れる */
  clipboard: Note[] = [];

  /** 選んだ音符を写す。写した数を返す */
  copySelected(): number {
    const sel = this.track.notes.filter((n) => this.selected.has(n.id));
    if (!sel.length) return 0;
    const t0 = Math.min(...sel.map((n) => n.onset));
    this.clipboard = sel.map((n) => ({ ...structuredClone(n), onset: n.onset - t0 }));
    return sel.length;
  }

  /** 写してから消す（切り取り）。消した数を返す */
  cutSelected(): number {
    const n = this.copySelected();
    if (!n) return 0;
    const before = this.snapshot();
    this.track.notes = this.track.notes.filter((x) => !this.selected.has(x.id));
    this.selected.clear();
    this.commit(before);
    this.changed("project");
    this.changed("selection");
    return n;
  }

  /** 写しを今のトラックの再生位置に貼る（相対の位置はそのまま、id は振り直す）。貼った音符を選ぶ。貼った数を返す */
  paste(): number {
    if (!this.clipboard.length) return 0;
    const before = this.snapshot();
    const base = Math.round(this.playTick);
    const t = this.track;
    let id = this.nextId();
    this.selected.clear();
    for (const c of this.clipboard) {
      const n: Note = { ...structuredClone(c), id: id++, onset: base + c.onset };
      t.notes.push(n);
      growRegion(t, n, this.project.beatsPerBar);
      this.selected.add(n.id);
    }
    this.commit(before);
    this.changed("project");
    this.changed("selection");
    return this.clipboard.length;
  }

  on(fn: (kind: ChangeKind) => void): void {
    this.listeners.push(fn);
  }

  changed(kind: ChangeKind): void {
    if (kind === "project") this.version++;
    for (const fn of this.listeners) fn(kind);
  }
}
