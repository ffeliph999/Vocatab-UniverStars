// プロジェクトと選択の入れ物。undo はプロジェクト全体の JSON を積む（モックなので素朴に）。
import { defaultExportOptions, type ExportOptions } from "./export";
import { t as tx } from "./i18n";
import type { Project, Track } from "./model";

// mix: トラックの音量・パン・消音（再生の混ぜ方だけ。合成し直さない）
export type ChangeKind = "project" | "selection" | "playhead" | "view" | "settings" | "mix";

export class Store {
  project: Project;
  selected = new Set<number>();
  playTick = 0;
  version = 0; // プロジェクトが変わるたびに増える（計算の結果の取り置きに使う）
  vocoder: "nhv" | "nsf" = "nhv";
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

  on(fn: (kind: ChangeKind) => void): void {
    this.listeners.push(fn);
  }

  changed(kind: ChangeKind): void {
    if (kind === "project") this.version++;
    for (const fn of this.listeners) fn(kind);
  }
}
