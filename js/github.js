// Open issue and PR counts for public GitHub repos, read from the public REST API.
// Unauthenticated requests are limited to 60 per hour per IP, and each repo costs two
// requests. Results are cached in memory and in localStorage for 15 minutes.

const TTL_MS = 15 * 60 * 1000;
const API = 'https://api.github.com';
const memory = new Map(); // "owner/repo" -> { status: 'loading' | 'ok' | 'error', issues?, prs?, error?, at? }
let token = ''; // personal access token from settings; enables private repos and a higher rate limit

const headers = () => ({
  Accept: 'application/vnd.github+json',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

// Called on startup and whenever the token changes. Cached results may be stale for the new token, so they are dropped.
export function configure(newToken) {
  token = newToken ?? '';
  memory.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith('board:gh:')) localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked */
  }
}

// Asks GitHub who the token belongs to. Throws with a readable message when it is rejected.
export async function checkGithubToken(value) {
  const res = await fetch(`${API}/user`, {
    headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${value}` },
  });
  if (!res.ok) throw new Error(res.status === 401 ? 'GitHub rejected this token. Check that it was copied in full and has not expired.' : `GitHub error ${res.status}`);
  const user = await res.json();
  return user.login;
}

const storageKey = (repo) => `board:gh:${repo}`;

function readStored(repo) {
  try {
    const raw = localStorage.getItem(storageKey(repo));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeStored(repo, data) {
  try {
    localStorage.setItem(storageKey(repo), JSON.stringify(data));
  } catch {
    /* storage blocked: the cache is memory-only */
  }
}

function explain(status) {
  if (status === 401) return 'Token rejected. Check it in Settings';
  if (status === 404) return token ? 'Not found, or the token cannot see it' : 'Not found, or private. Add a token in Settings';
  if (status === 403 || status === 429) return 'GitHub rate limit reached, try again later';
  return `GitHub error ${status}`;
}

async function fetchStats(repo) {
  const [infoRes, pullsRes] = await Promise.all([
    fetch(`${API}/repos/${repo}`, { headers: headers() }),
    fetch(`${API}/repos/${repo}/pulls?state=open&per_page=1`, { headers: headers() }),
  ]);
  for (const res of [infoRes, pullsRes]) {
    if (!res.ok) throw new Error(explain(res.status));
  }
  const info = await infoRes.json();
  const pulls = await pullsRes.json();
  // Page count from the Link header when there are several pages, otherwise the list length.
  const last = (pullsRes.headers.get('Link') ?? '').match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/);
  const prs = last ? Number(last[1]) : pulls.length;
  // open_issues_count includes pull requests, so subtract them.
  return { issues: Math.max(0, info.open_issues_count - prs), prs };
}

// Returns the current entry at once. When it is not cached yet, a fetch starts and
// `onChange` runs when it finishes.
export function repoStats(repo, onChange) {
  const current = memory.get(repo);
  if (current) return current;

  const stored = readStored(repo);
  if (stored && Date.now() - stored.at < TTL_MS) {
    const entry = { status: 'ok', ...stored };
    memory.set(repo, entry);
    return entry;
  }

  const entry = { status: 'loading' };
  memory.set(repo, entry);
  fetchStats(repo)
    .then((data) => {
      const at = Date.now();
      memory.set(repo, { status: 'ok', at, ...data });
      writeStored(repo, { at, ...data });
    })
    .catch((err) => {
      memory.set(repo, { status: 'error', error: err.message });
    })
    .finally(() => onChange?.());
  return entry;
}

// The newest open issues and PRs of a repo, for triage. Each entry is { number, title, pr, updated, author, labels }.
export async function openItems(repo) {
  const res = await fetch(`${API}/repos/${repo}/issues?state=open&per_page=30`, { headers: headers() });
  if (!res.ok) throw new Error(explain(res.status));
  const list = await res.json();
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
const activityCache = new Map();
const ACTIVITY_TTL_MS = 10 * 60 * 1000;

// All pages of a list endpoint, up to `maxPages` pages of 100.
async function pagesOf(url, maxPages = 3) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const sep = url.includes('?') ? '&' : '?';
    const res = await fetch(`${url}${sep}per_page=100&page=${page}`, { headers: headers() });
    if (!res.ok) throw new Error(explain(res.status));
    const list = await res.json();
    out.push(...list);
    if (list.length < 100) break;
  }
  return out;
}

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

// Drops the cached copy and fetches again.
export function refreshRepo(repo, onChange) {
  memory.delete(repo);
  try {
    localStorage.removeItem(storageKey(repo));
  } catch {
    /* ignore */
  }
  return repoStats(repo, onChange);
}
