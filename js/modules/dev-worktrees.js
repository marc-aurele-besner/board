// Dev's Worktrees panel: every git worktree of the workspace's repository, the ones `claude --worktree` makes and
// any other, each with a dot saying whether it is in use. One can be removed, or all the unused ones, or all of them.
// git keeps a worktree with changes or untracked files, so removing never loses work; its branch stays.
import { h, icon, statusOf } from '../ui.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
import { listWorktrees, removeWorktree } from '../terminal.js';
import { tasksOfWorktree, forgetWorktree } from '../task-worktrees.js';
import { baseName, panelHead, panelAction } from './dev-files.js';

// The list is read again when the panel is drawn after this long, and after every removal.
const STALE_MS = 5000;

// View state: the folder, what the runner said about it, the worktrees being removed, and the last refusals.
const state = { path: '', data: null, loadError: '', loading: false, at: 0, busy: new Set(), errors: new Map() };

const inside = (path, dir) => !!path && (path === dir || path.startsWith(`${dir}/`));

// Reads the worktrees of the repository holding `path`, unless they were read a moment ago. `force` reads them now.
export async function refreshWorktrees(ctx, path, { force = false } = {}) {
  if (path !== state.path) Object.assign(state, { path, data: null, loadError: '', at: 0, errors: new Map() });
  if (!ctx.ready() || state.loading || (!force && Date.now() - state.at < STALE_MS)) return;
  state.loading = true;
  try {
    const data = await listWorktrees(ctx.base(), path);
    if (path === state.path) Object.assign(state, { data, loadError: '' });
  } catch (err) {
    if (path === state.path) state.loadError = err.message;
  } finally {
    state.loading = false;
    state.at = Date.now();
    ctx.refresh();
  }
}

// In use (a claude or a command runs in it), held (an open task or an open terminal points at it, but nothing
// runs), or unused. `session` is the board's running terminal in it, stopped before it is removed.
function usageOf(ctx, w) {
  const { worktree, tasks } = w.claude ? tasksOfWorktree(ctx.store, w.name) : { worktree: null, tasks: [] };
  const sessions = ctx.sessions();
  const session = worktree?.session ? sessions.find((s) => s.id === worktree.session && s.running) : null;
  const open = tasks.filter((t) => statusOf(t) !== 'done');
  if (w.running || w.commands || session) {
    const why = w.running ? `claude runs in it (pid ${w.pid})` : session ? `terminal ${session.n} runs in it` : 'a command runs in it';
    return { tone: 'running', label: `In use: ${why}`, session: session?.id ?? worktree?.session ?? '' };
  }
  const terminals = sessions.filter((s) => inside(s.cwd, w.path));
  if (open.length || terminals.length) {
    const why = open.length ? `held by “${open[0].text}”${open.length > 1 ? ` and ${open.length - 1} more` : ''}` : `terminal ${terminals[0].n} is open in it`;
    return { tone: 'held', label: `Idle, ${why}`, session: worktree?.session ?? '' };
  }
  return { tone: 'idle', label: 'Not in use', session: worktree?.session ?? '' };
}

async function removeOne(ctx, w, use) {
  state.busy.add(w.path);
  state.errors.delete(w.path);
  ctx.refresh();
  try {
    await removeWorktree(ctx.base(), { cwd: state.data.root, path: w.path, session: use.session });
    if (w.claude) forgetWorktree(ctx.store, w.name);
    return true;
  } catch (err) {
    state.errors.set(w.path, err.message);
    return false;
  } finally {
    state.busy.delete(w.path);
  }
}

// One after another: git takes a lock on the repository for each removal.
async function removeMany(ctx, list) {
  let removed = 0;
  for (const [w, use] of list) if (await removeOne(ctx, w, use)) removed++;
  const kept = list.length - removed;
  toast(kept ? `${removed} removed, ${kept} kept: see the reasons in the list` : `${removed} ${removed === 1 ? 'worktree' : 'worktrees'} removed`);
  refreshWorktrees(ctx, state.path, { force: true });
}

function confirmRemove(ctx, list, title) {
  const running = list.filter(([, use]) => use.tone === 'running').length;
  const held = list.filter(([, use]) => use.tone === 'held').length;
  const notes = [
    running ? `${running} in use: the board's terminal running in it is stopped; a claude started elsewhere keeps its worktree.` : '',
    held ? `${held} still held by an open task or terminal.` : '',
    'git keeps a worktree with changes or untracked files. Branches are kept.',
  ].filter(Boolean);
  const dialog = openDialog({
    title,
    body: h('div', { class: 'stack' },
      h('p', null, `Remove ${list.length} ${list.length === 1 ? 'worktree' : 'worktrees'}?`),
      notes.map((n) => h('p', { class: 'muted small' }, n)),
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn-small', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn-small danger',
          onclick: () => {
            dialog.close();
            removeMany(ctx, list);
          },
        }, 'Remove'))),
  });
}

function row(ctx, w, use) {
  const busy = state.busy.has(w.path);
  const error = state.errors.get(w.path);
  const button = (name, title, onclick) => h('button', { type: 'button', class: 'tree-action', title, 'aria-label': `${title}: ${w.name}`, disabled: busy, onclick }, icon(name));
  const branch = w.branch && w.branch !== `worktree-${w.name}` ? w.branch : '';
  return h('div', { class: 'wt-item' },
    h('div', { class: 'tree-row scm-row wt-row' },
      h('div', { class: 'tree-item', title: `${w.path}${w.branch ? ` · ${w.branch}` : ''}` },
        h('span', { class: `wt-dot ${use.tone}`, role: 'img', 'aria-label': use.label, title: use.label }),
        h('span', { class: 'tree-name' }, w.name),
        branch ? h('span', { class: 'scm-dir muted' }, branch) : null),
      w.prunable ? null : button('terminal', 'Open a terminal in it', () => ctx.openTerminal(w.path)),
      busy ? h('span', { class: 'tree-action spin-icon wt-busy' }, icon('refresh')) : button('trash', 'Remove this worktree', () => {
        if (use.tone === 'running') confirmRemove(ctx, [[w, use]], 'Remove a worktree in use');
        else removeOne(ctx, w, use).then((ok) => {
          if (ok) toast(`Worktree ${w.name} removed`);
          refreshWorktrees(ctx, state.path, { force: true });
        });
      }),
      w.changes ? h('span', { class: 'scm-letter git-mod', title: `${w.changes} changed ${w.changes === 1 ? 'file' : 'files'}: git keeps it until they are committed or discarded` }, w.changes) : null),
    error ? h('p', { class: 'small tree-error wt-error' }, error) : null);
}

export function worktreesPanel(ctx, picker, switcher, path) {
  const data = state.data;
  const list = data?.worktrees?.map((w) => [w, usageOf(ctx, w)]) ?? [];
  const unused = list.filter(([, use]) => use.tone === 'idle');
  const busy = state.busy.size > 0;
  let body;
  if (!ctx.ready()) body = h('p', { class: 'muted small' }, 'Worktrees show once the runner answers.');
  else if (state.loadError) body = h('p', { class: 'small tree-error' }, state.loadError);
  else if (!data) body = h('p', { class: 'muted small' }, 'Reading the worktrees…');
  else if (data.repo === false) body = h('p', { class: 'muted small' }, 'This folder is not in a git repository.');
  else if (!list.length) body = h('p', { class: 'muted small' }, 'No worktrees besides the main checkout.');
  else {
    body = h('div', { class: 'stack wt' },
      h('div', { class: 'row wt-actions' },
        h('button', { type: 'button', class: 'btn-small', disabled: busy || !unused.length, title: 'Remove the worktrees nothing uses: no claude or command runs in them, and no open task or terminal points at them', onclick: () => confirmRemove(ctx, unused, 'Remove unused worktrees') }, icon('trash'), `Remove unused${unused.length ? ` (${unused.length})` : ''}`),
        h('button', { type: 'button', class: 'btn-small danger', disabled: busy, title: 'Remove every worktree but the main checkout', onclick: () => confirmRemove(ctx, list, 'Remove all worktrees') }, icon('trash'), 'Remove all')),
      h('div', { class: 'tree scm-list', role: 'list' }, list.map(([w, use]) => row(ctx, w, use))));
  }
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Worktrees' },
    switcher,
    panelHead('Worktrees', panelAction('refresh', 'Read the worktrees again', () => refreshWorktrees(ctx, path, { force: true }), !ctx.ready() || state.loading)),
    h('div', { class: 'ide-explorer-head' }, picker),
    data?.root ? h('div', { class: 'tree-root muted small', title: data.root }, baseName(data.root).toUpperCase()) : null,
    body);
}
