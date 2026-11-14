// A removal from the board's own data: it asks first, or, with Appearance's "Ask before removing" off, happens at
// once with Undo in a toast, which puts the collections it touched back as they were. Removals outside the data
// folder (files, worktrees, terminals) always ask, and do not come through here.
import { askBeforeRemoving } from './appearance.js';
import { toast } from './toast.js';
/** @import { Store, Collections } from '../types/data' */

/**
 * @param {Store} store
 * @param {{ ask: string, done: string, collections: (keyof Collections)[], run: () => void }} options
 *   ask: the question; done: the toast's text; collections: what `run` changes, saved for Undo
 * @returns {boolean} whether it was removed
 */
export function removeWithUndo(store, { ask, done, collections, run }) {
  if (askBeforeRemoving()) {
    if (!confirm(ask)) return false;
    run();
    return true;
  }
  const before = collections.map((c) => [c, structuredClone(store.get(c))]);
  run();
  toast(done, {
    undo: () => {
      for (const [c, saved] of before) {
        store.update(/** @type {keyof Collections} */ (c), (d) => {
          for (const key of Object.keys(d)) delete /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (d))[key];
          Object.assign(d, saved);
        });
      }
    },
  });
  return true;
}
