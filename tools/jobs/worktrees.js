// Gives back the git worktree a Dev session made for a task once every task holding it is completed: the command
// runner stops its session and removes it. Runs when todos.json changes (a task completed in any tab) and every
// 5 minutes. It asks the runner over HTTP with a local Origin, which the runner requires.
/** @import { FSWatcher } from 'node:fs' */
/** @import { Job } from '../../types/runner' */
import { watch } from 'node:fs';
import { removeDoneWorktrees } from '../../js/task-worktrees.js';
import { useRunnerOrigin } from '../../js/terminal.js';

/** @type {FSWatcher | null} */
let watcher = null;

export default /** @satisfies {Job} */ ({
  id: 'worktrees',
  delay: 2000,
  timeout: 2 * 60000,
  setup(store, { kick }) {
    useRunnerOrigin('http://localhost');
    watcher?.close();
    // The folder, not the file: tabs and the worker replace todos.json whole, which ends a watch on the file itself.
    watcher = watch(store.dir, (_event, name) => name === 'todos.json' && kick());
  },
  async run({ store, log }) {
    const said = [];
    await removeDoneWorktrees(store, (text) => {
      said.push(text);
      log.info(text);
    });
    return said.length ? { removed: said.length } : {};
  },
});
