// The command runner's answers (tools/terminal.js), as js/terminal.js returns them. API responses: only what the
// board reads, or what js/terminal.js documents, is typed.

import type { DevSession, DevUsage } from './data';

// GET /info.
export interface RunnerInfo {
  root: string;
  home: string;
  shell: string;
  max: number;
  running: number;
}

// GET /sessions: sessions is null before any list was saved.
export interface RunnerSessionList {
  active: string;
  sessions: DevSession[] | null;
}

// GET /status, by session id.
export interface RunnerStatus {
  // working, waiting, done, failed, stopped or idle.
  state: string;
  code?: number | null;
  cwd: string;
  // Subagents still working, for claude in a worktree.
  agents?: number;
}

// GET /files.
export interface RunnerFolder {
  path: string;
  entries: { name: string; dir: boolean }[];
}

// GET /file: text, or binary / tooLarge instead.
export interface RunnerFile {
  path: string;
  size: number;
  text?: string;
  binary?: boolean;
  tooLarge?: boolean;
}

// One event of a session's stream: session, start, out, err, size, cwd, exit, live or closed.
export interface RunnerEvent {
  t: string;
  // Output (out, err) or the folder (cwd).
  d?: string;
  // session: whether the runner had it.
  known?: boolean;
  // start.
  pid?: number;
  cwd?: string;
  command?: string;
  at?: number;
  // start and size.
  cols?: number;
  rows?: number;
  // exit.
  code?: number | null;
  signal?: string | null;
  ms?: number;
  stopped?: boolean;
  lost?: boolean;
}

// POST /run.
export interface RunnerRun {
  pid: number;
  cwd: string;
}

// POST /worktree/remove.
export interface RunnerRemoved {
  removed?: string;
  missing?: boolean;
}

// POST /claude/exit.
export interface RunnerClaudeExit {
  ended: boolean;
  removed: boolean;
  path: string;
  kept?: string;
}

// GET /worktrees: one worktree of the repository, but its main checkout.
export interface RunnerWorktree {
  path: string;
  name: string;
  branch: string;
  head: string;
  // Made by claude --worktree (in .claude/worktrees).
  claude: boolean;
  locked: boolean;
  prunable: boolean;
  pid: number | null;
  // The claude that locked it still runs.
  running: boolean;
  // The runner's running commands started inside it, and its running sessions there.
  commands: number;
  sessions: { id: string; cwd: string }[];
  // Files git would refuse to remove it over; null when it could not tell.
  changes: number | null;
}

export interface RunnerWorktrees {
  repo?: false;
  root?: string;
  worktrees?: RunnerWorktree[];
}

// A changed file, by git's status letters.
export interface GitFile {
  path: string;
  orig?: string;
  index: string;
  work: string;
  untracked?: boolean;
  conflict?: boolean;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  // Milliseconds.
  at: number;
  subject: string;
  refs: string[];
}

// GET /git: { repo: false, path } outside a repository.
export interface GitStatus {
  repo: boolean;
  path?: string;
  root?: string;
  branch?: string;
  oid?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  files?: GitFile[];
  // Files left out of `files`.
  more?: number;
  branches?: string[];
  remotes?: string[];
  log?: GitCommit[];
}

// GET /git/diff: a file's diff, or a commit's with `commit`.
export interface GitDiff {
  diff: string;
  commit?: { hash: string; author: string; email: string; at: number; message: string };
}

// GET /outcome.
export interface RunnerOutcome {
  output: string;
  repo: boolean;
  root?: string;
  branch?: string;
  upstream?: string;
  ahead?: number;
  behind?: number;
  base?: string;
  commit?: string;
  short?: string;
  subject?: string;
  commits?: { hash: string; short: string; subject: string }[];
  files?: { status: string; path: string; from?: string }[];
  more?: number;
  uncommitted?: number;
}

// GET /search.
export interface SearchMatch {
  path: string;
  line: number;
  col: number;
  text: string;
}

export interface RunnerSearch {
  path?: string;
  matches: SearchMatch[];
  more: boolean;
}

// POST /usage, by worktree name: what its claude sessions used (tools/usage.js).
export type WorktreeUsage = Omit<DevUsage, 'name' | 'cwd' | 'added' | 'taskIds' | 'session'>;
