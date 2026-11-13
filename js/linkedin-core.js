// linkedin.json without the DOM: LinkedIn's posts, comments, official sign-in and the saved session's call queue state.
// Follower counts stay in socials.json (js/socials.js). The runners import this file.
/** @import { LinkedinData, LinkedinAuth, LinkedinPost, DataStore } from '../types/data' */
import { notify } from './notify-core.js';
import { uid } from './ui.js';

export const LINKEDIN = 'linkedin';
/** @type {LinkedinData} */
export const LINKEDIN_DEFAULTS = { auth: null, posts: [], comments: [], cache: {}, session: { calls: {} } };

// The official sign-in, with the member's own developer app (Settings → LinkedIn → Publish as you).
export const LINKEDIN_AUTHORIZE = 'https://www.linkedin.com/oauth/v2/authorization';
export const LINKEDIN_SCOPES = 'openid profile email w_member_social';
const TOKEN_URL = 'https://www.linkedin.com/oauth/v2/accessToken';
const USERINFO_URL = 'https://api.linkedin.com/v2/userinfo';
// Warn this long before the token stops working: it cannot be renewed, only signed in again.
const EXPIRY_WARNING = 7 * 86400000;

/** @param {LinkedinAuth | null | undefined} auth */
export const signedIn = (auth) => Boolean(auth?.token && auth.expires > Date.now());

// Trades the sign-in's code for a token, then reads who signed in. Runs in the runners: LinkedIn's token endpoint
// answers no CORS request.
/** @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string }} p @returns {Promise<LinkedinAuth>} */
export async function exchangeLinkedinCode({ clientId, clientSecret, code, redirectUri }) {
  if (!clientId || !clientSecret) throw new Error('Save the app’s Client ID and Client Secret first.');
  if (!code) throw new Error('LinkedIn sent no code.');
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret }),
    signal: AbortSignal.timeout(20000),
  });
  const token = /** @type {{ access_token?: string, expires_in?: number, error?: string, error_description?: string }} */ (await res.json().catch(() => ({})));
  if (!res.ok || !token.access_token) throw new Error(`LinkedIn refused the sign-in: ${token.error_description || token.error || `HTTP ${res.status}`}`);
  const at = Date.now();
  const who = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${token.access_token}` }, signal: AbortSignal.timeout(20000) });
  const user = /** @type {{ sub?: string, name?: string, picture?: string, message?: string }} */ (await who.json().catch(() => ({})));
  if (!who.ok || !user.sub) throw new Error(`LinkedIn did not say who signed in: ${user.message || `HTTP ${who.status}`}`);
  return { token: token.access_token, expires: at + (token.expires_in ?? 60 * 86400) * 1000, sub: user.sub, name: user.name ?? '', picture: user.picture ?? '', at };
}

// Announces, once per sign-in, that its token stops working within a week.
/** @param {DataStore} store */
export function checkLinkedinExpiry(store) {
  const auth = store.get(LINKEDIN)?.auth;
  if (!auth?.token || auth.expires - Date.now() > EXPIRY_WARNING) return false;
  const day = new Date(auth.expires).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return notify(store, {
    kind: 'linkedin',
    text: auth.expires > Date.now()
      ? `LinkedIn’s sign-in ends on ${day}. Sign in again in Settings → LinkedIn to keep posting.`
      : 'LinkedIn’s sign-in has ended. Sign in again in Settings → LinkedIn to post.',
    href: '#/settings?section=linkedin',
    key: `linkedin-expiry:${auth.expires}`,
  });
}

// --- Weekly summary and rules: reads of posts and follower history, no DOM ---
/** @import { LinkedinPostMetrics } from '../types/data' */

// A post's last read of its results, or null before the first.
/** @param {LinkedinPost} post @returns {LinkedinPostMetrics | null} */
export const latestMetrics = (post) => (post.metrics?.length ? post.metrics[post.metrics.length - 1] : null);

// Reactions, comments and reposts together: what "did well" means when posts are compared.
/** @param {LinkedinPostMetrics | null | undefined} m */
export const engagement = (m) => (m ? (m.reactions ?? 0) + (m.comments ?? 0) + (m.reposts ?? 0) : 0);

// The posts published from `from` up to `to` (ms), oldest first.
/** @param {LinkedinPost[]} posts @param {number} from @param {number} [to] */
export const postsBetween = (posts, from, to = Date.now()) => posts
  .filter((p) => p.status === 'posted' && typeof p.postedAt === 'number' && p.postedAt >= from && p.postedAt < to)
  .sort((a, b) => Number(a.postedAt) - Number(b.postedAt));

// An account's followers now and `days` days ago, from its day-by-day history (socials.json). Without a point that
// old, the change counts from the oldest one (`since`). Null when the history is empty.
/**
 * @param {Record<string, number> | undefined} history
 * @param {number} days
 * @param {number} [at]
 * @returns {{ now: number, before: number, change: number, since: string } | null}
 */
export function followerChange(history, days, at = Date.now()) {
  const keys = Object.keys(history ?? {}).sort();
  if (!history || !keys.length) return null;
  const d = new Date(at);
  d.setDate(d.getDate() - days);
  const start = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const since = [...keys].reverse().find((k) => k <= start) ?? keys[0];
  const now = history[keys[keys.length - 1]];
  const before = history[since];
  return { now, before, change: now - before, since };
}

// The age of a read of a post's results, in the steps the runners read them at: about 1 hour, 24 hours and 7 days.
/** @param {LinkedinPost} post @param {LinkedinPostMetrics} m */
export const metricsAge = (post, m) => {
  const hours = (m.at - Number(post.postedAt)) / 3600000;
  return hours < 6 ? '1h' : hours < 72 ? '24h' : '7d';
};

// How a post's last read compares with the member's earlier posts read at the same age: its reactions, the median
// reactions of those posts and how many there were. Null before its first read or without an earlier post read then.
/**
 * @param {LinkedinPost} post
 * @param {LinkedinPost[]} posts
 * @returns {{ age: string, reactions: number, median: number, compared: number } | null}
 */
export function postStandout(post, posts) {
  const m = latestMetrics(post);
  if (!m || post.status !== 'posted' || typeof post.postedAt !== 'number') return null;
  const age = metricsAge(post, m);
  const earlier = posts
    .filter((p) => p.id !== post.id && p.status === 'posted' && typeof p.postedAt === 'number' && p.postedAt < Number(post.postedAt))
    .map((p) => (p.metrics ?? []).filter((x) => metricsAge(p, x) === age).at(-1)?.reactions)
    .filter((n) => typeof n === 'number')
    .sort((a, b) => a - b);
  if (!earlier.length) return null;
  const mid = Math.floor(earlier.length / 2);
  const median = earlier.length % 2 ? earlier[mid] : (earlier[mid - 1] + earlier[mid]) / 2;
  return { age, reactions: m.reactions ?? 0, median, compared: earlier.length };
}

// --- Posts ---

export const POST_LIMIT = 3000;
const POSTS_URL = 'https://api.linkedin.com/rest/posts';
// LinkedIn's versioned API wants a YYYYMM version, each kept about a year: move it on when LinkedIn sunsets it.
const API_VERSION = '202610';

// LinkedIn reads a post's commentary as "little text", where these characters mark mentions, hashtags and links:
// written plainly, they are dropped with the rest of the line. A backslash keeps them as text. `#` stays, so
// hashtags written as #tag still become hashtags.
/** @param {string} text */
export const escapeLittleText = (text) => text.replace(/[\\()[\]{}<>@|~_*]/g, '\\$&');

// The words of a line, without Markdown's heading marks, bold, list numbers or a trailing colon.
/** @param {string} line */
const bare = (line) => line.trim().replace(/^#{1,6}\s+/, '').replace(/^\d+[.)]\s*/, '').replace(/^\*\*(.*)\*\*$/, '$1').replace(/^__(.*)__$/, '$1').replace(/:$/, '').trim();
const HEADINGS = new Set(['x', 'x post', 'x (twitter)', 'twitter', 'tweet', 'linkedin', 'linkedin post', 'instagram', 'bluesky', 'threads', 'mastodon', 'topic']);
/** @param {string} line */
const isHeading = (line) => /^#{1,6}\s/.test(line.trim()) || /^(\*\*|__)[^*_]+(\*\*|__):?$/.test(line.trim()) || HEADINGS.has(bare(line).toLowerCase());

// The text of a post from a task's description: what follows a "LinkedIn" heading (as Cron's social post templates
// write them) up to the next heading, else the whole description.
/** @param {string | undefined} description */
export function linkedinDraftOf(description) {
  const lines = String(description ?? '').split('\n');
  const start = lines.findIndex((l) => /^linkedin( post)?$/i.test(bare(l)));
  if (start < 0) return lines.join('\n').trim();
  const end = lines.findIndex((l, i) => i > start && isHeading(l));
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n').trim();
}

/** @param {string} urn */
export const postUrl = (urn) => `https://www.linkedin.com/feed/update/${urn}/`;

/** @param {Partial<LinkedinPost>} fields @returns {LinkedinPost} */
export function makePost(fields) {
  return { id: uid(), taskId: null, projectId: null, text: '', link: '', status: 'draft', scheduledAt: null, createdAt: Date.now(), ...fields };
}

/** @param {DataStore} store @param {string} id @param {Partial<LinkedinPost>} patch */
function setPost(store, id, patch) {
  store.update(LINKEDIN, (d) => {
    const p = d.posts.find((x) => x.id === id);
    if (p) Object.assign(p, patch, { updatedAt: Date.now() });
  });
}

/** @param {string} link */
const hostOf = (link) => {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return link;
  }
};

// The request LinkedIn's Posts API takes: as the member, public, in the main feed, with the link as an article.
/** @param {LinkedinAuth} auth @param {LinkedinPost} post */
export function postRequest(auth, post) {
  /** @type {Record<string, unknown>} */
  const body = {
    author: `urn:li:person:${auth.sub}`,
    commentary: escapeLittleText(post.text),
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (post.link) body.content = { article: { source: post.link, title: hostOf(post.link) } };
  return {
    url: POSTS_URL,
    init: {
      method: 'POST',
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/json',
        'linkedin-version': API_VERSION,
        'x-restli-protocol-version': '2.0.0',
      },
      body: JSON.stringify(body),
    },
  };
}

// Posts one post as the member, from the runners (LinkedIn's API answers no browser). On success the post keeps its
// URN and page, and its task gets the link and is done; on failure it is marked failed with LinkedIn's reason.
/** @param {DataStore} store @param {string} id @returns {Promise<LinkedinPost>} */
export async function publishPost(store, id) {
  const data = store.get(LINKEDIN);
  const post = data.posts.find((p) => p.id === id);
  if (!post) throw new Error('This post is no longer in linkedin.json.');
  if (post.status === 'posted') return post;
  /** @param {string} error */
  const fail = (error) => {
    setPost(store, id, { status: 'failed', error });
    return /** @type {LinkedinPost} */ (store.get(LINKEDIN).posts.find((p) => p.id === id));
  };
  if (!post.text.trim()) return fail('The post has no text.');
  if (post.text.length > POST_LIMIT) return fail(`The post is longer than ${POST_LIMIT} characters.`);
  const auth = data.auth;
  if (!auth || !signedIn(auth)) return fail(auth ? 'LinkedIn’s sign-in has ended. Sign in again in Settings → LinkedIn.' : 'Sign in with LinkedIn in Settings → LinkedIn first.');
  setPost(store, id, { status: 'posting', error: null });
  const { url, init } = postRequest(auth, post);
  let res;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(30000) });
  } catch (err) {
    return fail(`LinkedIn did not answer: ${/** @type {Error} */ (err).message}`);
  }
  if (!res.ok) {
    const answer = /** @type {{ message?: string }} */ (await res.json().catch(() => ({})));
    return fail(res.status === 401 ? 'LinkedIn refused the sign-in. Sign in again in Settings → LinkedIn.' : `LinkedIn refused the post: ${answer.message || `HTTP ${res.status}`}`);
  }
  const urn = res.headers.get('x-restli-id') ?? res.headers.get('x-linkedin-id') ?? '';
  const page = urn ? postUrl(urn) : '';
  setPost(store, id, { status: 'posted', postedAt: Date.now(), urn, url: page, error: null, scheduledAt: null });
  if (post.taskId) {
    store.update('todos', (d) => {
      const task = d.items.find((t) => t.id === post.taskId);
      if (!task) return;
      if (page && !(task.links ?? []).some((l) => l.url === page)) task.links = [...(task.links ?? []), { url: page, title: 'LinkedIn post' }];
      task.status = 'done';
      delete task.done;
    });
  }
  return /** @type {LinkedinPost} */ (store.get(LINKEDIN).posts.find((p) => p.id === id));
}

// A scheduled post this late is not posted: the Mac was asleep or the runners stopped, and a post a day late may
// no longer fit. It is marked missed, to be rescheduled by hand.
const MISSED_AFTER = 12 * 3600000;

// The runners' minute round: posts each scheduled post whose time has come, oldest first, and marks the ones far
// past their time as missed. Each failure or miss is announced once.
/** @param {DataStore} store @param {number} [now] */
export async function postDuePosts(store, now = Date.now()) {
  const due = store.get(LINKEDIN).posts
    .filter((p) => p.status === 'scheduled' && typeof p.scheduledAt === 'number' && p.scheduledAt <= now)
    .sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt));
  let posted = 0;
  let missed = 0;
  let failed = 0;
  for (const p of due) {
    const label = `“${p.text.split('\n')[0].slice(0, 60)}”`;
    if (now - Number(p.scheduledAt) > MISSED_AFTER) {
      setPost(store, p.id, { status: 'missed', error: null });
      missed++;
      notify(store, { kind: 'linkedin', text: `The LinkedIn post ${label} was not posted: it was due more than 12 hours ago. Reschedule it or post it now.`, href: '#/calendar', key: `linkedin-missed:${p.id}:${p.scheduledAt}` });
      continue;
    }
    const done = await publishPost(store, p.id);
    if (done.status === 'posted') posted++;
    else {
      failed++;
      notify(store, { kind: 'linkedin', text: `The scheduled LinkedIn post ${label} failed: ${done.error ?? 'LinkedIn did not take it.'}`, href: '#/calendar', key: `linkedin-failed:${p.id}:${p.scheduledAt}` });
    }
  }
  return { posted, missed, failed };
}
