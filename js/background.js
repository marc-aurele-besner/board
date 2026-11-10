// Work that runs by itself while the board is open: reading Telegram, checking sites, and announcing deadlines.
// Nothing here runs when the board is closed; there is no server.
import { checkDeadlines } from './notifications.js';
import { pollTelegram } from './telegram.js';
import { sitesOf, siteData, checkSite, runRules, checkProviders, providersDue, checkBudgets } from './automations.js';

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
  const slow = quiet(async () => {
    checkDeadlines(store);
    checkBudgets(store);
    await checkDueSites(store);
    // Status pages follow the same interval as website health.
    if (providersDue(store)) await checkProviders(store);
  });
  // Start after the first paint, so opening the board is never held up by the network.
  setTimeout(telegram, 1500);
  setTimeout(slow, 3000);
  setInterval(telegram, MINUTE);
  setInterval(slow, 5 * MINUTE);
}
