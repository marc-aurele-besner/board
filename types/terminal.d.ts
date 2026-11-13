// The command runner's answers (tools/terminal.js), as js/terminal.js returns them. API responses: only what the
// board reads, or what js/terminal.js documents, is typed.

import type { DevSession, DevToolUse, DevUsage } from './data';

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
  // What claude waits on, when waiting stopped at a tool call: a question, a plan or a tool to allow.
  ask?: SessionAsk | null;
  // When that wait began, for one read from claude's screen rather than its transcript.
  since?: number;
  // The Artifacts claude published in this session.
  artifacts?: SessionArtifact[];
}

// kind: question, plan or permission. text: the question, or the tool and what it runs.
export interface SessionAsk {
  kind: string;
  text: string;
}

// A stretch of a turn spent waiting on the user: a question, a plan to approve or (only while it lasts) a permission.
// end 0 while it goes on.
export interface SessionWait {
  kind: string;
  at: number;
  end: number;
}

// One prompt of a claude session: what the user said, when (ms), when claude last answered it, whether the user
// interrupted it, the waits on the user inside it, and whether its last reply gave the done signal (js/dev-done.js).
export interface SessionTurn {
  text: string;
  at: number;
  end: number;
  interrupted: boolean;
  waits: SessionWait[];
  done?: boolean;
  // What it called and ran, and its replies' output tokens (as in DevTurn).
  tools: Record<string, DevToolUse>;
  skills: Record<string, number>;
  tokens: number;
}

// GET /turns: the prompts of a terminal's claude session, oldest first, and where its last turn stands: working,
// waiting (on a question, a plan or a permission: ask), or done (claude quit, or
// its last turn gave the done signal). claude false when the terminal never started claude.
export interface RunnerTurns {
  claude: boolean;
  state: string;
  ask?: SessionAsk | null;
  turns: SessionTurn[];
  // The skills it ran and the MCP tools it called, with how many times (as in DevUsage).
  skills?: Record<string, number>;
  mcp?: Record<string, number>;
  // Its subagents, newest first.
  agents?: SessionAgent[];
}

// A subagent of a claude session, from its transcript and .meta.json in <session>/subagents. state: working, done,
// or stopped (its transcript ended mid-turn, or went quiet too long). tool: its last tool call and what it worked
// on; tools: how many calls it made. task: the prompt it was given; said: its last text (its answer once done).
export interface SessionAgent {
  id: string;
  type: string;
  description: string;
  background: boolean;
  state: string;
  start: number;
  end: number;
  tool: { name: string; detail: string; at: number } | null;
  tools: number;
  said: string;
  task: string;
}

// A claude.ai Artifact link; title '' when none was given.
export interface SessionArtifact {
  url: string;
  title: string;
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

// One event of a session's stream, as attachSession() hands it on.
export type RunnerEvent =
  // Whether the runner had the session; its events so far are replayed next.
  | { t: 'session'; known: boolean }
  // The replay is over: new events follow as they come.
  | { t: 'live' }
  | { t: 'closed' }
  | { t: 'size'; cols: number; rows: number }
  // Starts written before the runner noted sizes lack cols and rows.
  | ({ t: 'start'; pid: number; cwd: string; command: string; at: number } & ({ cols: number; rows: number } | { cols?: undefined; rows?: undefined }))
  | { t: 'out' | 'err'; d: string }
  // The folder the command ended in.
  | { t: 'cwd'; d: string }
  // lost: the runner stopped while the command ran.
  | { t: 'exit'; code: number | null; signal: string | null; ms?: number; stopped?: boolean; lost?: boolean };

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
export type GitStatus = { repo: false; path: string } | GitRepoStatus;

export interface GitRepoStatus {
  repo: true;
  root: string;
  // '' when detached.
  branch: string;
  // '' before the first commit.
  oid: string;
  upstream: string;
  ahead: number;
  behind: number;
  files: GitFile[];
  // Files left out of `files`.
  more: number;
  branches: string[];
  remotes: string[];
  log: GitCommit[];
}

// GET /git/diff: a file's diff, or a commit's with `commit`.
export interface GitDiff {
  diff: string;
  commit?: { hash: string; author: string; email: string; at: number; message: string };
}

// GET /git/pr: the branch against the default branch, from where they part.
export interface GitPullRequest {
  root: string;
  // '' when detached.
  branch: string;
  base: string;
  mergeBase: string;
  // Only the commits: uncommitted and new files left out.
  committed: boolean;
  // Files changed in the working folder.
  uncommitted: number;
  // The latest commits, newest first; `count` is how many there are in all.
  commits: { hash: string; short: string; author: string; at: number; subject: string }[];
  count: number;
  // One unified diff of every file.
  diff: string;
  // New files left out of `diff`.
  more: number;
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

// A Claude Code skill, from its SKILL.md: typed as /<name> in claude.
export interface RunnerSkill {
  name: string;
  description: string;
  path: string;
}

// Dev's Skills panel: the user's own skills (~/.claude/skills) and the project's (.claude/skills), and the repository
// (or folder) the project's were read from.
export interface RunnerSkills {
  global: RunnerSkill[];
  project: RunnerSkill[];
  root: string;
}
