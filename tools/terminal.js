// Local command runner for the Dev section: `bun run terminal` (or `node tools/terminal.js`), or with the board
// through `bun start`. It runs a command in the user's shell and streams its output back as it comes, and lists
// folders, reads and searches files for the Dev file explorer and Search (read only), and runs git for Dev's Source Control. It also
// removes the git worktree a task's session made once the task is completed, and only a clean one, saves the
// images the page hands to claude as files, and reads what a task's claude session used from its transcripts and
// whether it is still working.
// The runner owns each terminal session: a command keeps running when the page reloads or closes, and the session's
// output is kept (in memory and in TERMINAL_STATE, a folder in the system's temp folder by default) so the page
// shows it again when it comes back, even after the runner restarted. The list of open terminals is kept there too,
// so every browser on this machine opens the same terminals.
// TERMINAL_PORT changes the port (8419 by default); TERMINAL_MAX the number of commands that may run at once (50).
// It can run anything on this machine, so it listens on 127.0.0.1 only and answers only pages served from this
// machine: the Origin check keeps other websites out, the Host check keeps out DNS rebinding.
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
/** @import { ChildProcessByStdio } from 'node:child_process' */
/** @import { Readable, Writable } from 'node:stream' */
/** @import { RequestBody } from '../types/runner' */
/** @import { DevSession } from '../types/data' */
/** @import { GitFile, RunnerEvent, RunnerSearch, SearchMatch, SessionArtifact, SessionAsk } from '../types/terminal' */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.js';
import { createTerminal } from '../js/vt.js';
import { sessionTranscript, worktreeActivity, worktreeUsage } from './usage.js';
import { installSkill, skillStatus } from './board-skill.js';

const PORT = Number(process.env.TERMINAL_PORT) || 8419;
const MAX = Number(process.env.TERMINAL_MAX) || 50;
const ROOT = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, '');
const WINDOWS = process.platform === 'win32';
const SHELL = WINDOWS ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// Commands may stop on their own; one that ignores SIGTERM is killed this long after.
const KILL_AFTER_MS = 2000;
// The file reader shows text files up to this size.
const READ_MAX = 1024 * 1024;
// Each session keeps this much output; older output is dropped first.
const LOG_MAX = 2 * 1024 * 1024;
// Sessions the page has not come back to for this long are deleted from disk.
const KEEP_MS = 30 * 24 * 3600 * 1000;
// Output reaches the disk in batches, at most this often.
const FLUSH_MS = 250;
const STATE = resolve(process.env.TERMINAL_STATE || join(tmpdir(), 'board-terminal'));
const SESSION_ID = /^[\w-]{1,64}$/;
// The terminals the page lists, in order, with the one shown.
const LIST_FILE = join(STATE, 'sessions.json');
// A task's prompt can be long; the list may be this large.
const LIST_MAX = 2 * 1024 * 1024;
const WORKTREE_NAME = /^[\w.-]{1,64}$/;
// Images the page hands to claude (pasted into a terminal, or kept on a task) are saved here, as files claude can read.
const IMAGES = join(STATE, 'images');
const IMAGE_MAX = 20 * 1024 * 1024;
// The runners' API (tools/worker.js), which tools/board.js calls from inside a terminal.
const WORKER_API = `http://127.0.0.1:${Number(process.env.WORKER_PORT) || 8420}`;
// That command, by its full path: claude runs it from another project's folder.
const BOARD_CLI = join(ROOT, 'tools', 'board.js');
/** @type {Record<string, string>} */
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const log = logger('terminal');

/** @typedef {Record<string, string>} Cors */
// An event as the runner keeps it: the fields some kinds lack read as optional on every kind.
/** @typedef {RunnerEvent & { d?: string, cols?: number, rows?: number, cwd?: string, command?: string }} SessionEvent */
/** @typedef {ChildProcessByStdio<Writable, Readable, Readable>} Child */
/**
 * A command and its session. `child` is set once the command has started.
 * @typedef {{ child: Child | null, dir: string, session: Session, stopped: boolean, killer: NodeJS.Timeout | number }} Job
 */
/**
 * @typedef {{ id: string, events: SessionEvent[], size: number, open: SessionEvent | null, listeners: Set<ServerResponse>,
 *   run: Job | null, known: boolean, pending: string, rewrite: boolean, timer: NodeJS.Timeout | number,
 *   disk: Promise<unknown>, closed: boolean, lastOut?: number, taps?: Set<(event: SessionEvent) => void>, transcript?: string,
 *   artifacts?: SessionArtifact[], artifactsRead?: SessionEvent, askSince?: number }} Session
 */

// Running commands by pid: the child, the folder it reports into, and its session.
/** @type {Map<number | undefined, Job & { child: Child }>} */
const running = new Map();
// Terminal sessions by id: their events (start, out, err, cwd, exit), the pages attached, and the running command.
/** @type {Map<string, Session>} */
const sessions = new Map();

/** @param {string} path */
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);

/** @param {string} path */
async function folderOf(path) {
  const full = resolve(expand(path || ROOT));
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`No folder at ${full}`);
  return full;
}

// Commands run in a pseudo-terminal, so interactive programs (the Claude CLI, prompts, progress bars) work and
// colour their output as in a real terminal. The page draws that output with its own terminal emulator.
// COLORFGBG tells programs that read it whether the page is light or dark (foreground;background).
/** @param {string} dir @param {unknown} theme */
function commandEnv(dir, theme) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: theme === 'dark' ? '15;0' : '0;15', PAGER: 'cat', GIT_PAGER: 'cat', BOARD_RUN_DIR: dir, BOARD_API: WORKER_API, BOARD_CLI };
  delete env.NO_COLOR;
  return env;
}

// `script` gives the command a pseudo-terminal with no dependency. macOS's script cannot read from the socket Node
// passes as stdin (nor from a FIFO), so `cat` copies it into a plain pipe through bash's process substitution. Bash
// then becomes script (exec), so the runner sees script's exit and its code, and nothing else holds the output open.
/** @param {string} script @returns {[string, string[]]} */
function ptyArgs(script) {
  if (process.platform === 'darwin') return ['/bin/bash', ['-c', 'exec script -q /dev/null "$@" < <(exec cat 2>/dev/null)', 'bash', SHELL, '-c', script]];
  return ['/bin/bash', ['-c', 'exec script -q -f -e -c "$0 -c \\"\\$BOARD_SCRIPT\\"" /dev/null < <(exec cat 2>/dev/null)', SHELL]];
}

/** @param {unknown} n @param {number} fallback @param {number} max */
const size = (n, fallback, max) => Math.min(max, Math.max(10, Math.round(Number(n)) || fallback));

// A folder's entries, folders first, for the explorer.
/** @param {string} path */
async function listFolder(path) {
  const full = await folderOf(path);
  const entries = await readdir(full, { withFileTypes: true });
  /** @type {{ name: string, dir: any }[]} */ // any: true, false or null (a link), subtracted in the sort
  const rows = entries.map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && null) }));
  // A link is shown as a folder when it points to one.
  await Promise.all(rows.filter((r) => r.dir === null).map(async (r) => (r.dir = !!(await stat(resolve(full, r.name)).catch(() => null))?.isDirectory())));
  rows.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: full, entries: rows };
}

// One file's text. Large and binary files are described, not sent.
/** @param {string} path */
async function readText(path) {
  const full = resolve(expand(path));
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new Error(`No file at ${full}`);
  if (info.size > READ_MAX) return { path: full, size: info.size, tooLarge: true };
  const bytes = await readFile(full);
  if (bytes.subarray(0, 8000).includes(0)) return { path: full, size: info.size, binary: true };
  return { path: full, size: info.size, text: bytes.toString('utf8') };
}

// Sessions. Every event of a session is kept and written to <id>.ndjson, so a page that attaches again gets the
// whole terminal back: the events are replayed into its emulator, then live ones follow.
/** @param {string} id */
const logFile = (id) => join(STATE, `${id}.ndjson`);
/** @param {object} event */
const lineOf = (event) => `${JSON.stringify(event)}\n`;
/** @param {SessionEvent} event */
const sizeOf = (event) => (event.d?.length ?? 0) + 64;

try {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
} catch (err) {
  log.error(`Cannot keep terminal sessions in ${STATE}: ${/** @type {Error} */ (err).message}`);
}
// Old sessions nobody came back to.
readdir(STATE)
  .then((names) => Promise.all(names.filter((n) => n.endsWith('.ndjson')).map(async (n) => {
    const info = await stat(join(STATE, n)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > KEEP_MS) await rm(join(STATE, n), { force: true });
  })))
  .catch(() => {});
readdir(IMAGES)
  .then((names) => Promise.all(names.map(async (n) => {
    const info = await stat(join(IMAGES, n)).catch(() => null);
    if (info && Date.now() - info.mtimeMs > KEEP_MS) await rm(join(IMAGES, n), { force: true });
  })))
  .catch(() => {});

// Adds an event to the session's log. Output arriving in pieces is merged into one event.
/** @param {Session} s @param {SessionEvent} event */
function push(s, event) {
  const last = s.events.at(-1);
  if ((event.t === 'out' || event.t === 'err') && last?.t === event.t) last.d += event.d;
  else s.events.push({ ...event });
  s.size += sizeOf(event);
  if (event.t === 'start') s.open = /** @type {SessionEvent} */ (s.events.at(-1)); // the copy pushed above
  if (event.t === 'out' || event.t === 'err' || event.t === 'start') s.lastOut = Date.now();
  if (event.t === 'exit') s.open = null;
  if (s.size <= LOG_MAX) return;
  // Too long: the oldest output goes, down to three quarters, but the running command's start stays, followed by
  // the terminal's size at the cut, so the output after it is replayed at the size it was drawn at.
  /** @type {{ cols: number, rows: number } | null} */
  let dims = null;
  while (s.events.length > 1 && s.size > LOG_MAX * 0.75) {
    const gone = /** @type {SessionEvent} */ (s.events.shift()); // the loop keeps at least one
    s.size -= sizeOf(gone);
    // An event with cols (a start or a size) has rows too.
    if (gone.cols) dims = { cols: gone.cols, rows: /** @type {number} */ (gone.rows) };
  }
  if (dims && !s.events[0].cols) {
    s.events.unshift({ t: 'size', ...dims });
    s.size += sizeOf(s.events[0]);
  }
  if (s.open && !s.events.includes(s.open)) {
    s.events.unshift(s.open);
    s.size += sizeOf(s.open);
  }
  s.rewrite = true;
}

// Writes are serialized per session: a batch of new lines, or the whole log after it was cut.
/** @param {Session} s */
function flush(s) {
  s.timer = 0;
  if (s.closed) return;
  const rewrite = s.rewrite;
  const text = rewrite ? s.events.map(lineOf).join('') : s.pending;
  s.pending = '';
  s.rewrite = false;
  s.disk = s.disk
    .then(() => (rewrite ? writeFile : appendFile)(logFile(s.id), text, { mode: 0o600 }))
    .catch((err) => log.error(`Could not save terminal ${s.id}: ${err.message}`));
}

/** @param {Session} s @param {SessionEvent} event */
function record(s, event) {
  push(s, event);
  for (const tap of s.taps ?? []) tap(event);
  const line = lineOf(event);
  if (!s.rewrite) s.pending += line;
  s.timer ||= setTimeout(() => flush(s), FLUSH_MS);
  if (s.listeners.size) {
    const tagged = lineOf({ ...event, s: s.id });
    for (const res of s.listeners) res.write(tagged);
  }
}

// A session by id, read from disk when the runner has not seen it since it started.
/** @param {string} id @returns {Promise<Session>} */
async function sessionOf(id) {
  if (sessions.has(id)) return /** @type {Session} */ (sessions.get(id));
  const text = await readFile(logFile(id), 'utf8').catch(() => '');
  if (sessions.has(id)) return /** @type {Session} */ (sessions.get(id));
  /** @type {Session} */
  const s = { id, events: [], size: 0, open: null, listeners: new Set(), run: null, known: !!text, pending: '', rewrite: false, timer: 0, disk: Promise.resolve(), closed: false };
  for (const line of text.split('\n')) {
    try {
      if (line) push(s, JSON.parse(line));
    } catch {}
  }
  s.rewrite = false;
  sessions.set(id, s);
  // A command that was running when the runner stopped never said how it ended.
  if (s.open) record(s, { t: 'exit', code: null, signal: null, lost: true });
  return s;
}

// The worktree a claude command names (`claude --worktree <name>`, or -w), before the prompt after `--`.
const WORKTREE_FLAG = /(?:^|\s)(?:--worktree|-w)(?:=|\s+)([\w.-]{1,64})(?=\s|$)/;
/** @param {string} [command] */
const worktreeOf = (command = '') => WORKTREE_FLAG.exec(String(command).split(/\s--\s/)[0])?.[1] ?? '';

// The claude transcript of a session that started claude: found by its folder, start time and prompt (the last word
// of the command, quoted by shellQuote() in js/dev-core.js), then remembered. Null for any other command.
const PROMPT_ARG = /\s--\s+('(?:[^']|'\\'')*')\s*$/;
/** @param {string} [command] */
const startsClaude = (command = '') => /(?:^|[\s/])claude(?:\s|$)/.test(command.split(/\s--\s/)[0]);
/** @param {Session} s */
async function transcriptOf(s) {
  const start = s.open ?? s.events.findLast((e) => e.t === 'start');
  if (start?.t !== 'start' || !start.at || !startsClaude(start.command)) return null;
  const quoted = PROMPT_ARG.exec(start.command)?.[1];
  const prompt = quoted ? quoted.slice(1, -1).replace(/'\\''/g, "'") : '';
  const t = await sessionTranscript({ cwd: start.cwd, at: start.at, prompt, worktree: worktreeOf(start.command), known: s.transcript }).catch(() => null);
  if (t) s.transcript = t.file;
  return t;
}

// What claude's screen asks of its user, when the last thing it drew is a prompt: a question's options or a request
// to proceed, closed by "Esc to cancel" and drawn after the "esc to interrupt" of its last working stretch. Read
// from the end of the output, without the escapes and spaces claude draws with.
const SCREEN_TAIL = 20000;
/** @param {Session} s @returns {SessionAsk | null} */
function screenAsk(s) {
  // A session read back from disk keeps its output in many small events.
  let out = '';
  for (let i = s.events.length - 1; i >= 0 && out.length < SCREEN_TAIL; i--) {
    const e = s.events[i];
    if (e.t === 'out') out = (e.d ?? '') + out;
    else if (e.t === 'start') break;
  }
  const seen = out.slice(-SCREEN_TAIL).replace(ESCAPES, '').replace(/\s+/g, '').toLowerCase();
  const at = seen.lastIndexOf('esctocancel');
  if (at < 0 || at < seen.lastIndexOf('esctointerrupt')) return null;
  const prompt = seen.slice(Math.max(0, at - 3000), at);
  if (prompt.includes('wouldyouliketoproceed')) return { kind: 'plan', text: 'Approve the plan' };
  if (prompt.includes('doyouwantto')) return { kind: 'permission', text: 'Allow a tool' };
  if (prompt.includes('entertoselect')) return { kind: 'question', text: 'Answer its question' };
  return null;
}

// What a session is doing, for a task's Dev button: running (and how long it has been quiet, as a program waiting
// for its user prints nothing), ended (with its exit code), or idle. A session that is gone is left out.
// Quiet is not enough for claude: a long tool call or a background subagent prints nothing either, so it waits only
// once its transcript says the turn ended and no subagent is still working.
// The Artifacts claude published come along, as last read from its transcript (not while output streams).
const QUIET_MS = 8000;
/** @param {string} id */
async function statusOf(id) {
  if (!sessions.has(id) && !(await stat(logFile(id)).catch(() => null))) return null;
  const s = await sessionOf(id);
  if (s.closed) return null;
  if (s.run) {
    const cwd = s.open?.cwd ?? '';
    if (Date.now() - (s.lastOut ?? 0) < QUIET_MS) return { state: 'working', cwd, ...(s.artifacts ? { artifacts: s.artifacts } : {}) };
    const name = worktreeOf(s.open?.command);
    const activity = (await transcriptOf(s))
      ?? (name && cwd ? (await worktreeActivity([{ name, cwd }]).catch(() => /** @type {Awaited<ReturnType<typeof worktreeActivity>>} */ ({})))[name] : null);
    // A turn stopped at a tool call with the terminal quiet waits on its user: a question, a plan, or a permission.
    // claude may not have written that reply to its transcript yet: the prompt on its screen tells instead.
    const shown = activity?.busy && !activity.ask ? screenAsk(s) : null;
    s.askSince = shown ? s.askSince || s.lastOut || Date.now() : 0;
    const ask = activity?.ask ?? shown;
    if (activity) s.artifacts = activity.artifacts;
    const more = activity ? { agents: activity.agents, ask, artifacts: activity.artifacts, ...(shown ? { since: s.askSince } : {}) } : {};
    const state = activity?.busy && !ask ? 'working' : 'waiting';
    // For the terminal's dot in Dev: a turn that ended with the done signal, and how long a working claude with no
    // subagent has neither printed nor written to its transcript (one that hangs does neither).
    const signalled = state === 'waiting' && !ask && !!activity && 'turns' in activity && !!/** @type {{ done?: boolean }[]} */ (activity.turns).at(-1)?.done;
    const written = state === 'working' && !activity?.agents && s.transcript ? (await stat(s.transcript).catch(() => null))?.mtimeMs : 0;
    // In whole minutes: Tasks draws again when a status changes, and a count of milliseconds changes at every read.
    const quiet = written ? Math.floor(Math.max(0, Date.now() - Math.max(s.lastOut ?? 0, written)) / 60000) * 60000 : 0;
    return { state, cwd, ...more, ...(signalled ? { signalled } : {}), ...(quiet ? { quiet } : {}) };
  }
  const exit = s.events.findLast((e) => e.t === 'exit');
  const where = s.events.findLast((e) => e.t === 'cwd' || e.t === 'start');
  const cwd = (where?.t === 'cwd' ? where.d : where?.cwd) ?? '';
  if (!exit) return { state: 'idle', cwd };
  // claude may publish just before it quits: its transcript is read once more after the exit.
  if (s.artifactsRead !== exit) {
    s.artifactsRead = exit;
    const t = await transcriptOf(s).catch(() => null);
    if (t) s.artifacts = t.artifacts;
  }
  return { state: exit.stopped ? 'stopped' : exit.code === 0 ? 'done' : 'failed', code: exit.code, cwd, ...(s.artifacts ? { artifacts: s.artifacts } : {}) };
}

// The prompts of the claude a terminal started, for the turns menu on Dev's bar, and where the last one stands:
// working, waiting on its user (with what it asks), or done once claude quit or gave the done
// signal (js/dev-done.js). Null for a terminal gone.
/** @param {string} id @returns {Promise<import('../types/terminal').RunnerTurns | null>} */
async function turnsOf(id) {
  const status = await statusOf(id);
  if (!status) return null;
  const t = await transcriptOf(await sessionOf(id)).catch(() => null);
  if (!t) return { claude: false, state: status.state, turns: [] };
  const ask = 'ask' in status ? /** @type {SessionAsk | null} */ (status.ask) : null;
  // A claude still open that ended its last turn with the done signal, asking nothing, is done too.
  const signalled = status.state === 'waiting' && !ask && !!t.turns.at(-1)?.done;
  const state = (status.state === 'working' || status.state === 'waiting') && !signalled ? status.state : 'done';
  // The wait going on now, whatever it waits on (a permission too, which leaves no trace once answered). One read
  // from the screen starts when the prompt was drawn.
  const since = /** @type {{ since?: number }} */ (status).since || t.since;
  const last = t.turns.at(-1);
  const turns = state === 'waiting' && last && since >= last.at
    ? [...t.turns.slice(0, -1), { ...last, waits: [...last.waits, { kind: ask?.kind ?? 'permission', at: since, end: 0 }] }]
    : t.turns;
  return { claude: true, state, ask, turns, skills: t.skills, mcp: t.mcp, agents: t.subagents, agentTools: t.agentTools, failures: t.failures };
}

// Each page reads every terminal through one stream: a browser opens only six connections to a host, so a stream
// per terminal used them all up after a few terminals and the next command never reached the runner. Events carry
// their session's id as `s`. Streams by the page's client id.
/** @type {Map<string, ServerResponse>} */
const streams = new Map();
const CLIENT_ID = /^[\w-]{1,64}$/;

/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors @param {string} client */
function openStream(req, res, cors, client) {
  res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.write(lineOf({ t: 'hello' }));
  streams.get(client)?.end();
  streams.set(client, res);
  res.on('close', () => {
    if (streams.get(client) === res) streams.delete(client);
    for (const s of sessions.values()) s.listeners.delete(res);
  });
}

// The page attaches a session to its stream: everything so far, a `live` marker, then events as they come.
// Detaching stops them.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors @param {string} action */
async function attach(req, res, cors, action) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const out = streams.get(String(body.client ?? ''));
  if (!out) return res.writeHead(404, cors).end('No stream for this page.');
  const id = String(body.session ?? '');
  if (!SESSION_ID.test(id)) return res.writeHead(400, cors).end('No terminal session.');
  if (action === 'detach') {
    sessions.get(id)?.listeners.delete(out);
    return res.writeHead(204, cors).end();
  }
  const s = await sessionOf(id);
  const tag = (/** @type {SessionEvent} */ e) => lineOf({ ...e, s: id });
  out.write(tag({ t: 'session', known: s.known || s.events.length > 0 }) + s.events.map(tag).join('') + tag({ t: 'live' }));
  s.listeners.add(out);
  res.writeHead(204, cors).end();
}

/** @param {IncomingMessage} req @returns {Promise<string>} */
function readBody(req, max = 100_000) {
  return new Promise((done, fail) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > max) req.destroy(new Error('Request too large'));
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });
}

// Saves an image sent as raw bytes and answers its path: { path }. Its content type picks the extension.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors @param {string} ext */
async function saveImage(req, res, cors, ext) {
  /** @type {Buffer[]} */
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      size += chunk.length;
      if (size > IMAGE_MAX) return res.writeHead(413, cors).end('That image is larger than 20 MB.');
      chunks.push(chunk);
    }
    await mkdir(IMAGES, { recursive: true, mode: 0o700 });
    const path = join(IMAGES, `${Date.now().toString(36)}-${randomBytes(4).toString('hex')}.${ext}`);
    await writeFile(path, Buffer.concat(chunks), { mode: 0o600 });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ path }));
  } catch (err) {
    res.writeHead(500, cors).end(`Could not save the image: ${/** @type {Error} */ (err).message}`);
  }
}

// The whole process group, so a dev server started by the command stops with it.
/** @param {Child} child @param {NodeJS.Signals} signal */
function stop(child, signal) {
  try {
    if (WINDOWS) child.kill(signal);
    else process.kill(-(/** @type {number} */ (child.pid)), signal); // no pid: the spawn failed, and kill(NaN) throws
  } catch {}
}

/**
 * @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors @param {number} [max]
 * @returns {Promise<RequestBody | null>}
 */
async function jsonBody(req, res, cors, max) {
  try {
    return JSON.parse(await readBody(req, max));
  } catch {
    res.writeHead(400, cors).end('Send JSON.');
    return null;
  }
}

/** @param {RequestBody} body @param {ServerResponse} res @param {Cors} cors */
async function sessionFrom(body, res, cors) {
  const id = String(body.session ?? '');
  if (SESSION_ID.test(id)) return sessionOf(id);
  res.writeHead(400, cors).end('No terminal session.');
  return null;
}

// Starts a command in a session. Its output goes to the session, which the page reads through /attach.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function run(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const command = String(body.command ?? '').trim();
  if (!command) return res.writeHead(400, cors).end('No command.');
  const s = await sessionFrom(body, res, cors);
  if (!s) return;
  if (running.size >= MAX) return res.writeHead(429, cors).end(`${MAX} commands are already running. Stop one, or start the board with TERMINAL_MAX set higher.`);
  let cwd;
  try {
    cwd = await folderOf(String(body.cwd ?? ''));
  } catch (err) {
    return res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
  }
  if (s.run) return res.writeHead(409, cors).end('A command is already running in this terminal.');
  const cols = size(body.cols, 100, 500);
  const rows = size(body.rows, 30, 200);

  // Each command runs in a fresh shell. It writes its terminal's name (for resizing) and, at the end, the folder
  // it ended in to a folder of its own, so the page keeps that folder: `cd` works.
  // The session is taken before the first await below, so a second Run cannot start another command in it.
  /** @type {Job} */
  const job = { child: null, dir: '', session: s, stopped: false, killer: 0 };
  s.run = job;
  const dir = WINDOWS ? '' : await mkdtemp(join(tmpdir(), 'board-run-'));
  const script = WINDOWS
    ? command
    : `stty cols ${cols} rows ${rows} 2>/dev/null; tty > "$BOARD_RUN_DIR/tty" 2>/dev/null\n${command}\n__board_status=$?; pwd > "$BOARD_RUN_DIR/cwd" 2>/dev/null; exit $__board_status`;
  const [file, args] = WINDOWS ? [SHELL, ['/d', '/s', '/c', script]] : ptyArgs(script);
  const started = performance.now();
  const env = { ...commandEnv(dir, body.theme), BOARD_SCRIPT: script, BOARD_SESSION: s.id, BOARD_SESSION_TOKEN: tokenOf(s.id) };
  const child = spawn(file, args, { cwd, detached: !WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
  Object.assign(job, { child, dir });
  running.set(child.pid, /** @type {Job & { child: Child }} */ (job)); // its child is set just above
  log.info(`started pid ${child.pid} in ${cwd} (${running.size} running)`);
  // pid is undefined only when the spawn failed, and an error event follows.
  record(s, { t: 'start', pid: /** @type {number} */ (child.pid), cwd, command, at: Date.now(), cols, rows });
  child.stdout.setEncoding('utf8').on('data', (d) => record(s, { t: 'out', d }));
  child.stderr.setEncoding('utf8').on('data', (d) => record(s, { t: 'err', d }));
  child.stdin.on('error', () => {});

  child.on('error', (err) => record(s, { t: 'err', d: `${err.message}\n` }));
  // `cat` waits for more input; once the command is done it is told there is none.
  child.on('exit', () => child.stdin.end());
  child.on('close', async (code, signal) => {
    clearTimeout(job.killer);
    running.delete(child.pid);
    const ms = performance.now() - started;
    log.info(`pid ${child.pid} ended ${signal ?? `with ${code}`} after ${Math.round(ms)}ms`);
    if (dir) {
      const endCwd = (await readFile(join(dir, 'cwd'), 'utf8').catch(() => '')).trim();
      if (endCwd) record(s, { t: 'cwd', d: endCwd });
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    if (s.run === job) s.run = null;
    record(s, { t: 'exit', code, signal, ms, stopped: job.stopped });
  });
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ pid: child.pid, cwd }));
}

// Stops a command and anything it started.
/** @param {Job | null} job */
function stopJob(job) {
  if (!job?.child || job.stopped) return;
  job.stopped = true;
  stop(job.child, 'SIGTERM');
  job.killer = setTimeout(() => stop(/** @type {Child} */ (job.child), 'SIGKILL'), KILL_AFTER_MS); // checked above
}

// Stop ends the session's command; clear empties its kept output; close does both and forgets the session.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors @param {string} action */
async function control(req, res, cors, action) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const s = await sessionFrom(body, res, cors);
  if (!s) return;
  if (action !== 'clear') stopJob(s.run);
  if (action === 'clear') {
    s.events = s.open ? [s.open] : [];
    s.size = s.events.reduce((n, e) => n + sizeOf(e), 0);
    s.rewrite = true;
    s.pending = '';
    s.timer ||= setTimeout(() => flush(s), FLUSH_MS);
  }
  if (action === 'close') {
    s.closed = true;
    clearTimeout(s.timer);
    sessions.delete(s.id);
    for (const listener of s.listeners) listener.write(lineOf({ t: 'closed', s: s.id }));
    s.listeners.clear();
    s.disk.then(() => rm(logFile(s.id), { force: true })).catch(() => {});
    dropToken(s.id);
    // Every browser drops it from its terminals on its next read of the list.
    await editList((list) => {
      list.sessions = list.sessions.filter((x) => x.id !== s.id);
    }).catch(() => {});
  }
  res.writeHead(204, cors).end();
}

// The open terminals: { active, sessions: [{ id, n, cwd, tasks?, prompt? }] }, or { sessions: null } before the
// page saved any. The runner owns this list: every browser adds, updates and closes terminals in it one change at a
// time and shows each terminal under the number the runner picked, so two browsers show the same terminals under
// the same numbers. Changes go one after another, each replacing the file whole.
/** @type {Promise<unknown>} */
let listWrite = Promise.resolve();
async function readList() {
  await listWrite;
  try {
    const list = JSON.parse(await readFile(LIST_FILE, 'utf8'));
    return { active: String(list.active ?? ''), sessions: Array.isArray(list.sessions) ? list.sessions : [] };
  } catch {
    return { active: '', sessions: null };
  }
}
/** @param {RequestBody} body */
function cleanList(body) {
  if (!Array.isArray(body.sessions)) return null;
  /** @type {Set<string>} */
  const seen = new Set();
  const sessions = [];
  for (const x of body.sessions.slice(0, 200)) {
    const id = String(x?.id ?? '');
    if (!SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const tasks = Array.isArray(x.tasks) ? x.tasks.filter((/** @type {unknown} */ t) => typeof t === 'string').slice(0, 200) : [];
    sessions.push({ id, n: Math.max(1, Math.round(Number(x.n)) || 1), cwd: String(x.cwd ?? ''), ...(tasks.length ? { tasks, prompt: String(x.prompt ?? '') } : {}) });
  }
  return { active: seen.has(String(body.active)) ? String(body.active) : '', sessions };
}
/** @param {{ active: string, sessions: DevSession[] }} list */
const writeList = async (list) => {
  const tmp = `${LIST_FILE}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify(list), { mode: 0o600 });
  await rename(tmp, LIST_FILE);
};

// Changes the list: read, changed by `change` (which returns its answer), written back, one change after another.
/** @template T @param {(list: { active: string, sessions: DevSession[] }) => T} change @returns {Promise<T>} */
function editList(change) {
  const done = listWrite.then(async () => {
    /** @type {{ active: string, sessions: DevSession[] }} */
    let list = { active: '', sessions: [] };
    try {
      const saved = JSON.parse(await readFile(LIST_FILE, 'utf8'));
      if (Array.isArray(saved.sessions)) list = { active: String(saved.active ?? ''), sessions: saved.sessions };
    } catch {}
    const answer = change(list);
    await writeList(list);
    return answer;
  });
  listWrite = done.catch((err) => log.error(`Could not save the terminal list: ${err.message}`));
  return done;
}

// Adds a terminal to the list, numbered one past the highest listed, and answers its entry. A terminal already
// listed keeps its number, so an add sent twice (two browsers, or a retry) is harmless.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function addToList(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const id = String(body.session ?? '');
  if (!SESSION_ID.test(id)) return res.writeHead(400, cors).end('No terminal session.');
  const tasks = Array.isArray(body.tasks) ? body.tasks.filter((/** @type {unknown} */ t) => typeof t === 'string').slice(0, 200) : [];
  try {
    const entry = await editList((list) => {
      const known = list.sessions.find((x) => x.id === id);
      if (known) return known;
      const n = Math.max(0, ...list.sessions.map((x) => Number(x.n) || 0)) + 1;
      const added = { id, n, cwd: String(body.cwd ?? ''), ...(tasks.length ? { tasks, prompt: String(body.prompt ?? '') } : {}) };
      list.sessions = [...list.sessions, added].slice(-200);
      return added;
    });
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(entry));
  } catch (err) {
    res.writeHead(500, cors).end(`Could not save the terminal list: ${/** @type {Error} */ (err).message}`);
  }
}

// --- Each terminal's token, for the board's tasks (tools/board.js) ---
// A command gets BOARD_SESSION_TOKEN, a secret only its terminal knows. The runners (tools/worker/tasks.js) ask
// POST /scope which terminal a token belongs to and which tasks it was started for, so a session reaches only its
// own tasks whatever it claims. One token per terminal, kept until it closes and across restarts.
const TOKENS_FILE = join(STATE, 'tokens.json');
/** @type {Record<string, string> | null} */
let tokens = null;
/** @returns {Record<string, string>} */
function readTokens() {
  if (tokens) return tokens;
  try {
    const saved = JSON.parse(readFileSync(TOKENS_FILE, 'utf8'));
    tokens = saved && typeof saved === 'object' ? saved : {};
  } catch {
    tokens = {};
  }
  return /** @type {Record<string, string>} */ (tokens);
}
function writeTokens() {
  try {
    writeFileSync(TOKENS_FILE, JSON.stringify(readTokens()), { mode: 0o600 });
  } catch (err) {
    log.error(`Could not save the terminals' tokens: ${/** @type {Error} */ (err).message}`);
  }
}
/** @param {string} id */
function tokenOf(id) {
  const all = readTokens();
  if (!all[id]) {
    all[id] = randomBytes(24).toString('hex');
    writeTokens();
  }
  return all[id];
}
/** @param {string} id */
function dropToken(id) {
  const all = readTokens();
  if (!all[id]) return;
  delete all[id];
  writeTokens();
}

// The terminal a token belongs to and the tasks it was started for (its entry in the list of open terminals);
// 404 for a token no open terminal holds.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function scopeOf(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const token = String(body.token ?? '');
  const all = readTokens();
  const id = token ? Object.keys(all).find((k) => all[k] === token) : '';
  if (!id) return res.writeHead(404, cors).end('This terminal is not open on the board.');
  const entry = (await readList()).sessions?.find((/** @type {DevSession} */ x) => x.id === id);
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ session: id, tasks: entry?.tasks ?? [] }));
}

// The other open terminals started for any of `tasks` (the runners send the asking session's reach), with where
// each works: its folder or claude's worktree, the branch, the last commit and the uncommitted files there, so a
// parallel session can see what is already done elsewhere. Read-only; the token must belong to an open terminal.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function scopePeers(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const token = String(body.token ?? '');
  const all = readTokens();
  const self = token ? Object.keys(all).find((k) => all[k] === token) : '';
  if (!self) return res.writeHead(404, cors).end('This terminal is not open on the board.');
  const wanted = new Set(Array.isArray(body.tasks) ? body.tasks.map(String).slice(0, 2000) : []);
  const listed = (await readList()).sessions ?? [];
  const peers = await Promise.all(listed
    .filter((/** @type {DevSession} */ x) => x.id !== self && (x.tasks ?? []).some((t) => wanted.has(t)))
    .map(async (/** @type {DevSession} */ x) => {
      const s = sessions.has(x.id) || (await stat(logFile(x.id)).catch(() => null)) ? await sessionOf(x.id) : null;
      const start = s?.open ?? s?.events.findLast((e) => e.t === 'start');
      const command = start?.t === 'start' ? String(start.command ?? '') : '';
      const name = worktreeOf(command);
      const base = start?.t === 'start' && start.cwd ? start.cwd : x.cwd;
      const tree = name && base ? join(base, '.claude', 'worktrees', name) : '';
      const dir = tree && (await stat(tree).catch(() => null)) ? tree : x.cwd || base;
      const where = dir ? await Promise.all([
        git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).then((out) => out.trim(), () => ''),
        git(dir, ['log', '-1', '--format=%h %s']).then((out) => out.trim(), () => ''),
        git(dir, ['status', '--porcelain', ...NOT_WORKTREES]).then((out) => out.split('\n').filter(Boolean).length, () => null),
      ]) : ['', '', null];
      return {
        session: x.id,
        n: x.n,
        tasks: (x.tasks ?? []).filter((t) => wanted.has(t)),
        cwd: x.cwd,
        worktree: tree && dir === tree ? tree : '',
        dir,
        branch: where[0] === 'HEAD' ? '' : where[0],
        commit: where[1],
        changes: where[2],
        claude: startsClaude(command),
        state: !s || s.closed ? 'closed' : s.run ? 'running' : 'ended',
        started: start?.t === 'start' ? start.at : 0,
      };
    }));
  res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ session: self, peers }));
}

// A listed terminal's folder changed (cd in it, or a command started in another folder).
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function updateList(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const id = String(body.session ?? '');
  if (!SESSION_ID.test(id)) return res.writeHead(400, cors).end('No terminal session.');
  await editList((list) => {
    const known = list.sessions.find((x) => x.id === id);
    if (known && typeof body.cwd === 'string') known.cwd = body.cwd;
  }).catch(() => {});
  res.writeHead(204, cors).end();
}

// The whole list, sent once by a page that kept it in its own storage before the runner kept it.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function saveList(req, res, cors) {
  const body = await jsonBody(req, res, cors, LIST_MAX);
  if (!body) return;
  const list = cleanList(body);
  if (!list) return res.writeHead(400, cors).end('Send the terminals as { active, sessions }.');
  listWrite = listWrite
    .then(() => writeList(list))
    .catch((err) => log.error(`Could not save the terminal list: ${err.message}`));
  await listWrite;
  res.writeHead(204, cors).end();
}

/** @param {number} pid */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return /** @type {NodeJS.ErrnoException} */ (err).code === 'EPERM';
  }
};

// `git worktree list --porcelain` as objects ({ worktree, HEAD, branch?, locked?, prunable? }); the main checkout first.
/** @param {string} list @returns {Record<string, string>[]} */
const worktreeEntries = (list) => list.trim().split(/\n\n+/).filter(Boolean)
  .map((block) => Object.fromEntries(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])));

/** @param {Record<string, string>} entry */
const lockPid = (entry) => Number(/\bpid (\d+)/.exec(entry.locked ?? '')?.[1]) || 0;
/** @param {string} path @param {string} dir */
const inside = (path, dir) => path === dir || path.startsWith(dir.endsWith('/') ? dir : `${dir}/`);

// Each process's parent, to tell which terminal a claude runs under. Empty where ps is missing (Windows).
/** @returns {Promise<Map<number, number>>} */
function parents() {
  if (WINDOWS) return Promise.resolve(new Map());
  return new Promise((done) => {
    execFile('ps', ['-A', '-o', 'pid=,ppid='], { timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return done(new Map());
      done(new Map(/** @type {[number, number][]} */ (String(out).split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter(([pid]) => pid))));
    });
  });
}

// The session whose running command has `pid` among its descendants.
/** @param {number} pid @param {Map<number, number>} parent */
function sessionOfPid(pid, parent) {
  // A pid with no parent known reads as undefined, which ends the walk.
  for (let p = pid, hops = 0; p > 1 && hops < 64; p = /** @type {number} */ (parent.get(p)), hops++) {
    const job = running.get(p);
    if (job) return job.session;
  }
  return null;
}

// The runner's sessions running in a worktree: the one the claude that locked it runs under, one started inside it,
// and one whose `claude --worktree <name>` names it from the main checkout. A page whose list lost the session (or
// never had it, when claude was typed into a terminal) still finds it this way.
/** @param {Record<string, string>} e @param {string} root @param {Map<number, number>} parent */
function sessionsIn(e, root, parent) {
  /** @type {Set<Session | null>} */
  const found = new Set();
  const pid = lockPid(e);
  if (pid && alive(pid)) found.add(sessionOfPid(pid, parent));
  for (const s of sessions.values()) {
    if (!s.run) continue;
    const cwd = s.events.findLast((x) => x.t === 'start')?.cwd ?? '';
    if (cwd && inside(cwd, e.worktree)) found.add(s);
    else if (cwd === root && worktreeOf(s.open?.command) === basename(e.worktree)) found.add(s);
  }
  found.delete(null);
  return /** @type {Session[]} */ ([...found]).map((s) => ({ id: s.id, cwd: s.events.findLast((x) => x.t === 'start')?.cwd ?? '' }));
}

// Every worktree of the repository holding `path`, but the main checkout, for Dev's Worktrees panel: { repo: false }
// outside one, else { root, worktrees: [{ path, name, branch, head, claude, locked, prunable, pid, running, commands,
// sessions, changes }] }. `running`: the claude that locked it still runs; `commands`: the runner's running commands
// started inside it; `sessions`: the runner's running sessions in it ({ id, cwd }); `changes`: files git would
// refuse to remove it over (null when it could not tell).
/** @param {string} path */
async function listWorktrees(path) {
  const dir = await folderOf(path);
  let entries;
  try {
    entries = worktreeEntries(await git(dir, ['worktree', 'list', '--porcelain']));
  } catch {
    return { repo: false };
  }
  const [main, ...rest] = entries;
  const started = [...sessions.values()].filter((s) => s.run).map((s) => s.events.findLast((e) => e.t === 'start')?.cwd ?? '');
  const parent = rest.some((e) => lockPid(e)) ? await parents() : new Map();
  const worktrees = await Promise.all(rest.filter((e) => e.worktree).map(async (e) => {
    const pid = lockPid(e);
    const changes = 'prunable' in e ? 0 : await git(e.worktree, ['status', '--porcelain']).then((out) => out.split('\n').filter(Boolean).length, () => null);
    return {
      path: e.worktree,
      name: basename(e.worktree),
      branch: e.branch?.replace(/^refs\/heads\//, '') ?? '',
      head: e.HEAD ?? '',
      claude: dirname(e.worktree).endsWith(join('.claude', 'worktrees')),
      locked: 'locked' in e,
      prunable: 'prunable' in e,
      pid,
      running: !!pid && alive(pid),
      commands: started.filter((cwd) => cwd && inside(cwd, e.worktree)).length,
      sessions: sessionsIn(e, main.worktree, parent),
      changes,
    };
  }));
  return { root: main.worktree, worktrees };
}

// Removes the worktree `claude --worktree <name>` made in the repo at `cwd` (.claude/worktrees/<name>) once its task
// is completed, or, given `path`, any worktree but the main checkout (Dev's Worktrees panel). The task's session is
// stopped first, since claude runs inside the worktree. git refuses a worktree with changes or untracked files, so
// nothing unsaved is lost, unless `force` is set (the panel's Force remove), which discards them; its branch is kept.
// Answers { removed: path }, or { missing: true } when the folder or the worktree is already gone.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function removeWorktree(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const name = String(body.name ?? '');
  const path = typeof body.path === 'string' && body.path ? resolve(expand(body.path)) : '';
  if (!path && !WORKTREE_NAME.test(name)) return res.writeHead(400, cors).end('No worktree name.');
  const reply = (/** @type {object} */ data) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(data));
  const id = String(body.session ?? '');
  const force = body.force === true;
  // Without a folder, the repo is the one the session's first command started in.
  let cwd = String(body.cwd ?? '');
  if (SESSION_ID.test(id) && (sessions.has(id) || (await stat(logFile(id)).catch(() => null)))) {
    const s = await sessionOf(id);
    stopJob(s.run);
    for (let waited = 0; s.run && waited < KILL_AFTER_MS + 2000; waited += 100) await new Promise((r) => setTimeout(r, 100));
    cwd ||= s.events.find((e) => e.t === 'start')?.cwd ?? '';
  }
  if (!cwd) return reply({ missing: true });
  let dir;
  try {
    dir = await folderOf(cwd);
  } catch {
    return reply({ missing: true });
  }
  let list;
  try {
    list = await git(dir, ['worktree', 'list', '--porcelain']);
  } catch (err) {
    return res.writeHead(400, cors).end(`Not a git repository: ${/** @type {Error} */ (err).message}`);
  }
  // The first entry is the main checkout, never removed. git runs there, as `dir` may be the folder removed.
  const [main, ...entries] = worktreeEntries(list);
  const tree = path
    ? entries.find((e) => e.worktree === path)
    : entries.find((e) => e.worktree && basename(e.worktree) === name && dirname(e.worktree).endsWith(join('.claude', 'worktrees')));
  if (!tree) return reply({ missing: true });
  const top = main?.worktree || dir;
  try {
    // claude locks its worktree while it runs; a lock whose claude has ended is left over.
    if ('locked' in tree) {
      const pid = lockPid(tree);
      if (pid && alive(pid)) return res.writeHead(409, cors).end(`claude still runs in ${tree.worktree} (pid ${pid}).`);
      await git(top, ['worktree', 'unlock', tree.worktree]);
    }
    // A worktree whose folder is gone only needs git to forget it.
    await git(top, 'prunable' in tree ? ['worktree', 'prune'] : ['worktree', 'remove', ...(force ? ['--force'] : []), tree.worktree]);
  } catch (err) {
    return res.writeHead(409, cors).end(/** @type {Error} */ (err).message);
  }
  log.info(`removed worktree ${tree.worktree}${force ? ' (forced)' : ''}`);
  reply({ removed: tree.worktree });
}

// Ends a claude that is done in its worktree (`claude --worktree <name>`): types /exit, then answers claude's
// "Exiting worktree session" question. claude counts every commit as lost on removal, even a pushed one, so git is
// asked here instead: Remove only when the worktree has no uncommitted file and every commit is on a remote, else
// Keep, which ends claude and leaves the worktree and its branch. claude removes a clean worktree without asking.
// Answers { ended, removed, path, kept?: why }.
const ESCAPES = /\x1b\[[0-9;?<>=]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
const DIALOG_MS = 20000;
const EXIT_MS = 60000;
/** @param {number} ms */
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

/** @param {string} path */
async function worktreeAtStake(path) {
  const changed = (await git(path, ['status', '--porcelain', ...NOT_WORKTREES])).trim();
  if (changed) return `${changed.split('\n').length} uncommitted ${changed.includes('\n') ? 'files' : 'file'}`;
  const unpushed = Number((await git(path, ['rev-list', '--count', 'HEAD', '--not', '--remotes'])).trim()) || 0;
  return unpushed ? `${unpushed} ${unpushed === 1 ? 'commit' : 'commits'} on no remote` : '';
}

/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function exitClaude(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const s = await sessionFrom(body, res, cors);
  if (!s) return;
  const job = s.run;
  const name = worktreeOf(s.open?.command);
  if (!job || s.closed) return res.writeHead(409, cors).end('Nothing runs in this terminal.');
  if (!name || !s.open?.cwd) return res.writeHead(400, cors).end('This terminal does not run claude in a worktree.');
  const path = join(s.open.cwd, '.claude', 'worktrees', name);
  let atStake;
  try {
    atStake = await worktreeAtStake(path);
  } catch (err) {
    atStake = `git could not read it (${/** @type {Error} */ (err).message})`;
  }
  // Watches the output for the question, ignoring the escapes and spaces claude draws it with.
  let seen = '';
  /** @type {(value: boolean) => void} */
  let asked;
  /** @type {Promise<boolean>} */
  const question = new Promise((r) => {
    asked = r;
  });
  const tap = (/** @type {SessionEvent} */ e) => {
    if (e.t === 'exit') return asked(false);
    if (e.t !== 'out' && e.t !== 'err') return;
    seen = (seen + e.d.replace(ESCAPES, '').replace(/\s+/g, '')).slice(-4000);
    if (seen.includes('Exitingworktreesession')) asked(true);
  };
  (s.taps ??= new Set()).add(tap);
  // job.child is null only for the moment before its command starts; this answers a running claude.
  /** @type {Promise<boolean>} */
  const ended = new Promise((r) => (s.run !== job ? r(true) : /** @type {Child} */ (job.child).once('close', () => r(true))));
  const write = (/** @type {string} */ data) => s.run === job && /** @type {Child} */ (job.child).stdin.write(data);
  try {
    // Typed, then sent: Enter on the command menu runs the command it shows, /exit.
    write('/exit');
    await pause(400);
    write('\r');
    const dialog = await Promise.race([question, ended.then(() => false), pause(DIALOG_MS).then(() => false)]);
    if (dialog) {
      await pause(300);
      // Keep is first and chosen; Remove is the one below it.
      if (!atStake) {
        write('\x1b[B');
        await pause(200);
      }
      write('\r');
    }
    const done = await Promise.race([ended, pause(EXIT_MS).then(() => false)]);
    const removed = !(await stat(path).catch(() => null));
    if (removed) log.info(`claude removed worktree ${path}`);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ended: done, removed, path, ...(atStake && !removed ? { kept: atStake } : {}) }));
  } finally {
    /** @type {Set<(event: SessionEvent) => void>} */ (s.taps).delete(tap);
  }
}

// Keys typed in the page, sent to a running command's terminal.
/** @param {IncomingMessage} req @param {ServerResponse} res @param {Cors} cors */
async function input(req, res, cors) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return res.writeHead(400, cors).end('Send JSON.');
  }
  const run = running.get(Number(body.pid));
  if (!run) return res.writeHead(404, cors).end('That command is not running.');
  if (typeof body.data === 'string') run.child.stdin.write(body.data);
  // A new size reaches the command as SIGWINCH, which the terminal sends when stty changes it.
  if (body.cols && body.rows && run.dir) {
    const tty = (await readFile(join(run.dir, 'tty'), 'utf8').catch(() => '')).trim();
    if (tty.startsWith('/dev/')) {
      const cols = size(body.cols, 100, 500);
      const rows = size(body.rows, 30, 200);
      spawn('stty', [process.platform === 'darwin' ? '-f' : '-F', tty, 'cols', String(cols), 'rows', String(rows)], { stdio: 'ignore' }).on('error', () => {});
      // Kept with the output: a page that attaches later replays what follows at this size.
      record(run.session, { t: 'size', cols, rows });
    }
  }
  res.writeHead(204, cors).end();
}

// Source control for Dev: git runs as a program (no shell), in the workspace's repository. Network commands may not
// ask for a password (there is nobody to type it): they fail and say so instead.
const GIT_MAX = 4 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{4,40}$/i;
const LOG_SHOWN = 30;
const FILES_SHOWN = 2000;

/** @param {string} cwd @param {string[]} args @param {{ timeout?: number, ok?: number[] }} [options] @returns {Promise<string>} */
function git(cwd, args, { timeout = 15000, ok = [0] } = {}) {
  return new Promise((done, fail) => {
    execFile('git', ['-c', 'core.quotePath=false', '-c', 'color.ui=false', ...args], {
      cwd,
      timeout,
      maxBuffer: GIT_MAX,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat', GCM_INTERACTIVE: 'never' },
    }, (err, stdout, stderr) => {
      const code = err ? (typeof err.code === 'number' ? err.code : -1) : 0;
      if (ok.includes(code)) return done(stdout);
      if (err?.code === 'ENOENT') return fail(new Error('git is not installed on this machine.'));
      if (err?.killed) return fail(new Error(`git ${args[0]} took too long and was stopped.`));
      if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return fail(new Error('The answer is too large to show.'));
      fail(new Error((stderr || stdout || /** @type {Error} */ (err).message).trim())); // ok always holds 0, so err is set here
    });
  });
}

// The repository holding a folder, or null.
/** @param {string} path */
async function repoOf(path) {
  const dir = await folderOf(path);
  const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '');
  return top.trim() || null;
}

// A SKILL.md's frontmatter: its name, its description (plain, quoted, or folded over indented lines), and
// whether it can be typed as a slash command.
/** @param {string} text @param {string} fallback */
function skillMeta(text, fallback) {
  const head = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? '';
  const lines = head.split(/\r?\n/);
  /** @type {Record<string, string>} */
  const fields = {};
  for (let i = 0; i < lines.length; i++) {
    const m = /^([\w-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    if (/^[>|][+-]?$/.test(value)) {
      const more = [];
      while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || !lines[i + 1].trim())) more.push(lines[++i].trim());
      value = more.join(' ').trim();
    }
    fields[m[1]] = value.replace(/^(['"])(.*)\1$/, '$2');
  }
  return { name: fields.name || fallback, description: fields.description ?? '', invocable: fields['user-invocable'] !== 'false' };
}

// The skills in one `skills` folder: each sub-folder (or link to one) holding a SKILL.md.
/** @param {string} dir */
async function skillsIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const skills = await Promise.all(entries.filter((e) => e.isDirectory() || e.isSymbolicLink()).map(async (e) => {
    const file = join(dir, e.name, 'SKILL.md');
    const text = await readFile(file, 'utf8').catch(() => null);
    if (text === null) return null;
    const meta = skillMeta(text.slice(0, 8000), e.name);
    return meta.invocable ? { name: meta.name, description: meta.description, path: file } : null;
  }));
  return skills.filter((s) => !!s).sort((a, b) => a.name.localeCompare(b.name));
}

// Claude Code's skills for Dev's Skills panel: the user's own (~/.claude/skills) and the project's, from the
// folder's .claude/skills and its repository's. { global, project, root }.
/** @param {string} path */
async function listSkills(path) {
  const dir = await folderOf(path);
  const root = (await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '')).trim() || dir;
  const own = join(homedir(), '.claude', 'skills');
  // In the home folder, the project's folder is the user's own: listed once, as theirs.
  const folders = [...new Set([dir, root])].map((d) => join(d, '.claude', 'skills')).filter((f) => f !== own);
  const project = (await Promise.all(folders.map(skillsIn))).flat().filter((s, i, all) => all.findIndex((x) => x.name === s.name) === i);
  return { global: await skillsIn(own), project, root };
}

// `git status --porcelain=v2 -z`: the branch lines, then one record per file. A rename carries its old path in
// the record after it.
/** @param {string} text */
function parseStatus(text) {
  const out = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0, files: /** @type {GitFile[]} */ ([]) };
  const records = text.split('\0');
  for (let i = 0; i < records.length; i++) {
    const r = records[i];
    if (!r) continue;
    if (r.startsWith('# ')) {
      const [key, ...rest] = r.slice(2).split(' ');
      if (key === 'branch.head') out.branch = rest.join(' ') === '(detached)' ? '' : rest.join(' ');
      else if (key === 'branch.oid') out.oid = rest[0] === '(initial)' ? '' : rest[0];
      else if (key === 'branch.upstream') out.upstream = rest.join(' ');
      else if (key === 'branch.ab') {
        out.ahead = Math.abs(Number(rest[0]) || 0);
        out.behind = Math.abs(Number(rest[1]) || 0);
      }
      continue;
    }
    const kind = r[0];
    const split = (/** @type {number} */ n) => {
      const parts = r.split(' ');
      return { xy: parts[1], path: parts.slice(n).join(' ') };
    };
    /** @type {{ xy: string, path: string, orig?: string, conflict?: boolean, untracked?: boolean }} */
    let file;
    if (kind === '1') file = split(8);
    else if (kind === '2') file = { ...split(9), orig: records[++i] };
    else if (kind === 'u') file = { ...split(10), conflict: true };
    else if (kind === '?') file = { xy: '?? ', path: r.slice(2), untracked: true };
    else continue;
    const [index, work] = file.untracked ? ['?', '?'] : [file.xy[0], file.xy[1]];
    out.files.push({ path: file.path, ...(file.orig ? { orig: file.orig } : {}), index, work, ...(file.conflict ? { conflict: true } : {}), ...(file.untracked ? { untracked: true } : {}) });
  }
  return out;
}

// The worktrees `claude --worktree` makes live inside the repo (.claude/worktrees); they are other checkouts, not
// changes, so Source control neither lists them nor stages them with everything else.
const NOT_WORKTREES = ['--', '.', ':(exclude).claude/worktrees'];

/** @param {string} path */
async function gitStatus(path) {
  const root = await repoOf(path);
  if (!root) return { repo: false, path: await folderOf(path) };
  const [status, log, branches, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...NOT_WORKTREES]),
    git(root, ['log', `-n${LOG_SHOWN}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1f%D%x1e'], { ok: [0, 128] }).catch(() => ''),
    git(root, ['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads']).catch(() => ''),
    git(root, ['remote']).catch(() => ''),
  ]);
  const parsed = parseStatus(status);
  return {
    repo: true,
    root,
    ...parsed,
    files: parsed.files.slice(0, FILES_SHOWN),
    more: Math.max(0, parsed.files.length - FILES_SHOWN),
    branches: branches.split('\n').filter(Boolean),
    remotes: remotes.split('\n').filter(Boolean),
    log: log.split('\x1e').map((l) => l.replace(/^\n/, '')).filter(Boolean).map((l) => {
      const [hash, short, author, at, subject, refs] = l.split('\x1f');
      return { hash, short, author, at: Number(at) * 1000, subject, refs: refs ? refs.split(', ').filter(Boolean) : [] };
    }),
  };
}

// Dev's Search: the lines holding `q` in the files under `path`, through git grep. In a repository it reads
// tracked and untracked files and skips ignored ones; elsewhere it reads the folder as it is, still skipping what a
// .gitignore names. Binary files and claude's worktrees are left out. `include` and `exclude` are comma-separated
// globs, as in an editor: a name with no slash matches at any depth. Answers { matches: [{ path, line, col, text }],
// more }, stopping at SEARCH_MAX matches.
const SEARCH_MAX = 2000;
const SEARCH_TEXT_MAX = 400;
const SEARCH_MS = 15000;
/** @param {string | null} list */
const globsOf = (list) => String(list ?? '').split(',').map((g) => g.trim().replace(/^\.\//, '').replace(/\/$/, '')).filter(Boolean)
  .flatMap((g) => {
    const glob = g.includes('/') ? g.replace(/^\//, '') : `**/${g}`;
    return [glob, `${glob}/**`];
  });

/** @param {URLSearchParams} params @returns {Promise<RunnerSearch>} */
async function searchFiles(params) {
  const q = params.get('q') ?? '';
  if (!q) return { matches: [], more: false };
  if (q.length > 1000) throw new Error('The search is too long.');
  const dir = await folderOf(params.get('path') ?? '');
  const inRepo = !!(await repoOf(dir));
  const args = ['-c', 'core.quotePath=false', 'grep', '-n', '--column', '-I', '-z', '--no-color', ...(inRepo ? ['--untracked'] : ['--no-index', '--exclude-standard'])];
  if (params.get('case') !== '1') args.push('-i');
  if (params.get('word') === '1') args.push('-w');
  args.push(params.get('regex') === '1' ? '-E' : '-F', '-e', q, '--');
  const include = globsOf(params.get('include'));
  args.push(...(include.length ? include.map((g) => `:(glob)${g}`) : ['.']));
  args.push(':(exclude,glob)**/.claude/worktrees/**', ...globsOf(params.get('exclude')).map((g) => `:(exclude,glob)${g}`));
  return new Promise((done, fail) => {
    const child = spawn('git', args, { cwd: dir, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0', GIT_PAGER: 'cat' } });
    /** @type {SearchMatch[]} */
    const matches = [];
    let buffer = '';
    let stderr = '';
    let more = false;
    let stopped = false;
    const stop = () => {
      stopped = true;
      child.kill();
    };
    const timer = setTimeout(() => {
      more = true;
      stop();
    }, SEARCH_MS);
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      if (stopped) return;
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = /** @type {string} */ (lines.pop()); // split() gives at least one part
      for (const raw of lines) {
        // path\0line\0column\0text, the column counted in bytes from 1.
        const [path, line, col, ...rest] = raw.split('\0');
        let text = rest.join('\0');
        let at = Math.max(0, Buffer.from(text).subarray(0, Number(col) - 1).toString('utf8').length);
        // A very long line (minified code) is cut around the match.
        if (text.length > SEARCH_TEXT_MAX) {
          const from = Math.max(0, at - 60);
          text = (from ? '…' : '') + text.slice(from, from + SEARCH_TEXT_MAX);
          at = at - from + (from ? 1 : 0);
        }
        matches.push({ path: join(dir, path), line: Number(line), col: at, text });
        if (matches.length >= SEARCH_MAX) {
          more = true;
          return stop();
        }
      }
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += chunk));
    child.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      clearTimeout(timer);
      fail(new Error(err.code === 'ENOENT' ? 'git is not installed on this machine.' : err.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // git grep exits 1 when nothing matched.
      if (stopped || code === 0 || code === 1) return done({ path: dir, matches, more });
      fail(new Error(stderr.trim().replace(/^fatal: /, '') || `git grep stopped (${code}).`));
    });
  });
}

// The default branch as the remote names it, else a local main or master, and where HEAD left it ('' when
// neither is found or they share no history).
/** @param {string} root */
async function defaultBase(root) {
  let base = (await git(root, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], { ok: [0, 1, 128] }).catch(() => '')).trim();
  for (const name of ['main', 'master']) {
    if (base) break;
    if ((await git(root, ['rev-parse', '--verify', '--quiet', name], { ok: [0, 1, 128] }).catch(() => '')).trim()) base = name;
  }
  const mergeBase = base ? (await git(root, ['merge-base', 'HEAD', base], { ok: [0, 1, 128] }).catch(() => '')).trim() : '';
  return { base, mergeBase };
}

// What a terminal left behind, for a Cron step that runs after a Run in Dev step: the end of its output (escape
// sequences and all; the page reads links from it), the same output as the screen showed it, claude's last answer
// and the files it wrote (from its transcript), and, in the folder it worked in, the branch, the last commit, and the
// commits and files that differ from the default branch (uncommitted ones included).
const OUTCOME_OUTPUT = 20000;
const OUTCOME_SCREEN = 20000;
const OUTCOME_FILES = 300;
const OUTCOME_COMMITS = 30;
// The whole answer: a long JSON answer cut at its start can no longer be read.
const OUTCOME_REPLY = 2_000_000;

// The output as the terminal drew it, in plain text. A program that redraws in place, as claude does, leaves its
// last drawing rather than every frame run together.
/** @param {SessionEvent[]} events */
function screenText(events) {
  const term = createTerminal();
  for (const e of events) {
    if (e.cols && e.rows) term.resize(e.cols, e.rows);
    else if ((e.t === 'out' || e.t === 'err') && e.d) term.write(e.d);
  }
  const lines = [...term.history, ...term.screen].map((l) => l.cells.map((c) => c?.c ?? ' ').join('').trimEnd());
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim().slice(-OUTCOME_SCREEN);
}
/** @param {URLSearchParams} params */
async function sessionOutcome(params) {
  const id = params.get('session') ?? '';
  let output = '';
  let screen = '';
  /** @type {{ reply?: string, written?: string[] }} */
  let claude = {};
  if (SESSION_ID.test(id) && (sessions.has(id) || (await stat(logFile(id)).catch(() => null)))) {
    const s = await sessionOf(id);
    const t = await transcriptOf(s);
    if (t) claude = { reply: t.reply.slice(-OUTCOME_REPLY), written: t.written.slice(-OUTCOME_FILES) };
    /** @type {string[]} */
    const chunks = [];
    let size = 0;
    for (let i = s.events.length - 1; i >= 0 && size < OUTCOME_OUTPUT; i--) {
      const e = s.events[i];
      if (e.t !== 'out' && e.t !== 'err') continue;
      chunks.push(e.d);
      size += e.d.length;
    }
    output = chunks.reverse().join('').slice(-OUTCOME_OUTPUT);
    screen = screenText(s.events);
  }
  const root = await repoOf(params.get('path') ?? '').catch(() => null);
  if (!root) return { output, screen, ...claude, repo: false };
  const status = parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...NOT_WORKTREES]));
  const head = (await git(root, ['log', '-1', '--format=%H%x1f%h%x1f%s'], { ok: [0, 128] }).catch(() => '')).trim().split('\x1f');
  const { base, mergeBase } = await defaultBase(root);
  /** @type {{ status: string, path: string, from?: string }[]} */
  let files = [];
  /** @type {{ hash: string, short: string, subject: string }[]} */
  let commits = [];
  if (mergeBase) {
    const names = await git(root, ['diff', '--name-status', '-z', '-M', mergeBase, ...NOT_WORKTREES]).catch(() => '');
    const parts = names.split('\0');
    for (let i = 0; i < parts.length - 1;) {
      const code = parts[i++];
      if (!code) continue;
      const renamed = /^[RC]/.test(code);
      const from = renamed ? parts[i++] : '';
      files.push({ status: code[0], path: parts[i++], ...(renamed ? { from } : {}) });
    }
    const log = await git(root, ['log', `-n${OUTCOME_COMMITS}`, '--format=%H%x1f%h%x1f%s%x1e', `${mergeBase}..HEAD`]).catch(() => '');
    commits = log.split('\x1e').map((l) => l.trim()).filter(Boolean).map((l) => {
      const [hash, short, subject] = l.split('\x1f');
      return { hash, short, subject };
    });
  }
  // Untracked files are not in the diff; they are changes too.
  for (const f of status.files) if (f.untracked && !files.some((x) => x.path === f.path)) files.push({ status: '?', path: f.path });
  const more = Math.max(0, files.length - OUTCOME_FILES);
  files = files.slice(0, OUTCOME_FILES);
  return {
    output,
    screen,
    ...claude,
    repo: true,
    root,
    branch: status.branch,
    upstream: status.upstream,
    ahead: status.ahead,
    behind: status.behind,
    base: base.replace(/^origin\//, ''),
    commit: head[0] ?? '',
    short: head[1] ?? '',
    subject: head[2] ?? '',
    commits,
    files,
    more,
    uncommitted: status.files.length,
  };
}

// A file's changes (staged, or in the working folder), or a commit's.
/** @param {URLSearchParams} params */
async function gitDiff(params) {
  const root = await repoOf(params.get('path') ?? '');
  if (!root) throw new Error('Not a git repository.');
  const commit = params.get('commit') ?? '';
  if (commit) {
    if (!COMMIT.test(commit)) throw new Error('Not a commit.');
    const [meta, diff] = await Promise.all([
      git(root, ['show', '-s', '--format=%H%x1f%an%x1f%ae%x1f%at%x1f%B', commit]),
      // A merge shows what it brought into its first parent, as editors show it, not git's empty combined diff.
      git(root, ['show', '--format=', '--patch', '-M', '--no-ext-diff', '--diff-merges=first-parent', commit]),
    ]);
    const [hash, author, email, at, body] = meta.split('\x1f');
    return { commit: { hash, author, email, at: Number(at) * 1000, message: body.trim() }, diff };
  }
  const file = params.get('file') ?? '';
  if (!file) throw new Error('No file.');
  const orig = params.get('orig') ?? '';
  const paths = ['--', ...(orig ? [orig] : []), file];
  if (params.get('untracked')) return { diff: await git(root, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file], { ok: [0, 1] }) };
  const staged = params.get('staged') ? ['--cached'] : [];
  return { diff: await git(root, ['diff', ...staged, '-M', '--no-ext-diff', ...paths]) };
}

// Dev's pull request view: what the branch changes against the default branch, as a GitHub pull request shows
// it, from where they part. Uncommitted and new files are included unless `committed` is set, so the view shows
// what the pull request will hold once they are committed.
const PR_UNTRACKED = 200;
/** @param {URLSearchParams} params */
async function gitPullRequest(params) {
  const root = await repoOf(params.get('path') ?? '');
  if (!root) throw new Error('Not a git repository.');
  const committed = !!params.get('committed');
  const status = parseStatus(await git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', ...NOT_WORKTREES]));
  const { base, mergeBase } = await defaultBase(root);
  if (!mergeBase) throw new Error(base ? `${status.branch || 'HEAD'} shares no history with ${base}.` : 'No default branch found (origin/HEAD, main or master).');
  const [log, diff] = await Promise.all([
    git(root, ['log', `-n${LOG_SHOWN}`, '--format=%H%x1f%h%x1f%an%x1f%at%x1f%s%x1e', `${mergeBase}..HEAD`]).catch(() => ''),
    git(root, ['diff', '-M', '--no-ext-diff', mergeBase, ...(committed ? ['HEAD'] : []), ...NOT_WORKTREES], { timeout: 30000 }),
  ]);
  const commits = log.split('\x1e').map((l) => l.trim()).filter(Boolean).map((l) => {
    const [hash, short, author, at, subject] = l.split('\x1f');
    return { hash, short, author, at: Number(at) * 1000, subject };
  });
  const count = Number((await git(root, ['rev-list', '--count', `${mergeBase}..HEAD`]).catch(() => '0')).trim()) || 0;
  // New files are not in git's diff; each is diffed against nothing, as git shows an added file.
  const untracked = committed ? [] : status.files.filter((f) => f.untracked && !f.path.endsWith('/')).map((f) => f.path);
  const added = [];
  for (const file of untracked.slice(0, PR_UNTRACKED)) {
    added.push(await git(root, ['diff', '--no-index', '--no-ext-diff', '--', '/dev/null', file], { ok: [0, 1] }).catch(() => ''));
  }
  return {
    root,
    branch: status.branch,
    base: base.replace(/^origin\//, ''),
    mergeBase,
    committed,
    uncommitted: status.files.length,
    commits,
    count,
    diff: diff + added.join(''),
    more: Math.max(0, untracked.length - PR_UNTRACKED),
  };
}

/** @param {unknown} files */
const validFiles = (files) => Array.isArray(files) && files.length && files.every((f) => typeof f === 'string' && f && !f.includes('\0'));

// Changes to the repository: the page names the action and what it applies to.
/** @param {RequestBody} body */
async function gitAction(body) {
  const path = String(body.path ?? '');
  const action = String(body.action ?? '');
  if (action === 'init') {
    const dir = await folderOf(path);
    await git(dir, ['init']);
    return { ok: true };
  }
  const root = await repoOf(path);
  if (!root) throw new Error('Not a git repository.');
  // Checked with validFiles() before each use.
  const files = /** @type {string[]} */ (body.files);
  const net = { timeout: 120000 };
  switch (action) {
    case 'stage':
      if (!validFiles(files)) throw new Error('No files.');
      await git(root, ['add', '-A', '--', ...files]);
      break;
    case 'stage-all':
      await git(root, ['add', '-A', ...NOT_WORKTREES]);
      break;
    case 'unstage': {
      if (!validFiles(files)) throw new Error('No files.');
      // Before the first commit there is no HEAD to restore from.
      const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1] });
      await git(root, head.trim() ? ['restore', '--staged', '--', ...files] : ['rm', '--cached', '-r', '-q', '--', ...files]);
      break;
    }
    case 'unstage-all': {
      const head = await git(root, ['rev-parse', '--verify', '-q', 'HEAD'], { ok: [0, 1] });
      await git(root, head.trim() ? ['reset', '-q'] : ['rm', '--cached', '-r', '-q', '.']);
      break;
    }
    case 'discard': {
      // Tracked files go back to what is staged (or committed); new files are deleted.
      if (!validFiles(files)) throw new Error('No files.');
      const untracked = Array.isArray(body.untracked) ? body.untracked.filter((f) => files.includes(f)) : [];
      const tracked = files.filter((f) => !untracked.includes(f));
      if (tracked.length) await git(root, ['restore', '--', ...tracked]);
      if (untracked.length) await git(root, ['clean', '-f', '-q', '--', ...untracked]);
      break;
    }
    case 'commit': {
      const message = String(body.message ?? '').trim();
      if (!message) throw new Error('Write a commit message first.');
      if (body.all) await git(root, ['add', '-A', ...NOT_WORKTREES]);
      await git(root, ['commit', '-q', '-m', message], { timeout: 60000 });
      break;
    }
    case 'fetch':
      await git(root, ['fetch', '--all', '--prune'], net);
      break;
    case 'pull':
      await git(root, ['pull', '--ff-only'], net);
      break;
    case 'push': {
      // A branch with no upstream yet is pushed to the first remote and tracks it, as Publish Branch does.
      const upstream = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], { ok: [0, 128] });
      if (upstream.trim()) await git(root, ['push'], net);
      else {
        const remote = (await git(root, ['remote'])).split('\n').filter(Boolean);
        if (!remote.length) throw new Error('This repository has no remote to push to.');
        await git(root, ['push', '-u', remote.includes('origin') ? 'origin' : remote[0], 'HEAD'], net);
      }
      break;
    }
    case 'checkout':
    case 'branch': {
      const name = String(body.branch ?? '').trim();
      if (!name || name.startsWith('-')) throw new Error('Not a branch name.');
      await git(root, ['check-ref-format', '--branch', name]).catch(() => {
        throw new Error(`“${name}” is not a valid branch name.`);
      });
      await git(root, action === 'branch' ? ['switch', '-c', name] : ['switch', name]);
      break;
    }
    default:
      throw new Error('Not a git action.');
  }
  return { ok: true };
}

// Shows a file or folder in the system's file manager: selected in Finder or Explorer, or its folder opened elsewhere.
/** @param {unknown} target */
async function reveal(target) {
  const full = resolve(expand(String(target ?? '')));
  const info = await stat(full).catch(() => null);
  if (!target || !info) throw new Error(`Nothing at ${full}`);
  /** @type {[string, string[]]} */
  const [cmd, args] = process.platform === 'darwin' ? ['open', ['-R', full]]
    : process.platform === 'win32' ? ['explorer', [`/select,${full}`]]
      : ['xdg-open', [info.isDirectory() ? full : dirname(full)]];
  await new Promise((done, fail) => {
    // Explorer exits with 1 even when it opened the window.
    execFile(cmd, args, (err) => (err && process.platform !== 'win32' ? fail(err) : done(null)));
  });
  return { ok: true };
}

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  // Unlike the relays, a request with no Origin is refused too: only the board's pages may run commands.
  if (!LOCAL_ORIGIN.test(origin) || !LOCAL_HOST.test(req.headers.host ?? '')) {
    res.writeHead(403).end('Only pages served from this machine may run commands.');
    return;
  }
  const cors = { 'access-control-allow-origin': origin, vary: 'origin' };
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end();
    return;
  }
  // A server's request always has its url, hence the casts below.
  const path = new URL(/** @type {string} */ (req.url), 'http://terminal').pathname;
  if (req.method === 'GET' && path === '/info') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ root: ROOT, home: homedir(), shell: SHELL, max: MAX, running: running.size }));
    return;
  }
  if (req.method === 'GET' && path === '/stream') {
    const client = new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('client') ?? '';
    if (!CLIENT_ID.test(client)) return res.writeHead(400, cors).end('No client id.');
    return openStream(req, res, cors, client);
  }
  if (req.method === 'GET' && path === '/sessions') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await readList()));
    return;
  }
  if (req.method === 'GET' && path === '/status') {
    const ids = (new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('sessions') ?? '').split(',').filter((id) => SESSION_ID.test(id)).slice(0, 200);
    /** @type {Record<string, object>} */
    const out = {};
    for (const id of ids) {
      const status = await statusOf(id);
      if (status) out[id] = status;
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(out));
    return;
  }
  if (req.method === 'GET' && path === '/turns') {
    const id = new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('session') ?? '';
    const body = SESSION_ID.test(id) ? await turnsOf(id) : null;
    if (!body) res.writeHead(404, cors).end('No such terminal.');
    else res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    return;
  }
  if (req.method === 'GET' && (path === '/files' || path === '/file')) {
    const target = new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('path') ?? '';
    try {
      const body = path === '/files' ? await listFolder(target) : await readText(target);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(404, cors).end(/** @type {NodeJS.ErrnoException} */ (err).code === 'EACCES' ? `Not allowed to read ${target}` : /** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'GET' && (path === '/git' || path === '/git/diff' || path === '/git/pr')) {
    const params = new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams;
    try {
      const body = path === '/git' ? await gitStatus(params.get('path') ?? '') : path === '/git/pr' ? await gitPullRequest(params) : await gitDiff(params);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'GET' && path === '/outcome') {
    try {
      const body = await sessionOutcome(new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'GET' && path === '/worktrees') {
    try {
      const body = await listWorktrees(new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('path') ?? '');
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  // Settings → Coding Agents: whether the board-tasks skill is linked into ~/.claude/skills.
  if (req.method === 'GET' && path === '/board-skill') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await skillStatus()));
    return;
  }
  if (req.method === 'GET' && path === '/skills') {
    try {
      const body = await listSkills(new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams.get('path') ?? '');
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'GET' && path === '/search') {
    try {
      const body = await searchFiles(new URL(/** @type {string} */ (req.url), 'http://terminal').searchParams);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  // JSON only: a page from elsewhere cannot send it without a preflight, which the Origin check refuses.
  const json = /^application\/json\b/.test(req.headers['content-type'] ?? '');
  if (req.method === 'POST' && path === '/run' && json) return run(req, res, cors);
  if (req.method === 'POST' && path === '/git' && json) {
    const body = await jsonBody(req, res, cors);
    if (!body) return;
    try {
      const result = await gitAction(body);
      log.info(`git ${body.action}`);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'POST' && (path === '/attach' || path === '/detach') && json) return attach(req, res, cors, path.slice(1));
  if (req.method === 'POST' && path === '/input' && json) return input(req, res, cors);
  if (req.method === 'POST' && path === '/sessions' && json) return saveList(req, res, cors);
  if (req.method === 'POST' && path === '/sessions/add' && json) return addToList(req, res, cors);
  if (req.method === 'POST' && path === '/sessions/update' && json) return updateList(req, res, cors);
  if (req.method === 'POST' && ['/stop', '/clear', '/close'].includes(path) && json) return control(req, res, cors, path.slice(1));
  if (req.method === 'POST' && path === '/scope' && json) return scopeOf(req, res, cors);
  if (req.method === 'POST' && path === '/scope/peers' && json) return scopePeers(req, res, cors);
  if (req.method === 'POST' && path === '/board-skill/install' && json) {
    try {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await installSkill()));
    } catch (err) {
      res.writeHead(500, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'POST' && path === '/worktree/remove' && json) return removeWorktree(req, res, cors);
  if (req.method === 'POST' && path === '/claude/exit' && json) return exitClaude(req, res, cors);
  if (req.method === 'POST' && path === '/reveal' && json) {
    const body = await jsonBody(req, res, cors);
    if (!body) return;
    try {
      const result = await reveal(body.path);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  if (req.method === 'POST' && path === '/usage' && json) {
    const body = await jsonBody(req, res, cors);
    if (!body) return;
    try {
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await worktreeUsage(body.worktrees)));
    } catch (err) {
      res.writeHead(500, cors).end(/** @type {Error} */ (err).message);
    }
    return;
  }
  // An image type also needs a preflight, so other websites cannot send one either.
  const imageType = IMAGE_TYPES[(req.headers['content-type'] ?? '').split(';')[0].trim()];
  if (req.method === 'POST' && path === '/image' && imageType) return saveImage(req, res, cors, imageType);
  res.writeHead(404, cors).end('Not a terminal request.');
})
  .on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${PORT} (terminal) is in use. Pick another with TERMINAL_PORT=<port> and set the same address on the Dev page.` : err.message);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => log.info(`Terminal runner on http://127.0.0.1:${PORT} (up to ${MAX} commands at once)`));

// Commands started from the board stop with it. Output not yet on disk is written now, so a restart keeps it.
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(signal, () => {
    for (const { child } of running.values()) stop(child, 'SIGKILL');
    for (const s of sessions.values()) {
      if (!s.timer || s.closed) continue;
      try {
        if (s.rewrite) writeFileSync(logFile(s.id), s.events.map(lineOf).join(''), { mode: 0o600 });
        else appendFileSync(logFile(s.id), s.pending, { mode: 0o600 });
      } catch {}
    }
    process.exit(0);
  });
}
