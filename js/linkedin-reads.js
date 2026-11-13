// What the runners read of the member's posts through the saved session: each post's results (reactions, comments,
// reposts, impressions) at about 1 hour, 24 hours and 7 days. No DOM; the runners import this file.
//
// UNVERIFIED: LinkedIn's voyager API is undocumented. The paths and answer shapes below are a best guess from what
// its pages call, never checked against a live session (the board never tests with a real one). They are kept in these
// few functions so a fix touches one place, and the parsing looks for the counts anywhere in the answer, under the
// names LinkedIn has used, so a reshaped answer still reads or fails with a readable error rather than a crash.
/** @import { LinkedinPost, LinkedinPostMetrics } from '../types/data' */

const HOUR = 3600000;

// When a post's results are read, after it was posted. metricsAge() in js/linkedin-core.js names a read by the same steps.
export const METRIC_STEPS = [
  { key: '1h', after: HOUR },
  { key: '24h', after: 24 * HOUR },
  { key: '7d', after: 7 * 24 * HOUR },
];
// A post older than this is not read on schedule any more (a Read results now still works).
export const METRICS_WINDOW = 30 * 24 * HOUR;

// The step whose read a post is due for now, or null. Only the latest step reached counts, so after a sleep a post
// gets one read rather than three; a read already made at that step (or a later one) means none is due. At most one
// read per step, so three reads per post ever.
/** @param {LinkedinPost} post @param {number} [now] @returns {string | null} */
export function dueStep(post, now = Date.now()) {
  if (post.status !== 'posted' || !post.urn || typeof post.postedAt !== 'number') return null;
  const age = now - post.postedAt;
  if (age > METRICS_WINDOW) return null;
  const reached = METRIC_STEPS.filter((s) => age >= s.after).pop();
  if (!reached) return null;
  const done = (post.metrics ?? []).map((m) => stepOf(post, m));
  const at = METRIC_STEPS.findIndex((s) => s.key === reached.key);
  return done.some((k) => METRIC_STEPS.findIndex((s) => s.key === k) >= at) ? null : reached.key;
}

// The step a read belongs to: the last one reached when it was made (a read at 30 hours is the 24-hour read).
/** @param {LinkedinPost} post @param {LinkedinPostMetrics} m */
export function stepOf(post, m) {
  const age = m.at - Number(post.postedAt);
  return METRIC_STEPS.filter((s) => age >= s.after).pop()?.key ?? '1h';
}

// UNVERIFIED path: a post's social counts. `urn` is the post's own ('urn:li:share:…' or 'urn:li:ugcPost:…').
/** @param {string} urn */
export const postCountsPath = (urn) => `socialActions/${encodeURIComponent(urn)}`;

/** @param {unknown} node @param {(key: string, value: unknown) => void} visit */
function walk(node, visit) {
  if (!node || typeof node !== 'object') return;
  for (const [k, v] of Object.entries(node)) {
    visit(k, v);
    walk(v, visit);
  }
}

// The first finite number under any of `keys`, anywhere in the answer.
/** @param {unknown} answer @param {string[]} keys @returns {number | undefined} */
function firstCount(answer, keys) {
  /** @type {Record<string, number>} */
  const found = {};
  walk(answer, (k, v) => {
    if (keys.includes(k) && !(k in found) && typeof v === 'number' && Number.isFinite(v)) found[k] = v;
  });
  const key = keys.find((k) => k in found);
  return key === undefined ? undefined : found[key];
}

// The counts in a social counts answer. Throws a readable error when none of reactions, comments or reposts is found.
/** @param {unknown} answer @param {number} [at] @returns {LinkedinPostMetrics} */
export function parsePostCounts(answer, at = Date.now()) {
  if (!answer || typeof answer !== 'object') throw new Error('LinkedIn’s answer for the post was empty.');
  let reactions = firstCount(answer, ['totalReactionCount', 'numReactions', 'aggregatedTotalLikes', 'totalLikes', 'numLikes']);
  if (reactions === undefined) {
    // Some answers only list the count of each reaction type.
    let sum = 0;
    let seen = false;
    walk(answer, (k, v) => {
      if (k !== 'reactionTypeCounts' || !Array.isArray(v)) return;
      for (const r of v) if (typeof r?.count === 'number') {
        sum += r.count;
        seen = true;
      }
    });
    if (seen) reactions = sum;
  }
  const comments = firstCount(answer, ['numComments', 'aggregatedTotalComments', 'totalFirstLevelComments', 'commentCount']);
  const reposts = firstCount(answer, ['numShares', 'numReposts', 'repostCount', 'shareCount']);
  const impressions = firstCount(answer, ['numImpressions', 'impressionCount', 'numViews', 'viewCount']);
  if (reactions === undefined && comments === undefined && reposts === undefined) {
    throw new Error('LinkedIn’s answer had no reaction, comment or repost count. Its API may have changed.');
  }
  /** @type {LinkedinPostMetrics} */
  const m = { at };
  if (reactions !== undefined) m.reactions = reactions;
  if (comments !== undefined) m.comments = comments;
  if (reposts !== undefined) m.reposts = reposts;
  if (impressions !== undefined) m.impressions = impressions;
  return m;
}

// --- Comments: the comments on the member's recent posts ---

// UNVERIFIED path: the newest comments of a post, `urn` being the post's own URN.
/** @param {string} urn @param {number} [count] */
export const postCommentsPath = (urn, count = 50) => `socialActions/${encodeURIComponent(urn)}/comments?count=${count}&start=0&sortOrder=REVERSE_CHRONOLOGICAL`;

/** @typedef {{ id: string, author: string, authorHeadline?: string, authorUrl?: string, text: string, at: number }} ParsedComment */

/** @param {unknown} v @returns {string} */
const textOf = (v) => {
  if (typeof v === 'string') return v;
  if (!v || typeof v !== 'object') return '';
  const o = /** @type {Record<string, any>} */ (v); // any: one of LinkedIn's text shapes
  if (typeof o.text === 'string') return o.text;
  if (o.text && typeof o.text === 'object') return textOf(o.text);
  if (Array.isArray(o.values)) return o.values.map((/** @type {any} */ x) => textOf(x?.value ?? x)).join(''); // any: as above
  return '';
};

// The comments in a comments answer, in any of the shapes LinkedIn has used: REST elements with `message` or
// `commentV2`, the normalized form whose `included` list holds comments and the profiles they point at, or the
// newer dash comments with `commentary` and `commenter`. Anything that looks like a comment (a comment URN and a text)
// is kept; the rest is skipped. Throws a readable error only when the answer is not JSON at all.
/** @param {unknown} answer @returns {ParsedComment[]} */
export function parseComments(answer) {
  if (!answer || typeof answer !== 'object') throw new Error('LinkedIn’s answer for the comments was empty.');
  /** @type {Map<string, Record<string, any>>} */ // any: LinkedIn's objects, read field by field
  const byUrn = new Map();
  /** @type {Record<string, any>[]} */ // any: as above
  const nodes = [];
  /** @param {unknown} n */
  const collect = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      n.forEach(collect);
      return;
    }
    const o = /** @type {Record<string, any>} */ (n); // any: as above
    nodes.push(o);
    const urn = o.entityUrn ?? o.urn ?? o.$id;
    if (typeof urn === 'string') byUrn.set(urn, o);
    for (const v of Object.values(o)) collect(v);
  };
  collect(answer);
  /** @param {unknown} ref @returns {Record<string, any> | undefined} */ // any: as above
  const deref = (ref) => (typeof ref === 'string' ? byUrn.get(ref) : ref && typeof ref === 'object' ? /** @type {Record<string, any>} */ (ref) : undefined); // any: as above
  /** @param {Record<string, any> | undefined} p */ // any: as above
  const nameOfProfile = (p) => (p ? [p.firstName, p.lastName].filter((s) => typeof s === 'string' && s).join(' ') : '');

  /** @type {Map<string, ParsedComment>} */
  const out = new Map();
  for (const o of nodes) {
    const id = [o.entityUrn, o.urn, o.commentUrn].find((u) => typeof u === 'string' && /^urn:li:[\w]*comment/i.test(u));
    if (!id || out.has(id)) continue;
    const text = textOf(o.commentary) || textOf(o.commentV2) || textOf(o.message) || textOf(o.comment) || '';
    if (!text.trim()) continue;
    const commenter = deref(o.commenter) ?? deref(o.actor) ?? deref(o.author);
    // The commenter can be a profile reference, or a block with a title and subtitle as the page draws it.
    const profile = deref(commenter?.member ?? commenter?.profile ?? commenter?.['*profile'] ?? commenter?.miniProfile ?? o['*commenterProfile'] ?? o.commenterProfileId) ?? commenter;
    const author = textOf(commenter?.title) || textOf(commenter?.name) || nameOfProfile(profile) || 'Someone';
    const headline = textOf(commenter?.subtitle) || textOf(commenter?.description) || textOf(profile?.occupation) || textOf(profile?.headline);
    const url = [commenter?.navigationUrl, commenter?.url, profile?.publicIdentifier ? `https://www.linkedin.com/in/${profile.publicIdentifier}/` : '']
      .find((u) => typeof u === 'string' && /^https:\/\/www\.linkedin\.com\//.test(u));
    const at = [o.createdAt, o.createdTime, o.created?.time, o.commentedAt].find((n) => typeof n === 'number' && n > 0);
    /** @type {ParsedComment} */
    const c = { id, author, text: text.trim(), at: at ?? Date.now() };
    if (headline) c.authorHeadline = headline;
    if (url) c.authorUrl = url;
    out.set(id, c);
  }
  return [...out.values()];
}
