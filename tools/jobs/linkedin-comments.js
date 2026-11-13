// Reads the comments on the member's posts of the last 14 days through the saved session's queue, and adds the ones
// not seen yet to linkedin.json `comments` (unread), for the Inbox's LinkedIn folder. One call per post per run at
// most, the posts read longest ago first, and a run stops at once when the session is gone or the day is used up.
// A batch of new comments is announced once (notification kind 'linkedin').
/** @import { Job } from '../../types/runner' */
/** @import { LinkedinComment } from '../../types/data' */
/** @import { LinkedinSessionError } from '../../js/linkedin-session.js' */
import { LINKEDIN } from '../../js/linkedin-core.js';
import { notify } from '../../js/notify-core.js';
import { sessionCookies } from '../../js/linkedin-session.js';
import { postCommentsPath, parseComments } from '../../js/linkedin-reads.js';
import { voyager } from '../linkedin-session.js';

const DAY = 24 * 3600000;
// Posts older than this are not read for comments any more.
const WINDOW = 14 * DAY;
// A run reads at most this many posts: each call waits 20 to 40 s in the queue, and the day has 60.
const MAX_CALLS = 5;
// How long one read of a post's comments stands: a fresh post is read every run (2 hours), an older one less often.
/** @param {number} age ms since posting */
const maxAgeOf = (age) => (age < 3 * DAY ? 110 * 60000 : 8 * 3600000);
const STOPS = new Set(['no-session', 'signed-out', 'limit']);

/** @param {string} urn */
export const commentsKey = (urn) => `post:${urn}:comments`;

export default /** @satisfies {Job} */ ({
  id: 'linkedin-comments',
  delay: 60000,
  timeout: 20 * 60000,
  quiet: true,
  async run({ store, signal }) {
    const now = Date.now();
    const li = store.get(LINKEDIN);
    const cache = li.cache ?? {};
    const due = (li.posts ?? [])
      .filter((p) => p.status === 'posted' && p.urn && typeof p.postedAt === 'number' && now - p.postedAt < WINDOW)
      .map((p) => ({ post: p, readAt: cache[commentsKey(/** @type {string} */ (p.urn))]?.at ?? 0, maxAge: maxAgeOf(now - Number(p.postedAt)) }))
      .filter((x) => now - x.readAt >= x.maxAge)
      .sort((a, b) => a.readAt - b.readAt);
    if (!due.length) return { added: 0 };
    if (!sessionCookies(store.get('settings').linkedin)) return { waiting: 'No LinkedIn session is saved in Settings → LinkedIn, so comments are not read.' };
    // The member's own replies are not news.
    const me = (li.auth?.name ?? '').trim().toLowerCase();
    /** @type {LinkedinComment[]} */
    const added = [];
    /** @type {{ text: string }[]} */
    const errors = [];
    let read = 0;
    for (const { post, maxAge } of due.slice(0, MAX_CALLS)) {
      const urn = /** @type {string} */ (post.urn);
      try {
        const found = parseComments(await voyager(store, { path: postCommentsPath(urn), cacheKey: commentsKey(urn), maxAge, signal }));
        read += 1;
        store.update(LINKEDIN, (d) => {
          d.comments ??= [];
          const seen = new Set(d.comments.map((c) => c.id));
          for (const c of found) {
            if (seen.has(c.id)) continue;
            const mine = Boolean(me) && c.author.trim().toLowerCase() === me;
            /** @type {LinkedinComment} */
            const row = { ...c, postId: post.id, postUrn: urn, read: mine, taskId: null };
            d.comments.push(row);
            if (!mine) added.push(row);
          }
        });
      } catch (err) {
        if (signal.aborted) throw err;
        const code = /** @type {LinkedinSessionError} */ (err).code;
        if (code && STOPS.has(code)) {
          announce();
          return { read, added: added.length, waiting: /** @type {Error} */ (err).message };
        }
        errors.push({ text: `${post.text.split('\n')[0].slice(0, 40)}: ${/** @type {Error} */ (err).message}` });
      }
    }
    announce();
    if (!read && errors.length) throw new Error(errors.slice(0, 3).map((e) => e.text).join('; '));
    return { read, added: added.length, errors };

    function announce() {
      if (!added.length) return;
      const first = added[0];
      const excerpt = first.text.length > 80 ? `${first.text.slice(0, 80)}…` : first.text;
      notify(store, {
        kind: 'linkedin',
        text: added.length === 1
          ? `New LinkedIn comment from ${first.author}: “${excerpt}”`
          : `${added.length} new LinkedIn comments, from ${[...new Set(added.map((c) => c.author))].slice(0, 3).join(', ')}.`,
        href: '#/inbox?folder=linkedin',
        key: `linkedin-comments:${first.id}`,
      });
    }
  },
});
