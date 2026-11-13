// The LinkedIn session queue (tools/linkedin-session.js) against a stubbed fetch and clock: nothing reaches LinkedIn.
// Checks the gap between calls, the daily limit, cached answers, and the stop after a sign-out.
// `node tools/check-linkedin.js`: prints each check and exits 1 when one fails.
/** @import { DataStore } from '../types/data' */
import { voyager, clock } from './linkedin-session.js';
import { linkedinCall, useLinkedinSession } from '../js/linkedin-session.js';
import { todayISO } from '../js/ui.js';
import { dueStep, parsePostCounts, parseComments } from '../js/linkedin-reads.js';
import linkedinMetrics from './jobs/linkedin-metrics.js';
import linkedinComments from './jobs/linkedin-comments.js';

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
// What fn throws, or null.
/** @param {() => unknown} fn @returns {unknown} */
const thrown = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err;
  }
};

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

// Post results (tools/jobs/linkedin-metrics.js): which read is due, how an answer is read, and a run's calls.
{
  const H = 3600000;
  const at = Date.now();
  /** @param {number} hoursAgo @param {number[]} [reads] hours after posting */
  const post = (hoursAgo, reads = []) => ({
    id: `p${hoursAgo}`, text: 'First line\nmore', status: 'posted', createdAt: 0, urn: `urn:li:share:${hoursAgo}`, postedAt: at - hoursAgo * H,
    metrics: reads.map((r) => ({ at: at - hoursAgo * H + r * H, reactions: 1 })),
  });
  check('no read before an hour', dueStep(post(0.5), at) === null);
  check('the 1-hour read is due', dueStep(post(2), at) === '1h');
  check('a step read once is not read again', dueStep(post(3, [1.2]), at) === null);
  check('the 24-hour read is due', dueStep(post(30, [1.2]), at) === '24h');
  check('after a sleep only the latest step is read', dueStep(post(240), at) === '7d');
  check('a 7-day read ends the reads', dueStep(post(400, [1, 24, 170]), at) === null);
  check('an old post is not read on schedule', dueStep(post(40 * 24), at) === null);
  check('a draft is not read', dueStep({ ...post(2), status: 'draft' }, at) === null);

  const m = parsePostCounts({ data: { totalSocialActivityCounts: { numLikes: 5, numComments: 2, numShares: 1, numImpressions: 300 } } }, at);
  check('counts are read from a nested answer', m.reactions === 5 && m.comments === 2 && m.reposts === 1 && m.impressions === 300);
  const sum = parsePostCounts({ reactionTypeCounts: [{ count: 3 }, { count: 4 }], numComments: 0 }, at);
  check('reactions add up from their types', sum.reactions === 7 && sum.comments === 0 && sum.impressions === undefined);
  check('an answer without counts is a readable error', /no reaction, comment or repost count/.test(String(/** @type {Error} */ (thrown(() => parsePostCounts({ elements: [] }))).message)));

  calls = [];
  answer = () => new Response('{"numLikes":9,"numComments":1,"numShares":0}', { status: 200 });
  const { store, data } = makeStore();
  data.linkedin.posts = [post(2), post(30, [1]), post(200), post(250), post(300), post(0.2)];
  const ctx = /** @type {any} */ ({ store, params: {}, signal: new AbortController().signal, force: false }); // any: a stand-in for the job's context
  const result = await linkedinMetrics.run(ctx);
  check('a run reads at most 4 posts', calls.length === 4 && result.read === 4);
  check('each read is added to its post', data.linkedin.posts[0].metrics.length === 1 && data.linkedin.posts[0].metrics[0].reactions === 9);
  check('the next run reads what is left, then nothing', (await linkedinMetrics.run(ctx)).read === 1 && (await linkedinMetrics.run(ctx)).read === 0 && calls.length === 5);

  calls = [];
  const limited = makeStore({ dailyLimit: 0 });
  limited.data.linkedin.posts = [post(2)];
  const out = await linkedinMetrics.run(/** @type {any} */ ({ ...ctx, store: limited.store })); // any: as above
  check('the daily limit stops a run without a call or an error', calls.length === 0 && Boolean(out.waiting) && !limited.data.linkedin.posts[0].metrics.length);
}

// Comments (tools/jobs/linkedin-comments.js): the shapes read, dedupe, the member's own replies, the notification.
{
  const normalized = {
    data: { elements: ['urn:li:fsd_comment:(1,urn:li:activity:9)'] },
    included: [
      { entityUrn: 'urn:li:fsd_comment:(1,urn:li:activity:9)', commentary: { text: 'Great point!' }, createdAt: 1700000000000, commenter: { title: { text: 'Sam Example' }, subtitle: 'Head of Growth', navigationUrl: 'https://www.linkedin.com/in/sam-example/' } },
    ],
  };
  const rest = { elements: [{ urn: 'urn:li:comment:(urn:li:activity:9,2)', message: { text: 'How long did it take?' }, created: { time: 1700000100000 }, commenter: 'urn:li:fs_miniProfile:x' }], included: [{ entityUrn: 'urn:li:fs_miniProfile:x', firstName: 'Alex', lastName: 'Example', occupation: 'Writer', publicIdentifier: 'alex-example' }] };
  const a = parseComments(normalized);
  check('a dash comment is read with its author and headline', a.length === 1 && a[0].author === 'Sam Example' && a[0].authorHeadline === 'Head of Growth' && a[0].at === 1700000000000);
  const b = parseComments(rest);
  check('a REST comment finds its author through the profile it points at', b.length === 1 && b[0].author === 'Alex Example' && b[0].authorUrl === 'https://www.linkedin.com/in/alex-example/' && b[0].text === 'How long did it take?');
  check('an answer without comments reads as none', parseComments({ elements: [], paging: { total: 0 } }).length === 0);

  // The job dates its reads by the cache entries, on the real clock.
  fakeNow = Date.now();
  calls = [];
  answer = () => new Response(JSON.stringify({ ...normalized, included: [...normalized.included, { entityUrn: 'urn:li:fsd_comment:(3,urn:li:activity:9)', commentary: { text: 'Thanks!' }, commenter: { title: { text: 'Me Myself' } } }] }), { status: 200 });
  const { store, data } = makeStore();
  data.linkedin.auth = { name: 'Me Myself' };
  const recent = Date.now() - 3 * 3600000;
  data.linkedin.posts = [
    { id: 'q1', text: 'One', status: 'posted', urn: 'urn:li:share:1', postedAt: recent, createdAt: 0 },
    { id: 'q2', text: 'Old', status: 'posted', urn: 'urn:li:share:2', postedAt: Date.now() - 20 * 86400000, createdAt: 0 },
  ];
  const ctx = /** @type {any} */ ({ store, params: {}, signal: new AbortController().signal, force: false }); // any: a stand-in for the job's context
  const first = await linkedinComments.run(ctx);
  check('only recent posts are read, once each', calls.length === 1 && first.added === 1);
  check('a new comment is saved unread, the member’s own reply read', data.linkedin.comments.length === 2
    && data.linkedin.comments.find((/** @type {{ author: string }} */ c) => c.author === 'Sam Example').read === false
    && data.linkedin.comments.find((/** @type {{ author: string }} */ c) => c.author === 'Me Myself').read === true);
  check('the batch is announced once', data.notifications.items.filter((/** @type {{ key: string }} */ n) => n.key.startsWith('linkedin-comments:')).length === 1);
  const second = await linkedinComments.run(ctx);
  check('a post read this run is not read again until its time', calls.length === 1 && second.added === 0);
  data.linkedin.cache['post:urn:li:share:1:comments'].at -= 3 * 3600000;
  await linkedinComments.run(ctx);
  check('a comment seen before is not added twice', calls.length === 2 && data.linkedin.comments.length === 2);
}

process.exit(failed ? 1 : 0);
