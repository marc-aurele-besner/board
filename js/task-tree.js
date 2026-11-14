// The tree that parentId makes of tasks, without the DOM: Tasks nests with it, and the runners check a Dev session's
// reach with it (tools/worker/tasks.js).
/** @import { Task } from '../types/data' */

// Whether putting `id` under `parentId` would put it under itself, at any depth.
/** @param {Task[]} items @param {string} id @param {string} parentId */
export function wouldLoop(items, id, parentId) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (let at = parentId, n = 0; at && n <= items.length; at = byId.get(at)?.parentId ?? '', n++) if (at === id) return true;
  return false;
}

// The ids of every task under `ids`, at any depth, `ids` left out unless one sits under another.
/** @param {Task[]} items @param {Iterable<string>} ids @returns {Set<string>} */
export function descendantsOf(items, ids) {
  /** @type {Map<string, string[]>} */
  const children = new Map();
  for (const item of items) {
    if (!item.parentId) continue;
    const list = children.get(item.parentId) ?? [];
    list.push(item.id);
    children.set(item.parentId, list);
  }
  /** @type {Set<string>} */
  const found = new Set();
  const queue = [...ids];
  while (queue.length) {
    for (const child of children.get(/** @type {string} */ (queue.pop())) ?? []) {
      if (found.has(child)) continue;
      found.add(child);
      queue.push(child);
    }
  }
  return found;
}
