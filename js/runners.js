// The board's side of the runners (tools/worker.js): their heartbeat, read from runners.json in the data folder,
// and their localhost API for Run now and the data folder's path.
// runners.json is not a store collection: it changes every 30 s, and the page should not redraw for that. It is read
// here on its own timer, and only a change that shows (online or offline, a job's outcome) is passed on.
import { WORKER_URL } from './runner-jobs.js';

const OFFLINE_MS = 90000;
const READ_MS = 10000;

let beat; // runners.json as last read: null when there is none, undefined until the first read
let watching = false;
const listeners = new Set();

export const heartbeat = () => beat ?? null;
export const runnersKnown = () => beat !== undefined;
export const runnersOnline = () => Boolean(beat?.worker?.beatAt && Date.now() - Date.parse(beat.worker.beatAt) < OFFLINE_MS);
export const jobState = (id) => beat?.jobs?.[id] ?? null;

// The parts of the heartbeat that show on screen: a fresh beat alone changes nothing.
const shown = () => JSON.stringify([runnersOnline(), beat?.worker?.folderId, beat?.worker?.startedAt, beat?.jobs]);

async function read(store) {
  const before = shown();
  try {
    beat = JSON.parse(await (await store.files.read('runners.json')).text());
  } catch {
    beat = null;
  }
  if (shown() !== before) listeners.forEach((fn) => fn());
}

// Reads runners.json now and then every few seconds while the tab is in view. `onChange` runs when what shows changed.
export function watchRunners(store, onChange) {
  listeners.add(onChange);
  if (watching) return;
  watching = true;
  read(store);
  setInterval(() => document.hidden || read(store), READ_MS);
  document.addEventListener('visibilitychange', () => document.hidden || read(store));
}

export const readRunnersNow = (store) => read(store);

async function call(method, path, body, timeoutMs = 10 * 60000) {
  let res;
  try {
    res = await fetch(`${WORKER_URL}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw new Error('The runners are not running. Start the board with bun start.');
  }
  const answer = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(answer.error || `Runners error ${res.status}`);
  return answer;
}

// Runs a job now and waits for it. Its results arrive through the data folder; the answer is { ok, error, … }.
export async function runJob(id, params) {
  const answer = await call('POST', `/run/${encodeURIComponent(id)}`, params ?? {});
  if (!answer.ok) throw new Error(answer.error || `${id} failed.`);
  return answer;
}

// The worker's live status, including the data folder it uses. Null when it does not answer.
export const workerStatus = () => call('GET', '/status', null, 3000).catch(() => null);

export const setWorkerFolder = (path) => call('POST', '/config', { dataFolder: path });
