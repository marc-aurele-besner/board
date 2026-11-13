// Monitoring → Socials, LinkedIn posts: the posts on a LinkedIn account's follower line, and the Posts table with each
// post's results as the runners read them at about 1 hour, 24 hours and 7 days (tools/jobs/linkedin-metrics.js).
import { h, icon, empty, refreshIcon } from '../ui.js';
import { toast } from '../toast.js';
import { runJob } from '../runners.js';
import { LINKEDIN, latestMetrics } from '../linkedin-core.js';
import { METRIC_STEPS, stepOf } from '../linkedin-reads.js';
import { dayKey, isOrganization } from '../socials.js';
import { sortTable } from './monitoring-web.js';
/** @import { Store, SocialAccount, LinkedinPost, LinkedinPostMetrics } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { Child } from '../../types/ui' */

const count = new Intl.NumberFormat();
// Posts being read now, so their button shows it.
/** @type {Set<string>} */
const reading = new Set();

/** @param {LinkedinPost} p */
export const firstLine = (p) => {
  const line = String(p.text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

/** @param {LinkedinPostMetrics | null | undefined} m */
export const resultsText = (m) => (m
  ? [`${count.format(m.reactions ?? 0)} reactions`, `${count.format(m.comments ?? 0)} comments`, `${count.format(m.reposts ?? 0)} reposts`,
    ...(m.impressions != null ? [`${count.format(m.impressions)} impressions`] : [])].join(' · ')
  : 'No results read yet');

/** @param {Store} store */
const posted = (store) => (store.get(LINKEDIN).posts ?? []).filter((p) => p.status === 'posted' && typeof p.postedAt === 'number');

// The posts that belong on an account's line: all of a person's (the member posts as themselves), and on a company
// page the posts of its project.
/** @param {Store} store @param {SocialAccount} a */
function postsOf(store, a) {
  if (a.network !== 'linkedin') return [];
  return posted(store).filter((p) => !isOrganization(a) || (a.projectId && p.projectId === a.projectId));
}

// A LinkedIn account's posts by the chart's days: the indices to mark and a tooltip that adds them under the count.
/**
 * @param {Store} store
 * @param {SocialAccount} a
 * @param {string[]} days history keys, one per label
 * @param {string[]} labels
 * @param {(number | null)[]} values
 * @param {(v: number) => string} format
 * @returns {{ marks: number[], tip: ((i: number) => Child) | null }}
 */
export function postMarks(store, a, days, labels, values, format) {
  /** @type {Map<number, LinkedinPost[]>} */
  const byDay = new Map();
  for (const p of postsOf(store, a)) {
    const i = days.indexOf(dayKey(new Date(Number(p.postedAt))));
    if (i >= 0) byDay.set(i, [...(byDay.get(i) ?? []), p]);
  }
  if (!byDay.size) return { marks: [], tip: null };
  return {
    marks: [...byDay.keys()],
    tip: (i) => [
      h('span', { class: 'muted' }, labels[i]),
      values[i] != null ? h('span', { class: 'tip-row' }, h('span', null, 'Followers'), h('strong', null, format(/** @type {number} */ (values[i])))) : null,
      (byDay.get(i) ?? []).map((p) => h('span', { class: 'tip-post' },
        h('span', { class: 'tip-post-text' }, icon('linkedin'), ' ', firstLine(p)),
        h('span', { class: 'muted' }, resultsText(latestMetrics(p))))),
    ],
  };
}

// Asks the runners to read one post's results now (a single session call, through the queue).
/** @param {Store} store @param {LinkedinPost} p */
function readNow(store, p) {
  reading.add(p.id);
  store.refresh();
  runJob('linkedin-metrics', { posts: [p.id] })
    .then(() => toast('Results read.'))
    .catch((err) => toast(`Could not read the results: ${/** @type {Error} */ (err).message}`))
    .finally(() => {
      reading.delete(p.id);
      store.sync();
    });
}

/** @param {LinkedinPost} p @param {string} step */
const readAt = (p, step) => (p.metrics ?? []).filter((m) => stepOf(p, m) === step).at(-1) ?? null;

/** @param {LinkedinPostMetrics | null} m */
const stepCell = (m) => (m
  ? h('span', { title: `${resultsText(m)}, read ${new Date(m.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` }, count.format(m.reactions ?? 0))
  : h('span', { class: 'muted' }, '—'));

// The Posts card: the posts published in the period with their last read results and the reactions at each step.
/** @param {Store} store @param {PeriodWindow} w */
export function postsCard(store, w) {
  const all = posted(store);
  if (!all.length) return null;
  const rows = all.filter((p) => Number(p.postedAt) >= w.start && Number(p.postedAt) < w.end)
    .sort((a, b) => Number(b.postedAt) - Number(a.postedAt))
    .map((p) => ({ post: p, last: latestMetrics(p) }));
  /** @typedef {typeof rows[number]} Row */
  /** @param {(m: LinkedinPostMetrics) => number | undefined} pick */
  const num = (pick) => ({
    num: true,
    value: (/** @type {Row} */ r) => (r.last ? pick(r.last) ?? -1 : -1),
    format: (/** @type {number} */ v) => (v < 0 ? '—' : count.format(v)),
  });
  return h('section', { class: 'card stack' },
    h('h3', null, 'LinkedIn posts'),
    h('p', { class: 'muted small' }, 'Results are read through the saved session about 1 hour, 24 hours and 7 days after posting. The 1h, 24h and 7d columns are reactions at each read.'),
    rows.length
      ? sortTable('linkedin-posts', [
        { label: 'Date', value: (r) => Number(r.post.postedAt), format: (v) => new Date(v).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) },
        {
          label: 'Post',
          clip: true,
          value: (r) => firstLine(r.post),
          format: (v, r) => (r.post.url ? h('a', { href: r.post.url, target: '_blank', rel: 'noopener noreferrer', title: 'Open on LinkedIn' }, v) : v),
        },
        { label: 'Reactions', ...num((m) => m.reactions) },
        { label: 'Comments', ...num((m) => m.comments) },
        { label: 'Reposts', ...num((m) => m.reposts) },
        { label: 'Impressions', ...num((m) => m.impressions) },
        ...METRIC_STEPS.map((s) => ({
          label: s.key,
          num: true,
          value: (/** @type {Row} */ r) => readAt(r.post, s.key)?.reactions ?? -1,
          format: (/** @type {number} */ _, /** @type {Row} */ r) => stepCell(readAt(r.post, s.key)),
        })),
        {
          label: 'Read',
          value: (r) => r.last?.at ?? 0,
          format: (_, r) => {
            const busy = reading.has(r.post.id);
            return h('button', {
              type: 'button',
              class: 'icon-btn',
              title: busy ? 'Reading… (waits its turn in the session queue)' : 'Read results now',
              'aria-label': `Read the results of “${firstLine(r.post)}” now`,
              disabled: busy || !r.post.urn,
              onclick: () => readNow(store, r.post),
            }, refreshIcon(busy));
          },
        },
      ], rows)
      : empty('No LinkedIn post published in this period.'));
}
