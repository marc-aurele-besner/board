// Dev's Source Control, as in VS Code or Cursor: the workspace's branch, its changes (staged, not staged, in
// conflict), a commit box, sync with the remote, and recent commits. A changed file or a commit opens as a diff in
// the editor. git runs through the runner on this machine, in the repository that holds the workspace folder.
import { h, icon } from '../ui.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
import { onContextMenu, copyItem } from '../menu.js';
import { gitStatus, gitDiff, gitAction } from '../terminal.js';
import { openDiff, openFile, baseName, panelHead, panelAction } from './dev-files.js';
import { openPullRequest } from './dev-pr.js';
/** @import { DevContext, FileDecor } from '../../types/dev' */
/** @import { GitStatus, GitRepoStatus, GitFile, GitCommit } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @import { IconName } from '../../types/data' */
/** @import { MenuEntry } from '../menu.js' */

// The status is read again when the panel is drawn after this long, and after every action.
const STALE_MS = 5000;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

// View state: the folder, what git said about it, the action running, its error, the commit message per folder,
// and the folded sections.
/**
 * @type {{ path: string, status: GitStatus | null, loadError: string, loading: boolean, at: number, busy: string, error: string,
 *   messages: Map<string, string>, folded: Set<string>, decor: Map<string, FileDecor> }}
 */
const state = { path: '', status: null, loadError: '', loading: false, at: 0, busy: '', error: '', messages: new Map(), folded: new Set(['log']), decor: new Map() };

// Only called while the status is a repository's.
const fullPath = (/** @type {string} */ rel) => `${/** @type {GitRepoStatus} */ (state.status).root}/${rel}`;
const dirOf = (/** @type {string} */ rel) => rel.split('/').slice(0, -1).join('/');

// What a status letter means, and its colour in the tree and the lists.
/** @typedef {[string, string, string]} Letter A letter, its tone and what it means. */
/** @type {Record<string, Letter>} */
const LETTERS = {
  M: ['M', 'git-mod', 'Modified'],
  T: ['T', 'git-mod', 'Type changed'],
  A: ['A', 'git-new', 'Added'],
  R: ['R', 'git-mod', 'Renamed'],
  C: ['C', 'git-new', 'Copied'],
  D: ['D', 'git-del', 'Deleted'],
  '?': ['U', 'git-new', 'Untracked'],
};
/** @type {Letter} */
const CONFLICT = ['!', 'git-conflict', 'Conflict'];
const describe = (/** @type {string} */ letter) => LETTERS[letter] ?? ['M', 'git-mod', 'Modified'];

// The tree's colours: changed files by full path, and the folders holding them.
/** @param {GitStatus} status */
function buildDecor(status) {
  state.decor = new Map();
  if (!status?.repo) return;
  for (const f of status.files) {
    const [letter, tone, label] = f.conflict ? CONFLICT : describe(f.work !== '.' ? f.work : f.index);
    // An untracked folder (a nested repository) ends in a slash; the tree names it without one.
    const path = f.path.replace(/\/$/, '');
    state.decor.set(fullPath(path), { letter, tone, label });
    const parts = path.split('/');
    for (let i = parts.length - 1; i > 0; i--) {
      const dir = fullPath(parts.slice(0, i).join('/'));
      if (!state.decor.has(dir)) state.decor.set(dir, { tone: tone === 'git-conflict' ? tone : 'git-dir' });
    }
  }
}

export const decorOf = (/** @type {string} */ path) => state.decor.get(path) ?? null;
export const changeCount = () => (state.status?.repo ? state.status.files.length : 0);

// Reads the repository holding `path`, unless it was read a moment ago. `force` reads it now.
/** @param {DevContext} ctx @param {string} path @param {{ force?: boolean }} [options] */
export async function refreshGit(ctx, path, { force = false } = {}) {
  if (path !== state.path) {
    Object.assign(state, { path, status: null, loadError: '', at: 0, error: '' });
    state.decor = new Map();
  }
  if (!ctx.ready() || state.loading || (!force && Date.now() - state.at < STALE_MS)) return;
  state.loading = true;
  // A read every few seconds that finds what was shown redraws nothing: rebuilding the page each time made it flash.
  const before = JSON.stringify([state.status, state.loadError]);
  try {
    const status = await gitStatus(ctx.base(), path);
    if (path !== state.path) return;
    Object.assign(state, { status, loadError: '' });
    buildDecor(status);
  } catch (err) {
    if (path === state.path) state.loadError = /** @type {Error} */ (err).message;
  } finally {
    state.loading = false;
    state.at = Date.now();
    if (force || path !== state.path || JSON.stringify([state.status, state.loadError]) !== before) ctx.refresh();
  }
}

/** @param {DevContext} ctx @param {string} action @param {object} [body] */
async function act(ctx, action, body = {}, done = '') {
  if (state.busy) return;
  state.busy = action;
  state.error = '';
  ctx.refresh();
  try {
    await gitAction(ctx.base(), state.path, action, body);
    if (done) toast(done);
    return true;
  } catch (err) {
    state.error = /** @type {Error} */ (err).message;
    return false;
  } finally {
    state.busy = '';
    await refreshGit(ctx, state.path, { force: true });
  }
}

/** @param {DevContext} ctx @param {GitFile} f @param {boolean} staged */
function showDiff(ctx, f, staged) {
  const where = f.conflict ? 'Conflict' : staged ? 'Staged' : 'Working tree';
  openDiff(ctx, {
    key: `git:${staged ? 'staged' : 'work'}:${/** @type {GitRepoStatus} */ (state.status).root}/${f.path}`,
    name: `${baseName(f.path)} (${where.toLowerCase()})`,
    title: `${f.orig ? `${f.orig} → ` : ''}${f.path} · ${where}`,
    file: (staged ? f.index : f.work) === 'D' ? '' : fullPath(f.path),
    load: () => gitDiff(ctx.base(), { path: state.path, file: f.path, ...(f.orig && staged ? { orig: f.orig } : {}), ...(staged ? { staged: 1 } : {}), ...(f.untracked ? { untracked: 1 } : {}) }),
  });
}

/** @param {DevContext} ctx @param {GitCommit} c */
function showCommit(ctx, c) {
  openDiff(ctx, {
    key: `git:commit:${c.hash}`,
    name: c.short,
    title: c.subject,
    load: () => gitDiff(ctx.base(), { path: state.path, commit: c.hash }),
  });
}

/** @param {DevContext} ctx @param {GitFile[]} files */
function confirmDiscard(ctx, files) {
  const untracked = files.filter((f) => f.untracked).map((f) => f.path);
  const one = files.length === 1;
  const text = one
    ? files[0].untracked ? `Delete ${files[0].path}? It is not in git, so it cannot be brought back.` : `Discard the changes to ${files[0].path}? They are lost.`
    : `Discard the changes to ${files.length} files? ${untracked.length ? `${untracked.length} new ${untracked.length === 1 ? 'file is' : 'files are'} deleted. ` : ''}This cannot be undone.`;
  const dialog = openDialog({
    title: one && files[0].untracked ? 'Delete file' : 'Discard changes',
    body: h('div', { class: 'stack' },
      h('p', null, text),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn-small', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn-small danger',
          onclick: () => {
            dialog.close();
            act(ctx, 'discard', { files: files.map((f) => f.path), untracked });
          },
        }, one && files[0].untracked ? 'Delete' : 'Discard'))),
  });
}

// Switch to a branch, or create one from where the repository is now.
/** @param {DevContext} ctx */
function branchDialog(ctx) {
  // Opened from a repository's panel.
  const { branches, branch } = /** @type {GitRepoStatus} */ (state.status);
  const list = h('div', { class: 'scm-branches' });
  const draw = (/** @type {string} */ q) => list.replaceChildren(...branches.filter((b) => b.toLowerCase().includes(q.toLowerCase())).map((b) =>
    h('button', {
      type: 'button',
      class: b === branch ? 'fp-row active' : 'fp-row',
      disabled: b === branch,
      onclick: () => {
        dialog.close();
        act(ctx, 'checkout', { branch: b }, `On ${b}`);
      },
    }, icon(b === branch ? 'check' : 'git-branch'), h('span', null, b))));
  draw('');
  const dialog = openDialog({
    title: 'Branches',
    body: h('div', { class: 'stack' },
      h('input', { type: 'search', placeholder: 'Find a branch', 'aria-label': 'Find a branch', oninput: (/** @type {Event} */ e) => draw(/** @type {HTMLInputElement} */ (e.currentTarget).value) }),
      list,
      h('form', {
        class: 'row',
        onsubmit: (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          const name = String(new FormData(/** @type {HTMLFormElement} */ (e.currentTarget)).get('branch') ?? '').trim();
          if (!name) return;
          dialog.close();
          act(ctx, 'branch', { branch: name }, `Created ${name}`);
        },
      },
        h('input', { name: 'branch', placeholder: 'New branch name', autocomplete: 'off', spellcheck: false, 'aria-label': 'New branch name', class: 'grow' }),
        h('button', { type: 'submit', class: 'btn-small primary' }, icon('plus'), 'Create')),
      h('p', { class: 'muted small' }, 'Switching keeps your changes when git can carry them over; otherwise it says why it cannot.')),
  });
}

/** @param {DevContext} ctx @param {boolean} all */
function commit(ctx, all) {
  const message = (state.messages.get(state.path) ?? '').trim();
  if (!message) {
    state.error = 'Write a commit message first.';
    return ctx.refresh();
  }
  act(ctx, 'commit', { message, all }, 'Committed').then((ok) => {
    if (!ok) return;
    state.messages.delete(state.path);
    ctx.refresh();
  });
}

/** @param {DevContext} ctx @param {GitFile} f @param {'staged' | 'work'} side @returns {MenuEntry[]} */
function fileMenu(ctx, f, side) {
  const staged = side === 'staged';
  const busy = !!state.busy;
  const full = fullPath(f.path);
  const dir = dirOf(f.path);
  return [
    { label: 'Open changes', icon: () => icon('diff'), onSelect: () => showDiff(ctx, f, staged) },
    (staged ? f.index : f.work) !== 'D' ? { label: 'Open the file', icon: () => icon('file'), onSelect: () => openFile(ctx, full) } : null,
    '-',
    busy ? null : staged
      ? { label: 'Unstage', icon: () => icon('minus'), onSelect: () => act(ctx, 'unstage', { files: [f.path] }) }
      : { label: 'Stage', icon: () => icon('plus'), onSelect: () => act(ctx, 'stage', { files: [f.path] }) },
    busy || staged ? null : { label: f.untracked ? 'Delete the new file' : 'Discard the changes', icon: () => icon('undo'), danger: true, onSelect: () => confirmDiscard(ctx, [f]) },
    '-',
    { label: 'Open a terminal in its folder', icon: () => icon('terminal'), onSelect: () => ctx.openTerminal(dir ? fullPath(dir) : /** @type {GitRepoStatus} */ (state.status).root) },
    copyItem('Copy path', full),
    copyItem('Copy relative path', f.path),
  ];
}

/** @param {DevContext} ctx @param {GitCommit} c @returns {MenuEntry[]} */
const commitMenu = (ctx, c) => [
  { label: 'Open the commit', icon: () => icon('git-commit'), onSelect: () => showCommit(ctx, c) },
  '-',
  copyItem('Copy commit hash', c.hash),
  copyItem('Copy short hash', c.short),
  copyItem('Copy message', c.subject),
];

/** @param {DevContext} ctx @param {GitFile} f @param {'staged' | 'work'} side */
function fileRow(ctx, f, side) {
  const staged = side === 'staged';
  const [letter, tone, label] = f.conflict ? CONFLICT : describe(staged ? f.index : f.work === '?' ? '?' : f.work);
  const dir = dirOf(f.path);
  const busy = !!state.busy;
  /** @type {(name: IconName, title: string, onclick: () => void) => HTMLButtonElement} */
  const button = (name, title, onclick) => h('button', { type: 'button', class: 'tree-action', title, 'aria-label': `${title}: ${f.path}`, disabled: busy, onclick }, icon(name));
  return onContextMenu(h('div', { class: 'tree-row scm-row' },
    h('button', { type: 'button', class: `tree-item ${tone}`, title: `${f.orig ? `${f.orig} → ` : ''}${f.path} · ${label}`, onclick: () => showDiff(ctx, f, staged) },
      icon('file'),
      h('span', { class: 'tree-name' }, baseName(f.path)),
      dir ? h('span', { class: 'scm-dir muted' }, dir) : null),
    (staged ? f.index : f.work) !== 'D' ? button('file', 'Open the file', () => openFile(ctx, fullPath(f.path))) : null,
    side === 'work' ? button('undo', f.untracked ? 'Delete the new file' : 'Discard the changes', () => confirmDiscard(ctx, [f])) : null,
    staged ? button('minus', 'Unstage', () => act(ctx, 'unstage', { files: [f.path] })) : button('plus', 'Stage', () => act(ctx, 'stage', { files: [f.path] })),
    h('span', { class: `scm-letter ${tone}`, title: label }, letter)), () => fileMenu(ctx, f, side));
}

/** @param {DevContext} ctx @param {string} key @param {string} title @param {number | null} count @param {Child} actions @param {Child} rows */
function section(ctx, key, title, count, actions, rows) {
  const open = !state.folded.has(key);
  return h('div', { class: 'scm-section' },
    h('div', { class: 'tree-row scm-section-head' },
      h('button', {
        type: 'button',
        class: 'tree-item',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) state.folded.add(key);
          else state.folded.delete(key);
          ctx.refresh();
        },
      }, h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')), h('span', { class: 'tree-name' }, title)),
      open ? actions : null,
      count !== null ? h('span', { class: 'scm-count' }, count) : null),
    open ? rows : null);
}

const ago = (/** @type {number} */ at) => {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(at).toLocaleDateString();
};

/** @param {DevContext} ctx @param {GitRepoStatus} st */
function syncButtons(ctx, st) {
  const busy = !!state.busy;
  if (!st.remotes.length) return [];
  // The action running turns its button's icon into a spinner.
  const glyph = (/** @type {string} */ action, /** @type {IconName} */ name) => (state.busy === action ? h('span', { class: 'spin-icon' }, icon('refresh')) : icon(name));
  if (!st.upstream && st.branch) {
    return [h('button', { type: 'button', class: 'btn-small', disabled: busy || !st.oid, title: `Push ${st.branch} and track it on the remote`, onclick: () => act(ctx, 'push', {}, `Published ${st.branch}`) }, glyph('push', 'arrow-up'), 'Publish')];
  }
  if (!st.upstream) return [];
  return [
    h('button', { type: 'button', class: 'icon-btn', disabled: busy, title: 'Fetch from every remote', 'aria-label': 'Fetch', onclick: () => act(ctx, 'fetch') }, glyph('fetch', 'refresh')),
    h('button', { type: 'button', class: 'btn-small scm-sync', disabled: busy, title: `Pull from ${st.upstream} (fast-forward only)`, onclick: () => act(ctx, 'pull', {}, 'Pulled') }, glyph('pull', 'arrow-down'), String(st.behind)),
    h('button', { type: 'button', class: 'btn-small scm-sync', disabled: busy || !st.ahead, title: `Push to ${st.upstream}`, onclick: () => act(ctx, 'push', {}, 'Pushed') }, glyph('push', 'arrow-up'), String(st.ahead)),
  ];
}

/** @param {DevContext} ctx */
function repoBody(ctx) {
  // Drawn only for a repository.
  const st = /** @type {GitRepoStatus} */ (state.status);
  const conflicts = st.files.filter((f) => f.conflict);
  const staged = st.files.filter((f) => !f.conflict && !f.untracked && f.index !== '.');
  const work = st.files.filter((f) => !f.conflict && (f.untracked || f.work !== '.'));
  const busy = !!state.busy;
  const all = !staged.length;
  const branch = st.branch || (st.oid ? `detached at ${st.oid.slice(0, 7)}` : 'no branch');
  const canCommit = !busy && (staged.length || work.length) && !conflicts.length;
  const message = h('textarea', {
    name: 'commit-message',
    class: 'scm-message',
    rows: 2,
    placeholder: `Message (${isMac ? '⌘' : 'Ctrl'}+Enter to commit on ${st.branch || 'HEAD'})`,
    'aria-label': 'Commit message',
    value: state.messages.get(state.path) ?? '',
    oninput: (/** @type {Event} */ e) => state.messages.set(state.path, /** @type {HTMLTextAreaElement} */ (e.currentTarget).value),
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && canCommit) {
        e.preventDefault();
        commit(ctx, all);
      }
    },
  });
  return [
    h('div', { class: 'scm-branch' },
      h('button', { type: 'button', class: 'scm-branch-btn', disabled: busy, title: 'Switch or create a branch', onclick: () => branchDialog(ctx) }, icon('git-branch'), h('span', null, branch)),
      ...syncButtons(ctx, st)),
    h('div', { class: 'scm-commit' },
      message,
      h('button', {
        type: 'button',
        class: 'btn-small primary',
        disabled: !canCommit,
        title: conflicts.length ? 'Resolve the conflicts first' : all ? 'Stage every change and commit it' : 'Commit the staged changes',
        onclick: () => commit(ctx, all),
      }, state.busy === 'commit' ? h('span', { class: 'spin-icon' }, icon('refresh')) : icon('check'), all && work.length ? 'Commit all' : 'Commit')),
    state.error ? h('div', { class: 'scm-error small', role: 'alert' },
      h('span', null, state.error),
      h('button', { type: 'button', class: 'term-close', 'aria-label': 'Dismiss', onclick: () => { state.error = ''; ctx.refresh(); } }, icon('x'))) : null,
    h('div', { class: 'tree scm-list' },
      conflicts.length ? section(ctx, 'conflicts', 'Merge conflicts', conflicts.length, null, conflicts.map((f) => fileRow(ctx, f, 'work'))) : null,
      staged.length ? section(ctx, 'staged', 'Staged changes', staged.length,
        h('button', { type: 'button', class: 'tree-action', title: 'Unstage all', 'aria-label': 'Unstage all', disabled: busy, onclick: () => act(ctx, 'unstage-all') }, icon('minus')),
        staged.map((f) => fileRow(ctx, f, 'staged'))) : null,
      section(ctx, 'work', 'Changes', work.length,
        work.length ? [
          h('button', { type: 'button', class: 'tree-action', title: 'Discard all changes', 'aria-label': 'Discard all changes', disabled: busy, onclick: () => confirmDiscard(ctx, work) }, icon('undo')),
          h('button', { type: 'button', class: 'tree-action', title: 'Stage all changes', 'aria-label': 'Stage all changes', disabled: busy, onclick: () => act(ctx, 'stage-all') }, icon('plus')),
        ] : null,
        work.length ? work.map((f) => fileRow(ctx, f, 'work')) : h('div', { class: 'tree-note muted small' }, staged.length ? 'Everything is staged.' : 'No changes.')),
      st.more ? h('div', { class: 'tree-note muted small' }, `${st.more} more changed files not listed.`) : null,
      section(ctx, 'log', 'Commits', null, null,
        st.log.length
          ? st.log.map((c) => onContextMenu(h('div', { class: 'tree-row scm-row' },
              h('button', { type: 'button', class: 'tree-item', title: `${c.subject}\n${c.author} · ${new Date(c.at).toLocaleString()} · ${c.short}`, onclick: () => showCommit(ctx, c) },
                icon('git-commit'),
                h('span', { class: 'tree-name' }, c.subject),
                c.refs.length ? h('span', { class: 'scm-refs' }, c.refs.map((r) => r.replace(/^HEAD -> /, '')).join(', ')) : null,
                h('span', { class: 'scm-dir muted' }, ago(c.at)))), () => commitMenu(ctx, c)))
          : h('div', { class: 'tree-note muted small' }, 'No commits yet.'))),
  ];
}

// The Source Control side panel. `picker` chooses the workspace, `switcher` the side panel.
/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher @param {string} path */
export function sourceControl(ctx, picker, switcher, path) {
  const st = state.status;
  let body;
  if (!ctx.ready()) body = h('p', { class: 'muted small' }, 'Source control shows once the runner answers.');
  else if (state.loadError) body = h('p', { class: 'small tree-error' }, state.loadError);
  else if (!st) body = h('p', { class: 'muted small' }, 'Reading the repository…');
  else if (!st.repo) {
    body = h('div', { class: 'stack scm-empty' },
      h('p', { class: 'muted small' }, 'This folder is not in a git repository.'),
      h('button', { type: 'button', class: 'btn-small', disabled: !!state.busy, onclick: () => act(ctx, 'init', {}, 'Repository created') }, icon('git-branch'), 'Initialize repository'),
      state.error ? h('p', { class: 'small tree-error' }, state.error) : null);
  } else body = repoBody(ctx);
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Source control' },
    switcher,
    panelHead('Source control',
      st?.repo ? panelAction('git-pull-request', 'Review the branch as a pull request', () => openPullRequest(ctx, path), !ctx.ready()) : null,
      panelAction('refresh', 'Read the repository again', () => refreshGit(ctx, path, { force: true }), !ctx.ready() || state.loading)),
    h('div', { class: 'ide-explorer-head' }, picker),
    st?.repo ? h('div', { class: 'tree-root muted small', title: st.root }, baseName(st.root).toUpperCase()) : null,
    body);
}
