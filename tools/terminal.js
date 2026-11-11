// Local command runner for the Dev section: `bun run terminal` (or `node tools/terminal.js`), or with the board
// through `bun start`. It runs a command in the user's shell and streams its output back as it comes, and lists
// folders and reads files for the Dev file explorer (read only: nothing here writes a file).
// TERMINAL_PORT changes the port (8419 by default); TERMINAL_MAX the number of commands that may run at once (12).
// It can run anything on this machine, so it listens on 127.0.0.1 only and answers only pages served from this
// machine: the Origin check keeps other websites out, the Host check keeps out DNS rebinding.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
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
const log = logger('terminal');
// Running commands by pid: the child and the folder it reports into.
const running = new Map();

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

async function run(req, res, cors) {
  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return res.writeHead(400, cors).end('Send JSON: { "command": "...", "cwd": "..." }');
  }
  const command = String(body.command ?? '').trim();
  if (!command) return res.writeHead(400, cors).end('No command.');
  if (running.size >= MAX) return res.writeHead(429, cors).end(`${MAX} commands are already running. Stop one, or start the board with TERMINAL_MAX set higher.`);
  let cwd;
  try {
    cwd = await folderOf(String(body.cwd ?? ''));
  } catch (err) {
    return res.writeHead(400, cors).end(err.message);
  }
  const cols = size(body.cols, 100, 500);
  const rows = size(body.rows, 30, 200);

  // Each command runs in a fresh shell. It writes its terminal's name (for resizing) and, at the end, the folder
  // it ended in to a folder of its own, so the page keeps that folder: `cd` works.
  const dir = WINDOWS ? '' : await mkdtemp(join(tmpdir(), 'board-run-'));
  const script = WINDOWS
    ? command
    : `stty cols ${cols} rows ${rows} 2>/dev/null; tty > "$BOARD_RUN_DIR/tty" 2>/dev/null\n${command}\n__board_status=$?; pwd > "$BOARD_RUN_DIR/cwd" 2>/dev/null; exit $__board_status`;
  const [file, args] = WINDOWS ? [SHELL, ['/d', '/s', '/c', script]] : ptyArgs(script);
  const started = performance.now();
  const child = spawn(file, args, { cwd, detached: !WINDOWS, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...commandEnv(dir, body.theme), BOARD_SCRIPT: script } });
  const run = { child, dir };
  running.set(child.pid, run);
  log.info(`started pid ${child.pid} in ${cwd} (${running.size} running)`);
  res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  const send = (event) => res.writableEnded || res.write(`${JSON.stringify(event)}\n`);
  send({ t: 'start', pid: child.pid, cwd });
  child.stdout.setEncoding('utf8').on('data', (d) => send({ t: 'out', d }));
  child.stderr.setEncoding('utf8').on('data', (d) => send({ t: 'err', d }));
  child.stdin.on('error', () => {});

  let killer = 0;
  child.on('error', (err) => send({ t: 'err', d: `${err.message}\n` }));
  // `cat` waits for more input; once the command is done it is told there is none.
  child.on('exit', () => child.stdin.end());
  child.on('close', async (code, signal) => {
    clearTimeout(killer);
    running.delete(child.pid);
    const ms = performance.now() - started;
    log.info(`pid ${child.pid} ended ${signal ?? `with ${code}`} after ${Math.round(ms)}ms`);
    if (dir) {
      const endCwd = (await readFile(join(dir, 'cwd'), 'utf8').catch(() => '')).trim();
      if (endCwd) send({ t: 'cwd', d: endCwd });
      rm(dir, { recursive: true, force: true }).catch(() => {});
    }
    send({ t: 'exit', code, signal, ms });
    res.end();
  });
  // The page stopped the command, closed the session, or was reloaded.
  res.on('close', () => {
    if (!running.has(child.pid)) return;
    stop(child, 'SIGTERM');
    killer = setTimeout(() => stop(child, 'SIGKILL'), KILL_AFTER_MS);
  });
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
  res.writeHead(404, cors).end('Not a terminal request.');
})
  .on('error', (err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${PORT} (terminal) is in use. Pick another with TERMINAL_PORT=<port> and set the same address on the Dev page.` : err.message);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => log.info(`Terminal runner on http://127.0.0.1:${PORT} (up to ${MAX} commands at once)`));

// Commands started from the board stop with it.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const { child } of running.values()) stop(child, 'SIGKILL');
    process.exit(0);
  });
}
