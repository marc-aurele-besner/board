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
