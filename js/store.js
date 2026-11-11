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

  // Files kept beside the JSON files, such as the originals of bills. Paths are relative to the data folder ("bills/x.pdf").
  async function fileHandle(path, create) {
    const parts = path.split('/');
    let folder = dir;
    for (const part of parts.slice(0, -1)) folder = await folder.getDirectoryHandle(part, { create });
    return folder.getFileHandle(parts[parts.length - 1], { create });
  }
  const files = {
    async write(path, blob) {
      const handle = await fileHandle(path, true);
      const writable = await handle.createWritable();
      await writable.write(blob);
      await writable.close();
      return path;
    },
    async read(path) {
      const handle = await fileHandle(path, false);
      return handle.getFile();
    },
  };

  return {
    files,
    load,
    get: (name) => data[name],
    // Mutate a collection in place, then save and re-render.
    update(name, mutate) {
      mutate(data[name]);
      schedule(name);
      notify();
    },
    // Save without re-rendering, for caches and renewed tokens that change nothing on screen.
    save(name, mutate) {
      mutate(data[name]);
      schedule(name);
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
    // The name of the connected data folder, for Settings.
    folderName: dir.name,
    get status() {
      return status;
    },
  };
}
