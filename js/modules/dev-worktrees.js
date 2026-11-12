// @ts-check
// Dev's Worktrees panel: every git worktree of the workspace's repository, the ones `claude --worktree` makes and
// any other, each with a dot saying whether it is in use. One can be removed, or all the unused ones, or all of them.
// git keeps a worktree with changes or untracked files, so removing never loses work; its branch stays.
import { h, icon, statusOf } from '../ui.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
import { listWorktrees, removeWorktree } from '../terminal.js';
import { tasksOfWorktree, forgetWorktree } from '../task-worktrees.js';
import { baseName, panelHead, panelAction } from './dev-files.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerWorktrees, RunnerWorktree } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @import { IconName, Task } from '../../types/data' */
/** @typedef {ReturnType<typeof usageOf>} Use */
/** @typedef {[RunnerWorktree, Use]} Entry */

// The list is read again when the panel is drawn after this long, and after every removal.
const STALE_MS = 5000;

// View state: the folder, what the runner said about it, the worktrees being removed, and the last refusals.
/**
 * @type {{ path: string, data: RunnerWorktrees | null, loadError: string, loading: boolean, at: number, busy: Set<string>,
 *   errors: Map<string, string>, folded: Set<string> }}
 */
const state = { path: '', data: null, loadError: '', loading: false, at: 0, busy: new Set(), errors: new Map(), folded: new Set() };

// The panel's groups, in the order they show.
const GROUPS = [['running', 'In use'], ['held', 'Held'], ['idle', 'Not in use']];

const inside = (/** @type {string} */ path, /** @type {string} */ dir) => !!path && (path === dir || path.startsWith(`${dir}/`));

// Reads the worktrees of the repository holding `path`, unless they were read a moment ago. `force` reads them now.
/** @param {DevContext} ctx @param {string} path @param {{ force?: boolean }} [options] */
export async function refreshWorktrees(ctx, path, { force = false } = {}) {
  if (path !== state.path) Object.assign(state, { path, data: null, loadError: '', at: 0, errors: new Map() });
  if (!ctx.ready() || state.loading || (!force && Date.now() - state.at < STALE_MS)) return;
  state.loading = true;
  try {
    const data = await listWorktrees(ctx.base(), path);
    if (path === state.path) Object.assign(state, { data, loadError: '' });
  } catch (err) {
    if (path === state.path) state.loadError = /** @type {Error} */ (err).message;
  } finally {
    state.loading = false;
    state.at = Date.now();
    ctx.refresh();
  }
}

// In use (a claude or a command runs in it), held (an open task or an open terminal points at it, but nothing
// runs), or unused. `session` is the board's running terminal in it, stopped before it is removed. `why` says what
// uses or holds it when no task says so, `task` is the task it was made for, if any. `terminal` is the terminal
// linked to it, shown by its row: one the runner says runs in it, else its task's session, else one opened in its
// folder, running first. One Dev's list lost is { id, cwd, n: 0 }, listed again when shown.
/** @param {DevContext} ctx @param {RunnerWorktree} w */
function usageOf(ctx, w) {
  return { ...usageTone(ctx, w), terminal: terminalOf(ctx, w) };
}

/** @param {DevContext} ctx @param {RunnerWorktree} w */
function terminalOf(ctx, w) {
  const { worktree } = w.claude ? tasksOfWorktree(ctx.store, w.name) : { worktree: null };
  const sessions = ctx.sessions();
  const live = (w.sessions ?? []).map((r) => sessions.find((s) => s.id === r.id) ?? { id: r.id, cwd: r.cwd, n: 0, running: true });
  const linked = sessions.find((s) => s.id === worktree?.session);
  const inIt = sessions.filter((s) => inside(s.cwd, w.path));
  return live.find((s) => s.id === worktree?.session) ?? live[0] ?? (linked?.running ? linked : null) ?? inIt.find((s) => s.running) ?? linked ?? inIt[0] ?? null;
}

/** @param {DevContext} ctx @param {RunnerWorktree} w */
function usageTone(ctx, w) {
  const { worktree, tasks } = w.claude ? tasksOfWorktree(ctx.store, w.name) : { worktree: null, tasks: [] };
  const sessions = ctx.sessions();
  const session = (worktree?.session ? sessions.find((s) => s.id === worktree.session && s.running) : null)
    ?? (w.sessions?.length ? sessions.find((s) => s.id === w.sessions[0].id) ?? { id: w.sessions[0].id, n: 0 } : null);
  const open = tasks.filter((/** @type {Task} */ t) => statusOf(t) !== 'done');
  const task = open[0] ?? tasks[0] ?? null;
  const more = (open.length || tasks.length) - 1;
  if (w.running || w.commands || session) {
    const why = w.running ? `claude runs in it (pid ${w.pid})` : session ? `${session.n ? `terminal ${session.n}` : 'a terminal'} runs in it` : 'a command runs in it';
    return { tone: 'running', label: `In use: ${why}`, why, task, more, session: session?.id ?? worktree?.session ?? '' };
  }
  const terminals = sessions.filter((s) => inside(s.cwd, w.path));
  if (open.length || terminals.length) {
    const why = open.length ? `held by “${open[0].text}”${open.length > 1 ? ` and ${open.length - 1} more` : ''}` : `terminal ${terminals[0].n} is open in it`;
    return { tone: 'held', label: `Idle, ${why}`, why: open.length ? '' : why, task, more, session: worktree?.session ?? '' };
  }
  return { tone: 'idle', label: 'Not in use', why: task ? 'its task is done' : '', task, more, session: worktree?.session ?? '' };
}

/** @param {DevContext} ctx @param {RunnerWorktree} w @param {Use} use */
async function removeOne(ctx, w, use) {
  state.busy.add(w.path);
  state.errors.delete(w.path);
  ctx.refresh();
  try {
    // The panel lists worktrees only from a repository's answer.
    await removeWorktree(ctx.base(), { cwd: /** @type {RunnerWorktrees} */ (state.data).root, path: w.path, session: use.session });
    if (w.claude) forgetWorktree(ctx.store, w.name);
    return true;
  } catch (err) {
    state.errors.set(w.path, /** @type {Error} */ (err).message);
    return false;
  } finally {
    state.busy.delete(w.path);
  }
}

// One after another: git takes a lock on the repository for each removal.
/** @param {DevContext} ctx @param {Entry[]} list */
async function removeMany(ctx, list) {
  let removed = 0;
  for (const [w, use] of list) if (await removeOne(ctx, w, use)) removed++;
  const kept = list.length - removed;
  toast(kept ? `${removed} removed, ${kept} kept: see the reasons in the list` : `${removed} ${removed === 1 ? 'worktree' : 'worktrees'} removed`);
  refreshWorktrees(ctx, state.path, { force: true });
}

/** @param {DevContext} ctx @param {Entry[]} list @param {string} title */
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

// A line under a worktree's name: an icon and a text cut to the panel's width, in full on hover.
const meta = (/** @type {IconName} */ name, /** @type {string} */ text, cls = '') => h('div', { class: `wt-meta muted ${cls}`, title: text }, icon(name), h('span', { class: 'wt-meta-text' }, text));

/** @param {DevContext} ctx @param {RunnerWorktree} w @param {Use} use */
function row(ctx, w, use) {
  const busy = state.busy.has(w.path);
  const error = state.errors.get(w.path);
  /** @type {(name: IconName, title: string, onclick: () => void) => HTMLButtonElement} */
  const button = (name, title, onclick) => h('button', { type: 'button', class: 'tree-action', title, 'aria-label': `${title}: ${w.name}`, disabled: busy, onclick }, icon(name));
  const branch = w.branch && w.branch !== `worktree-${w.name}` ? w.branch : '';
  const task = use.task ? `${use.task.text}${use.more > 0 ? ` (+${use.more})` : ''}` : '';
  return h('div', { class: 'wt-item', role: 'listitem' },
    h('div', { class: 'tree-row scm-row wt-row' },
      h('div', { class: 'tree-item', title: w.path },
        h('span', { class: `wt-dot ${use.tone}`, role: 'img', 'aria-label': use.label, title: use.label }),
        h('span', { class: 'tree-name' }, w.name)),
      w.prunable ? null : use.terminal
        ? h('button', {
          type: 'button',
          class: `tree-action wt-term${use.terminal.running ? ' running' : ''}`,
          title: `Show ${use.terminal.n ? `terminal ${use.terminal.n}` : 'its terminal'}${use.terminal.running ? ', running in it' : ', open in it'}`,
          'aria-label': `Show its terminal: ${w.name}`,
          disabled: busy,
          onclick: () => ctx.showTerminal(use.terminal.id, use.terminal.cwd),
        }, icon('terminal'))
        : button('terminal', 'Open a terminal in it', () => ctx.openTerminal(w.path)),
      w.prunable ? null : ctx.cronLink({ session: use.session, worktree: w.claude ? w.name : '', runId: use.task?.cronRun }, w.name),
      busy ? h('span', { class: 'tree-action spin-icon wt-busy' }, icon('refresh')) : button('trash', 'Remove this worktree', () => {
        if (use.tone === 'running') confirmRemove(ctx, [[w, use]], 'Remove a worktree in use');
        else removeOne(ctx, w, use).then((ok) => {
          if (ok) toast(`Worktree ${w.name} removed`);
          refreshWorktrees(ctx, state.path, { force: true });
        });
      }),
      w.changes ? h('span', { class: 'scm-letter git-mod', title: `${w.changes} changed ${w.changes === 1 ? 'file' : 'files'}: git keeps it until they are committed or discarded` }, w.changes) : null),
    task ? meta('check-square', task) : null,
    branch ? meta('git-branch', branch) : w.branch ? null : meta('git-commit', w.head ? `detached at ${w.head.slice(0, 7)}` : 'no branch'),
    w.prunable ? meta('alert', 'its folder is gone: removing it cleans git up', 'wt-warn') : use.why ? meta(use.tone === 'running' ? 'activity' : 'info', use.why) : null,
    error ? h('p', { class: 'small tree-error wt-error' }, error) : null);
}

// One group of worktrees, folded or open, with its count.
/** @param {DevContext} ctx @param {string} tone @param {string} title @param {Entry[]} rows */
function group(ctx, tone, title, rows) {
  const open = !state.folded.has(tone);
  return h('div', { class: 'scm-section' },
    h('div', { class: 'tree-row scm-section-head' },
      h('button', {
        type: 'button',
        class: 'tree-item',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) state.folded.add(tone);
          else state.folded.delete(tone);
          ctx.refresh();
        },
      }, h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')), h('span', { class: `wt-dot ${tone}` }), h('span', { class: 'tree-name' }, title)),
      h('span', { class: 'scm-count' }, rows.length)),
    open ? h('div', { role: 'list' }, rows.map(([w, use]) => row(ctx, w, use))) : null);
}

/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher @param {string} path */
export function worktreesPanel(ctx, picker, switcher, path) {
  const data = state.data;
  /** @type {Entry[]} */
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
      h('div', { class: 'tree scm-list' }, GROUPS.map(([tone, title]) => {
        const rows = list.filter(([, use]) => use.tone === tone).sort(([a], [b]) => a.name.localeCompare(b.name));
        return rows.length ? group(ctx, tone, title, rows) : null;
      })));
  }
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Worktrees' },
    switcher,
    panelHead('Worktrees', panelAction('refresh', 'Read the worktrees again', () => refreshWorktrees(ctx, path, { force: true }), !ctx.ready() || state.loading)),
    h('div', { class: 'ide-explorer-head' }, picker),
    data?.root ? h('div', { class: 'tree-root muted small', title: data.root }, baseName(data.root).toUpperCase()) : null,
    body);
}
