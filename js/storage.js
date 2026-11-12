// File System Access API wrapper: one folder holds one JSON file per collection.
// The folder handle is remembered in IndexedDB so the user only re-grants permission.

export const SCHEMA_VERSION = 1;

const DB_NAME = 'board';
const KV_STORE = 'kv';
const HANDLE_KEY = 'dataFolder';

export const fsSupported = () => typeof window.showDirectoryPicker === 'function';

let dbPromise = null;

function getDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KV_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function kv(mode, run) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, mode);
    const req = run(tx.objectStore(KV_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

export const saveHandle = (handle) => kv('readwrite', (s) => s.put(handle, HANDLE_KEY));
export const loadHandle = () => kv('readonly', (s) => s.get(HANDLE_KEY));

export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(handle);
  return handle;
}

export async function hasPermission(handle, request = false) {
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// A collection's file as it is on disk, or null when there is none yet. `stamp` changes when the file does; the
// sample folder's files have no date, so theirs is null and the text is compared instead.
export async function readSnapshot(dir, name) {
  try {
    const file = await (await dir.getFileHandle(`${name}.json`)).getFile();
    const stamp = file.lastModified == null ? null : `${file.lastModified}:${file.size}`;
    return { stamp, file };
  } catch (err) {
    if (err.name === 'NotFoundError') return null;
    throw err;
  }
}

// Returns the text it wrote and the file's new stamp, so the store knows what is on disk.
export async function writeJSON(dir, name, data) {
  const fh = await dir.getFileHandle(`${name}.json`, { create: true });
  const text = JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION }, null, 2);
  const writable = await fh.createWritable(); // browsers swap in the new file on close()
  await writable.write(text);
  await writable.close();
  const file = await fh.getFile();
  return { text, stamp: file.lastModified == null ? null : `${file.lastModified}:${file.size}` };
}
