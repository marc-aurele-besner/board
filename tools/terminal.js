// Local command runner for the Dev section: `bun run terminal` (or `node tools/terminal.js`), or with the board
// through `bun start`. It runs a command in the user's shell and streams its output back as it comes, and lists
// folders and reads files for the Dev file explorer (read only: it writes no file of yours).
// The runner owns each terminal session: a command keeps running when the page reloads or closes, and the session's
// output is kept (in memory and in TERMINAL_STATE, a folder in the system's temp folder by default) so the page
// shows it again when it comes back, even after the runner restarted.
// TERMINAL_PORT changes the port (8419 by default); TERMINAL_MAX the number of commands that may run at once (12).
// It can run anything on this machine, so it listens on 127.0.0.1 only and answers only pages served from this
// machine: the Origin check keeps other websites out, the Host check keeps out DNS rebinding.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { appendFile, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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

function readBody(req) {
  return new Promise((done, fail) => {
    let text = '';
    req.on('data', (chunk) => {
      text += chunk;
      if (text.length > 100_000) req.destroy(new Error('Request too large'));
    });
    req.on('end', () => done(text));
    req.on('error', fail);
  });
}

// The whole process group, so a dev server started by the command stops with it.
function stop(child, signal) {
  try {
    if (WINDOWS) child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {}
}

async function jsonBody(req, res, cors) {
  try {
    return JSON.parse(await readBody(req));
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
  // JSON only: a page from elsewhere cannot send it without a preflight, which the Origin check refuses.
  const json = /^application\/json\b/.test(req.headers['content-type'] ?? '');
  if (req.method === 'POST' && path === '/run' && json) return run(req, res, cors);
  if (req.method === 'POST' && path === '/input' && json) return input(req, res, cors);
  if (req.method === 'POST' && ['/stop', '/clear', '/close'].includes(path) && json) return control(req, res, cors, path.slice(1));
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
