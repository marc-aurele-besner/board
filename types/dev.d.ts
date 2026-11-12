// What Dev's side panels (js/modules/dev-files.js, dev-git.js, dev-search.js, dev-worktrees.js) need of the Dev
// section (js/modules/dev.js filesCtx()).

import type { Store } from './data';

// A changed file's mark in the explorer (dev-git.js): a folder holding changes has only a tone.
export interface FileDecor {
  tone: string;
  letter?: string;
  label?: string;
}

// A terminal of the Dev page, as the panels read it.
export interface DevTerminalRef {
  id: string;
  n: number;
  cwd: string;
  running: boolean;
}

export interface DevContext {
  // The command runner's address.
  base(): string;
  // The runner answered.
  ready(): boolean;
  refresh(): void;
  decor?(path: string): FileDecor | null;
  store: Store;
  sessions(): DevTerminalRef[];
  openTerminal(path: string): void;
  // A link to the Cron run that started a session or worktree, or null.
  cronLink(which: { session?: string; worktree?: string; runId?: string }, label: string): HTMLElement | null;
  // Shows a terminal, listing it again when Dev's list lost it.
  showTerminal(id: string, cwd?: string): void;
}
