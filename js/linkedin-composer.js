// The LinkedIn post composer: a task's (or a project's) post, its text and link, a preview of how it shows in the
// feed, and Save draft or Post now. Opened from a task, from Calendar and from a project's LinkedIn tab.
import { h, icon } from './ui.js';
import { openDialog } from './modal.js';
import { toast } from './toast.js';
import { LINKEDIN, POST_LIMIT, linkedinDraftOf, makePost, signedIn } from './linkedin-core.js';
import { postNow } from './linkedin.js';
/** @import { Store, LinkedinPost } from '../types/data' */

// LinkedIn folds a post after about three lines; this many characters is close to it.
const FOLD = 210;

/** @param {string} link */
const hostOf = (link) => {
  try {
    return new URL(link).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// The post a task already has and that is still being written, so opening the composer again goes on with it.
/** @param {Store} store @param {string} taskId */
const openPostOf = (store, taskId) => store.get(LINKEDIN).posts.find((p) => p.taskId === taskId && ['draft', 'failed'].includes(p.status));

/**
 * @param {Store} store
 * @param {{ postId?: string, taskId?: string, projectId?: string | null }} from
 */
export function openLinkedinComposer(store, { postId, taskId, projectId }) {
  const task = taskId ? store.get('todos').items.find((t) => t.id === taskId) : undefined;
  const saved = postId ? store.get(LINKEDIN).posts.find((p) => p.id === postId) : taskId ? openPostOf(store, taskId) : undefined;
  /** @type {LinkedinPost} */
  const post = saved ? { ...saved } : makePost({
    taskId: taskId ?? null,
    projectId: task ? task.projectId : projectId ?? null,
    text: task ? linkedinDraftOf(task.description) : '',
  });
  const auth = store.get(LINKEDIN).auth;
  const live = signedIn(auth);
  const posted = post.status === 'posted';

  const text = h('textarea', { name: 'text', rows: 10, class: 'li-text', value: post.text, placeholder: 'What do you want to talk about?', 'aria-label': 'Post text', readonly: posted });
  const link = h('input', { name: 'link', type: 'url', value: post.link ?? '', placeholder: 'https://… (optional)', 'aria-label': 'Link to share', autocomplete: 'off', readonly: posted });
  const counter = h('span', { class: 'small muted li-count', 'aria-live': 'polite' });
  const preview = h('div', { class: 'li-preview', 'aria-label': 'Preview' });
  const status = h('p', { class: 'small', role: 'status' });
  /** @param {string} message @param {boolean} [ok] */
  const say = (message, ok = true) => {
    status.textContent = message;
    status.className = `small ${ok ? 'muted' : 'error'}`;
  };
  if (post.status === 'failed' && post.error) say(`The last try failed: ${post.error}`, false);

  let open = false;
  const paint = () => {
    const value = text.value;
    counter.textContent = `${value.length.toLocaleString()} / ${POST_LIMIT.toLocaleString()}`;
    counter.classList.toggle('error', value.length > POST_LIMIT);
    const host = hostOf(link.value.trim());
    const long = value.length > FOLD && !open;
    preview.replaceChildren(
      h('div', { class: 'li-preview-head' },
        auth?.picture
          ? h('img', { class: 'li-avatar', src: auth.picture, alt: '', referrerpolicy: 'no-referrer' })
          : h('span', { class: 'li-avatar' }, icon('linkedin')),
        h('div', { class: 'li-preview-who' },
          h('strong', null, auth?.name || 'You'),
          h('span', { class: 'muted small' }, 'Now · ', icon('globe')))),
      h('div', { class: 'li-preview-text' },
        value.trim() ? (long ? value.slice(0, FOLD).trimEnd() : value) : h('span', { class: 'muted' }, 'The post’s text shows here.'),
        long ? h('button', { type: 'button', class: 'btn-link-inline muted', onclick: () => { open = true; paint(); } }, '…more') : null));
    if (host) {
      preview.append(h('div', { class: 'share li-preview-link' },
        h('div', { class: 'share-img none' }, icon('link')),
        h('div', { class: 'share-text' }, h('strong', null, host), h('span', { class: 'muted small' }, link.value.trim()))));
    }
  };
  text.addEventListener('input', paint);
  link.addEventListener('input', paint);
  paint();

  // Saves the post as it stands in the fields, with any extra fields; the first save adds it.
  /** @param {Partial<LinkedinPost>} [patch] */
  const save = (patch = {}) => {
    Object.assign(post, { text: text.value.trim(), link: link.value.trim(), ...patch, updatedAt: Date.now() });
    store.update(LINKEDIN, (d) => {
      const at = d.posts.findIndex((p) => p.id === post.id);
      if (at < 0) d.posts.push({ ...post });
      else d.posts[at] = { ...d.posts[at], ...post };
    });
  };
  const check = () => {
    if (!text.value.trim()) return 'Write the post first.';
    if (text.value.length > POST_LIMIT) return `LinkedIn takes at most ${POST_LIMIT.toLocaleString()} characters.`;
    if (link.value.trim() && !hostOf(link.value.trim())) return 'The link is not a full address (https://…).';
    return '';
  };

  const postButton = h('button', {
    type: 'button',
    class: 'primary',
    disabled: !live || posted,
    title: live ? 'Post on LinkedIn now, as you' : 'Sign in with LinkedIn in Settings → LinkedIn first',
    onclick: async () => {
      const problem = check();
      if (problem) return say(problem, false);
      save({ status: 'draft', scheduledAt: null, error: null });
      postButton.disabled = true;
      say('Posting…');
      try {
        const done = await postNow(store, post.id);
        if (done.status === 'posted') {
          dialog.close();
          toast(post.taskId ? 'Posted on LinkedIn. The task has its link and is done.' : 'Posted on LinkedIn');
          return;
        }
        say(done.error || 'LinkedIn did not take the post.', false);
      } catch (err) {
        say(/** @type {Error} */ (err).message, false);
      }
      postButton.disabled = false;
    },
  }, icon('send'), 'Post now');

  const body = h('form', {
    class: 'li-composer',
    onsubmit: (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      if (!text.value.trim()) return say('Write the post first.', false);
      save(post.status === 'failed' ? { status: 'draft', error: null } : {});
      dialog.close();
      toast('LinkedIn draft saved');
    },
  },
    h('div', { class: 'li-composer-cols' },
      h('div', { class: 'stack-sm' },
        h('label', { class: 'stack-sm' }, h('span', { class: 'row between' }, h('span', { class: 'small' }, 'Post'), counter), text),
        h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'Link'), link),
        task ? h('p', { class: 'muted small' }, 'From the task “', task.text, '”. Once posted, the task gets the post’s link and is done.') : null),
      h('div', { class: 'stack-sm' }, h('span', { class: 'small' }, 'Preview'), preview)),
    live ? null : h('p', { class: 'small error' }, 'Not signed in: ', h('a', { href: '#/settings?section=linkedin', onclick: () => dialog.close() }, 'sign in with LinkedIn'), ' to post. Drafts can still be saved.'),
    status,
    posted
      ? h('div', { class: 'svc-actions' }, post.url ? h('a', { class: 'btn-small', href: post.url, target: '_blank', rel: 'noopener' }, icon('linkedin'), 'Open on LinkedIn') : null)
      : h('div', { class: 'svc-actions' },
          h('button', { type: 'submit' }, 'Save draft'),
          postButton));
  const dialog = openDialog({ title: posted ? 'LinkedIn post' : saved ? 'Edit LinkedIn post' : 'New LinkedIn post', body, wide: true });
  requestAnimationFrame(() => text.focus());
  return dialog;
}
