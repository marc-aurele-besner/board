// Local command runner for the Dev section: `bun run terminal` (or `node tools/terminal.js`), or with the board
// through `bun start`. It runs a command in the user's shell and streams its output back as it comes, and lists
// folders and reads files for the Dev file explorer (read only), and runs git for Dev's Source Control. It also
// removes the git worktree a task's session made once the task is completed, and only a clean one, and saves the
// images the page hands to claude as files.
// The runner owns each terminal session: a command keeps running when the page reloads or closes, and the session's
// output is kept (in memory and in TERMINAL_STATE, a folder in the system's temp folder by default) so the page
// shows it again when it comes back, even after the runner restarted. The list of open terminals is kept there too,
// so every browser on this machine opens the same terminals.
// TERMINAL_PORT changes the port (8419 by default); TERMINAL_MAX the number of commands that may run at once (12).
// It can run anything on this machine, so it listens on 127.0.0.1 only and answers only pages served from this
// machine: the Origin check keeps other websites out, the Host check keeps out DNS rebinding.
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.js';

const PORT = Number(process.env.TERMINAL_PORT) || 8419;
const MAX = Number(process.env.TERMINAL_MAX) || 12;
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
const IMAGE_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const log = logger('terminal');
// Running commands by pid: the child, the folder it reports into, and its session.
const running = new Map();
// Terminal sessions by id: their events (start, out, err, cwd, exit), the pages attached, and the running command.
const sessions = new Map();

const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);

async function folderOf(path) {
  const full = resolve(expand(path || ROOT));
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`No folder at ${full}`);
  return full;
}

// Commands run in a pseudo-terminal, so interactive programs (the Claude CLI, prompts, progress bars) work and
// colour their output as in a real terminal. The page draws that output with its own terminal emulator.
// COLORFGBG tells programs that read it whether the page is light or dark (foreground;background).
function commandEnv(dir, theme) {
  const env = { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', COLORFGBG: theme === 'dark' ? '15;0' : '0;15', PAGER: 'cat', GIT_PAGER: 'cat', BOARD_RUN_DIR: dir };
  delete env.NO_COLOR;
  return env;
}

// `script` gives the command a pseudo-terminal with no dependency. macOS's script cannot read from the socket Node
// passes as stdin (nor from a FIFO), so `cat` copies it into a plain pipe through bash's process substitution. Bash
// then becomes script (exec), so the runner sees script's exit and its code, and nothing else holds the output open.
function ptyArgs(script) {
  if (process.platform === 'darwin') return ['/bin/bash', ['-c', 'exec script -q /dev/null "$@" < <(exec cat 2>/dev/null)', 'bash', SHELL, '-c', script]];
  return ['/bin/bash', ['-c', 'exec script -q -f -e -c "$0 -c \\"\\$BOARD_SCRIPT\\"" /dev/null < <(exec cat 2>/dev/null)', SHELL]];
}

const size = (n, fallback, max) => Math.min(max, Math.max(10, Math.round(Number(n)) || fallback));

// A folder's entries, folders first, for the explorer.
async function listFolder(path) {
  const full = await folderOf(path);
  const entries = await readdir(full, { withFileTypes: true });
  const rows = entries.map((e) => ({ name: e.name, dir: e.isDirectory() || (e.isSymbolicLink() && null) }));
  // A link is shown as a folder when it points to one.
  await Promise.all(rows.filter((r) => r.dir === null).map(async (r) => (r.dir = !!(await stat(resolve(full, r.name)).catch(() => null))?.isDirectory())));
  rows.sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  return { path: full, entries: rows };
}

// One file's text. Large and binary files are described, not sent.
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
const logFile = (id) => join(STATE, `${id}.ndjson`);
const lineOf = (event) => `${JSON.stringify(event)}\n`;
const sizeOf = (event) => (event.d?.length ?? 0) + 64;

try {
  mkdirSync(STATE, { recursive: true, mode: 0o700 });
} catch (err) {
  log.error(`Cannot keep terminal sessions in ${STATE}: ${err.message}`);
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
function push(s, event) {
  const last = s.events.at(-1);
  if ((event.t === 'out' || event.t === 'err') && last?.t === event.t) last.d += event.d;
  else s.events.push({ ...event });
  s.size += sizeOf(event);
  if (event.t === 'start') s.open = s.events.at(-1);
  if (event.t === 'out' || event.t === 'err' || event.t === 'start') s.lastOut = Date.now();
  if (event.t === 'exit') s.open = null;
  if (s.size <= LOG_MAX) return;
  // Too long: the oldest output goes, down to three quarters, but the running command's start stays.
  while (s.events.length > 1 && s.size > LOG_MAX * 0.75) s.size -= sizeOf(s.events.shift());
  if (s.open && !s.events.includes(s.open)) {
    s.events.unshift(s.open);
    s.size += sizeOf(s.open);
  }
  s.rewrite = true;
}

// Writes are serialized per session: a batch of new lines, or the whole log after it was cut.
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

function record(s, event) {
  push(s, event);
  const line = lineOf(event);
  if (!s.rewrite) s.pending += line;
  s.timer ||= setTimeout(() => flush(s), FLUSH_MS);
  for (const res of s.listeners) res.write(line);
}

// A session by id, read from disk when the runner has not seen it since it started.
async function sessionOf(id) {
  if (sessions.has(id)) return sessions.get(id);
  const text = await readFile(logFile(id), 'utf8').catch(() => '');
  if (sessions.has(id)) return sessions.get(id);
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

// What a session is doing, for a task's Dev button: running (and how long it has been quiet, as a program waiting
// for its user prints nothing), ended (with its exit code), or idle. A session that is gone is left out.
const QUIET_MS = 8000;
async function statusOf(id) {
  if (!sessions.has(id) && !(await stat(logFile(id)).catch(() => null))) return null;
  const s = await sessionOf(id);
  if (s.closed) return null;
  if (s.run) return { state: Date.now() - (s.lastOut ?? 0) < QUIET_MS ? 'working' : 'waiting', cwd: s.open?.cwd ?? '' };
  const exit = s.events.findLast((e) => e.t === 'exit');
  const where = s.events.findLast((e) => e.t === 'cwd' || e.t === 'start');
  const cwd = (where?.t === 'cwd' ? where.d : where?.cwd) ?? '';
  if (!exit) return { state: 'idle', cwd };
  return { state: exit.stopped ? 'stopped' : exit.code === 0 ? 'done' : 'failed', code: exit.code, cwd };
}

// The page attaches to a session: everything so far, a `live` marker, then events as they come.
async function attach(req, res, cors, id) {
  const s = await sessionOf(id);
  res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  res.write(lineOf({ t: 'session', known: s.known || s.events.length > 0 }));
  res.write(s.events.map(lineOf).join(''));
  res.write(lineOf({ t: 'live' }));
  s.listeners.add(res);
  res.on('close', () => s.listeners.delete(res));
}

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
async function saveImage(req, res, cors, ext) {
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
    res.writeHead(500, cors).end(`Could not save the image: ${err.message}`);
  }
}

// The whole process group, so a dev server started by the command stops with it.
function stop(child, signal) {
  try {
    if (WINDOWS) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

async function jsonBody(req, res, cors, max) {
  try {
    return JSON.parse(await readBody(req, max));
  } catch {
    res.writeHead(400, cors).end('Send JSON.');
    return null;
  }
}

async function sessionFrom(body, res, cors) {
  const id = String(body.session ?? '');
  if (SESSION_ID.test(id)) return sessionOf(id);
  res.writeHead(400, cors).end('No terminal session.');
  return null;
}

// Starts a command in a session. Its output goes to the session, which the page reads through /attach.
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
    return res.writeHead(400, cors).end(err.message);
  }
  if (s.run) return res.writeHead(409, cors).end('A command is already running in this terminal.');
  const cols = size(body.cols, 100, 500);
  const rows = size(body.rows, 30, 200);

  // Each command runs in a fresh shell. It writes its terminal's name (for resizing) and, at the end, the folder
  // it ended in to a folder of its own, so the page keeps that folder: `cd` works.
  // The session is taken before the first await below, so a second Run cannot start another command in it.
  const job = { child: null, dir: '', session: s, stopped: false, killer: 0 };
  s.run = job;
  const dir = WINDOWS ? '' : await mkdtemp(join(tmpdir(), 'board-run-'));
  const script = WINDOWS
    ? command
    : `stty cols ${cols} rows ${rows} 2>/dev/null; tty > "$BOARD_RUN_DIR/tty" 2>/dev/null\n${command}\n__board_status=$?; pwd > "$BOARD_RUN_DIR/cwd" 2>/dev/null; exit $__board_status`;
  const [file, args] = WINDOWS ? [SHELL, ['/d', '/s', '/c', script]] : ptyArgs(script);
  const started = performance.now();
  const child = spawn(file, args, { cwd, detached: !WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...commandEnv(dir, body.theme), BOARD_SCRIPT: script } });
  Object.assign(job, { child, dir });
  running.set(child.pid, job);
  log.info(`started pid ${child.pid} in ${cwd} (${running.size} running)`);
  record(s, { t: 'start', pid: child.pid, cwd, command, at: Date.now() });
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
function stopJob(job) {
  if (!job?.child || job.stopped) return;
  job.stopped = true;
  stop(job.child, 'SIGTERM');
  job.killer = setTimeout(() => stop(job.child, 'SIGKILL'), KILL_AFTER_MS);
}

// Stop ends the session's command; clear empties its kept output; close does both and forgets the session.
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
    for (const listener of s.listeners) listener.end();
    s.disk.then(() => rm(logFile(s.id), { force: true })).catch(() => {});
  }
  res.writeHead(204, cors).end();
}

// The open terminals: { active, sessions: [{ id, n, cwd, tasks?, prompt? }] }, or { sessions: null } before the
// page saved any. Writes go one after another, each replacing the file whole.
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
function cleanList(body) {
  if (!Array.isArray(body.sessions)) return null;
  const seen = new Set();
  const sessions = [];
  for (const x of body.sessions.slice(0, 200)) {
    const id = String(x?.id ?? '');
    if (!SESSION_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    const tasks = Array.isArray(x.tasks) ? x.tasks.filter((t) => typeof t === 'string').slice(0, 200) : [];
    sessions.push({ id, n: Math.max(1, Math.round(Number(x.n)) || 1), cwd: String(x.cwd ?? ''), ...(tasks.length ? { tasks, prompt: String(x.prompt ?? '') } : {}) });
  }
  return { active: seen.has(String(body.active)) ? String(body.active) : '', sessions };
}
async function saveList(req, res, cors) {
  const body = await jsonBody(req, res, cors, LIST_MAX);
  if (!body) return;
  const list = cleanList(body);
  if (!list) return res.writeHead(400, cors).end('Send the terminals as { active, sessions }.');
  const tmp = `${LIST_FILE}.${process.pid}.tmp`;
  listWrite = listWrite
    .then(() => writeFile(tmp, JSON.stringify(list), { mode: 0o600 }))
    .then(() => rename(tmp, LIST_FILE))
    .catch((err) => log.error(`Could not save the terminal list: ${err.message}`));
  await listWrite;
  res.writeHead(204, cors).end();
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

// Removes the worktree `claude --worktree <name>` made in the repo at `cwd` (.claude/worktrees/<name>) once its task
// is completed. The task's session is stopped first, since claude runs inside the worktree. git refuses a worktree
// with changes or untracked files, so nothing unsaved is lost; its branch is kept.
// Answers { removed: path }, or { missing: true } when the folder or the worktree is already gone.
async function removeWorktree(req, res, cors) {
  const body = await jsonBody(req, res, cors);
  if (!body) return;
  const name = String(body.name ?? '');
  if (!WORKTREE_NAME.test(name)) return res.writeHead(400, cors).end('No worktree name.');
  const reply = (data) => res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(data));
  const id = String(body.session ?? '');
  // Without a folder, the repo is the one the session's first command started in.
  let cwd = String(body.cwd ?? '');
  if (SESSION_ID.test(id)) {
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
    return res.writeHead(400, cors).end(`Not a git repository: ${err.message}`);
  }
  // The first entry is the main checkout, never removed.
  const entries = list.trim().split(/\n\n+/).slice(1)
    .map((block) => Object.fromEntries(block.split('\n').map((line) => [line.split(' ')[0], line.slice(line.indexOf(' ') + 1)])));
  const tree = entries.find((e) => e.worktree && basename(e.worktree) === name && dirname(e.worktree).endsWith(join('.claude', 'worktrees')));
  if (!tree) return reply({ missing: true });
  try {
    // claude locks its worktree while it runs; a lock whose claude has ended is left over.
    if ('locked' in tree) {
      const pid = Number(/\bpid (\d+)/.exec(tree.locked)?.[1]);
      if (pid && alive(pid)) return res.writeHead(409, cors).end(`claude still runs in ${tree.worktree} (pid ${pid}).`);
      await git(dir, ['worktree', 'unlock', tree.worktree]);
    }
    await git(dir, ['worktree', 'remove', tree.worktree]);
  } catch (err) {
    return res.writeHead(409, cors).end(err.message);
  }
  log.info(`removed worktree ${tree.worktree}`);
  reply({ removed: tree.worktree });
}

// Keys typed in the page, sent to a running command's terminal.
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
      spawn('stty', [process.platform === 'darwin' ? '-f' : '-F', tty, 'cols', String(size(body.cols, 100, 500)), 'rows', String(size(body.rows, 30, 200))], { stdio: 'ignore' }).on('error', () => {});
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
      fail(new Error((stderr || stdout || err.message).trim()));
    });
  });
}

// The repository holding a folder, or null.
async function repoOf(path) {
  const dir = await folderOf(path);
  const top = await git(dir, ['rev-parse', '--show-toplevel']).catch(() => '');
  return top.trim() || null;
}

// `git status --porcelain=v2 -z`: the branch lines, then one record per file. A rename carries its old path in
// the record after it.
function parseStatus(text) {
  const out = { branch: '', oid: '', upstream: '', ahead: 0, behind: 0, files: [] };
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
    const split = (n) => {
      const parts = r.split(' ');
      return { xy: parts[1], path: parts.slice(n).join(' ') };
    };
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

async function gitStatus(path) {
  const root = await repoOf(path);
  if (!root) return { repo: false, path: await folderOf(path) };
  const [status, log, branches, remotes] = await Promise.all([
    git(root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']),
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

// A file's changes (staged, or in the working folder), or a commit's.
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

const validFiles = (files) => Array.isArray(files) && files.length && files.every((f) => typeof f === 'string' && f && !f.includes('\0'));

// Changes to the repository: the page names the action and what it applies to.
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
  const files = body.files;
  const net = { timeout: 120000 };
  switch (action) {
    case 'stage':
      if (!validFiles(files)) throw new Error('No files.');
      await git(root, ['add', '-A', '--', ...files]);
      break;
    case 'stage-all':
      await git(root, ['add', '-A']);
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
      if (body.all) await git(root, ['add', '-A']);
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
  const path = new URL(req.url, 'http://terminal').pathname;
  if (req.method === 'GET' && path === '/info') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify({ root: ROOT, home: homedir(), shell: SHELL, max: MAX, running: running.size }));
    return;
  }
  if (req.method === 'GET' && path === '/attach') {
    const id = new URL(req.url, 'http://terminal').searchParams.get('session') ?? '';
    if (!SESSION_ID.test(id)) return res.writeHead(400, cors).end('No terminal session.');
    return attach(req, res, cors, id);
  }
  if (req.method === 'GET' && path === '/sessions') {
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(await readList()));
    return;
  }
  if (req.method === 'GET' && path === '/status') {
    const ids = (new URL(req.url, 'http://terminal').searchParams.get('sessions') ?? '').split(',').filter((id) => SESSION_ID.test(id)).slice(0, 200);
    const out = {};
    for (const id of ids) {
      const status = await statusOf(id);
      if (status) out[id] = status;
    }
    res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(out));
    return;
  }
  if (req.method === 'GET' && (path === '/files' || path === '/file')) {
    const target = new URL(req.url, 'http://terminal').searchParams.get('path') ?? '';
    try {
      const body = path === '/files' ? await listFolder(target) : await readText(target);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(404, cors).end(err.code === 'EACCES' ? `Not allowed to read ${target}` : err.message);
    }
    return;
  }
  if (req.method === 'GET' && (path === '/git' || path === '/git/diff')) {
    const params = new URL(req.url, 'http://terminal').searchParams;
    try {
      const body = path === '/git' ? await gitStatus(params.get('path') ?? '') : await gitDiff(params);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(body));
    } catch (err) {
      res.writeHead(400, cors).end(err.message);
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
      res.writeHead(400, cors).end(err.message);
    }
    return;
  }
  if (req.method === 'POST' && path === '/input' && json) return input(req, res, cors);
  if (req.method === 'POST' && path === '/sessions' && json) return saveList(req, res, cors);
  if (req.method === 'POST' && ['/stop', '/clear', '/close'].includes(path) && json) return control(req, res, cors, path.slice(1));
  if (req.method === 'POST' && path === '/worktree/remove' && json) return removeWorktree(req, res, cors);
  // An image type also needs a preflight, so other websites cannot send one either.
  const imageType = IMAGE_TYPES[(req.headers['content-type'] ?? '').split(';')[0].trim()];
  if (req.method === 'POST' && path === '/image' && imageType) return saveImage(req, res, cors, imageType);
  res.writeHead(404, cors).end('Not a terminal request.');
})
  .on('error', (err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${PORT} (terminal) is in use. Pick another with TERMINAL_PORT=<port> and set the same address on the Dev page.` : err.message);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => log.info(`Terminal runner on http://127.0.0.1:${PORT} (up to ${MAX} commands at once)`));

// Commands started from the board stop with it. Output not yet on disk is written now, so a restart keeps it.
for (const signal of ['SIGINT', 'SIGTERM']) {
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
