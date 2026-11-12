// Work that runs by itself while the board is open: reading Telegram, checking sites, Cron flows, announcing deadlines,
// renewing Google sign-ins before they expire, removing the worktrees of completed tasks, and reading what their
// claude sessions used.
// Nothing here runs when the board is closed; there is no server.
import { checkDeadlines } from './notifications.js';
import { pollTelegram } from './telegram.js';
import { runDueFlows } from './cron.js';
import { refreshTokens } from './google.js';
import { sitesOf, siteData, checkSite, runRules, checkProviders, providersDue, checkBudgets } from './automations.js';
import { removeDoneWorktrees } from './task-worktrees.js';
import { refreshDevUsage } from './dev-usage.js';

const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
let started = false;

const olderThan = (at, ms) => !at || Date.now() - Date.parse(at) > ms;

// Health follows the interval chosen in Tools. Certificates, domains, DNS and crawl files change slowly, so they are looked up once a day.
async function checkDueSites(store) {
  const every = (store.get('tools').every || 60) * MINUTE;
  for (const p of sitesOf(store)) {
    const s = siteData(store, p.id);
    const parts = [
      olderThan(s.health?.at, every) ? 'health' : null,
      olderThan(s.ssl?.at, DAY) ? 'ssl' : null,
      olderThan(s.domain?.at, DAY) ? 'domain' : null,
      olderThan(s.dns?.at, DAY) ? 'dns' : null,
      olderThan(s.crawl?.at, DAY) ? 'crawl' : null,
    ].filter(Boolean);
    if (parts.length) await checkSite(store, p, parts);
  }
  runRules(store);
}

export function startBackground(store) {
  if (started) return;
  started = true;
  const quiet = (work) => () => Promise.resolve().then(work).catch((err) => console.warn('Background work failed', err));
  const telegram = quiet(() => pollTelegram(store));
  const cron = quiet(() => runDueFlows(store));
  const slow = quiet(async () => {
    checkDeadlines(store);
    checkBudgets(store);
    await checkDueSites(store);
    // Status pages follow the same interval as website health.
    if (providersDue(store)) await checkProviders(store);
  });
  // Start after the first paint, so opening the board is never held up by the network.
  const google = quiet(() => refreshTokens());
  const devUsage = quiet(() => refreshDevUsage(store));
  // Google first: the sections opened next read with these tokens.
  setTimeout(google, 500);
  setTimeout(telegram, 1500);
  setTimeout(slow, 3000);
  setTimeout(cron, 4000);
  setTimeout(devUsage, 5000);
  setInterval(telegram, MINUTE);
  setInterval(cron, MINUTE);
  setInterval(google, MINUTE);
  setInterval(devUsage, MINUTE);
  setInterval(slow, 5 * MINUTE);
  // A task completed anywhere (Tasks, the palette, another tab's save) gives back the worktree its Dev session made.
  store.subscribe(() => removeDoneWorktrees(store));
  setTimeout(() => removeDoneWorktrees(store), 2000);
}
