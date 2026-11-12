// File System Access API wrapper: one folder holds one JSON file per collection.
// The folder handle is remembered in IndexedDB so the user only re-grants permission.

export const SCHEMA_VERSION = 1;

const DB_NAME = 'board';
const KV_STORE = 'kv';
const HANDLE_KEY = 'dataFolder';

export const fsSupported = () => typeof window.showDirectoryPicker === 'function';

/** @type {Promise<IDBDatabase> | null} */
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
function getDB() {
  dbPromise ??= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(KV_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * @param {IDBTransactionMode} mode
 * @param {(store: IDBObjectStore) => IDBRequest} run
 * @returns {Promise<unknown>}
 */
async function kv(mode, run) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(KV_STORE, mode);
    const req = run(tx.objectStore(KV_STORE));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
  });
}

/** @param {FileSystemDirectoryHandle} handle */
export const saveHandle = (handle) => kv('readwrite', (s) => s.put(handle, HANDLE_KEY));
export const loadHandle = () => /** @type {Promise<FileSystemDirectoryHandle | undefined>} */ (kv('readonly', (s) => s.get(HANDLE_KEY)));

/** @returns {Promise<FileSystemDirectoryHandle>} */
export async function pickFolder() {
  const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
  await saveHandle(handle);
  return handle;
}

/** @param {FileSystemHandle} handle @param {boolean} [request] */
export async function hasPermission(handle, request = false) {
  /** @type {FileSystemHandlePermissionDescriptor} */
  const opts = { mode: 'readwrite' };
  if ((await handle.queryPermission(opts)) === 'granted') return true;
  if (!request) return false;
  return (await handle.requestPermission(opts)) === 'granted';
}

// A collection's file as it is on disk, or null when there is none yet. `stamp` changes when the file does; the
// sample folder's files have no date, so theirs is null and the text is compared instead.
/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 * @returns {Promise<{ stamp: string | null, file: File } | null>}
 */
export async function readSnapshot(dir, name) {
  try {
    const file = await (await dir.getFileHandle(`${name}.json`)).getFile();
    const stamp = file.lastModified == null ? null : `${file.lastModified}:${file.size}`;
    return { stamp, file };
  } catch (err) {
    if (/** @type {Error} */ (err).name === 'NotFoundError') return null;
    throw err;
  }
}

// Returns the text it wrote and the file's new stamp, so the store knows what is on disk.
/**
 * @param {FileSystemDirectoryHandle} dir
 * @param {string} name
 * @param {object} data
 * @returns {Promise<{ text: string, stamp: string | null }>}
 */
export async function writeJSON(dir, name, data) {
  const fh = await dir.getFileHandle(`${name}.json`, { create: true });
  const text = JSON.stringify({ ...data, schemaVersion: SCHEMA_VERSION }, null, 2);
  const writable = await fh.createWritable(); // browsers swap in the new file on close()
  await writable.write(text);
  await writable.close();
  const file = await fh.getFile();
  return { text, stamp: file.lastModified == null ? null : `${file.lastModified}:${file.size}` };
}
