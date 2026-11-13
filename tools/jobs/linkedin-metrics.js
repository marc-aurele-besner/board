// Reads the results of the member's posts (reactions, comments, reposts, impressions) about 1 hour, 24 hours and 7 days
// after each was posted, through the saved session's queue, and appends each read to the post's `metrics` in
// linkedin.json. Session calls are few (60 a day by default, 20 to 40 s apart), so a run reads at most MAX_CALLS posts,
// a post is read at most once per step, and a run stops at once when the session is gone or the day is used up.
// Posts → Read results now (Monitoring → Socials) runs it for one post: POST /run/linkedin-metrics { posts: [id] }.
/** @import { Job } from '../../types/runner' */
/** @import { LinkedinPost } from '../../types/data' */
/** @import { LinkedinSessionError } from '../../js/linkedin-session.js' */
import { LINKEDIN } from '../../js/linkedin-core.js';
import { sessionCookies } from '../../js/linkedin-session.js';
import { dueStep, postCountsPath, parsePostCounts } from '../../js/linkedin-reads.js';
import { voyager } from '../linkedin-session.js';

// Each call waits 20 to 40 s in the queue: four fit well inside a 15-minute interval.
const MAX_CALLS = 4;
// A post whose read failed (not found, an answer that could not be read) is tried again after this long, not every run.
const RETRY_MS = 6 * 3600000;
// A cached answer serves a scheduled read for this long; a Read now always asks LinkedIn.
const STEP_MAX_AGE = 30 * 60000;
/** @type {Map<string, number>} */
const failedAt = new Map();

// Errors after which no further call can work in this run.
const STOPS = new Set(['no-session', 'signed-out', 'limit']);

export default /** @satisfies {Job} */ ({
  id: 'linkedin-metrics',
  delay: 30000,
  timeout: 20 * 60000,
  quiet: true,
  async run({ store, params, signal }) {
    const now = Date.now();
    const posts = store.get(LINKEDIN).posts ?? [];
    const asked = params.posts?.length ? posts.filter((p) => params.posts?.includes(p.id)) : null;
    if (asked && !asked.length) throw new Error('That post is not in linkedin.json any more.');
    if (asked) {
      const p = asked[0];
      if (p.status !== 'posted' || !p.urn) throw new Error('The post has no LinkedIn id yet: it reads once it is posted.');
    }
    /** @type {{ post: LinkedinPost, step: string }[]} */
    const due = asked
      ? asked.filter((p) => p.urn).map((post) => ({ post, step: 'now' }))
      : posts.flatMap((post) => {
        const step = dueStep(post, now);
        return step && now - (failedAt.get(`${post.id}:${step}`) ?? 0) > RETRY_MS ? [{ post, step }] : [];
      });
    if (!due.length) return { read: 0 };
    if (!sessionCookies(store.get('settings').linkedin)) {
      if (asked) throw new Error('No LinkedIn session is saved. Add li_at and JSESSIONID in Settings → LinkedIn.');
      return { waiting: 'No LinkedIn session is saved in Settings → LinkedIn, so posts’ results are not read.' };
    }
    let read = 0;
    /** @type {{ text: string }[]} */
    const errors = [];
    for (const { post, step } of due.slice(0, MAX_CALLS)) {
      const urn = /** @type {string} */ (post.urn);
      try {
        const answer = await voyager(store, {
          path: postCountsPath(urn),
          cacheKey: `post:${urn}:counts:${step}`,
          maxAge: step === 'now' ? 0 : STEP_MAX_AGE,
          signal,
        });
        const m = parsePostCounts(answer);
        store.update(LINKEDIN, (d) => {
          const p = d.posts.find((x) => x.id === post.id);
          if (!p) return;
          p.metrics = [...(p.metrics ?? []), m];
        });
        failedAt.delete(`${post.id}:${step}`);
        read += 1;
      } catch (err) {
        if (signal.aborted) throw err;
        const code = /** @type {LinkedinSessionError} */ (err).code;
        // The session is gone or the day is used up: the posts stay due and are read once it comes back.
        if (code && STOPS.has(code)) {
          if (asked) throw err;
          return { read, waiting: /** @type {Error} */ (err).message };
        }
        failedAt.set(`${post.id}:${step}`, now);
        const text = /** @type {Error} */ (err).message;
        if (asked) throw new Error(text);
        errors.push({ text: `${post.text.split('\n')[0].slice(0, 40)}: ${text}` });
      }
    }
    if (!read && errors.length) throw new Error(errors.slice(0, 3).map((e) => e.text).join('; '));
    return { read, errors };
  },
});
