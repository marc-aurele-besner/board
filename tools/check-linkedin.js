// The LinkedIn session queue (tools/linkedin-session.js) against a stubbed fetch and clock: nothing reaches LinkedIn.
// Checks the gap between calls, the daily limit, cached answers, and the stop after a sign-out.
// `node tools/check-linkedin.js`: prints each check and exits 1 when one fails.
/** @import { DataStore } from '../types/data' */
import { voyager, clock } from './linkedin-session.js';
import { linkedinCall, useLinkedinSession } from '../js/linkedin-session.js';
import { todayISO } from '../js/ui.js';

let failed = 0;
/** @param {string} name @param {boolean} ok */
const check = (name, ok) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`);
};

/** @param {Record<string, unknown>} [linkedin] @param {Record<string, unknown>} [session] */
function makeStore(linkedin = {}, session = {}) {
  /** @type {Record<string, any>} */ // any: a stand-in for the store's collections
  const data = {
    settings: { linkedin: { liAt: 'test-li-at', jsessionid: 'ajax:test', ...linkedin } },
    linkedin: { posts: [], comments: [], cache: {}, session: { calls: {}, ...session } },
    notifications: { items: [], prefs: {} },
  };
  const store = /** @type {DataStore} */ (/** @type {unknown} */ ({
    get: (/** @type {string} */ name) => data[name],
    update: (/** @type {string} */ name, /** @type {(d: any) => void} */ fn) => fn(data[name]), // any: as above
    save: (/** @type {string} */ name, /** @type {(d: any) => void} */ fn) => fn(data[name]), // any: as above
  }));
  return { store, data };
}

let fakeNow = 1_000_000_000_000;
/** @type {number[]} */
const slept = [];
clock.now = () => fakeNow;
clock.sleep = async (ms) => {
  slept.push(ms);
  fakeNow += ms;
};

/** @type {string[]} */
let calls = [];
/** @type {() => Response} */
let answer = () => new Response('{"followerCount":7}', { status: 200 });
/** @type {Record<string, string>} */
let lastHeaders = {};
globalThis.fetch = async (/** @type {string | URL | Request} */ url, /** @type {RequestInit | undefined} */ init) => {
  lastHeaders = /** @type {Record<string, string>} */ (init?.headers ?? {});
  calls.push(String(url));
  return answer();
};

/** @param {Promise<unknown>} p */
const codeOf = (p) => p.then(() => 'none', (/** @type {{ code?: string }} */ err) => err.code ?? 'plain');

// Pace: the first call waits out the last one's gap (from linkedin.json, as after a restart), the next 20 to 40 s.
{
  const { store, data } = makeStore({}, { lastCallAt: fakeNow - 5000 });
  await Promise.all([voyager(store, { path: 'a' }), voyager(store, { path: 'b' })]);
  check('two calls are made', calls.length === 2);
  check('the first waits out the gap left from before a restart', slept[0] >= 15000 && slept[0] <= 35000);
  check('the second waits 20 to 40 s', slept[1] >= 20000 && slept[1] <= 40000);
  check('calls are counted for today', data.linkedin.session.calls[todayISO()] === 2);
  check('the session cookies are sent', lastHeaders.cookie === 'li_at=test-li-at; JSESSIONID="ajax:test"' && lastHeaders['csrf-token'] === 'ajax:test');
}

// Cache: the same key is not asked twice while its answer is fresh, even when asked at once.
{
  calls = [];
  const { store, data } = makeStore();
  const [a, b] = await Promise.all([voyager(store, { path: 'c', cacheKey: 'k' }), voyager(store, { path: 'c', cacheKey: 'k' })]);
  const c = await voyager(store, { path: 'c', cacheKey: 'k' });
  check('a cached answer is reused', calls.length === 1 && JSON.stringify([a, b, c]) === JSON.stringify([{ followerCount: 7 }, { followerCount: 7 }, { followerCount: 7 }]));
  fakeNow += 8 * 24 * 3600000;
  await voyager(store, { path: 'c', cacheKey: 'k' });
  check('an answer older than maxAge is asked again', calls.length === 2 && data.linkedin.cache.k.at === fakeNow);
}

// Daily limit.
{
  calls = [];
  const { store } = makeStore({ dailyLimit: 2 });
  await voyager(store, { path: 'd1' });
  await voyager(store, { path: 'd2' });
  check('the call past the daily limit is refused', (await codeOf(voyager(store, { path: 'd3' }))) === 'limit' && calls.length === 2);
}

// Sign-out: a redirect stops every later call, and notifies once.
{
  calls = [];
  const { store, data } = makeStore();
  answer = () => new Response(null, { status: 302, headers: { location: 'https://www.linkedin.com/login' } });
  check('a redirect is a sign-out', (await codeOf(voyager(store, { path: 'e' }))) === 'signed-out');
  check('the sign-out is saved', Boolean(data.linkedin.session.expiredAt && data.linkedin.session.error));
  answer = () => new Response('{}', { status: 200 });
  check('later calls are refused without calling', (await codeOf(voyager(store, { path: 'f' }))) === 'signed-out' && calls.length === 1);
  check('one notification', data.notifications.items.filter((/** @type {{ kind: string }} */ n) => n.kind === 'linkedin').length === 1);
  data.linkedin.session.expiredAt = null;
  check('a saved session lifts the stop', (await codeOf(voyager(store, { path: 'g' }))) === 'none');
}

// A cookie that clears li_at, a 999 and a 401 are sign-outs too; a 404 is not.
for (const [name, res] of /** @type {[string, () => Response][]} */ ([
  ['a cleared li_at cookie', () => new Response('{}', { status: 200, headers: { 'set-cookie': 'li_at=delete me; Max-Age=0; Path=/' } })],
  // Response() takes no status above 599, but fetch hands LinkedIn's 999 through.
  ['a 999', () => /** @type {Response} */ (/** @type {unknown} */ ({ status: 999, ok: false, headers: new Headers(), text: async () => '' }))],
  ['a 401', () => new Response('', { status: 401 })],
])) {
  const { store } = makeStore();
  answer = res;
  check(`${name} is a sign-out`, (await codeOf(voyager(store, { path: 'h' }))) === 'signed-out');
}
{
  const { store, data } = makeStore();
  answer = () => new Response('', { status: 404 });
  const err = /** @type {{ code?: string, status?: number }} */ (await voyager(store, { path: 'i' }).catch((e) => e));
  check('a 404 is an http error with its status', err.code === 'http' && err.status === 404 && !data.linkedin.session.expiredAt);
}

// No session saved.
{
  calls = [];
  const { store } = makeStore({ liAt: '' });
  check('no session is refused without calling', (await codeOf(voyager(store, { path: 'j' }))) === 'no-session' && calls.length === 0);
}

// Shared code's entry point uses the queue the runners hand it.
{
  useLinkedinSession(voyager);
  answer = () => new Response('{"ok":1}', { status: 200 });
  const { store } = makeStore();
  check('linkedinCall goes through the queue in the runners', JSON.stringify(await linkedinCall(store, { path: 'k' })) === '{"ok":1}');
}

process.exit(failed ? 1 : 0);
