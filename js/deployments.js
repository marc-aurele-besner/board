// A PR's preview deployments read straight from Vercel and Netlify, with the tokens of Settings → Vercel and Netlify.
// The bots' PR comments (js/previews.js) give a link and a rough state; the APIs add the deployment itself: its exact
// state, the commit, when it started and finished, why it failed, its page on the provider, and its build log.
// The runners call this to fill github.json `previews`; the board calls it for a build log.
// Both APIs answer browsers (CORS), except Netlify's build log: it streams over a WebSocket that only Netlify's CLI
// documents, so the board asks the runners for it (GET /previews/log/netlify/<site>/<deploy>).
import { workerCall } from './runners.js';
/** @import { DataStore, PreviewItem } from '../types/data' */
/** @typedef {{ vercel: string, netlify: string }} DeployTokens */
/** @typedef {{ at: number, text: string, level: string }} LogLine */
/** @typedef {{ lines: LogLine[], truncated: boolean }} DeployLog */

const VERCEL = 'https://api.vercel.com';
const NETLIFY = 'https://api.netlify.com/api/v1';
const NETLIFY_LOGS = 'wss://socketeer.services.netlify.com/build/logs';
// Which projects a repo deploys to changes rarely, so it is looked up again only this often.
const PROJECTS_FOR = 30 * 60000;
const MAX_LINES = 5000;
// Netlify replays a finished build's log and then closes; this stops a socket that never does.
const LOG_TIMEOUT = 30000;

/** @param {DataStore} store @returns {DeployTokens} */
export const deployTokens = (store) => {
  const s = store.get('settings');
  return { vercel: s.vercel?.token?.trim() ?? '', netlify: s.netlify?.token?.trim() ?? '' };
};
/** @param {DataStore} store */
export const hasDeployTokens = (store) => Object.values(deployTokens(store)).some(Boolean);

/**
 * @param {string} name
 * @param {number} status
 */
const explain = (name, status) =>
  status === 401 || status === 403 ? `${name} rejected the token. Check it in Settings → ${name}.`
    : status === 429 ? `${name} asks to slow down (rate limit). The next read tries again.`
      : `${name} error ${status}`;

/**
 * @param {string} token
 * @param {string} path
 * @param {Record<string, string | number | undefined>} [query]
 */
async function vercel(token, path, query = {}) {
  const url = new URL(VERCEL + path);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(explain('Vercel', res.status)), { status: res.status });
  return res.json();
}

/**
 * @param {string} token
 * @param {string} path
 */
async function netlify(token, path) {
  const res = await fetch(NETLIFY + path, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw Object.assign(new Error(explain('Netlify', res.status)), { status: res.status });
  return res.json();
}

// Settings' Test buttons: who the token belongs to.
/** @param {string} token */
export async function checkVercel(token) {
  const { user } = await vercel(token, '/v2/user');
  const { teams = [] } = await vercel(token, '/v2/teams', { limit: 100 }).catch(() => ({}));
  return `Connected as ${user?.username ?? user?.email ?? 'your account'}${teams.length ? `, with ${teams.length} team${teams.length === 1 ? '' : 's'}` : ''}.`;
}
/** @param {string} token */
export async function checkNetlify(token) {
  const user = await netlify(token, '/user');
  return `Connected as ${user?.full_name || user?.slug || user?.email || 'your account'}.`;
}

// --- Which projects a repo deploys to ---

/** @typedef {{ id: string, name: string, team?: string }} VercelProject */
/** @typedef {{ id: string, name: string }} NetlifySite */
/** @type {Map<string, { at: number, token: string, projects: VercelProject[] }>} */
const vercelProjects = new Map();
/** @type {{ at: number, token: string, sites: Map<string, NetlifySite[]> } | null} */
let netlifySites = null;

const lower = (/** @type {unknown} */ s) => String(s ?? '').toLowerCase();

// The Vercel projects linked to a GitHub repo, in the personal account and every team the token reaches.
/** @param {string} token @param {string} repo @param {number} at */
async function vercelProjectsOf(token, repo, at) {
  const key = lower(repo);
  const cached = vercelProjects.get(key);
  if (cached && cached.token === token && at - cached.at < PROJECTS_FOR) return cached.projects;
  const { teams = [] } = await vercel(token, '/v2/teams', { limit: 100 });
  const scopes = [undefined, ...teams.map((/** @type {{ id: string }} */ t) => t.id)];
  const [org, name] = key.split('/');
  /** @type {VercelProject[]} */
  const projects = [];
  let failures = 0;
  for (const team of scopes) {
    try {
      const answer = await vercel(token, '/v10/projects', { repoUrl: `https://github.com/${repo}`, limit: 100, teamId: team });
      for (const p of answer.projects ?? []) {
        // The repoUrl filter is the API's; the link check keeps a project of another repo out if it is ever ignored.
        if (lower(p.link?.org) === org && lower(p.link?.repo) === name) projects.push({ id: p.id, name: p.name, team });
      }
    } catch (err) {
      // A token scoped to one team cannot read the personal account; that alone is not a failure.
      if (/** @type {{ status?: number }} */ (err).status !== 403) throw err;
      failures++;
    }
  }
  if (failures === scopes.length) throw new Error(explain('Vercel', 403));
  vercelProjects.set(key, { at, token, projects });
  return projects;
}

// Every Netlify site the token reaches, by the GitHub repo it builds.
/** @param {string} token @param {string} repo @param {number} at */
async function netlifySitesOf(token, repo, at) {
  if (!netlifySites || netlifySites.token !== token || at - netlifySites.at >= PROJECTS_FOR) {
    /** @type {Map<string, NetlifySite[]>} */
    const sites = new Map();
    for (let page = 1; page <= 20; page++) {
      const list = await netlify(token, `/sites?filter=all&per_page=100&page=${page}`);
      for (const s of list) {
        const path = lower(s.build_settings?.repo_path);
        if (path) sites.set(path, [...(sites.get(path) ?? []), { id: s.id, name: s.name }]);
      }
      if (list.length < 100) break;
    }
    netlifySites = { at, token, sites };
  }
  return netlifySites.sites.get(lower(repo)) ?? [];
}

// Whether the token reaches a project that builds this repo, so the PR's branch is worth reading.
/** @param {DeployTokens} tokens @param {string} repo @param {number} [at] */
export async function deploysRepo(tokens, repo, at = Date.now()) {
  const [v, n] = await Promise.all([
    tokens.vercel ? vercelProjectsOf(tokens.vercel, repo, at) : [],
    tokens.netlify ? netlifySitesOf(tokens.netlify, repo, at) : [],
  ]);
  return v.length + n.length > 0;
}

// --- A PR's newest deployment ---

/** @type {Record<string, string>} */
const VERCEL_STATE = { QUEUED: 'queued', INITIALIZING: 'building', BUILDING: 'building', READY: 'ready', ERROR: 'failed', BLOCKED: 'failed', CANCELED: 'canceled' };
/** @type {Record<string, string>} */
const NETLIFY_STATE = {
  new: 'queued', enqueued: 'queued', pending_review: 'queued',
  building: 'building', uploading: 'building', uploaded: 'building', preparing: 'building', prepared: 'building', processing: 'building', processed: 'building', retrying: 'building', accepted: 'building',
  ready: 'ready', error: 'failed', rejected: 'canceled', canceled: 'canceled', cancelled: 'canceled',
};

/** @param {string | null | undefined} iso */
const ms = (iso) => (iso ? Date.parse(iso) || undefined : undefined);

// Drops the fields an API left empty, so github.json keeps only what is known.
/** @param {PreviewItem} item @returns {PreviewItem} */
const compact = (item) => /** @type {PreviewItem} */ (Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined && v !== null && v !== '')));

/** @param {string} token @param {VercelProject} p @param {number} number @param {string} branch */
async function vercelDeployment(token, p, number, branch) {
  const { deployments = [] } = await vercel(token, '/v7/deployments', { projectId: p.id, branch, limit: branch ? 10 : 50, teamId: p.team });
  const ofPr = (/** @type {{ meta?: Record<string, string> }} */ d) => String(d.meta?.githubPrId ?? '') === String(number);
  const d = deployments.find(ofPr) ?? (branch ? deployments.find((/** @type {{ target?: string | null }} */ x) => x.target !== 'production') : null);
  if (!d || d.readyState === 'DELETED') return null;
  return compact({
    provider: 'vercel',
    name: p.name,
    url: d.url ? `https://${d.url}` : '',
    state: VERCEL_STATE[d.readyState ?? d.state] ?? '',
    id: d.uid,
    team: p.team,
    inspect: d.inspectorUrl ?? undefined,
    error: d.errorMessage ?? undefined,
    sha: d.meta?.githubCommitSha,
    created: d.created ?? d.createdAt,
    ready: d.readyState === 'READY' ? d.ready : undefined,
  });
}

/** @param {string} token @param {NetlifySite} site @param {number} number @param {string} branch */
async function netlifyDeploy(token, site, number, branch) {
  const list = await netlify(token, `/sites/${site.id}/deploys?per_page=${branch ? 10 : 50}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`);
  const d = list.find((/** @type {{ review_id?: number }} */ x) => x.review_id === number)
    ?? (branch ? list.find((/** @type {{ context?: string }} */ x) => x.context !== 'production') : null);
  if (!d) return null;
  const state = d.skipped ? 'canceled' : NETLIFY_STATE[d.state] ?? '';
  return compact({
    provider: 'netlify',
    name: d.name ?? site.name,
    url: d.deploy_ssl_url ?? d.deploy_url ?? '',
    state,
    id: d.id,
    site: site.id,
    inspect: d.admin_url ? `${d.admin_url}/deploys/${d.id}` : undefined,
    error: d.error_message ?? undefined,
    sha: d.commit_ref ?? undefined,
    created: ms(d.created_at),
    ready: state === 'ready' ? ms(d.published_at) ?? ms(d.updated_at) : undefined,
  });
}

// The newest deployment of a PR on each project of its repo. `branch` is the PR's head branch; without it the
// recent deployments are searched for the PR's number.
/** @param {DeployTokens} tokens @param {string} repo @param {number} number @param {string} branch @param {number} [at] */
export async function prDeployments(tokens, repo, number, branch, at = Date.now()) {
  const [v, n] = await Promise.all([
    tokens.vercel ? vercelProjectsOf(tokens.vercel, repo, at) : [],
    tokens.netlify ? netlifySitesOf(tokens.netlify, repo, at) : [],
  ]);
  const found = await Promise.all([
    ...v.map((p) => vercelDeployment(tokens.vercel, p, number, branch)),
    ...n.map((s) => netlifyDeploy(tokens.netlify, s, number, branch)),
  ]);
  return {
    items: /** @type {PreviewItem[]} */ (found.filter(Boolean)),
    // A provider with a project for this repo answers for it, even with no deployment yet: its comments are not read.
    providers: [...(v.length ? ['vercel'] : []), ...(n.length ? ['netlify'] : [])],
  };
}

// --- Build logs ---

/** @param {LogLine[]} lines @returns {DeployLog} */
const capped = (lines) => ({ lines: lines.slice(-MAX_LINES), truncated: lines.length > MAX_LINES });

// A Vercel build's log: its events, oldest first.
/** @param {string} token @param {PreviewItem} item */
async function vercelLog(token, item) {
  const events = await vercel(token, `/v3/deployments/${encodeURIComponent(String(item.id))}/events`, { builds: 1, direction: 'forward', limit: -1, teamId: item.team });
  /** @type {LogLine[]} */
  const lines = [];
  for (const e of Array.isArray(events) ? events : []) {
    const text = String(e.text ?? e.payload?.text ?? '');
    if (!text || e.type === 'delimiter' || e.type === 'deployment-state') continue;
    const level = e.type === 'stderr' || e.type === 'fatal' || e.level === 'error' ? 'error' : e.level === 'warning' ? 'warn' : e.type === 'command' ? 'command' : '';
    lines.push({ at: Number(e.date ?? e.payload?.date ?? e.created) || 0, text, level });
  }
  return capped(lines);
}

// A Netlify build's log, over the socket Netlify's CLI reads it from: it replays the log, then closes once the build
// has ended. Runners only: it needs Node's WebSocket (Bun, or Node 22) and the token.
/** @param {string} token @param {string} site @param {string} id @returns {Promise<DeployLog>} */
export function netlifyLog(token, site, id) {
  const Socket = globalThis.WebSocket;
  if (!Socket) return Promise.reject(new Error('Reading a Netlify log needs the runners started with Bun (bun start) or Node 22.'));
  return new Promise((resolve, reject) => {
    /** @type {LogLine[]} */
    const lines = [];
    const ws = new Socket(NETLIFY_LOGS);
    let settled = false;
    /** @param {Error} [err] */
    const finish = (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { ws.close(); } catch { /* already closed */ }
      if (err && !lines.length) reject(err);
      else resolve(capped(lines));
    };
    const timer = setTimeout(() => finish(), LOG_TIMEOUT);
    ws.onopen = () => ws.send(JSON.stringify({ deploy_id: id, site_id: site, access_token: token }));
    ws.onmessage = (/** @type {MessageEvent} */ e) => {
      let m;
      try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m?.type === 'report' && m.section === 'building') return finish();
      const text = String(m?.message ?? m?.log ?? '');
      if (!text) return;
      const level = lower(m.level) === 'error' ? 'error' : lower(m.level).startsWith('warn') ? 'warn' : '';
      lines.push({ at: Number(m.ts) || Date.parse(m.ts) || 0, text, level });
    };
    ws.onerror = () => finish(new Error('Netlify’s log stream could not be reached.'));
    ws.onclose = () => finish();
  });
}

// A deployment's build log, for the board: Vercel's straight from its API, Netlify's through the runners.
/** @param {DataStore} store @param {PreviewItem} item @returns {Promise<DeployLog>} */
export async function deployLog(store, item) {
  if (!item.id) throw new Error('This preview was found in a PR comment, so its log is not known. Add a token in Settings to read it.');
  if (item.provider === 'vercel') {
    const { vercel: token } = deployTokens(store);
    if (!token) throw new Error('Add a Vercel token in Settings → Vercel to read the log.');
    return vercelLog(token, item);
  }
  if (!item.site) throw new Error('This deploy has no site.');
  return /** @type {Promise<DeployLog>} */ (workerCall('GET', `/previews/log/netlify/${encodeURIComponent(item.site)}/${encodeURIComponent(item.id)}`, null, LOG_TIMEOUT + 15000));
}
