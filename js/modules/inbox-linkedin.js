// Inbox → LinkedIn: the comments on the member's posts, read by the runners (tools/jobs/linkedin-comments.js) into
// linkedin.json. Each shows its author, their headline, the post it is on and when; it can be opened on LinkedIn,
// marked read, turned into a task, or answered with a reply drafted by AI that the user copies (nothing is posted).
import { h, icon, empty } from '../ui.js';
import { toast } from '../toast.js';
import { makeTask } from '../capture.js';
import { ask } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { LINKEDIN } from '../linkedin-core.js';
/** @import { Store, DataStore, LinkedinComment, LinkedinPost } from '../../types/data' */

// View state: unread only or every comment, and the reply drafts by comment id (kept while the Inbox redraws).
/** @type {{ all: boolean }} */
const view = { all: false };
/** @type {Map<string, { busy: boolean, text: string, error: string }>} */
const drafts = new Map();

/** @param {DataStore} store */
const commentsOf = (store) => store.get(LINKEDIN)?.comments ?? [];
/** @param {DataStore} store */
export const hasComments = (store) => commentsOf(store).length > 0;
// Unread comments, for the folder's count and the Inbox tab's pill.
/** @param {DataStore} store */
export const unreadComments = (store) => commentsOf(store).filter((c) => !c.read).length;

/** @param {LinkedinPost | undefined} p */
const firstLine = (p) => {
  const line = String(p?.text ?? '').split('\n').map((l) => l.trim()).find(Boolean) ?? '';
  return line.length > 90 ? `${line.slice(0, 90)}…` : line;
};

/** @param {number} at */
function when(at) {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}

/** @param {Store} store @param {string[]} ids @param {Partial<LinkedinComment>} fields */
function patch(store, ids, fields) {
  const set = new Set(ids);
  store.update(LINKEDIN, (d) => {
    for (const c of d.comments ?? []) if (set.has(c.id)) Object.assign(c, fields);
  });
}

// A task to answer the comment, in the post's project, linking to the post. The comment keeps the task's id.
/** @param {Store} store @param {LinkedinComment} c @param {LinkedinPost | undefined} post */
function makeCommentTask(store, c, post) {
  const task = makeTask({
    text: `Reply to ${c.author} on LinkedIn`,
    description: [
      `${c.author}${c.authorHeadline ? ` (${c.authorHeadline})` : ''} commented on “${firstLine(post) || 'your post'}”, ${new Date(c.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}:`,
      '',
      c.text,
      '',
      'Inbox: #/inbox?folder=linkedin',
    ].join('\n'),
    projectId: post?.projectId ?? null,
    priority: 'medium',
    ...(post?.url ? { links: [{ url: post.url, title: 'LinkedIn post' }] } : {}),
  });
  store.update('todos', (d) => d.items.push(task));
  patch(store, [c.id], { taskId: task.id, read: true });
  toast('Task added');
}

// Asks the model for a reply; the draft shows in an editable box under the comment.
/** @param {Store} store @param {LinkedinComment} c @param {LinkedinPost | undefined} post */
async function draftReply(store, c, post) {
  drafts.set(c.id, { busy: true, text: drafts.get(c.id)?.text ?? '', error: '' });
  store.refresh();
  try {
    const text = await ask(store, 'task-reply', [
      { role: 'system', content: systemPrompt(store, 'linkedin-reply') },
      {
        role: 'user',
        content: `My post:\n${post?.text ?? '(the post is not in the board any more)'}\n\nThe comment, by ${c.author}${c.authorHeadline ? ` (${c.authorHeadline})` : ''}:\n${c.text}`,
      },
    ], { projectId: post?.projectId ?? '' });
    drafts.set(c.id, { busy: false, text: text.trim(), error: '' });
  } catch (err) {
    drafts.set(c.id, { busy: false, text: drafts.get(c.id)?.text ?? '', error: /** @type {Error} */ (err).message });
  }
  store.refresh();
}

/** @param {Store} store @param {LinkedinComment} c @param {LinkedinPost | undefined} post */
function draftBox(store, c, post) {
  const d = drafts.get(c.id);
  if (!d) return null;
  if (d.busy && !d.text) return h('p', { class: 'muted small', role: 'status' }, 'Drafting a reply…');
  if (!d.text && d.error) {
    return h('div', { class: 'row li-reply' },
      h('p', { class: 'small social-error', role: 'status' }, d.error),
      h('button', { type: 'button', class: 'btn-small', onclick: () => draftReply(store, c, post) }, icon('refresh'), 'Try again'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { drafts.delete(c.id); store.refresh(); } }, 'Dismiss'));
  }
  const box = h('textarea', {
    class: 'li-reply-text',
    rows: 3,
    'aria-label': `Reply to ${c.author}`,
    // Kept as typed, without a redraw, so the field keeps focus.
    oninput: (/** @type {Event} */ ev) => {
      d.text = /** @type {HTMLTextAreaElement} */ (ev.target).value;
    },
  }, d.text);
  return h('div', { class: 'stack li-reply' },
    d.error ? h('p', { class: 'small social-error', role: 'status' }, d.error) : null,
    box,
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn-small',
        onclick: () => navigator.clipboard.writeText(box.value).then(() => toast('Reply copied. Paste it under the comment on LinkedIn.'), () => toast('Could not copy the reply.')),
      }, icon('copy'), 'Copy'),
      post?.url ? h('a', { class: 'btn-small', href: post.url, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), 'Open post') : null,
      h('button', { type: 'button', class: 'btn-small', disabled: d.busy, onclick: () => draftReply(store, c, post) }, icon('sparkle'), d.busy ? 'Drafting…' : 'Draft again'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { drafts.delete(c.id); store.refresh(); } }, 'Discard')));
}

/** @param {Store} store @param {LinkedinComment} c @param {Map<string, LinkedinPost>} posts */
function commentRow(store, c, posts) {
  const post = posts.get(c.postId);
  const task = c.taskId ? store.get('todos').items.find((t) => t.id === c.taskId) : null;
  return h('li', { class: `li-comment${c.read ? '' : ' unread'}`, 'data-id': c.id },
    h('div', { class: 'li-comment-head' },
      h('span', { class: 'social-avatar' }, icon('linkedin')),
      h('div', { class: 'li-comment-who' },
        c.authorUrl ? h('a', { href: c.authorUrl, target: '_blank', rel: 'noopener noreferrer' }, h('strong', null, c.author)) : h('strong', null, c.author),
        c.authorHeadline ? h('span', { class: 'muted small' }, c.authorHeadline) : null),
      h('span', { class: 'muted small li-comment-when', title: new Date(c.at).toLocaleString() }, when(c.at))),
    h('p', { class: 'li-comment-text' }, c.text),
    h('p', { class: 'muted small li-comment-post' }, 'On ', post?.url
      ? h('a', { href: post.url, target: '_blank', rel: 'noopener noreferrer' }, `“${firstLine(post)}”`)
      : `“${firstLine(post) || 'a post no longer in the board'}”`),
    h('div', { class: 'row li-comment-actions' },
      post?.url
        ? h('a', { class: 'btn-small', href: post.url, target: '_blank', rel: 'noopener noreferrer', onclick: () => { if (!c.read) patch(store, [c.id], { read: true }); } }, icon('link'), 'Open on LinkedIn')
        : null,
      h('button', { type: 'button', class: 'btn-small', onclick: () => patch(store, [c.id], { read: !c.read }) }, icon(c.read ? 'mail' : 'check'), c.read ? 'Mark unread' : 'Mark read'),
      task
        ? h('a', { class: 'btn-small', href: `#/todos?filter=${task.projectId ?? 'personal'}`, title: task.text }, icon('check-square'), 'Task')
        : h('button', { type: 'button', class: 'btn-small', onclick: () => makeCommentTask(store, c, post) }, icon('check-square'), 'Make task'),
      drafts.has(c.id) ? null : h('button', { type: 'button', class: 'btn-small', onclick: () => draftReply(store, c, post) }, icon('sparkle'), 'Draft reply with AI')),
    draftBox(store, c, post));
}

// The LinkedIn folder's pane, in place of the mail list.
/** @param {Store} store */
export function linkedinPane(store) {
  const all = [...commentsOf(store)].sort((a, b) => b.at - a.at);
  const unread = all.filter((c) => !c.read);
  const shown = view.all ? all : unread;
  const posts = new Map((store.get(LINKEDIN).posts ?? []).map((p) => [p.id, p]));
  /** @param {boolean} on @param {string} label @param {number} count @param {() => void} onclick */
  const chip = (on, label, count, onclick) => h('button', { type: 'button', class: on ? 'lp-chip active' : 'lp-chip', 'aria-pressed': String(on), onclick }, label, count ? h('span', { class: 'chip-count' }, count) : null);
  return h('div', { class: 'stack inbox-main' },
    h('div', { class: 'row between' },
      h('div', { class: 'row lp-filters' },
        chip(!view.all, 'Unread', unread.length, () => { view.all = false; store.refresh(); }),
        chip(view.all, 'All comments', all.length, () => { view.all = true; store.refresh(); }),
        unread.length ? h('button', { type: 'button', class: 'btn-small', onclick: () => patch(store, unread.map((c) => c.id), { read: true }) }, icon('check'), 'Mark all read') : null),
      h('span', { class: 'muted small' }, 'Comments on your posts of the last 14 days, read every 2 hours through the saved session.')),
    shown.length
      ? h('section', { class: 'card inbox-card' }, h('ul', { class: 'li-comments' }, shown.map((c) => commentRow(store, c, posts))))
      : empty(all.length ? 'No unread comment. All comments shows the ones read.' : 'No comment yet. The runners read the comments on your recent posts every 2 hours.'));
}
