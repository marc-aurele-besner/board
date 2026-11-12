// Work that runs by itself while the board is open: Cron flows,
// removing the worktrees of completed tasks, and reading what their claude sessions used.
// Nothing here runs when the board is closed. The runners (tools/worker.js) take this work over, job by job.
import { runDueFlows } from './cron.js';
import { removeDoneWorktrees } from './task-worktrees.js';
import { refreshDevUsage } from './dev-usage.js';

const MINUTE = 60000;
let started = false;

export function startBackground(store) {
  if (started) return;
  started = true;
  const quiet = (work) => () => Promise.resolve().then(work).catch((err) => console.warn('Background work failed', err));
  const cron = quiet(() => runDueFlows(store));
  // Start after the first paint, so opening the board is never held up by the network.
  const devUsage = quiet(() => refreshDevUsage(store));
  setTimeout(cron, 4000);
  setTimeout(devUsage, 5000);
  setInterval(cron, MINUTE);
  setInterval(devUsage, MINUTE);
  // A task completed anywhere (Tasks, the palette, another tab's save) gives back the worktree its Dev session made.
  store.subscribe(() => removeDoneWorktrees(store));
  setTimeout(() => removeDoneWorktrees(store), 2000);
}
