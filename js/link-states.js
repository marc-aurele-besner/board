// Whether the issues and PRs linked to tasks are open, merged or closed. The runners (tools/jobs/link-states.js) read
// them into github.json `links`: { "owner/repo#12": { at, state, error } }, and Tasks colours each link like GitHub.
// One read of GitHub's issue endpoint answers for both: a PR is an issue with `pull_request.merged_at`.
import { GITHUB, issueState } from './github.js';
import { previewKey } from './previews.js';
import { runJob } from './runners.js';
import { statusOf } from './ui.js';
/** @import { DataStore, Store, LinkState } from '../types/data' */
/** @import { IssueState } from './github.js' */
/** @typedef {{ repo: string, number: number }} LinkRef */

const MIN = 60000;
// An open link is read often, as a merge is what Tasks waits on; a finished one rarely, in case it is reopened.
const AGAIN_OPEN = 2 * MIN;
const AGAIN_FINISHED = 60 * MIN;
const AGAIN_FAILED = 10 * MIN;
const KEPT = 14 * 24 * 60 * MIN;
const PER_RUN = 30;
const OPEN = 'open';

/** @param {DataStore} store */
const savedLinks = (store) => store.get(GITHUB)?.links ?? {};

// Every link on a task, by key, and whether only done tasks carry it.
/** @param {DataStore} store */
function taskLinks(store) {
  /** @type {Map<string, LinkRef & { done: boolean }>} */
  const links = new Map();
  for (const task of store.get('todos').items) {
    const done = statusOf(task) === 'done';
    for (const l of [...(task.prs ?? []), ...(task.issues ?? []), ...(task.issue ? [task.issue] : [])]) {
      if (!l?.repo || !l.number) continue;
      const key = previewKey(l.repo, l.number);
      const seen = links.get(key);
      if (seen) seen.done &&= done;
      else links.set(key, { repo: l.repo, number: l.number, done });
    }
  }
  return links;
}

// The links worth reading: every link of an open task, and those of done tasks that were still open at the last read
// (a task is often marked done before its PR is merged).
/** @param {DataStore} store */
function tracked(store) {
  const saved = savedLinks(store);
  return [...taskLinks(store)].filter(([key, l]) => !l.done || !saved[key]?.state || saved[key].state === OPEN);
}

/** @param {LinkState | undefined} entry @param {number} at */
function due(entry, at) {
  if (!entry?.at) return true;
  const wait = !entry.state ? AGAIN_FAILED : entry.state === OPEN ? AGAIN_OPEN : AGAIN_FINISHED;
  return at - entry.at >= wait;
}

// The links due a read, the longest unread first and, among those never read, open tasks' before done ones' (the first
// reads would otherwise go to old done tasks while the tasks in review stay uncoloured).
/** @param {DataStore} store @param {number} [at] */
export function dueLinks(store, at = Date.now()) {
  const saved = savedLinks(store);
  return tracked(store)
    .filter(([key]) => due(saved[key], at))
    .sort(([ka, a], [kb, b]) => (saved[ka]?.at ?? 0) - (saved[kb]?.at ?? 0) || Number(a.done) - Number(b.done))
    .slice(0, PER_RUN)
    .map(([, l]) => ({ repo: l.repo, number: l.number }));
}

// GitHub's answer as one word: 'open', 'merged' or 'closed' for a PR; 'open', 'completed' or 'not_planned' for an issue.
/** @param {IssueState} issue */
export function stateOf(issue) {
  if (issue.state === OPEN) return OPEN;
  if (issue.pull_request) return issue.pull_request.merged_at ? 'merged' : 'closed';
  return issue.state_reason === 'not_planned' ? 'not_planned' : 'completed';
}

// Reads the links' states into github.json. A failed read keeps the state found before. Runners only.
/** @param {DataStore} target @param {LinkRef[]} links @param {number} [at] */
export async function readLinkStates(target, links, at = Date.now()) {
  const found = await Promise.all(links.map(async (l) => {
    try {
      return { l, state: stateOf(await issueState(l.repo, l.number)), error: null };
    } catch (err) {
      return { l, state: '', error: /** @type {Error} */ (err).message };
    }
  }));
  // A finished link of a done task is no longer read, but its state stays as long as a task carries it.
  const keep = new Set(taskLinks(target).keys());
  target.save(GITHUB, (d) => {
    d.links ??= {};
    for (const { l, state, error } of found) {
      const key = previewKey(l.repo, l.number);
      d.links[key] = { at, state: state || d.links[key]?.state || '', error };
    }
    for (const [key, entry] of Object.entries(d.links)) {
      if (!keep.has(key) && at - (entry.at ?? 0) > KEPT) delete d.links[key];
    }
  });
  return found.filter((f) => f.error).map((f) => `${f.l.repo}#${f.l.number}: ${f.error}`);
}

/** @type {Set<string>} */
const asked = new Set();
/** @type {LinkRef[]} */
let waiting = [];

// A link's last known state ('' before its first read). A link shown but never read is asked of the runners once.
/** @param {Store} store @param {LinkRef} link */
export function linkState(store, link) {
  const key = previewKey(link.repo, link.number);
  const entry = savedLinks(store)[key];
  if (!entry && !asked.has(key)) {
    asked.add(key);
    waiting.push({ repo: link.repo, number: link.number });
    if (waiting.length === 1) queueMicrotask(() => askMissing(store));
  }
  return entry?.state ?? '';
}

// The links shown unread in one render go to the runners in one request (the job reads up to 30 a request).
/** @param {Store} store */
function askMissing(store) {
  const links = waiting;
  waiting = [];
  for (let i = 0; i < links.length; i += PER_RUN) {
    runJob('link-states', { links: links.slice(i, i + PER_RUN) }).then(() => store.sync()).catch(() => {});
  }
}
