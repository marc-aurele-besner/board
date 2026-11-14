// A Dev session's own tasks, for tools/board.js: list, read, add and edit them through the runners' API.
// Each request carries its terminal's token (BOARD_SESSION_TOKEN). The command runner names the terminal it belongs
// to and the tasks it was started for (POST /scope), so nothing the request claims widens its reach.
// A session's reach: the tasks it was started for (its roots, read-only: Tasks moves them as the session works),
// every task under them, and every task it made, with what is under those. Any other task is refused.
/** @import { DataStore, Task } from '../../types/data' */
/** @import { NodeStore, RequestBody } from '../../types/runner' */
import { homedir } from 'node:os';
import { makeTask } from '../../js/capture.js';
import { STATUSES } from '../../js/task-labels.js';
import { descendantsOf, wouldLoop } from '../../js/task-tree.js';
import { runnerOf } from '../../js/dev-core.js';

// The tasks one session may make, all its subagents together.
export const SESSION_TASK_LIMIT = 100;
// A task a Dev session made has `auto: DEV_AUTO` and `autoRef: <terminal session id>`.
export const DEV_AUTO = 'dev';

const STATUS_KEYS = STATUSES.map(([key]) => key);
const PRIORITIES = ['high', 'medium', 'low', 'none'];
const DUE = /^\d{4}-\d{2}-\d{2}$/;
const TEXT_MAX = 500;
const DESCRIPTION_MAX = 20000;

/** @typedef {{ session: string, roots: string[] }} SessionScope */

/** @param {string} message @param {number} status */
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

// The terminal a token belongs to and its tasks, from the command runner.
/** @param {DataStore} store @param {RequestBody} body @returns {Promise<SessionScope>} */
export async function scopeFromToken(store, body) {
  const token = String(body.token ?? '');
  if (!token) throw fail('No BOARD_SESSION_TOKEN: only a terminal the board opened in Dev can use its tasks.', 401);
  const base = runnerOf(store).replace(/\/+$/, '');
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${base}/scope`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ token }) });
  } catch {
    throw fail(`The command runner at ${base} is not answering.`, 503);
  }
  if (res.status === 404) throw fail('This terminal is not open on the board any more.', 401);
  if (!res.ok) throw fail(`The command runner answered ${res.status}: ${await res.text()}`, 502);
  const answer = /** @type {{ session?: unknown, tasks?: unknown }} */ (await res.json());
  return { session: String(answer.session ?? ''), roots: Array.isArray(answer.tasks) ? answer.tasks.map(String) : [] };
}

// The ids a session reaches, its roots among them, and those it made.
/** @param {Task[]} items @param {SessionScope} scope */
export function reachOf(items, { session, roots }) {
  const known = new Set(items.map((t) => t.id));
  const rootIds = new Set(roots.filter((id) => known.has(id)));
  const own = new Set(items.filter((t) => t.auto === DEV_AUTO && t.autoRef === session).map((t) => t.id));
  const all = new Set([...rootIds, ...own, ...descendantsOf(items, [...rootIds, ...own])]);
  return { all, roots: rootIds, own };
}

/** @param {Task} task @param {ReturnType<typeof reachOf>} reach */
const summary = (task, reach) => ({
  id: task.id,
  text: task.text,
  status: task.status ?? (task.done ? 'done' : 'todo'),
  priority: task.priority,
  due: task.due ?? '',
  category: task.category,
  parentId: task.parentId ?? '',
  root: reach.roots.has(task.id),
  mine: reach.own.has(task.id),
});

// The session's tasks as a tree, roots first, each followed by what is under it. `q` keeps tasks whose title or
// description holds every word.
/** @param {DataStore} store @param {SessionScope} scope @param {string} [q] */
export function listTasks(store, scope, q = '') {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (/** @type {Task} */ t) => words.every((w) => `${t.text}\n${t.description ?? ''}`.toLowerCase().includes(w));
  const inReach = items.filter((t) => reach.all.has(t.id));
  /** @type {Array<ReturnType<typeof summary> & { depth: number }>} */
  const out = [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @param {Task} task @param {number} depth */
  const walk = (task, depth) => {
    if (seen.has(task.id)) return;
    seen.add(task.id);
    if (matches(task)) out.push({ ...summary(task, reach), depth });
    for (const child of inReach.filter((t) => t.parentId === task.id)) walk(child, depth + 1);
  };
  // Tops: tasks in reach whose parent is not.
  for (const task of inReach.filter((t) => !t.parentId || !reach.all.has(t.parentId))) walk(task, 0);
  return { session: scope.session, roots: [...reach.roots], made: reach.own.size, limit: SESSION_TASK_LIMIT, tasks: out };
}

/** @param {DataStore} store @param {SessionScope} scope @param {string} id */
export function showTask(store, scope, id) {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  const task = items.find((t) => t.id === id);
  if (!task || !reach.all.has(id)) throw fail(`Task ${id} is not one of this session's tasks.`, 403);
  return { ...summary(task, reach), description: task.description ?? '', projectId: task.projectId, created: task.created };
}

// The fields a session may set, checked; only those present in `body`.
/** @param {RequestBody} body */
function fieldsOf(body) {
  /** @type {Partial<Task>} */
  const fields = {};
  if (body.text !== undefined) {
    const text = String(body.text).trim();
    if (!text) throw fail('A task needs a title.');
    if (text.length > TEXT_MAX) throw fail(`A title is at most ${TEXT_MAX} characters.`);
    fields.text = text;
  }
  if (body.description !== undefined) {
    const description = String(body.description);
    if (description.length > DESCRIPTION_MAX) throw fail(`A description is at most ${DESCRIPTION_MAX} characters.`);
    fields.description = description;
  }
  if (body.status !== undefined) {
    if (!STATUS_KEYS.includes(String(body.status))) throw fail(`A status is one of: ${STATUS_KEYS.join(', ')}.`);
    fields.status = String(body.status);
  }
  if (body.priority !== undefined) {
    if (!PRIORITIES.includes(String(body.priority))) throw fail(`A priority is one of: ${PRIORITIES.join(', ')}.`);
    fields.priority = String(body.priority);
  }
  if (body.due !== undefined) {
    const due = String(body.due);
    if (due && !DUE.test(due)) throw fail('A due date is YYYY-MM-DD, or empty for none.');
    fields.due = due;
  }
  if (body.category !== undefined) {
    fields.category = String(body.category);
  }
  return fields;
}

/** @param {string} path */
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);

// The project whose folder holds `cwd` (the deepest one), for a task with no parent.
/** @param {DataStore} store @param {string} cwd */
function projectOfFolder(store, cwd) {
  if (!cwd) return null;
  let best = null;
  let length = 0;
  for (const project of store.get('projects').projects) {
    const dir = expand(project.localPath ?? '').replace(/\/+$/, '');
    if (dir && (cwd === dir || cwd.startsWith(`${dir}/`)) && dir.length > length) [best, length] = [project, dir.length];
  }
  return best?.id ?? null;
}

// Adds a task under `parentId`: one of the session's tasks, or its root when it has one. With no root, a task
// goes to "To Organize", in the project whose folder the session runs in.
/** @param {DataStore} store @param {SessionScope} scope @param {RequestBody} body */
export function addTask(store, scope, body) {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  if (reach.own.size >= SESSION_TASK_LIMIT) throw fail(`This session already made ${SESSION_TASK_LIMIT} tasks, its limit.`, 429);
  const fields = fieldsOf(body);
  if (!fields.text) throw fail('A task needs a title.');
  let parentId = String(body.parentId ?? '');
  if (!parentId && reach.roots.size > 1) throw fail(`This session works on ${reach.roots.size} tasks (${[...reach.roots].join(', ')}): name the parent.`);
  if (!parentId) parentId = [...reach.roots][0] ?? '';
  const parent = parentId ? items.find((t) => t.id === parentId) : null;
  if (parentId && (!parent || !reach.all.has(parentId))) throw fail(`Task ${parentId} is not one of this session's tasks.`, 403);
  const task = makeTask({
    ...fields,
    projectId: parent ? parent.projectId : projectOfFolder(store, String(body.cwd ?? '')),
    auto: DEV_AUTO,
    autoRef: scope.session,
    ...(parent ? { parentId } : { inbox: true }),
  });
  store.update('todos', (d) => {
    d.items.push(task);
  });
  return showTask(store, scope, task.id);
}

// Edits one of the session's tasks other than its roots. A new parent must be one of its tasks (a root is fine) and
// not a task under the edited one.
/** @param {DataStore} store @param {SessionScope} scope @param {string} id @param {RequestBody} body */
export function editTask(store, scope, id, body) {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  if (!items.some((t) => t.id === id) || !reach.all.has(id)) throw fail(`Task ${id} is not one of this session's tasks.`, 403);
  if (reach.roots.has(id)) throw fail(`Task ${id} is the task this session works on; the board moves it, so it cannot be edited from here.`, 403);
  const fields = fieldsOf(body);
  if (body.parentId !== undefined) {
    const parentId = String(body.parentId);
    if (!parentId) throw fail('A session\'s task stays under one of its tasks; name a parent.');
    if (!reach.all.has(parentId)) throw fail(`Task ${parentId} is not one of this session's tasks.`, 403);
    if (parentId === id || wouldLoop(items, id, parentId)) throw fail('A task cannot go under itself or one of its own subtasks.');
    fields.parentId = parentId;
  }
  if (!Object.keys(fields).length) throw fail('Nothing to change.');
  store.update('todos', (d) => {
    const task = d.items.find((t) => t.id === id);
    if (!task) return;
    Object.assign(task, fields);
    if (fields.status) delete task.done;
    if (fields.parentId) delete task.inbox;
  });
  return showTask(store, scope, id);
}

// The runners' routes. Every answer is written to disk before it returns, so an open tab shows it on its next sync.
/** @param {() => NodeStore | null} storeOf @returns {Record<string, (body: RequestBody, rest: string) => Promise<unknown>>} */
export function taskRoutes(storeOf) {
  /** @param {(store: DataStore, scope: SessionScope, body: RequestBody, rest: string) => unknown} fn */
  const route = (fn) => async (/** @type {RequestBody} */ body, /** @type {string} */ rest) => {
    const store = storeOf();
    if (!store) throw fail('The runners have no data folder. Set it in Settings → Runners.', 503);
    const scope = await scopeFromToken(store, body);
    const answer = fn(store, scope, body, rest);
    store.flush();
    return answer;
  };
  return {
    'POST /tasks/list': route((store, scope, body) => listTasks(store, scope, String(body.q ?? ''))),
    'POST /tasks/show': route((store, scope, body) => showTask(store, scope, String(body.id ?? ''))),
    'POST /tasks/add': route((store, scope, body) => addTask(store, scope, body)),
    'POST /tasks/edit': route((store, scope, body) => editTask(store, scope, String(body.id ?? ''), body)),
  };
}
