// The board's store for Node: the same get / update / save the shared modules in js/ call, over node:fs.
// The board's tabs write the same files, so every write is a read-merge-write with js/merge.js (base = what the
// worker last read), and a file is swapped in with a rename so a tab never reads half of one.
// Everything here is synchronous: the worker is one thread, so two jobs that write one file never interleave.
import { readFileSync, writeFileSync, renameSync, statSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { merge } from '../../js/merge.js';

const SCHEMA_VERSION = 1;
const SAVE_DELAY_MS = 200;

// The shapes the jobs read. A file the board has not written yet reads as these.
export const DEFAULTS = {
  settings: { telegram: {}, google: {}, runners: {} },
  todos: { items: [], categories: [] },
  projects: { projects: [] },
  notifications: { items: [], prefs: {} },
  google: { tokens: {}, pictures: {} },
  inbox: { emails: [], syncedAt: '' },
  tools: { sites: {}, every: 60, providers: [], status: {} },
  finance: { entries: [], budgets: {}, recurring: [] },
  usage: { entries: [] },
  calendar: { calendars: {} },
};

export function createNodeStore(dir, { log } = {}) {
  const data = {};
  // What the worker last read from or wrote to each file: { text, stamp }. It is the base of the merge.
  const synced = {};
  const dirty = new Set();
  let timer = null;

  const pathOf = (name) => join(dir, `${name}.json`);
  const stampOf = (name) => {
    try {
      const s = statSync(pathOf(name));
      return `${s.mtimeMs}:${s.size}`;
    } catch (err) {
      if (err.code === 'ENOENT') return null;
      throw err;
    }
  };
  const fill = (name, value) => {
    for (const [key, v] of Object.entries(DEFAULTS[name] ?? {})) value[key] ??= structuredClone(v);
    return value;
  };

  // Brings in what a tab saved since the worker last read the file.
  function pull(name) {
    const stamp = stampOf(name);
    const known = synced[name];
    if (!stamp) {
      data[name] ??= fill(name, {});
      return;
    }
    if (known && known.stamp === stamp && data[name]) return;
    const text = readFileSync(pathOf(name), 'utf8');
    if (!text.trim()) {
      data[name] ??= fill(name, {});
      return;
    }
    const theirs = JSON.parse(text);
    if (!data[name]) data[name] = fill(name, theirs);
    else if (!known || known.text !== text) merge(known?.text ? JSON.parse(known.text) : {}, data[name], theirs);
    synced[name] = { text, stamp };
  }

  function write(name) {
    pull(name); // merge what a tab wrote since the last read, right before writing
    const { schemaVersion: _, ...value } = data[name];
    const text = JSON.stringify({ ...value, schemaVersion: SCHEMA_VERSION }, null, 2);
    if (synced[name]?.text === text) return;
    const file = pathOf(name);
    const temp = join(dirname(file), `.${name}.json.worker-${process.pid}`);
    writeFileSync(temp, text);
    renameSync(temp, file);
    synced[name] = { text, stamp: stampOf(name) };
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    for (const name of [...dirty]) {
      dirty.delete(name);
      try {
        write(name);
      } catch (err) {
        dirty.add(name);
        log?.error(`Could not save ${name}.json: ${err.message}`);
      }
    }
  }

  const change = (name, mutate) => {
    pull(name);
    mutate(data[name]);
    dirty.add(name);
    timer ??= setTimeout(flush, SAVE_DELAY_MS);
  };

  return {
    dir,
    get(name) {
      pull(name);
      return data[name];
    },
    update: change,
    save: change,
    // Re-rendering has no meaning here.
    refresh() {},
    subscribe: () => () => {},
    flush,
    // Files kept beside the JSON files, relative to the data folder.
    files: {
      read: async (path) => {
        const text = readFileSync(join(dir, path), 'utf8');
        return { text: async () => text };
      },
      write: async (path, blob) => {
        mkdirSync(dirname(join(dir, path)), { recursive: true });
        writeFileSync(join(dir, path), typeof blob === 'string' ? blob : Buffer.from(await blob.arrayBuffer()));
        return path;
      },
    },
    folderName: dir.split('/').pop(),
    status: 'saved',
    pending: false,
  };
}

// A file only the worker writes (runners.json): no merge, swapped in whole.
export function writeOwn(dir, name, value) {
  const file = join(dir, `${name}.json`);
  const temp = join(dir, `.${name}.json.worker-${process.pid}`);
  writeFileSync(temp, JSON.stringify(value, null, 2));
  renameSync(temp, file);
}
