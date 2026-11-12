// The runners: one local worker that does the board's background work on a schedule (mail, calendar, DeFi, site
// checks, Telegram, Cron flows…) and writes the results into the data folder, whether or not a board tab is open.
// The board only reads and renders those files; its 3 s disk sync brings them into an open tab.
// It runs inside `bun start` and `bun dev` (tools/start.js imports it), so it stops with them.
//
// The browser knows its data folder only as a handle, never as a path, so the path is set once:
// BOARD_DATA=<folder> wins; otherwise ~/.config/board/worker.json { "dataFolder": "~/…" }, which Settings → Runners writes.
// WORKER_PORT changes the port of its localhost API (8420 by default).
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './log.js';
import { createNodeStore } from './worker/store.js';
import { createScheduler } from './worker/schedule.js';
import { serve } from './worker/http.js';
import { jobs } from './jobs/index.js';

const PORT = Number(process.env.WORKER_PORT) || 8420;
const CONFIG = join(homedir(), '.config', 'board', 'worker.json');
const log = logger('worker');

const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);
const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

function readConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG, 'utf8'));
  } catch {
    return {};
  }
}

// The data folder's path, as configured (with ~), and where it came from.
function configuredFolder() {
  if (process.env.BOARD_DATA) return { path: process.env.BOARD_DATA, from: 'BOARD_DATA' };
  const { dataFolder = '' } = readConfig();
  return { path: dataFolder, from: dataFolder ? CONFIG : '' };
}

const scheduler = createScheduler({ jobs, log });
let folder = { path: '', from: '', error: '' };

function open() {
  const { path, from } = configuredFolder();
  folder = { path, from, error: '' };
  if (!path) {
    log.info('No data folder yet. Set its path in the board: Settings → Runners.');
    return scheduler.use(null);
  }
  const dir = expand(path);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    folder.error = `There is no folder at ${path}.`;
    log.error(folder.error);
    return scheduler.use(null);
  }
  log.info(`Data folder ${path}${from === 'BOARD_DATA' ? ' (from BOARD_DATA)' : ''}`);
  scheduler.use(createNodeStore(dir, { log }));
}

serve({
  port: PORT,
  log,
  routes: {
    'GET /status': () => ({ ...scheduler.status(), folder: { path: folder.path, from: folder.from, error: folder.error } }),
    'POST /run/*': (body, id) => scheduler.run(id, { params: body ?? {} }),
    'POST /config': (body) => {
      if (process.env.BOARD_DATA) {
        const err = new Error('BOARD_DATA is set where the board was started, so it decides the folder.');
        err.status = 409;
        throw err;
      }
      const path = tilde(String(body.dataFolder ?? '').trim());
      if (path && !existsSync(expand(path))) {
        const err = new Error(`There is no folder at ${path}.`);
        err.status = 400;
        throw err;
      }
      mkdirSync(join(homedir(), '.config', 'board'), { recursive: true });
      writeFileSync(CONFIG, `${JSON.stringify({ ...readConfig(), dataFolder: path }, null, 2)}\n`);
      open();
      return { ok: true, folder };
    },
  },
});

open();
