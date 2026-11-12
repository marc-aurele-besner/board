// The git worktrees Dev sessions made for tasks (task.worktrees: { name, cwd, session }). Once every task that holds
// one is completed, the runners ask the command runner to stop its session and remove it, wherever the tasks were
// completed from.
// git refuses a worktree with changes or untracked files: that one is kept, marked `kept` with git's answer, and
// tried again when its tasks are reopened and completed again.
/** @import { DataStore, Task, TaskWorktree } from '../types/data' */
/** @typedef {{ worktree: TaskWorktree, tasks: Task[] }} WorktreeEntry */
import { removeWorktree, TERMINAL_RUNNER } from './terminal.js';
import { toast } from './toast.js';
import { statusOf } from './ui.js';
import { rememberWorktrees } from './dev-usage.js';

const COLLECTION = 'todos';
// After the runner could not be reached, wait this long before asking again.
const RETRY_MS = 60000;
/** @type {Set<string>} */
const busy = new Set();
let unreachableAt = 0;

/** @param {DataStore} store */
const runnerOf = (store) => store.get('dev')?.runner || TERMINAL_RUNNER;

// Each worktree with the tasks holding it.
/** @param {DataStore} store */
function worktreesOf(store) {
  /** @type {Map<string, WorktreeEntry>} */
  const all = new Map();
  for (const task of store.get(COLLECTION).items) {
    for (const w of task.worktrees ?? []) {
      if (!all.has(w.name)) all.set(w.name, { worktree: w, tasks: [] });
      /** @type {WorktreeEntry} */ (all.get(w.name)).tasks.push(task);
    }
  }
  return [...all.values()];
}

/** @param {DataStore} store @param {string} name @param {Partial<TaskWorktree>} [patch] */
function forget(store, name, patch) {
  store.update(COLLECTION, (d) => {
    for (const task of d.items) {
      if (!task.worktrees?.some((w) => w.name === name)) continue;
      if (patch) task.worktrees = task.worktrees.map((w) => (w.name === name ? { ...w, ...patch } : w));
      else task.worktrees = task.worktrees.filter((w) => w.name !== name);
      if (!task.worktrees.length) delete task.worktrees;
    }
  });
}

/** @param {DataStore} store @param {WorktreeEntry} entry @param {(message: string) => void} say */
async function remove(store, { worktree, tasks }, say) {
  busy.add(worktree.name);
  // Its record outlives the task's entry, so what its session used is still read once it is gone.
  rememberWorktrees(store, [{ worktree, taskIds: tasks.map((t) => t.id) }]);
  try {
    // removeWorktree() takes a worktree by name or by path; terminal.js does not mark `path` optional yet.
    const { removed } = await removeWorktree(runnerOf(store), /** @type {Parameters<typeof removeWorktree>[1]} */ (worktree));
    forget(store, worktree.name);
    if (removed) say(`Worktree ${worktree.name} removed: “${tasks[0].text}” is completed`);
  } catch (err) {
    if (/reach the terminal runner/.test(/** @type {Error} */ (err).message)) unreachableAt = Date.now();
    else {
      forget(store, worktree.name, { kept: /** @type {Error} */ (err).message });
      say(`Worktree ${worktree.name} kept: ${/** @type {Error} */ (err).message}`);
    }
  } finally {
    busy.delete(worktree.name);
  }
}

// The tasks holding the worktree `name`, and its record ({ name, cwd, session }), for Dev's Worktrees panel.
/** @param {DataStore} store @param {string} name @returns {{ worktree: TaskWorktree | null, tasks: Task[] }} */
export function tasksOfWorktree(store, name) {
  return worktreesOf(store).find((e) => e.worktree.name === name) ?? { worktree: null, tasks: [] };
}

// A worktree removed from Dev's Worktrees panel: the tasks let it go, and what its session used is kept.
/** @param {DataStore} store @param {string} name */
export function forgetWorktree(store, name) {
  const { worktree, tasks } = tasksOfWorktree(store, name);
  if (!worktree) return;
  rememberWorktrees(store, [{ worktree, taskIds: tasks.map((t) => t.id) }]);
  forget(store, name);
}

// The runners' job (tools/jobs/worktrees.js), when todos.json changes and every 5 minutes: cheap when no task holds a
// worktree. `say` reports what happened (the runners log it). Returns the removals started, which it awaits.
/** @param {DataStore} store @param {(message: string) => void} [say] */
export function removeDoneWorktrees(store, say = toast) {
  /** @type {Promise<void>[]} */
  const started = [];
  for (const entry of worktreesOf(store)) {
    const { worktree, tasks } = entry;
    const done = tasks.every((t) => statusOf(t) === 'done');
    if (worktree.kept) {
      if (!done) forget(store, worktree.name, { kept: undefined });
      continue;
    }
    if (!done || busy.has(worktree.name) || Date.now() - unreachableAt < RETRY_MS) continue;
    started.push(remove(store, entry, say));
  }
  return Promise.all(started);
}
