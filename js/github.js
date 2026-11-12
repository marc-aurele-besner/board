// Open issue and PR counts for GitHub repos, read from the REST API. The runners (tools/jobs/github.js) read every
// project's repos every 15 minutes into github.json: { repos: { "owner/repo": { at, issues, prs, items, error } } },
// `items` being the newest 30 open issues and PRs. The board reads that file and asks the runners for a repo it lacks.
// Unauthenticated requests are limited to 60 per hour per IP, and each repo costs three.

import { h, icon } from './ui.js';
import { runJob } from './runners.js';
/** @import { DataStore, Store, GithubItem, GithubSettings, RepoStats } from '../types/data' */

export const GITHUB = 'github';
export const GITHUB_DEFAULTS = { repos: {} };
const ITEMS_KEPT = 30;
const API = 'https://api.github.com';
/** @type {Store | null} */
let store = null;
export const useGithubStore = (/** @type {Store} */ next) => {
  store = next;
};
const saved = (/** @type {string} */ repo) => store?.get(GITHUB)?.repos?.[repo] ?? null;
// Tokens from settings: a default token for any repo, and one token per organization. An organization's
// token is used for its repos (private ones included); the default covers the rest.
/** @type {{ token: string, orgs: Record<string, string> }} */
let config = { token: '', orgs: {} };
const hasToken = () => Boolean(config.token || Object.keys(config.orgs).length);
const tokenFor = (/** @type {string} */ repo) => config.orgs[String(repo).split('/')[0].toLowerCase()] || config.token;
const headers = (/** @type {string} */ repo) => {
  const t = tokenFor(repo);
  return { Accept: 'application/vnd.github+json', ...(t ? { Authorization: `Bearer ${t}` } : {}) };
};

// The avatar of a GitHub organization (or user). github.com/<name>.png redirects to the image, so it
// costs no API request. The GitHub mark stands in when it fails to load.
/** @param {string} name @param {string} [className] */
export function orgAvatar(name, className = 'project-icon') {
  return h('img', {
    class: `${className} org-avatar`,
    src: `https://github.com/${encodeURIComponent(name)}.png?size=64`,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: (/** @type {Event} */ e) => /** @type {HTMLImageElement} */ (e.currentTarget).replaceWith(icon('github')),
  });
}

// A link to an organization, or to one of its repos ('owner/repo'), led by the owner's avatar.
/** @param {string} path */
export function githubLink(path) {
  return h('a', { class: 'gh-link', href: `https://github.com/${path}`, target: '_blank', rel: 'noopener' },
    orgAvatar(String(path).split('/')[0]),
    h('span', null, path));
}

// Called on startup and whenever a key changes. Cached results may be stale for the new keys, so they are dropped.
/** @param {GithubSettings | null | undefined} github */
export function configure(github) {
  config = {
    token: github?.token ?? '',
    orgs: Object.fromEntries((github?.orgs ?? []).filter((o) => o.org && o.token).map((o) => [o.org.toLowerCase(), o.token])),
  };
  // Earlier versions cached the counts in the browser.
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('board:gh:')) localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked, or the runners */
  }
}

// Asks GitHub who the token belongs to. Throws with a readable message when it is rejected.
/** @param {string} value @returns {Promise<string>} */
export async function checkGithubToken(value) {
  const res = await fetch(`${API}/user`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${value}` },
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'GitHub rejected this token. Check that it was copied in full and has not expired.' : `GitHub error ${res.status}`);
  const user = /** @type {{ login: string }} */ (await res.json());
  return user.login;
}

/** @param {number} status */
function explain(status) {
  if (status === 401) return 'Token rejected. Check it in Settings';
  if (status === 404) return hasToken() ? 'Not found, or the token cannot see it' : 'Not found, or private. Add a token in Settings';
  if (status === 403 || status === 429) return 'GitHub rate limit reached, try again later';
  return `GitHub error ${status}`;
}

/** @param {string} repo */
async function fetchStats(repo) {
  const [infoRes, pullsRes] = await Promise.all([
    fetch(`${API}/repos/${repo}`, { headers: headers(repo) }),
    fetch(`${API}/repos/${repo}/pulls?state=open&per_page=1`, { headers: headers(repo) }),
  ]);
  for (const res of [infoRes, pullsRes]) {
    if (!res.ok) throw new Error(explain(res.status));
  }
  const info = /** @type {{ open_issues_count: number }} */ (await infoRes.json());
  const pulls = /** @type {unknown[]} */ (await pullsRes.json());
  // Page count from the Link header when there are several pages, otherwise the list length.
  const last = (pullsRes.headers.get('Link') ?? '').match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  const prs = last ? Number(last[1]) : pulls.length;
  // open_issues_count includes pull requests, so subtract them.
  return { issues: Math.max(0, info.open_issues_count - prs), prs };
}

// Reads repos into github.json: counts and the newest open items. A failed read keeps the last counts. Runners only.
/** @param {DataStore} target @param {string[]} repos @returns {Promise<string[]>} */
export async function readRepos(target, repos) {
  const found = await Promise.all(repos.map(/** @returns {Promise<[string, RepoStats]>} */ async (repo) => {
    try {
      const [stats, items] = await Promise.all([fetchStats(repo), fetchOpenItems(repo)]);
      return [repo, { at: Date.now(), ...stats, items: items.slice(0, ITEMS_KEPT), error: null }];
    } catch (err) {
      return [repo, { error: /** @type {Error} */ (err).message, failedAt: Date.now() }];
    }
  }));
  target.save(GITHUB, (d) => {
    d.repos ??= {};
    for (const [repo, entry] of found) d.repos[repo] = { ...d.repos[repo], ...entry };
  });
  return found.filter(([, e]) => e.error).map(([repo, e]) => `${repo}: ${e.error}`);
}

/** @type {Set<string>} */
const asking = new Set();
// Asks the runners for repos github.json lacks, then reads the file again.
/** @param {string[]} repos @param {() => void} [onChange] */
function ask(repos, onChange) {
  const fresh = repos.filter((r) => !asking.has(r));
  if (!fresh.length) return;
  fresh.forEach((r) => asking.add(r));
  runJob('github', { repos: fresh })
    .then(() => store?.sync())
    .catch(() => {})
    .finally(() => {
      fresh.forEach((r) => asking.delete(r));
      onChange?.();
    });
}

// The repo's entry: { status: 'ok' | 'loading' | 'error', issues?, prs?, error?, at? }, from github.json. A repo the
// file does not hold yet is asked of the runners, and `onChange` runs once they answered.
/** @param {string} repo @param {() => void} [onChange] */
export function repoStats(repo, onChange) {
  const entry = saved(repo);
  if (entry?.at) return { status: 'ok', ...entry };
  if (entry?.error) return { status: 'error', error: entry.error };
  ask([repo], onChange);
  return { status: 'loading' };
}

// The newest open issues and PRs of a repo, for triage. Each entry is { number, title, pr, updated, author, labels }.
// From github.json when the runners read it; read here otherwise.
/** @param {string} repo @returns {Promise<GithubItem[]>} */
export async function openItems(repo) {
  return saved(repo)?.items ?? fetchOpenItems(repo);
}

/**
 * @param {string} repo
 * @returns {Promise<GithubItem[]>}
 */
async function fetchOpenItems(repo) {
  const res = await fetch(`${API}/repos/${repo}/issues?state=open&per_page=30`, { headers: headers(repo) });
  if (!res.ok) throw new Error(explain(res.status));
  const list = /** @type {ApiIssue[]} */ (await res.json());
  return list.map((i) => ({
    number: i.number,
    title: i.title,
    pr: Boolean(i.pull_request),
    updated: i.updated_at,
    author: i.user?.login ?? '',
    labels: (i.labels ?? []).map((l) => l.name),
  }));
}

// Commits, pull requests and issues of a repo since a date, for the Monitoring tab. Cached for 10 minutes.
/** @type {Map<string, { at: number, data: RepoActivity }>} */
const activityCache = new Map();
const ACTIVITY_TTL_MS = 10 * 60 * 1000;
/**
 * @typedef {object} RepoActivity
 * @property {{ at: string, author: string }[]} commits
 * @property {{ created: string, merged: string | null, closed: string | null, updated: string, state: string, author: string }[]} pulls
 * @property {{ created: string, closed: string | null, state: string }[]} issues
 */
/** An issue or PR as the issues endpoint returns it; only the fields read here. @typedef {{ number: number, title: string, pull_request?: object, updated_at: string, user?: { login: string } | null, labels?: { name: string }[] }} ApiIssue */

// All pages of a list endpoint, up to `maxPages` pages of 100.
/** @param {string} url @param {number} [maxPages] @returns {Promise<any[]>} any: each endpoint's items differ; the callers read their own fields */
async function pagesOf(url, maxPages = 3) {
  const repo = url.match(/repos\/([^/]+\/[^/?]+)/)?.[1] ?? '';
  /** @type {unknown[]} */
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}per_page=100&page=${page}`, { headers: headers(repo) });
    if (!res.ok) throw new Error(explain(res.status));
    const list = /** @type {unknown[]} */ (await res.json());
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

/** @param {string} repo @param {string} since ISO date @returns {Promise<RepoActivity>} */
export async function fetchActivity(repo, since) {
  const key = `${repo}|${since}`;
  const hit = activityCache.get(key);
  if (hit && Date.now() - hit.at < ACTIVITY_TTL_MS) return hit.data;
  const [commits, pulls, issues] = await Promise.all([
    pagesOf(`${API}/repos/${repo}/commits?since=${encodeURIComponent(since)}`),
    pagesOf(`${API}/repos/${repo}/pulls?state=all&sort=updated&direction=desc`),
    pagesOf(`${API}/repos/${repo}/issues?state=all&since=${encodeURIComponent(since)}`),
  ]);
  const data = {
    commits: commits
      .map((c) => ({ at: c.commit?.author?.date, author: c.author?.login || c.commit?.author?.name || 'unknown' }))
      .filter((c) => c.at),
    pulls: pulls.map((p) => ({
      created: p.created_at,
      merged: p.merged_at,
      closed: p.closed_at,
      updated: p.updated_at,
      state: p.state,
      author: p.user?.login ?? '',
    })),
    issues: issues
      .filter((i) => !i.pull_request)
      .map((i) => ({ created: i.created_at, closed: i.closed_at, state: i.state })),
  };
  activityCache.set(key, { at: Date.now(), data });
  return data;
}

// A repo's description, topics, languages, README and top-level file list, to understand what it is.
// `contentAccess` is false when GitHub would not show the files (the token needs Contents: Read-only).
const decodeBase64Utf8 = (/** @type {string} */ b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s+/g, '')), (c) => c.charCodeAt(0)));

/** @param {string} repo */
export async function fetchRepoOverview(repo) {
  const get = (/** @type {string} */ path) => fetch(`${API}/repos/${repo}${path}`, { headers: headers(repo) });
  const [info, languages, readme, contents] = await Promise.all([get(''), get('/languages'), get('/readme'), get('/contents')]);
  if (!info.ok) throw new Error(explain(info.status));
  const meta = /** @type {{ description?: string | null, topics?: string[], default_branch?: string, pushed_at?: string }} */ (await info.json());
  const languageNames = languages.ok ? Object.keys(await languages.json()) : [];
  const readmeText = readme.ok ? decodeBase64Utf8(/** @type {{ content?: string }} */ (await readme.json()).content ?? '') : '';
  const files = contents.ok ? /** @type {{ name: string, type: string }[]} */ (await contents.json()).map((f) => ({ name: f.name, type: f.type })) : [];
  return {
    description: meta.description ?? '',
    topics: meta.topics ?? [],
    languages: languageNames,
    defaultBranch: meta.default_branch ?? '',
    pushedAt: meta.pushed_at ?? '',
    readme: readmeText.slice(0, 12000),
    files: files.slice(0, 80),
    contentAccess: readme.ok || contents.ok,
  };
}

// Asks the runners to read the repo again now.
/** @param {string} repo @param {() => void} [onChange] */
export function refreshRepo(repo, onChange) {
  ask([repo], onChange);
  return { status: 'loading', ...(saved(repo) ?? {}) };
}

// Opens an issue in a repo. Needs a token that can write issues for the repo's owner (Issues: Read and write).
/** @param {string} repo @param {string} title @param {string} body */
export async function createIssue(repo, title, body) {
  const res = await fetch(`${API}/repos/${repo}/issues`, {
    method: 'POST',
    headers: { ...headers(repo), 'Content-Type': 'application/json' },
    body: JSON.stringify({ title, body }),
  });
  if (res.status === 403 || res.status === 404) {
    throw new Error('GitHub refused to create the issue. The token needs Issues: Read and write for this repo.');
  }
  if (!res.ok) throw new Error(explain(res.status));
  const issue = /** @type {{ number: number, html_url: string, title: string }} */ (await res.json());
  return { repo, number: issue.number, url: issue.html_url, title: issue.title };
}

// An existing issue of a repo, as a link a task can keep.
/** @param {string} repo @param {number | string} number */
export async function getIssue(repo, number) {
  const res = await fetch(`${API}/repos/${repo}/issues/${number}`, { headers: headers(repo) });
  if (!res.ok) throw new Error(res.status === 404 ? `Issue #${number} was not found in ${repo}.` : explain(res.status));
  const issue = /** @type {{ number: number, html_url: string, title: string }} */ (await res.json());
  return { repo, number: issue.number, url: issue.html_url, title: issue.title };
}

// Whether an issue or a PR is open, merged or closed: the fields of GitHub's answer that tell.
/** @typedef {{ state?: string, state_reason?: string | null, pull_request?: { merged_at?: string | null } }} IssueState */
/** @param {string} repo @param {number | string} number @returns {Promise<IssueState>} */
export async function issueState(repo, number) {
  const res = await fetch(`${API}/repos/${repo}/issues/${number}`, { headers: headers(repo) });
  if (!res.ok) throw new Error(explain(res.status));
  const { state, state_reason, pull_request } = await res.json();
  return { state, state_reason, pull_request };
}

// The comments of an issue or a PR's conversation: the first 100, and the last 100 when there are more pages.
/** A comment as GitHub returns it; only the fields read. @typedef {{ body?: string | null, updated_at?: string, user?: { login?: string } | null }} IssueComment */
/** @param {string} repo @param {number | string} number @returns {Promise<IssueComment[]>} */
export async function issueComments(repo, number) {
  const url = `${API}/repos/${repo}/issues/${number}/comments?per_page=100`;
  const res = await fetch(url, { headers: headers(repo) });
  if (!res.ok) throw new Error(explain(res.status));
  const first = /** @type {IssueComment[]} */ (await res.json());
  const last = (res.headers.get('Link') ?? '').match(/<([^>]+)>;\s*rel="last"/)?.[1];
  if (!last) return first;
  const more = await fetch(last, { headers: headers(repo) });
  return more.ok ? [...first, .../** @type {IssueComment[]} */ (await more.json())] : first;
}
