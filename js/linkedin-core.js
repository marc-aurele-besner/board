// linkedin.json without the DOM: LinkedIn's posts, comments, official sign-in and the saved session's call queue state.
// Follower counts stay in socials.json (js/socials.js). The runners import this file.
/** @import { LinkedinData, LinkedinAuth, DataStore } from '../types/data' */
import { notify } from './notify-core.js';

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
/** @import { LinkedinPost, LinkedinPostMetrics } from '../types/data' */

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
