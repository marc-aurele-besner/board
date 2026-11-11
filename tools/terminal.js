// Local command runner for the Dev section: `bun run terminal` (or `node tools/terminal.js`), or with the board
// through `bun start`. It runs a command in the user's shell and streams its output back as it comes.
// TERMINAL_PORT changes the port (8419 by default); TERMINAL_MAX the number of commands that may run at once (12).
// It can run anything on this machine, so it listens on 127.0.0.1 only and answers only pages served from this
// machine: the Origin check keeps other websites out, the Host check keeps out DNS rebinding.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
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
const log = logger('terminal');
const running = new Map();

const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);

async function folderOf(path) {
  const full = resolve(expand(path || ROOT));
  const info = await stat(full).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`No folder at ${full}`);
  return full;
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

  // Each command runs in a fresh shell, so the folder it ends in is written to fd 3 and the page keeps it: `cd` works.
  const script = WINDOWS ? command : `${command}\n__board_status=$?; pwd >&3 2>/dev/null; exit $__board_status`;
  const args = WINDOWS ? ['/d', '/s', '/c', script] : ['-c', script];
  const started = performance.now();
  const child = spawn(SHELL, args, {
    cwd,
    detached: !WINDOWS,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe', WINDOWS ? 'ignore' : 'pipe'],
    // No interactive terminal: tools that colour or page their output are asked not to.
    env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', FORCE_COLOR: '0', PAGER: 'cat', GIT_PAGER: 'cat', CI: process.env.CI ?? '' },
  });
  running.set(child.pid, child);
  log.info(`started pid ${child.pid} in ${cwd} (${running.size} running)`);
  res.writeHead(200, { ...cors, 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-cache', 'x-content-type-options': 'nosniff' });
  const send = (event) => res.writableEnded || res.write(`${JSON.stringify(event)}\n`);
  send({ t: 'start', pid: child.pid, cwd });
  child.stdout.setEncoding('utf8').on('data', (d) => send({ t: 'out', d }));
  child.stderr.setEncoding('utf8').on('data', (d) => send({ t: 'err', d }));
  let endCwd = '';
  child.stdio[3]?.setEncoding('utf8').on('data', (d) => (endCwd += d));

  let killer = 0;
  child.on('error', (err) => send({ t: 'err', d: `${err.message}\n` }));
  child.on('close', (code, signal) => {
    clearTimeout(killer);
    running.delete(child.pid);
    const ms = performance.now() - started;
    log.info(`pid ${child.pid} ended ${signal ?? `with ${code}`} after ${Math.round(ms)}ms`);
    if (endCwd.trim()) send({ t: 'cwd', d: endCwd.trim() });
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
  // JSON only: a page from elsewhere cannot send it without a preflight, which the Origin check refuses.
  if (req.method === 'POST' && path === '/run' && /^application\/json\b/.test(req.headers['content-type'] ?? '')) return run(req, res, cors);
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
    for (const child of running.values()) stop(child, 'SIGKILL');
    process.exit(0);
  });
}
