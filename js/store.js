// In-memory state for every collection, with debounced, serialized saves to disk.
import { readJSON, writeJSON } from './storage.js';

const SAVE_DELAY_MS = 300;
const RETRY_DELAY_MS = 3000;

export function createStore(dir, collections) {
  const data = {};
  const dirty = new Set();
  const dataListeners = new Set();
  const statusListeners = new Set();
  let status = 'saved';
  let timer = null;
  let chain = Promise.resolve();

  const setStatus = (next) => {
    status = next;
    statusListeners.forEach((fn) => fn(next));
  };
  const notify = () => dataListeners.forEach((fn) => fn());

  async function writeDirty() {
    clearTimeout(timer);
    timer = null;
    if (!dirty.size) return;
    const names = [...dirty];
    dirty.clear();
    setStatus('saving');
    try {
      for (const name of names) await writeJSON(dir, name, data[name]);
      setStatus('saved');
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

  function schedule(name) {
    dirty.add(name);
    clearTimeout(timer);
    timer = setTimeout(flush, SAVE_DELAY_MS);
  }

  async function load() {
    for (const [name, defaults] of Object.entries(collections)) {
      const loaded = await readJSON(dir, name, defaults);
      for (const [key, value] of Object.entries(defaults)) loaded[key] ??= structuredClone(value);
      data[name] = loaded;
    }
  }

  return {
    load,
    get: (name) => data[name],
    // Mutate a collection in place, then save and re-render.
    update(name, mutate) {
      mutate(data[name]);
      schedule(name);
      notify();
    },
    // Re-render without saving (for view-state changes such as filters and tabs).
    refresh: notify,
    subscribe(fn) {
      dataListeners.add(fn);
      return () => dataListeners.delete(fn);
    },
    onStatus(fn) {
      statusListeners.add(fn);
      return () => statusListeners.delete(fn);
    },
    flush,
    get status() {
      return status;
    },
  };
}
