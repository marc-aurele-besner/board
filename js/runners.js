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

// The parts of the heartbeat that sections show: online or not, and each job's outcome. Run times change every
// few seconds (Telegram listens all the time), so only Settings → Runners redraws for those.
const shown = () => JSON.stringify([runnersOnline(), beat?.worker?.folderId, beat?.worker?.startedAt,
  Object.entries(beat?.jobs ?? {}).map(([id, j]) => [id, j.ok, j.error, j.waiting, j.errors, j.on])]);

async function read(store) {
  const before = shown();
  const text = JSON.stringify(beat);
  try {
    beat = JSON.parse(await (await store.files.read('runners.json')).text());
  } catch {
    beat = null;
  }
  const outcome = shown() !== before;
  if (outcome || JSON.stringify(beat) !== text) listeners.forEach((fn) => fn({ outcome }));
}

// Reads runners.json now and then every few seconds while the tab is in view. `onChange({ outcome })` runs when it
// changed; `outcome` is true when a job's outcome or the runners' state did, not only run times.
export function watchRunners(store, onChange) {
  listeners.add(onChange);
  if (watching) return;
  watching = true;
  read(store).then(() => findFolder(store));
  setInterval(() => document.hidden || read(store), READ_MS);
  document.addEventListener('visibilitychange', () => document.hidden || read(store));
}

export const readRunnersNow = (store) => read(store);

// A request to the runners' API. Throws with their error, or with how to start them when they do not answer.
export async function workerCall(method, path, body, timeoutMs = 10 * 60000) {
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
  const answer = await workerCall('POST', `/run/${encodeURIComponent(id)}`, params ?? {});
  if (!answer.ok) throw new Error(answer.error || `${id} failed.`);
  return answer;
}

// The worker's live status, including the data folder it uses. Null when it does not answer.
export const workerStatus = () => workerCall('GET', '/status', null, 3000).catch(() => null);

export const setWorkerFolder = (path) => workerCall('POST', '/config', { dataFolder: path });

// Asks the runners to find this tab's folder by its name and folderId. { ok, folder } when exactly one matched.
export const findWorkerFolder = (store) =>
  workerCall('POST', '/config/find', { name: store.folderName, folderId: store.get('settings').folderId ?? '' }, 10000);

// When the runners answer but were never told where the data folder is, they look for this tab's folder themselves,
// so a fresh `bun start` works without a trip to Settings → Runners.
async function findFolder(store) {
  if (runnersOnline()) return;
  const status = await workerStatus();
  if (!status || status.folder?.path || status.folder?.from) return;
  const answer = await findWorkerFolder(store).catch(() => null);
  if (answer?.ok) setTimeout(() => read(store), 2000);
}
