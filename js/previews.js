// @ts-check
// Preview deployments of pull requests. Repos on Vercel or Netlify get a bot comment on each PR with the link to the
// PR's preview, edited as each push deploys again. The runners (tools/jobs/previews.js) read those comments for the
// PRs of open tasks and recent Cron runs into github.json `previews`:
// { "owner/repo#12": { at, first, items: [{ provider, name, url, state }], error } }.
// Tasks and Cron runs show them next to their PRs.
import { h, icon, statusOf } from './ui.js';
import { GITHUB, issueComments } from './github.js';
import { runJob } from './runners.js';
/** @import { DataStore, Store, CronRunStep, PrPreviews, PreviewItem } from '../types/data' */
/** @typedef {{ repo: string, number: number }} PrRef */
// A comment of the GitHub API, as far as it is read here.
/** @typedef {{ updated_at?: string, user?: { login?: string } | null, body?: string | null }} PrComment */

const MIN = 60000;
// How long a PR waits between two reads: soon while a preview builds or no bot has commented yet, rarely once ready.
const AGAIN_BUILDING = MIN;
const AGAIN_READY = 20 * MIN;
const AGAIN_QUIET = 10 * MIN;
const AGAIN_QUIET_LONG = 60 * MIN;
// The PRs of Cron runs this recent are read; an entry no PR has needed for this long is dropped.
const RUNS_WITHIN = 3 * 24 * 60 * MIN;
const KEPT = 14 * 24 * 60 * MIN;
// Reads per run, so a long list does not spend the GitHub rate limit at once.
const PER_RUN = 30;

/**
 * @param {string} repo
 * @param {number} number
 */
export const previewKey = (repo, number) => `${String(repo).toLowerCase()}#${number}`;

/** @param {string} text */
const stateOf = (text) => {
  const t = String(text).toLowerCase();
  if (/ready|success/.test(t)) return 'ready';
  if (/fail|error/.test(t)) return 'failed';
  if (/cancel/.test(t)) return 'canceled';
  if (/ignored|skipped/.test(t)) return 'ignored';
  if (/build|queue|initiali|pending|processing|deploying/.test(t)) return 'building';
  return '';
};

// Markdown and HTML out of a table cell: "**app**" and "[app](…)" read "app".
/** @param {string} cell */
const plain = (cell) => cell.replace(/<[^>]+>/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '').trim();
/** @param {string} line */
const cellsOf = (line) => line.trim().replace(/^\||\|$/g, '').split('|');

// Vercel's comment is a table with one row per Vercel project: | **app** | ✅ Ready ([Inspect](…)) | [Visit Preview](…) | …
const VERCEL_URL = /https?:\/\/[\w.-]+\.vercel\.app\b[^\s)|\]]*/;
/** @param {string} body */
function parseVercel(body) {
  /** @type {PreviewItem[]} */
  const items = [];
  for (const line of body.split('\n')) {
    if (!line.trim().startsWith('|')) continue;
    const cells = cellsOf(line);
    if (cells.length < 3 || /^\s*:?-+/.test(cells[0]) || /^\s*name\s*$/i.test(plain(cells[0]))) continue;
    const url = line.match(/\[Visit Preview\]\((https?:\/\/[^)\s]+)\)/i)?.[1] ?? line.match(VERCEL_URL)?.[0] ?? '';
    const state = stateOf(plain(cells[1]));
    if (!url && !state) continue;
    items.push({ provider: 'vercel', name: plain(cells[0]), url, state });
  }
  if (!items.length) {
    const url = body.match(VERCEL_URL)?.[0];
    if (url) items.push({ provider: 'vercel', name: '', url, state: stateOf(body) || 'ready' });
  }
  return items;
}

// Netlify's comment is one per site: "Deploy Preview for *site* ready!", then a table with a "Deploy Preview" row.
const NETLIFY_URL = /https?:\/\/deploy-preview-\d+--[\w-]+\.netlify\.app\b[^\s)|\]]*/;
/**
 * @param {string} body
 * @returns {PreviewItem[]}
 */
function parseNetlify(body) {
  const head = body.match(/Deploy Preview for \*?([^*\n]+?)\*?\s+(ready|processing|building|failed|canceled|cancelled|errored)/i);
  const row = body.split('\n').find((l) => l.includes('|') && /Deploy Preview/i.test(l) && /https?:\/\//.test(l));
  const url = row?.match(/https?:\/\/[^\s)|\]]+/)?.[0] ?? body.match(NETLIFY_URL)?.[0] ?? '';
  if (!head && !url) return [];
  return [{ provider: 'netlify', name: head?.[1]?.trim() ?? '', url, state: head ? stateOf(head[2]) : 'ready' }];
}

// The previews in a PR's comments: the newest word of each bot on each of its projects.
/** @param {PrComment[]} comments */
export function previewsFromComments(comments) {
  /** @type {Map<string, PreviewItem>} */
  const found = new Map();
  const sorted = [...comments].sort((a, b) => String(a.updated_at ?? '').localeCompare(String(b.updated_at ?? '')));
  for (const c of sorted) {
    const login = String(c.user?.login ?? '').toLowerCase();
    const body = String(c.body ?? '');
    const items = login.startsWith('vercel') ? parseVercel(body) : login.startsWith('netlify') ? parseNetlify(body) : [];
    for (const item of items) found.set(`${item.provider}|${item.name}`, item);
  }
  return [...found.values()].filter((i) => i.state !== 'ignored');
}

/**
 * @param {string} a
 * @param {string} b
 */
const sameRepo = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
/**
 * @template {PrRef} P
 * @param {P[]} prs
 */
const uniquePrs = (prs) => prs.filter((p, i) => p?.repo && p.number && prs.findIndex((q) => q?.repo && sameRepo(q.repo, p.repo) && q.number === p.number) === i);

// The PRs worth reading: those of tasks still open, and of Cron runs from the last few days.
/**
 * @param {DataStore} store
 * @param {number} [at]
 */
export function trackedPrs(store, at = Date.now()) {
  const tasks = store.get('todos').items.filter((t) => statusOf(t) !== 'done').flatMap((t) => t.prs ?? []);
  const runs = (store.get('cron')?.runs ?? [])
    .filter((r) => at - Date.parse(r.at) < RUNS_WITHIN)
    .flatMap((r) => [...r.steps, ...(r.current ? [r.current] : [])])
    // The run's current terminal has neither field; stepRecord() in js/cron.js writes `pr` and never `prs`.
    .flatMap((/** @type {Partial<CronRunStep>} */ s) => s.prs?.length ? s.prs : s.pr ? [s.pr] : []);
  return uniquePrs([...tasks, ...runs]).map((p) => ({ repo: p.repo, number: p.number }));
}

// Whether a PR is due a read, from what the last one found.
/**
 * @param {PrPreviews | undefined} entry
 * @param {number} at
 */
function due(entry, at) {
  if (!entry?.at) return true;
  const since = at - entry.at;
  const items = entry.items ?? [];
  if (items.some((i) => i.state === 'building')) return since >= AGAIN_BUILDING;
  if (items.length) return since >= AGAIN_READY;
  // No bot has commented: likely a repo without previews, so it is read less and less often.
  const age = at - (entry.first ?? entry.at);
  return since >= (age < 60 * MIN ? AGAIN_BUILDING : age < 24 * 60 * MIN ? AGAIN_QUIET : AGAIN_QUIET_LONG);
}

/**
 * @param {DataStore} store
 * @param {number} [at]
 */
export const duePrs = (store, at = Date.now()) => {
  const saved = store.get(GITHUB)?.previews ?? {};
  return trackedPrs(store, at).filter((p) => due(saved[previewKey(p.repo, p.number)], at)).slice(0, PER_RUN);
};

// Reads the PRs' comments into github.json. A failed read keeps what was found before. Runners only.
/**
 * @param {DataStore} target
 * @param {PrRef[]} prs
 * @param {number} [at]
 */
export async function readPreviews(target, prs, at = Date.now()) {
  const found = await Promise.all(prs.map(async (p) => {
    /** @typedef {[PrRef, Pick<PrPreviews, 'items' | 'error'>]} Found */
    try {
      return /** @type {Found} */ ([p, { items: previewsFromComments(await issueComments(p.repo, p.number)), error: null }]);
    } catch (err) {
      return /** @type {Found} */ ([p, { error: /** @type {Error} */ (err).message }]);
    }
  }));
  const keep = new Set(trackedPrs(target, at).map((p) => previewKey(p.repo, p.number)));
  target.save(GITHUB, (d) => {
    d.previews ??= {};
    for (const [p, entry] of found) {
      const key = previewKey(p.repo, p.number);
      d.previews[key] = { ...d.previews[key], ...entry, at, first: d.previews[key]?.first ?? at };
    }
    for (const [key, entry] of Object.entries(d.previews)) {
      if (!keep.has(key) && at - (entry.at ?? 0) > KEPT) delete d.previews[key];
    }
  });
  return found.filter(([, e]) => e.error).map(([p, e]) => `${p.repo}#${p.number}: ${e.error}`);
}

// The previews of these PRs, from github.json.
/**
 * @template {PrRef} P
 * @param {DataStore} store
 * @param {P[]} prs
 */
export function previewsOf(store, prs) {
  const saved = store.get(GITHUB)?.previews ?? {};
  return uniquePrs(prs).flatMap((p) => (saved[previewKey(p.repo, p.number)]?.items ?? []).map((i) => ({ ...i, pr: p })));
}

/** @type {Set<string>} */
const asked = new Set();
// PRs github.json has never read are asked of the runners once, so a new PR does not wait for the next run.
/**
 * @param {Store} store
 * @param {PrRef[]} prs
 */
function askMissing(store, prs) {
  const saved = store.get(GITHUB)?.previews ?? {};
  const fresh = uniquePrs(prs).filter((p) => !saved[previewKey(p.repo, p.number)] && !asked.has(previewKey(p.repo, p.number)));
  if (!fresh.length) return;
  fresh.forEach((p) => asked.add(previewKey(p.repo, p.number)));
  runJob('previews', { prs: fresh.map((p) => ({ repo: p.repo, number: p.number })) }).then(() => store.sync()).catch(() => {});
}

/** @type {Record<string, string>} */
const PROVIDER = { vercel: 'Vercel', netlify: 'Netlify' };
/** @type {Record<string, string>} */
const STATE_TEXT = { building: 'building', failed: 'failed', canceled: 'canceled' };

// Links to the previews of these PRs, styled with `className` (a task's chips or a Cron run's).
/**
 * @param {Store} store
 * @param {PrRef[]} prs
 * @param {string} className
 */
export function previewChips(store, prs, className) {
  askMissing(store, prs);
  const items = previewsOf(store, prs);
  const named = items.length > 1;
  return items.map((i) => {
    const label = named && i.name ? `Preview ${i.name}` : 'Preview';
    const state = STATE_TEXT[i.state];
    const title = `${PROVIDER[i.provider] ?? 'Preview'}${i.name ? ` · ${i.name}` : ''}${state ? ` · ${state}` : ''} · ${i.pr.repo} #${i.pr.number}${i.url ? `\n${i.url}` : ''}`;
    const body = [icon('globe'), label, state ? h('span', { class: 'muted small' }, state) : null];
    return i.url
      ? h('a', { class: `${className} preview-link`, href: i.url, target: '_blank', rel: 'noopener noreferrer', title, 'aria-label': `Open the ${label.toLowerCase()} of ${i.pr.repo} #${i.pr.number}` }, body)
      : h('span', { class: `${className} preview-link muted`, title }, body);
  });
}
