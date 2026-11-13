// The saved LinkedIn session's call queue, run by the runners only: the contract is at the top of js/linkedin-session.js.
// One call at a time, 20 to 40 s apart, a daily limit, answers kept in linkedin.json's cache, and a full stop once
// LinkedIn signs the session out, since calling on would only look more like a bot.
/** @import { DataStore } from '../types/data' */
/** @import { LinkedinRequest } from '../js/linkedin-session.js' */
import { LINKEDIN } from '../js/linkedin-core.js';
import { notify } from '../js/notify-core.js';
import { todayISO } from '../js/ui.js';
import { LinkedinSessionError, sessionCookies, dailyLimit, DEFAULT_MAX_AGE } from '../js/linkedin-session.js';

const BASE = 'https://www.linkedin.com/voyager/api/';
// LinkedIn answers a browser, not a script.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
const DAY_MS = 24 * 3600000;
// Answers and day counts older than this are dropped.
const KEEP_MS = 30 * DAY_MS;

// Swapped by tools/check-linkedin.js so the test does not wait 20 s a call.
export const clock = {
  gapMin: 20000,
  gapMax: 40000,
  now: () => Date.now(),
  /** @param {number} ms @param {AbortSignal} [signal] @returns {Promise<void>} */
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    }, { once: true });
  }),
};

/** @type {Promise<unknown>} */
let chain = Promise.resolve();
let pending = 0;
let nextAt = 0;
// One call per cache key at a time: a second ask for the same answer waits for the first.
/** @type {Map<string, Promise<unknown>>} */
const inFlight = new Map();

export const queueState = () => ({ pending, nextAt: pending ? nextAt || clock.now() : null });

/** @param {DataStore} store @param {string | undefined} key @param {number} maxAge */
function cached(store, key, maxAge) {
  if (!key || maxAge <= 0) return undefined;
  const hit = store.get(LINKEDIN).cache?.[key];
  return hit && clock.now() - hit.at < maxAge ? hit : undefined;
}

// Throws when no call may be made now: no session, signed out, or today's limit reached.
/** @param {DataStore} store */
function guard(store) {
  const saved = store.get('settings').linkedin;
  const cookies = sessionCookies(saved);
  if (!cookies) throw new LinkedinSessionError('no-session', 'No LinkedIn session is saved. Add li_at and JSESSIONID in Settings → LinkedIn.');
  const session = store.get(LINKEDIN).session ?? { calls: {} };
  if (session.expiredAt) {
    throw new LinkedinSessionError('signed-out', `LinkedIn signed the session out${session.error ? ` (${session.error})` : ''}. Save li_at and JSESSIONID again in Settings → LinkedIn.`);
  }
  const limit = dailyLimit(saved);
  if ((session.calls?.[todayISO()] ?? 0) >= limit) {
    throw new LinkedinSessionError('limit', `Today’s ${limit} LinkedIn session calls are used. The limit is in Settings → LinkedIn.`);
  }
  return cookies;
}

// LinkedIn ends a session with a redirect to its sign-in page, a 401, its 999 bot wall, or a cookie that clears li_at.
/** @param {Response} res */
function signedOut(res) {
  if (res.status === 401 || res.status === 999 || (res.status >= 300 && res.status < 400)) return `LinkedIn answered ${res.status}`;
  const cookies = res.headers.getSetCookie?.() ?? [res.headers.get('set-cookie') ?? ''];
  const cleared = cookies.some((c) => {
    const m = c.match(/(?:^|,\s*)li_at=([^;]*)(.*)/i);
    return m && (!m[1].replace(/"/g, '').trim() || /delete/i.test(m[1]) || /max-age=0\b/i.test(m[2]) || /expires=[^;]*1970/i.test(m[2]));
  });
  return cleared ? 'LinkedIn cleared the li_at cookie' : '';
}

/** @param {DataStore} store @param {string} reason */
function expire(store, reason) {
  const at = clock.now();
  store.update(LINKEDIN, (d) => {
    d.session ??= { calls: {} };
    d.session.expiredAt = at;
    d.session.error = reason;
  });
  notify(store, {
    kind: 'linkedin',
    text: `LinkedIn signed the board’s session out (${reason}). Session reads are stopped until li_at and JSESSIONID are saved again in Settings → LinkedIn.`,
    href: '#/settings?section=linkedin',
    key: `linkedin-signed-out:${at}`,
  });
}

/** @param {DataStore} store @param {LinkedinRequest} req */
async function call(store, req) {
  const cookies = guard(store);
  const { lastCallAt = 0 } = store.get(LINKEDIN).session ?? {};
  const gap = clock.gapMin + Math.random() * (clock.gapMax - clock.gapMin);
  nextAt = Math.max(clock.now(), lastCallAt + gap);
  if (nextAt > clock.now()) await clock.sleep(nextAt - clock.now(), req.signal);
  // Checked again: the session may have been signed out, or the day used up, while this call waited.
  guard(store);
  req.signal?.throwIfAborted();
  const at = clock.now();
  const today = todayISO();
  store.update(LINKEDIN, (d) => {
    d.session ??= { calls: {} };
    d.session.calls ??= {};
    d.session.calls[today] = (d.session.calls[today] ?? 0) + 1;
    d.session.lastCallAt = at;
    const oldest = new Date(at - KEEP_MS).toISOString().slice(0, 10);
    for (const day of Object.keys(d.session.calls)) if (day < oldest) delete d.session.calls[day];
  });
  const res = await fetch(`${BASE}${req.path.replace(/^\/+/, '')}`, {
    method: req.method ?? 'GET',
    headers: {
      'user-agent': UA,
      accept: 'application/json',
      'accept-language': 'en-US,en;q=0.9',
      'x-restli-protocol-version': '2.0.0',
      'x-li-lang': 'en_US',
      ...req.headers,
      cookie: `li_at=${cookies.liAt}; JSESSIONID="${cookies.jsessionid}"`,
      'csrf-token': cookies.jsessionid,
    },
    redirect: 'manual',
    signal: req.signal,
  });
  const out = signedOut(res);
  if (out) {
    expire(store, out);
    throw new LinkedinSessionError('signed-out', `${out}: the session is signed out. Save li_at and JSESSIONID again in Settings → LinkedIn.`, res.status);
  }
  if (!res.ok) throw new LinkedinSessionError('http', res.status === 404 ? 'LinkedIn has no such page (404).' : `LinkedIn answered ${res.status}.`, res.status);
  const text = await res.text();
  const value = text.trim() ? JSON.parse(text) : null;
  if (req.cacheKey) {
    const key = req.cacheKey;
    store.update(LINKEDIN, (d) => {
      d.cache ??= {};
      d.cache[key] = { at: clock.now(), value };
      for (const [k, entry] of Object.entries(d.cache)) if (clock.now() - entry.at > KEEP_MS) delete d.cache[k];
    });
  }
  return value;
}

// The queue: see js/linkedin-session.js for the contract. The worker hands it to useLinkedinSession at startup.
/** @param {DataStore} store @param {LinkedinRequest} req @returns {Promise<unknown>} */
export function voyager(store, req) {
  const maxAge = req.maxAge ?? DEFAULT_MAX_AGE;
  const hit = cached(store, req.cacheKey, maxAge);
  if (hit) return Promise.resolve(hit.value);
  // Failing fast: no point waiting in the queue to learn the session is gone.
  try {
    guard(store);
  } catch (err) {
    return Promise.reject(err);
  }
  const key = req.cacheKey;
  const same = key && maxAge > 0 ? inFlight.get(key) : undefined;
  if (same) return same;
  pending += 1;
  const turn = chain.then(() => {
    // An answer saved by a call that was ahead in the queue.
    const late = cached(store, key, maxAge);
    return late ? late.value : call(store, req);
  }).finally(() => {
    pending -= 1;
    if (key && inFlight.get(key) === turn) inFlight.delete(key);
  });
  chain = turn.catch(() => {});
  if (key && maxAge > 0) inFlight.set(key, turn);
  return turn;
}
