// The runners: one local worker that does the board's background work on a schedule (mail, calendar, DeFi, site
// checks, Telegram, Cron flows…) and writes the results into the data folder, whether or not a board tab is open.
// The board only reads and renders those files; its 3 s disk sync brings them into an open tab.
// It runs inside `bun start` and `bun dev` (tools/start.js imports it), so it stops with them.
//
// The browser knows its data folder only as a handle, never as a path, so the path is set once:
// BOARD_DATA=<folder> wins; otherwise ~/.config/board/worker.json { "dataFolder": "~/…" }, which Settings → Runners writes.
// WORKER_PORT changes the port of its localhost API (8420 by default).
/** @import { RequestBody } from '../types/runner' */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from './log.js';
import { createNodeStore } from './worker/store.js';
import { createScheduler } from './worker/schedule.js';
import { serve } from './worker/http.js';
import { jobs } from './jobs/index.js';
import { taskRoutes } from './worker/tasks.js';
import { contextRoutes } from './worker/context.js';
import { sendWire } from '../js/http-request.js';
import { pageConsole } from './worker/page-console.js';
import { slackCall, slackFile } from './slack.js';
import { voyager, queueState } from './linkedin-session.js';
import { exchangeLinkedinCode, publishPost } from '../js/linkedin-core.js';
import { useLinkedinSession } from '../js/linkedin-session.js';

// Shared code (Cron steps) calls linkedinCall(); here it runs the session's queue itself.
useLinkedinSession(voyager);

const PORT = Number(process.env.WORKER_PORT) || 8420;
const CONFIG = join(homedir(), '.config', 'board', 'worker.json');
const log = logger('worker');

/** @param {string} path */
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);
/** @param {string} path */
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

function noOverride() {
  if (!process.env.BOARD_DATA) return;
  const err = /** @type {Error & { status?: number }} */ (new Error('BOARD_DATA is set where the board was started, so it decides the folder.'));
  err.status = 409;
  throw err;
}

/** @param {string} path */
function setFolder(path) {
  mkdirSync(join(homedir(), '.config', 'board'), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify({ ...readConfig(), dataFolder: path }, null, 2)}\n`);
  open();
  return { ok: true, folder };
}

/** @param {string} dir */
const subfolders = (dir) => {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.name.startsWith('.')).map((e) => join(dir, e.name));
  } catch {
    return [];
  }
};

// Folders named `name` whose settings.json holds `folderId`: in the home folder, Desktop, Documents, Downloads and
// iCloud Drive, and one level below those.
/** @param {string} name @param {string} folderId */
function findFolder(name, folderId) {
  if (!name || !folderId || name.includes('/') || name.startsWith('.')) return [];
  const home = homedir();
  const roots = [home, ...['Desktop', 'Documents', 'Downloads', 'Library/Mobile Documents/com~apple~CloudDocs'].map((d) => join(home, d))];
  const places = [...new Set([...roots, ...roots.slice(1).flatMap(subfolders)])];
  return places.map((dir) => join(dir, name)).filter((dir) => {
    try {
      return JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).folderId === folderId;
    } catch {
      return false;
    }
  });
}

// Routes a job adds, such as reading one Resend email's body: (body, rest, store).
const jobRoutes = Object.fromEntries(jobs.flatMap((job) => Object.entries(job.routes ?? {})).map(([key, fn]) => [key, (/** @type {RequestBody} */ body, /** @type {string} */ rest) => {
  const store = scheduler.store();
  if (!store) throw new Error('The runners have no data folder. Set it in Settings → Runners.');
  return fn(body, rest, store);
}]));

serve({
  port: PORT,
  log,
  routes: {
    ...jobRoutes,
    // tools/board.js: a Dev session's own tasks (list, show, add, edit), by its terminal's token.
    ...taskRoutes(() => scheduler.store()),
    // tools/board.js: the other sessions on its tasks, their project and brand, and their images.
    ...contextRoutes(() => scheduler.store()),
    // Tools → Requests: sends a request from Node, where CORS does not apply. Needs no data folder.
    'POST /http': (body) => sendWire(/** @type {import('../js/http-request.js').Wire} */ (body)),
    // Tasks → a PR's preview site: its console, read by loading it once in headless Chrome.
    'POST /page-console': (body) => pageConsole(/** @type {Parameters<typeof pageConsole>[0]} */ (body)),
    // The Slack tab: Web API calls and session-only files, with the session cookie a page cannot send.
    'POST /slack': (body) => slackCall(body),
    'POST /slack/file': (body) => slackFile(body),
    // Settings → LinkedIn: the official sign-in's code for a token. LinkedIn's token endpoint answers no CORS request.
    'POST /linkedin/token': (body) => exchangeLinkedinCode({
      clientId: String(body.clientId ?? ''),
      clientSecret: String(body.clientSecret ?? ''),
      code: String(body.code ?? ''),
      redirectUri: String(body.redirectUri ?? ''),
    }),
    // A tab's LinkedIn session call: it waits its turn in the queue, so the answer can take minutes.
    'POST /linkedin/voyager': async (body) => {
      const store = scheduler.store();
      if (!store) throw new Error('The runners have no data folder. Set it in Settings → Runners.');
      const { path, cacheKey, maxAge, method, headers } = body;
      if (typeof path !== 'string' || !path) throw Object.assign(new Error('No path.'), { status: 400 });
      try {
        const value = await voyager(store, {
          path,
          cacheKey: typeof cacheKey === 'string' ? cacheKey : undefined,
          maxAge: typeof maxAge === 'number' ? maxAge : undefined,
          method: typeof method === 'string' ? method : undefined,
          headers: headers && typeof headers === 'object' ? /** @type {Record<string, string>} */ (headers) : undefined,
        });
        return { ok: true, value };
      } catch (err) {
        const e = /** @type {Error & { code?: string, status?: number }} */ (err);
        return { ok: false, error: e.message, code: e.code, status: e.status };
      }
    },
    'GET /linkedin/queue': () => queueState(),
    // A task's or project's LinkedIn post, now: its answer is the post as saved, written to disk before it returns.
    'POST /linkedin/post': async (body) => {
      const store = scheduler.store();
      if (!store) throw new Error('The runners have no data folder. Set it in Settings → Runners.');
      const post = await publishPost(store, String(body.id ?? ''));
      store.flush();
      return post;
    },
    'GET /status': () => ({ ...scheduler.status(), folder: { path: folder.path, from: folder.from, error: folder.error } }),
    'POST /run/*': (body, id) => scheduler.run(id, { params: body ?? {} }),
    'POST /config': (body) => {
      noOverride();
      const path = tilde(String(body.dataFolder ?? '').trim());
      if (path && !existsSync(expand(path))) {
        const err = /** @type {Error & { status?: number }} */ (new Error(`There is no folder at ${path}.`));
        err.status = 400;
        throw err;
      }
      return setFolder(path);
    },
    // The tab knows its folder only by name and by the folderId in its settings.json: look for it where people keep
    // folders, and use it when exactly one matches.
    'POST /config/find': (body) => {
      noOverride();
      const found = findFolder(String(body.name ?? ''), String(body.folderId ?? ''));
      return found.length === 1 ? setFolder(tilde(found[0])) : { ok: false, found: found.map(tilde), folder };
    },
  },
});

open();
