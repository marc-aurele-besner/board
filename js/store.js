// In-memory state for every collection, with debounced, serialized saves to disk.
// Another tab or browser may have the same folder open, so each save first merges what that one saved, and sync()
// brings its changes in between saves.
/** @import { Collections, CollectionName } from '../types/data' */
import { readSnapshot, writeJSON } from './storage.js';
import { merge } from './merge.js';

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 3000;

/** @typedef {'saved' | 'saving' | 'error'} SaveStatus */

/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {Partial<Record<CollectionName, object>>} collections each collection's defaults
 */
export function createStore(dir, collections) {
  // Filled by load() for every collection in `collections`.
  const data = /** @type {Collections} */ ({});
  // The same object, indexed by a name only known at run time.
  const byName = /** @type {Record<string, object>} */ (/** @type {unknown} */ (data));
  /** @type {Set<CollectionName>} */
  const dirty = new Set();
  /** @type {Set<(info: { user: boolean }) => void>} */
  const dataListeners = new Set();
  /** @type {Set<(status: SaveStatus) => void>} */
  const statusListeners = new Set();
  /** @type {SaveStatus} */
  let status = 'saved';
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  // What this tab last read from or wrote to each file: { text, stamp }. It is the base of the merge.
  /** @type {Record<string, { text: string, stamp: string | null } | null>} */
  const synced = {};

  /** @param {SaveStatus} next */
  const setStatus = (next) => {
    status = next;
    statusListeners.forEach((fn) => fn(next));
  };
  // Renders are coalesced to one per frame: a search or a load saves many times in a burst, and redrawing the page
  // for each one made it flash.
  let frame = 0;
  let byUser = false;
  const notify = () => {
    // A save made while an event is handled (a click, a key, a submit) is the user's own. Saves from timers and
    // finished loads are not, and the shell holds those while the user is typing.
    if (window.event) byUser = true;
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const user = byUser;
      byUser = false;
      dataListeners.forEach((fn) => fn({ user }));
    });
  };

  async function writeDirty() {
    clearTimeout(timer);
    timer = undefined;
    if (!dirty.size) return;
    const names = [...dirty];
    dirty.clear();
    setStatus('saving');
    try {
      let changed = false;
      for (const name of names) {
        if (await pull(name)) changed = true;
        synced[name] = await writeJSON(dir, name, data[name]);
      }
      setStatus('saved');
      if (changed) notify();
    } catch (err) {
      names.forEach((name) => dirty.add(name));
      console.error('Save failed', err);
      setStatus('error');
      timer = setTimeout(flush, RETRY_DELAY_MS);
    }
  }

  // Chain writes so two saves of the same file never overlap.
  function flush() {
    chain = chain.then(writeDirty);
    return chain;
  }

  /** @param {CollectionName} name */
  function schedule(name) {
    dirty.add(name);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  async function load() {
    for (const [name, defaults] of Object.entries(collections)) {
      const snap = await readSnapshot(dir, name);
      const text = snap ? await snap.file.text() : '';
      const loaded = text.trim() ? JSON.parse(text) : structuredClone(defaults);
      for (const [key, value] of Object.entries(defaults)) loaded[key] ??= structuredClone(value);
      byName[name] = loaded;
      synced[name] = snap ? { text, stamp: snap.stamp } : null;
    }
  }

  // Merges into memory what another tab saved to this collection's file since this tab last read or wrote it.
  // Returns whether memory changed.
  /** @param {string} name */
  async function pull(name) {
    const snap = await readSnapshot(dir, name);
    if (!snap) return false;
    const known = synced[name];
    if (known && snap.stamp && snap.stamp === known.stamp) return false;
    const text = await snap.file.text();
    if (known && text === known.text) {
      known.stamp = snap.stamp;
      return false;
    }
    if (!text.trim()) return false;
    const theirs = JSON.parse(text);
    const before = JSON.stringify(byName[name]);
    merge(known?.text ? JSON.parse(known.text) : {}, byName[name], theirs);
    synced[name] = { text, stamp: snap.stamp };
    return JSON.stringify(byName[name]) !== before;
  }

  // Reads every collection's file and merges what changed on disk. Queued behind saves, so the two never overlap.
  function sync() {
    chain = chain.then(async () => {
      let changed = false;
      for (const name of Object.keys(collections)) {
        try {
          if (await pull(name)) changed = true;
        } catch (err) {
          console.error(`Could not read ${name}`, err);
        }
      }
      if (changed) notify();
    });
    return chain;
  }

  // Files kept beside the JSON files, such as the originals of bills. Paths are relative to the data folder ("bills/x.pdf").
  /** @param {string} path @param {boolean} create */
  async function fileHandle(path, create) {
    const parts = path.split('/');
    let folder = dir;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create });
    return folder.getFileHandle(parts[parts.length - 1], { create });
  }
  const files = {
    /** @param {string} path @param {Blob} blob */
    async write(path, blob) {
      const handle = await fileHandle(path, true);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return path;
    },
    /** @param {string} path */
    async read(path) {
      const handle = await fileHandle(path, false);
      return handle.getFile();
    },
    /** @param {string} path */
    async remove(path) {
      const parts = path.split('/');
      let folder = dir;
      for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part);
      await folder.removeEntry(parts[parts.length - 1]);
    },
  };

  return {
    files,
    load,
    /** @template {CollectionName} K @param {K} name @returns {Collections[K]} */
    get: (name) => data[name],
    // Mutate a collection in place, then save and re-render.
    /** @template {CollectionName} K @param {K} name @param {(data: Collections[K]) => void} mutate */
    update(name, mutate) {
      mutate(data[name]);
      schedule(name);
      notify();
    },
    // Save without re-rendering, for caches and renewed tokens that change nothing on screen.
    /** @template {CollectionName} K @param {K} name @param {(data: Collections[K]) => void} mutate */
    save(name, mutate) {
      mutate(data[name]);
      schedule(name);
    },
    // Re-render without saving (for view-state changes such as filters and tabs).
    refresh: notify,
    /** @param {(info: { user: boolean }) => void} fn */
    subscribe(fn) {
      dataListeners.add(fn);
      return () => dataListeners.delete(fn);
    },
    /** @param {(status: SaveStatus) => void} fn */
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    flush,
    sync,
    // Whether a change is not on disk yet, so leaving the page now would lose it.
    get pending() {
      return dirty.size > 0 || status === 'saving';
    },
    // The name of the connected data folder, for Settings.
    folderName: dir.name,
    get status() {
      return status;
    },
  };
}
