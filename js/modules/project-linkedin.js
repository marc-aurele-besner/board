// The LinkedIn block of a project's page: its posts as Drafts, Scheduled and Posted (with their latest results),
// New post, and each post's actions. Writing, scheduling and editing happen in the composer.
import { h, icon } from '../ui.js';
import { toast } from '../toast.js';
import { LINKEDIN, latestMetrics, signedIn } from '../linkedin-core.js';
import { openLinkedinComposer, whenText } from '../linkedin-composer.js';
import { postNow } from '../linkedin.js';
import { numberLocale } from '../locale.js';
/** @import { Store, Project, LinkedinPost } from '../../types/data' */

// Posts being posted from here now, so their row shows it.
/** @type {Set<string>} */
const posting = new Set();
const count = { format: (/** @type {number} */ n) => n.toLocaleString(numberLocale()) };

/** @param {Store} store @param {LinkedinPost} p */
function postNowFromList(store, p) {
  posting.add(p.id);
  store.refresh();
  postNow(store, p.id)
    .then((done) => toast(done.status === 'posted' ? 'Posted on LinkedIn' : `Not posted: ${done.error ?? 'LinkedIn did not take it.'}`))
    .catch((err) => toast(`Not posted: ${/** @type {Error} */ (err).message}`))
    .finally(() => {
      posting.delete(p.id);
      store.refresh();
    });
}

/** @param {Store} store @param {LinkedinPost} p */
function remove(store, p) {
  const all = store.get(LINKEDIN).posts;
  const at = all.findIndex((x) => x.id === p.id);
  store.update(LINKEDIN, (d) => {
    d.posts = d.posts.filter((x) => x.id !== p.id);
  });
  toast('Draft deleted', { undo: () => store.update(LINKEDIN, (d) => d.posts.splice(Math.min(at, d.posts.length), 0, p)) });
}

// "12 reactions · 2 comments · 1 repost · 800 impressions", from the post's last read.
/** @param {LinkedinPost} p */
function metricsLine(p) {
  const m = latestMetrics(p);
  if (!m) return 'No results read yet.';
  /** @type {[number | undefined, string][]} */
  const parts = [[m.reactions, 'reaction'], [m.comments, 'comment'], [m.reposts, 'repost'], [m.impressions, 'impression']];
  return parts.filter(([n]) => typeof n === 'number').map(([n, word]) => `${count.format(Number(n))} ${word}${n === 1 ? '' : 's'}`).join(' · ');
}

/** @param {Store} store @param {LinkedinPost} p @param {boolean} live */
function postRow(store, p, live) {
  const line = p.text.split('\n').find((l) => l.trim())?.trim() || 'Empty post';
  const busy = posting.has(p.id) || p.status === 'posting';
  const out = p.status === 'posted';
  const meta = out
    ? `${p.postedAt ? `Posted ${whenText(p.postedAt)} · ` : ''}${metricsLine(p)}`
    : p.status === 'scheduled' && p.scheduledAt ? `Scheduled for ${whenText(p.scheduledAt)}`
      : p.status === 'missed' && p.scheduledAt ? `Missed: it was due ${whenText(p.scheduledAt)}`
        : p.status === 'failed' ? `Failed: ${p.error ?? 'LinkedIn did not take it.'}`
          : busy ? 'Posting…' : `Draft, ${p.text.length.toLocaleString(numberLocale())} characters`;
  const edit = () => openLinkedinComposer(store, { postId: p.id });
  return h('li', { class: 'li-post-row' },
    h('button', { type: 'button', class: 'li-post-main', title: out ? 'Show the post' : 'Edit the post', onclick: edit },
      h('span', { class: 'li-post-text' }, line),
      h('span', { class: `small ${p.status === 'failed' || p.status === 'missed' ? 'error' : 'muted'}` }, meta)),
    h('div', { class: 'row li-post-actions' },
      out
        ? (p.url ? h('a', { class: 'icon-btn', href: p.url, target: '_blank', rel: 'noopener', title: 'Open on LinkedIn', 'aria-label': 'Open on LinkedIn' }, icon('linkedin')) : null)
        : [
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit the post', onclick: edit }, icon('pencil')),
            h('button', { type: 'button', class: 'icon-btn', title: p.status === 'scheduled' ? 'Reschedule' : 'Schedule', 'aria-label': p.status === 'scheduled' ? 'Reschedule the post' : 'Schedule the post', onclick: edit }, icon('clock')),
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: live ? 'Post now' : 'Sign in with LinkedIn in Settings → LinkedIn first',
              'aria-label': 'Post now',
              disabled: !live || busy,
              onclick: () => postNowFromList(store, p),
            }, icon('send')),
            p.status !== 'scheduled'
              ? h('button', { type: 'button', class: 'icon-btn', title: 'Delete the draft', 'aria-label': 'Delete the draft', disabled: busy, onclick: () => remove(store, p) }, icon('trash'))
              : null,
          ]));
}

/** @param {Store} store @param {Project} p */
export function linkedinBlock(store, p) {
  const data = store.get(LINKEDIN);
  const live = signedIn(data.auth);
  const posts = data.posts.filter((x) => x.projectId === p.id);
  const drafts = posts.filter((x) => ['draft', 'failed', 'missed', 'posting'].includes(x.status)).sort((a, b) => (b.updatedAt ?? b.createdAt) - (a.updatedAt ?? a.createdAt));
  const scheduled = posts.filter((x) => x.status === 'scheduled').sort((a, b) => Number(a.scheduledAt) - Number(b.scheduledAt));
  const posted = posts.filter((x) => x.status === 'posted').sort((a, b) => Number(b.postedAt) - Number(a.postedAt));
  /** @param {string} title @param {LinkedinPost[]} list */
  const group = (title, list) => (list.length
    ? h('div', { class: 'li-post-group' },
        h('h4', { class: 'small muted' }, `${title} (${list.length})`),
        h('ul', { class: 'li-post-list' }, list.map((x) => postRow(store, x, live))))
    : null);
  return h('section', { class: 'pp-block li-project' },
    h('div', { class: 'row between' },
      h('h3', null, 'LinkedIn'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => openLinkedinComposer(store, { projectId: p.id }) }, icon('plus'), 'New post')),
    posts.length
      ? [group('Drafts', drafts), group('Scheduled', scheduled), group('Posted', posted)]
      : h('p', { class: 'muted small' }, 'Posts written for this project, scheduled or posted on LinkedIn as you.'),
    live ? null : h('p', { class: 'muted small' }, h('a', { href: '#/settings?section=linkedin' }, 'Sign in with LinkedIn'), ' to post; drafts can be written meanwhile.'));
}
