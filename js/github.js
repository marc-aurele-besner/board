// Open issue and PR counts for public GitHub repos, read from the public REST API.
// Unauthenticated requests are limited to 60 per hour per IP, and each repo costs two
// requests. Results are cached in memory and in localStorage for 15 minutes.

const TTL_MS = 15 * 60 * 1000;
const API = 'https://api.github.com/repos';
const HEADERS = { Accept: 'application/vnd.github+json' };
const memory = new Map(); // "owner/repo" -> { status: 'loading' | 'ok' | 'error', issues?, prs?, error?, at? }

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
  if (status === 404) return 'Not found, or private';
  if (status === 403 || status === 429) return 'GitHub rate limit reached, try again later';
  return `GitHub error ${status}`;
}

async function fetchStats(repo) {
  const [infoRes, pullsRes] = await Promise.all([
    fetch(`${API}/${repo}`, { headers: HEADERS }),
    fetch(`${API}/${repo}/pulls?state=open&per_page=1`, { headers: HEADERS }),
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
