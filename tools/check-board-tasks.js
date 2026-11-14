// A Dev session's tasks (tools/worker/tasks.js): what it may read and change, its limit, and a tab's write meanwhile.
// `node tools/check-board-tasks.js`: exits 1 when a rule does not hold.
/** @import { Task } from '../types/data' */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNodeStore } from './worker/store.js';
import { addTask, editTask, listTasks, showTask, SESSION_TASK_LIMIT, DEV_AUTO } from './worker/tasks.js';

const dir = mkdtempSync(join(tmpdir(), 'board-tasks-'));
const file = join(dir, 'todos.json');
const read = () => JSON.parse(readFileSync(file, 'utf8'));
let failed = 0;
/** @param {boolean} ok @param {string} text */
const expect = (ok, text) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};
/** @param {() => unknown} fn @param {number} status */
const refused = (fn, status) => {
  try {
    fn();
    return false;
  } catch (err) {
    return /** @type {{ status?: number }} */ (err).status === status;
  }
};

/** @param {string} id @param {Partial<Task>} [fields] @returns {Task} */
const task = (id, fields = {}) => ({ id, text: id, description: '', status: 'todo', priority: 'none', category: '', projectId: 'p1', due: '', created: '', ...fields });

try {
  writeFileSync(file, JSON.stringify({
    items: [
      task('root'),
      task('child', { parentId: 'root' }),
      task('grandchild', { parentId: 'child' }),
      task('other'),
      task('under-other', { parentId: 'other' }),
      task('made-elsewhere', { auto: DEV_AUTO, autoRef: 's2' }),
    ],
    categories: [],
  }));
  writeFileSync(join(dir, 'projects.json'), JSON.stringify({ projects: [{ id: 'p1', name: 'One', localPath: '/work/one' }] }));
  const store = createNodeStore(dir);
  const scope = { session: 's1', roots: ['root'] };

  const listed = listTasks(store, scope).tasks.map((t) => t.id);
  expect(listed.join() === 'root,child,grandchild', 'the list holds the root and everything under it, in tree order');
  expect(listTasks(store, scope, 'grand').tasks.length === 1, 'a search keeps the matching tasks');
  expect(showTask(store, scope, 'grandchild').id === 'grandchild', 'a task under the root can be read');
  expect(refused(() => showTask(store, scope, 'other'), 403), 'another task cannot be read');
  expect(refused(() => showTask(store, scope, 'made-elsewhere'), 403), 'another session\'s task cannot be read');

  const added = addTask(store, scope, { text: 'Follow-up', description: 'Why' });
  const saved = store.get('todos').items.find((t) => t.id === added.id);
  expect(saved?.parentId === 'root' && saved.projectId === 'p1', 'a new task goes under the root, in its project');
  expect(saved?.auto === DEV_AUTO && saved.autoRef === 's1', 'a new task is marked as made by the session');
  const nested = addTask(store, scope, { text: 'Deeper', parentId: added.id });
  expect(nested.parentId === added.id, 'a task can go under one the session made');
  expect(refused(() => addTask(store, scope, { text: 'x', parentId: 'other' }), 403), 'a task cannot go under another task');
  expect(refused(() => addTask(store, scope, { text: '' }), 400), 'a task needs a title');

  expect(editTask(store, scope, 'child', { status: 'doing', priority: 'high' }).status === 'doing', 'a task under the root can be edited');
  expect(refused(() => editTask(store, scope, 'root', { text: 'x' }), 403), 'the root cannot be edited');
  expect(refused(() => editTask(store, scope, 'other', { text: 'x' }), 403), 'another task cannot be edited');
  expect(refused(() => editTask(store, scope, 'child', { status: 'nope' }), 400), 'an unknown status is refused');
  expect(refused(() => editTask(store, scope, 'child', { parentId: 'grandchild' }), 400), 'a task cannot go under its own subtask');
  expect(refused(() => editTask(store, scope, 'child', { parentId: 'other' }), 403), 'a task cannot move under another task');
  expect(editTask(store, scope, nested.id, { parentId: 'child' }).parentId === 'child', 'a task can move within the session\'s tasks');

  // No root: the task waits in To Organize, in the project whose folder the session runs in, and stays the
  // session's own.
  const loose = { session: 's3', roots: [] };
  const top = addTask(store, loose, { text: 'Loose', cwd: '/work/one/.claude/worktrees/x' });
  const topSaved = store.get('todos').items.find((t) => t.id === top.id);
  expect(!topSaved?.parentId && topSaved?.inbox === true && topSaved.projectId === 'p1', 'with no root, a task goes to To Organize in the folder\'s project');
  expect(editTask(store, loose, top.id, { text: 'Loose, renamed' }).text === 'Loose, renamed', 'a session edits a task it made');
  expect(listTasks(store, loose).tasks.length === 1, 'a session with no root lists only what it made');
  expect(refused(() => addTask(store, { session: 's4', roots: ['root', 'other'] }, { text: 'x' }), 400), 'with two roots, the parent must be named');

  // A tab adds a task meanwhile: both survive the session's next write.
  store.flush();
  const disk = read();
  disk.items.push(task('from-tab'));
  writeFileSync(file, JSON.stringify(disk));
  addTask(store, scope, { text: 'After the tab' });
  store.flush();
  const ids = read().items.map((/** @type {Task} */ t) => t.id);
  expect(ids.includes('from-tab') && read().items.some((/** @type {Task} */ t) => t.text === 'After the tab'), 'a tab\'s task and the session\'s both survive');

  const made = store.get('todos').items.filter((t) => t.auto === DEV_AUTO && t.autoRef === 's1').length;
  for (let i = made; i < SESSION_TASK_LIMIT; i++) addTask(store, scope, { text: `Task ${i}` });
  expect(refused(() => addTask(store, scope, { text: 'One too many' }), 429), `a task past the limit of ${SESSION_TASK_LIMIT} is refused`);
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
