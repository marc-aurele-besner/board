// The git worktrees Dev sessions made for tasks (task.worktrees: { name, cwd, session }). Once every task that holds
// one is completed, the command runner stops its session and removes it, wherever the tasks were completed from.
// git refuses a worktree with changes or untracked files: that one is kept, marked `kept` with git's answer, and
// tried again when its tasks are reopened and completed again.
import { removeWorktree, TERMINAL_RUNNER } from './terminal.js';
import { toast } from './toast.js';
import { statusOf } from './ui.js';
import { rememberWorktrees } from './dev-usage.js';

const COLLECTION = 'todos';
// After the runner could not be reached, wait this long before asking again.
const RETRY_MS = 60000;
const busy = new Set();
let unreachableAt = 0;

const runnerOf = (store) => store.get('dev')?.runner || TERMINAL_RUNNER;

// Each worktree with the tasks holding it.
function worktreesOf(store) {
  const all = new Map();
  for (const task of store.get(COLLECTION).items) {
    for (const w of task.worktrees ?? []) {
      if (!all.has(w.name)) all.set(w.name, { worktree: w, tasks: [] });
      all.get(w.name).tasks.push(task);
    }
  }
  return [...all.values()];
}

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

async function remove(store, { worktree, tasks }) {
  busy.add(worktree.name);
  // Its record outlives the task's entry, so what its session used is still read once it is gone.
  rememberWorktrees(store, [{ worktree, taskIds: tasks.map((t) => t.id) }]);
  try {
    const { removed } = await removeWorktree(runnerOf(store), worktree);
    forget(store, worktree.name);
    if (removed) toast(`Worktree ${worktree.name} removed: “${tasks[0].text}” is completed`);
  } catch (err) {
    if (/reach the terminal runner/.test(err.message)) unreachableAt = Date.now();
    else {
      forget(store, worktree.name, { kept: err.message });
      toast(`Worktree ${worktree.name} kept: ${err.message}`);
    }
  } finally {
    busy.delete(worktree.name);
  }
}

// The tasks holding the worktree `name`, and its record ({ name, cwd, session }), for Dev's Worktrees panel.
export function tasksOfWorktree(store, name) {
  return worktreesOf(store).find((e) => e.worktree.name === name) ?? { worktree: null, tasks: [] };
}

// A worktree removed from Dev's Worktrees panel: the tasks let it go, and what its session used is kept.
export function forgetWorktree(store, name) {
  const { worktree, tasks } = tasksOfWorktree(store, name);
  if (!worktree) return;
  rememberWorktrees(store, [{ worktree, taskIds: tasks.map((t) => t.id) }]);
  forget(store, name);
}

// Called on every store change: cheap when no task holds a worktree.
export function removeDoneWorktrees(store) {
  for (const entry of worktreesOf(store)) {
    const { worktree, tasks } = entry;
    const done = tasks.every((t) => statusOf(t) === 'done');
    if (worktree.kept) {
      if (!done) forget(store, worktree.name, { kept: undefined });
      continue;
    }
    if (!done || busy.has(worktree.name) || Date.now() - unreachableAt < RETRY_MS) continue;
    remove(store, entry);
  }
}
