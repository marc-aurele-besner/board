// A task's GitHub issues and pull requests, and the links Dev finds in a terminal's output: when a task is handed
// to claude and it opens a PR or an issue, the link printed in the terminal is added to the task.
// A PR alone does not mean claude is done (it may still check CI, merge, or wait on a subagent): Tasks moves the task
// on to review once claude also waits for its user. A caller that knows the session ended passes `review`.
/** @import { DataStore, Task, TaskArtifact, TaskLink } from '../types/data' */
import { getIssue } from './github.js';
import { toast } from './toast.js';
import { statusOf } from './ui.js';
import { statusName } from './task-labels.js';

const COLLECTION = 'todos';

// Tasks saved before several were allowed kept one `issue`.
/** @param {Task} task @returns {TaskLink[]} */
export const issuesOf = (task) => task.issues ?? (task.issue ? [task.issue] : []);
/** @param {Task} task @returns {TaskLink[]} */
export const prsOf = (task) => task.prs ?? [];
/** @param {Task} task @returns {TaskArtifact[]} */
export const artifactsOf = (task) => task.artifacts ?? [];

// Adds the claude.ai Artifacts each Dev session published to the tasks it works on, by session id. A title that comes
// later (a type's artifact is named before its first write) fills in an empty one. Saves only on a change.
/** @param {DataStore} store @param {Record<string, TaskArtifact[]>} bySession */
export function addTaskArtifacts(store, bySession) {
  /** @param {Task} task */
  const missing = (task) => (bySession[task.devSession ?? ''] ?? []).filter((a) => {
    const had = artifactsOf(task).find((x) => x.url === a.url);
    return !had || (!had.title && a.title);
  });
  if (!store.get(COLLECTION).items.some((t) => missing(t).length)) return;
  /** @type {{ task: string, artifact: TaskArtifact }[]} */
  const added = [];
  store.update(COLLECTION, (d) => {
    for (const task of d.items) {
      for (const a of missing(task)) {
        const list = artifactsOf(task);
        const had = list.find((x) => x.url === a.url);
        if (had) had.title = a.title;
        else {
          task.artifacts = [...list, { url: a.url, title: a.title }];
          added.push({ task: task.text, artifact: a });
        }
      }
    }
  });
  for (const { task, artifact } of added) toast(`Artifact${artifact.title ? ` “${artifact.title}”` : ''} added to “${task}”`);
}

/** @param {string} a @param {string} b */
const sameRepo = (a, b) => a.toLowerCase() === b.toLowerCase();
/** @param {{ repo: string, number: number }} a @param {{ repo: string, number: number }} b */
const sameLink = (a, b) => sameRepo(a.repo, b.repo) && a.number === b.number;

// Every github.com issue or pull request link in a text, once each: [{ kind: 'issue' | 'pr', repo, number, url }].
const LINK = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/g;
/** @typedef {{ kind: string, repo: string, number: number, url: string }} FoundLink */
/** @param {unknown} text */
export function findGithubLinks(text) {
  /** @type {FoundLink[]} */
  const found = [];
  for (const m of String(text ?? '').matchAll(LINK)) {
    const link = { kind: m[2] === 'pull' ? 'pr' : 'issue', repo: m[1], number: Number(m[3]), url: `https://github.com/${m[1]}/${m[2]}/${m[3]}` };
    if (!found.some((f) => f.kind === link.kind && sameLink(f, link))) found.push(link);
  }
  return found;
}

// Terminal output with its escape sequences taken out, so links can be read from it. Colours inside a link are dropped;
// cursor moves become a space, so text drawn in two places on the screen does not run into one number.
// A hyperlink (OSC 8) keeps its address.
/** @param {unknown} data */
export const plainOutput = (data) => String(data)
  .replace(/\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)/g, ' $1 ')
  .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, ' ')
  .replace(/\x1b\[[0-?]*[ -/]*m/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, ' ')
  .replace(/\x1b[@-_]/g, ' ');

// Adds links to tasks, each only to tasks whose project lists its repo (any repo when the project lists none).
// Titles are read from GitHub afterwards, when a token can see the repo.
/** @param {DataStore} store @param {string[]} taskIds @param {FoundLink[]} links @param {{ review?: boolean }} [options] */
export function addTaskLinks(store, taskIds, links, { review = false } = {}) {
  /** @param {Task} task */
  const repos = (task) => store.get('projects').projects.find((p) => p.id === task.projectId)?.github?.repos ?? [];
  /** @type {{ task: Task, link: FoundLink }[]} */
  const added = [];
  store.update(COLLECTION, (d) => {
    for (const task of d.items.filter((t) => taskIds.includes(t.id))) {
      const allowed = repos(task);
      for (const link of links) {
        const repo = allowed.length ? allowed.find((r) => sameRepo(r, link.repo)) : link.repo;
        if (!repo) continue;
        const list = link.kind === 'pr' ? prsOf(task) : issuesOf(task);
        if (list.some((l) => sameLink(l, link))) continue;
        const saved = { repo, number: link.number, url: link.url, title: '' };
        if (link.kind === 'pr') task.prs = [...list, saved];
        else {
          task.issues = [...list, saved];
          delete task.issue;
        }
        added.push({ task, link });
      }
    }
  });
  const prs = added.filter((a) => a.link.kind === 'pr');
  if (review && prs.length) moveToReview(store, prs.map((a) => a.task.id));
  for (const { task, link } of added) {
    toast(`${link.kind === 'pr' ? 'PR' : 'Issue'} #${link.number} added to “${task.text}”`);
    getIssue(link.repo, link.number).then(({ title }) => title && store.update(COLLECTION, (d) => {
      const t = d.items.find((x) => x.id === task.id);
      const l = (link.kind === 'pr' ? t?.prs : t?.issues)?.find((x) => sameLink(x, link));
      if (l) l.title = title;
    })).catch(() => {});
  }
}

// Claude is done with the tasks: those still in progress wait for review. A task moved elsewhere meanwhile is
// left where it was put.
/** @param {DataStore} store @param {string[]} taskIds */
export function moveToReview(store, taskIds) {
  /** @param {Task} task */
  const moving = (task) => taskIds.includes(task.id) && statusOf(task) === 'doing';
  // Nothing to move: no save and no re-render.
  if (!store.get(COLLECTION).items.some(moving)) return;
  /** @type {string[]} */
  const moved = [];
  store.update(COLLECTION, (d) => {
    for (const task of d.items) {
      if (!moving(task)) continue;
      task.status = 'review';
      delete task.done;
      moved.push(task.text);
    }
  });
  if (moved.length) toast(moved.length === 1 ? `“${moved[0]}” moved to ${statusName(store, 'review')}` : `${moved.length} tasks moved to ${statusName(store, 'review')}`);
}

// Reads a terminal's output as it streams for links, and adds the new ones to the session's tasks.
// A link or an escape sequence can arrive split over two chunks, so the end of the last chunk is read again with the
// next one, and a link touching the end waits for it: "pull/15" may still become "pull/158".
// `known` holds links that were already in the prompt or that a full-screen program draws again.
/** @param {DataStore} store @param {string[]} taskIds @param {string} [prompt] */
export function linkWatcher(store, taskIds, prompt = '') {
  const known = new Set(findGithubLinks(prompt).map((l) => l.url.toLowerCase()));
  let tail = '';
  return (/** @type {string} */ data) => {
    const raw = tail + data;
    tail = raw.slice(-300);
    const text = plainOutput(raw).replace(/[\w./:-]+$/, '');
    const fresh = findGithubLinks(text).filter((l) => !known.has(l.url.toLowerCase()));
    if (!fresh.length) return;
    for (const l of fresh) known.add(l.url.toLowerCase());
    addTaskLinks(store, taskIds, fresh);
  };
}
