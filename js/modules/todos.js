/** @import { Store, Task, TaskArtifact, TaskLink, TaskWebLink, Project, ProjectLabel, IconName } from '../../types/data' */
/** @import { RunnerStatus } from '../../types/terminal' */
/** @import { PickOption } from '../inline.js' */
/** @import { MenuEntry } from '../menu.js' */
/** @import { SlashItem } from '../slash-complete.js' */
/** @typedef {{ text: string, status: string[], priority: string[], project: string[], category: string[] }} ColFilter */
/** @typedef {{ id: string, title: string, category: string, priority: string }} TidySuggestion */
// What this section reads of repoStats(): the counts are there when status is 'ok'.
/** @typedef {{ status: string, issues: number, prs: number, error?: string | null }} RepoState */
import { h, uid, icon, statusOf, notice, todayISO } from '../ui.js';
import { makeTask } from '../capture.js';
import { AUTO_SOURCES, autoSourceLink } from '../automations.js';
import { toast } from '../toast.js';
import { createProject, projectIcon, labelsOf, projectTree, moveProject, labelColor } from './projects.js';
import { editText, pickChip, pickButton, pickMulti, pill } from '../inline.js';
import { repoStats, createIssue, getIssue, githubLink } from '../github.js';
import { openDialog } from '../modal.js';
import { issuesOf, prsOf, artifactsOf, addTaskArtifacts, moveToReview } from '../task-links.js';
import { previewChips } from '../previews.js';
import { openLinkedinComposer, whenText } from '../linkedin-composer.js';
import { LINKEDIN } from '../linkedin-core.js';
import { linkState } from '../link-states.js';
import { recordsOfTask, sumUsage, usageLine, usageTitle } from '../dev-usage.js';
import { startDevSession, openSession, runnerOf } from './dev.js';
import { DEV_MODEL_NAMES, DEV_EFFORTS, ASK_LABELS, claudeState, devAgents, taskAgent, taskAgentCommand, projectAgent, agentEfforts, devDefaults, taskRunOptions } from '../dev-core.js';
import { agentLogo } from './dev-agent-field.js';
import { DONE_ASK } from '../dev-done.js';
import { openMenu, copyItem } from '../menu.js';
import { sessionStatus, runnerInfo, listSkills } from '../terminal.js';
import { slashComplete } from '../slash-complete.js';
import { imagesOf, imageDrop, imageStrip, imagePathsFor, addImages } from '../task-images.js';
import { dragsFiles, imageFiles } from '../images.js';
import { ask, parseJson } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { profilesFor } from '../profile.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { taskMatcher, QUERY_HINT } from '../task-query.js';
import { resizableSide } from '../side-resize.js';
import { taskStatuses, statusName, statusOptions, statusLook, categoryColor, taskCategoryNames, categoryLabelIds, isReady } from '../task-labels.js';

const COLLECTION = 'todos';
const PRIORITIES = [
  ['none', 'No priority'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
// The "Show" filter: "Open" (anything not done), "Ready" (open, but neither parked nor blocked) and each status by
// the name it has in Settings → Labels.
/** @param {Store} store */
const statusFilters = (store) => [{ value: 'open', label: 'Open' }, { value: 'ready', label: 'Ready' }, ...taskStatuses(store).map((s) => ({ value: s.key, label: s.name, ...statusLook(s) }))];
/** @type {Record<string, number>} */
const PRIORITY_ORDER = { high: 0, medium: 1, low: 2, none: 3 };
const NO_CATEGORY = '__none';
// Lists that are not a project: everything, no project, due today or late, waiting to be organized, made by a rule.
const SMART_LISTS = ['all', 'personal', 'today', 'organize', 'auto'];
// Ways to lay out the same tasks: [key, label, icon]. The list, status and column filters apply to all of them.
/** @type {[string, string, IconName][]} */
const LAYOUTS = [['table', 'Table', 'list'], ['board', 'Board', 'columns'], ['project', 'By project', 'folder'], ['status', 'By status', 'check-square']];
// In "By status", what is being worked on comes first and what is done comes last.
const STATUS_GROUP_ORDER = ['doing', 'review', 'ondeck', 'todo', 'blocked', 'paused', 'parking', 'done'];

// Tasks open sorted by status, so what is being worked on is on top. An empty key means the manual (dragged) order.
const DEFAULT_SORT = { key: 'status', dir: 'asc' };
/** @param {{ key: string, dir: string }} s */
const isDefaultSort = (s) => s.key === DEFAULT_SORT.key && s.dir === DEFAULT_SORT.dir;

// View state lives here so it survives re-renders.
// filter: one of SMART_LISTS, or a project id. status, category: lists of picked values; empty means any.
// sort: { key, dir }. colFilter: the title filter, and a list of picked values per column. Empty means "any".
// query: the search box, read by taskMatcher (words plus #project, !priority, is:status, cat:, due: tokens).
/**
 * @type {{ layout: string, query: string, filter: string, status: string[], category: string[], expanded: Set<string>, collapsed: Set<string>,
 *   selected: Set<string>, lastPicked: string | null, dragId: string | null, dragStatus: string | null, creatingProject: boolean,
 *   showProject: boolean, sort: { key: string, dir: string }, colFilter: ColFilter,
 *   tidy: { status: string, items: TidySuggestion[], error?: string }, focusTask: string }}
 */
const view = {
  layout: 'table',
  query: '',
  filter: 'all',
  status: ['open'],
  category: [],
  expanded: new Set(),
  // Tasks whose subtasks are folded away. Not saved: a reload shows every subtask.
  collapsed: new Set(),
  // Ticked tasks, for the batch actions. Not saved: a reload starts with nothing selected.
  selected: new Set(),
  // The task last ticked, so Shift+click can tick everything between it and the next one.
  lastPicked: null,
  dragId: null,
  dragStatus: null,
  creatingProject: false,
  showProject: false,
  sort: { ...DEFAULT_SORT },
  colFilter: emptyColFilter(),
  tidy: { status: 'idle', items: [] },
  // The task a link opened (#/todos?task=…, from a Cron run), scrolled to and marked once.
  focusTask: '',
};

/** @returns {ColFilter} */
function emptyColFilter() {
  return { text: '', status: [], priority: [], project: [], category: [] };
}
/** @param {string} f */
const isProjectFilter = (f) => !SMART_LISTS.includes(f);
/** @param {Task} item */
const matchesFilter = (item) => {
  const f = view.filter;
  if (f === 'all') return true;
  if (f === 'personal') return item.projectId === null;
  if (f === 'today') return Boolean(item.due) && /** @type {string} */ (item.due) <= todayISO();
  if (f === 'organize') return Boolean(item.inbox);
  if (f === 'auto') return Boolean(item.auto);
  return item.projectId === f;
};
/** @param {Task} item */
const matchesStatus = (item) => {
  const s = statusOf(item);
  if (!view.status.length) return true;
  return view.status.includes(s) || (s !== 'done' && view.status.includes('open')) || (isReady(s) && view.status.includes('ready'));
};
/** @param {Task} item */
const matchesCategory = (item) => !view.category.length || view.category.includes(item.category || NO_CATEGORY);
/** @param {Task} item */
const matchesColumns = (item) => {
  const f = view.colFilter;
  if (f.text && !item.text.toLowerCase().includes(f.text.toLowerCase())) return false;
  if (f.status.length && !f.status.includes(statusOf(item))) return false;
  if (f.priority.length && !f.priority.includes(item.priority ?? 'none')) return false;
  if (f.project.length && !f.project.includes(item.projectId ?? 'none')) return false;
  if (f.category.length && !f.category.includes(item.category || NO_CATEGORY)) return false;
  return true;
};
/** @param {Store} store */
const projectsOf = (store) => store.get('projects').projects;
// The forms here hold only text fields.
/** @param {HTMLFormElement} form */
const formValues = (form) => /** @type {Record<string, string>} */ (Object.fromEntries(new FormData(form)));
/** @param {string} a @param {string} b */
const sameLower = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** @param {string[][]} list @param {string} key */
const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? '';

// Task categories. Each has a scope: 'all' (every project), 'project' (one project),
// or 'projectCategory' (every project carrying one of its project labels, such as Web).
/** @param {Store} store */
const todoCategories = (store) => store.get(COLLECTION).categories ?? [];

// Names a todo in this project can use: general ones, plus those scoped to the project or one of its labels.
/** @param {Store} store @param {string | null} projectId */
function categoriesFor(store, projectId) {
  const project = projectsOf(store).find((p) => p.id === projectId);
  const labels = project ? labelsOf(project) : [];
  return todoCategories(store)
    .filter((c) =>
      c.scope === 'all' ||
      (c.scope === 'project' && c.projectId === projectId) ||
      categoryLabelIds(c).some((id) => labels.includes(id)))
    .map((c) => c.name);
}

// The project a task typed in the add field goes to, as far as is known before it is added: the project its
// #tag names, else the listed one. A #tag naming no project yet leaves the user's own skills.
/** @param {Store} store @param {string} raw @returns {string | null} */
function addFieldProject(store, raw) {
  const tag = raw.match(/(?:^|\s)#([\w-]+)/);
  if (tag) return projectsOf(store).find((p) => p.name.toLowerCase() === tag[1].toLowerCase())?.id ?? null;
  return isProjectFilter(view.filter) ? view.filter : null;
}

// "buy milk #home" files the item under project "home" (created if missing).
// Extra lines from a multi-line paste arrive as the description.
// Images pasted or dropped on the add field go to the task it adds. Returns the task added, or null.
/** @param {Store} store @param {string} raw @param {string} [description] @returns {Task | null} */
function addItem(store, raw, description = '') {
  let text = raw.trim();
  const tag = text.match(/(?:^|\s)#([\w-]+)/);
  if (tag) text = text.replace(tag[0], ' ').replace(/\s+/g, ' ').trim();
  if (!text) {
    if (pending.length) toast('Give the task a title, then add it with its images');
    return null;
  }

  let projectId = isProjectFilter(view.filter) ? view.filter : null;
  if (tag) {
    const project = projectsOf(store).find((p) => p.name.toLowerCase() === tag[1].toLowerCase())
      ?? createProject(store, tag[1]).project;
    projectId = project.id;
  }
  const task = makeTask({ text, description, projectId, due: view.filter === 'today' ? todayISO() : '' });
  store.update(COLLECTION, (d) => d.items.push(task));
  if (pending.length) {
    addImages(store, task.id, pending.map((p) => p.file));
    clearPending();
  }
  return task;
}

// --- Images waiting on the add field, shown under it until the task is added ---

/** @type {{ file: File, url: string }[]} */
const pending = []; // { file, url }
/** @type {HTMLDivElement | null} */
let pendingStrip = null;

function clearPending() {
  for (const p of pending.splice(0)) URL.revokeObjectURL(p.url);
  drawPending();
}

/** @param {File[]} files */
function takePending(files) {
  pending.push(...files.map((file) => ({ file, url: URL.createObjectURL(file) })));
  drawPending();
}

// Drawn in place, since the page waits to rebuild while the add field holds typed text.
function drawPending() {
  if (!pendingStrip) return;
  pendingStrip.hidden = !pending.length;
  pendingStrip.replaceChildren(...pending.map((p) =>
    h('div', { class: 'task-image' },
      h('span', { class: 'task-image-open', title: p.file.name || 'Pasted image' }, h('img', { src: p.url, alt: p.file.name || 'Pasted image' })),
      h('button', {
        type: 'button',
        class: 'icon-btn task-image-remove',
        title: 'Remove the image',
        'aria-label': 'Remove the image',
        onclick: () => {
          pending.splice(pending.indexOf(p), 1);
          URL.revokeObjectURL(p.url);
          drawPending();
        },
      }, icon('x')))),
    pending.length ? h('span', { class: 'muted small' }, pending.length === 1 ? 'Added with the task' : `${pending.length} images, added with the task`) : '');
}

function pendingImagesStrip() {
  // Redrawn in place through this reference, so a patched redraw swaps it whole (data-own).
  pendingStrip = h('div', { class: 'task-images quick-images', 'data-own': '' });
  drawPending();
  return pendingStrip;
}

// Pasting several lines: first non-empty line is the title, the rest is the description.
/** @param {Store} store @param {ClipboardEvent} e */
function pasteAsTodo(store, e) {
  const files = imageFiles(e.clipboardData);
  if (files.length) {
    e.preventDefault();
    takePending(files);
    return;
  }
  const raw = e.clipboardData?.getData('text/plain') ?? '';
  if (!/\r?\n/.test(raw.trim())) return; // single line: let the browser paste normally
  e.preventDefault();
  const lines = raw.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return;
  addItem(store, lines[first], lines.slice(first + 1).join('\n').trim());
}

// Every edit to a todo goes through here, one task or a batch. A status change also drops the legacy `done` flag.
/** @param {Store} store @param {string[]} ids @param {Partial<Task>} patch */
function updateItems(store, ids, patch) {
  const pick = new Set(ids);
  store.update(COLLECTION, (d) => {
    for (const item of d.items) {
      if (!pick.has(item.id)) continue;
      Object.assign(item, patch);
      if ('status' in patch) delete item.done;
      // A task that got its project and its deadline no longer waits in "To Organize".
      if (item.inbox && item.projectId && item.due) delete item.inbox;
    }
  });
}
/** @param {Store} store @param {string} id @param {Partial<Task>} patch */
const updateItem = (store, id, patch) => updateItems(store, [id], patch);

// Deleting is immediate, with a few seconds to take it back.
/** @param {Store} store @param {string} id */
function removeItem(store, id) {
  const items = store.get(COLLECTION).items;
  const index = items.findIndex((i) => i.id === id);
  if (index < 0) return;
  const removed = items[index];
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });
  toast('Task deleted', { undo: () => store.update(COLLECTION, (d) => d.items.splice(Math.min(index, d.items.length), 0, removed)) });
}

// Deleting a batch, with the same few seconds to take it back.
/** @param {Store} store @param {string[]} ids */
function removeItems(store, ids) {
  const pick = new Set(ids);
  const before = store.get(COLLECTION).items;
  const count = before.filter((i) => pick.has(i.id)).length;
  if (!count) return;
  const snapshot = before.map((i) => ({ item: i, index: before.indexOf(i) })).filter(({ item }) => pick.has(item.id));
  view.selected.clear();
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => !pick.has(i.id));
  });
  toast(`${count} task${count === 1 ? '' : 's'} deleted`, {
    undo: () => store.update(COLLECTION, (d) => {
      for (const { item, index } of snapshot) d.items.splice(Math.min(index, d.items.length), 0, item);
    }),
  });
}

// The deadline next to a title: today and late ones stand out.
/** @param {Task} item */
function dueChip(item) {
  if (!item.due || statusOf(item) === 'done') return null;
  const today = todayISO();
  const label = new Date(`${item.due}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  if (item.due < today) return h('span', { class: 'due late' }, `Overdue · ${label}`);
  return h('span', { class: item.due === today ? 'due today' : 'due' }, item.due === today ? 'Today' : label);
}

// Time left until the end of the deadline day: hours on the last day, days before that.
/** @param {string} due */
function timeLeft(due) {
  // @ts-expect-error a Date subtracts as its time in milliseconds
  const ms = new Date(`${due}T23:59:59`) - Date.now();
  const hours = Math.floor(Math.abs(ms) / 3_600_000);
  /** @param {number} n @param {string} unit */
  const plural = (n, unit) => `${n} ${unit}${n === 1 ? '' : 's'}`;
  const span = hours < 24 ? plural(Math.max(hours, 1), 'hour') : plural(Math.floor(hours / 24), 'day');
  return ms < 0 ? `${span} late` : `in ${span}`;
}

// The deadline in a task row: an icon button when none is set, the time left when one is.
// Both open the native date picker on a hidden input.
/** @param {Store} store @param {Task} item */
function dueControl(store, item) {
  const input = h('input', {
    type: 'date',
    class: 'due-picker',
    value: item.due ?? '',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => updateItem(store, item.id, { due: e.target.value }),
  });
  const open = () => {
    try { input.showPicker(); } catch { input.focus(); }
  };
  const date = item.due ? new Date(`${item.due}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) : '';
  const button = item.due
    ? h('button', { type: 'button', class: 'btn-small due-left', title: `Deadline: ${date}`, 'aria-label': `Deadline for "${item.text}": ${date}. Change it`, onclick: open }, timeLeft(item.due))
    : h('button', { type: 'button', class: 'icon-btn', title: 'Set a deadline', 'aria-label': `Set a deadline for "${item.text}"`, onclick: open }, icon('calendar'));
  return h('span', { class: 'due-control' }, button, input);
}

// The flag on a task the board created by itself, naming where it came from.
/** @param {Task} item */
function autoBadge(item) {
  if (!item.auto) return null;
  if (item.auto === 'notion' && item.notion?.url) {
    return h('a', { class: 'auto-badge', href: item.notion.url, target: '_blank', rel: 'noopener', title: 'Imported from Notion. Open the page' }, icon('notion'), 'Notion');
  }
  const telegram = item.auto === 'telegram';
  return h('span', { class: 'auto-badge', title: `Created automatically by ${/** @type {Record<string, string>} */ (AUTO_SOURCES)[item.auto] ?? 'a rule'}` }, icon(telegram ? 'send' : 'zap'), telegram ? 'Telegram' : 'Auto');
}

// A category on a card: in its colour when Settings → Labels gives it one, otherwise a plain tag.
/** @param {Store} store @param {string} name */
function categoryTag(store, name) {
  if (!name) return null;
  const color = categoryColor(store, name);
  return color ? pill(name, { color }) : h('span', { class: 'tag' }, name);
}

// What a task in "To Organize" still needs.
/** @param {Task} item */
const missingFor = (item) => [item.projectId ? '' : 'a project', item.due ? '' : 'a deadline'].filter(Boolean).join(' and ') || 'a look';

// Creates a todo category from a todo's category picker. It is scoped to that todo's project, if it has one.
/** @param {Store} store @param {string} name @param {string | null} projectId */
function createTodoCategory(store, name, projectId) {
  const existing = todoCategories(store).find((c) => sameLower(c.name, name));
  if (!existing) {
    store.update(COLLECTION, (d) =>
      d.categories.push({ id: uid(), name, scope: projectId ? 'project' : 'all', projectId: projectId ?? null, projectCategoryIds: [] }));
  }
  return name;
}

/** @param {Store} store @param {string} id */
const toggleExpanded = (store, id) => {
  if (view.expanded.has(id)) view.expanded.delete(id);
  else view.expanded.add(id);
  store.refresh();
};

// projectId null means Personal.
/** @param {Store} store @param {string} id @param {string | null} projectId */
const moveToProject = (store, id, projectId) => updateItem(store, id, { projectId });

// Move `id` next to `targetId` (before it, or after it when `after` is true).
// The stored array order is the display order, so this is the reorder. It also takes the target's place in the
// tree: `parentId` is the task the target shows under ('' for none), so dropping next to a subtask makes a sibling.
/** @param {Store} store @param {string} id @param {string} targetId @param {boolean} after @param {string} parentId @param {Partial<Task>} [patch] */
function moveItem(store, id, targetId, after, parentId, patch = {}) {
  if (id === targetId) return;
  store.update(COLLECTION, (d) => {
    const from = d.items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const [item] = d.items.splice(from, 1);
    let to = d.items.findIndex((i) => i.id === targetId);
    if (to < 0) to = from;
    d.items.splice(after ? to + 1 : to, 0, item);
    // Next to one of its own subtasks, a task only moves: it cannot go under itself.
    if (!parentId) delete item.parentId;
    else if (!wouldLoop(d.items, id, parentId)) item.parentId = parentId;
    Object.assign(item, patch);
    if ('status' in patch) delete item.done;
  });
}

// --- Subtasks: a task with a parentId shows under that task while both are in the same list ---

// Whether putting `id` under `parentId` would put it under itself, at any depth.
/** @param {Task[]} items @param {string} id @param {string} parentId */
function wouldLoop(items, id, parentId) {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (let at = parentId, n = 0; at && n <= items.length; at = byId.get(at)?.parentId ?? '', n++) if (at === id) return true;
  return false;
}

// Puts `id` under `parentId`, after the subtasks it already has. `patch` adds changes, such as a board column's status.
/** @param {Store} store @param {string} id @param {string} parentId @param {Partial<Task>} [patch] */
function nestUnder(store, id, parentId, patch = {}) {
  if (id === parentId) return;
  if (wouldLoop(store.get(COLLECTION).items, id, parentId)) {
    toast('A task cannot go under one of its own subtasks');
    return;
  }
  store.update(COLLECTION, (d) => {
    const from = d.items.findIndex((i) => i.id === id);
    if (from < 0 || !d.items.some((i) => i.id === parentId)) return;
    const [item] = d.items.splice(from, 1);
    const under = new Set([parentId]);
    let to = -1;
    d.items.forEach((i, n) => {
      if (under.has(i.id) || (i.parentId && under.has(i.parentId))) {
        under.add(i.id);
        to = n;
      }
    });
    d.items.splice(to + 1, 0, item);
    item.parentId = parentId;
    Object.assign(item, patch);
    if ('status' in patch) delete item.done;
  });
}

// --- Dragging several tasks: a drag that starts on a selected task carries every selected task ---

// The tasks a drag carries: the selected ones, in list order, when the dragged task is among them, else the dragged
// task alone. With `tops`, a selected task under another selected task is left out: it moves with its parent.
/** @param {Store} store @param {boolean} [tops] @returns {string[]} */
function draggedIds(store, tops = false) {
  const id = view.dragId;
  if (!id) return [];
  if (!view.selected.has(id) || view.selected.size < 2) return [id];
  const items = store.get(COLLECTION).items;
  const byId = new Map(items.map((i) => [i.id, i]));
  /** @param {Task} item */
  const underPicked = (item) => {
    for (let at = item.parentId, n = 0; at && n <= items.length; at = byId.get(at)?.parentId, n++) if (view.selected.has(at)) return true;
    return false;
  };
  return items.filter((i) => view.selected.has(i.id) && !(tops && underPicked(i))).map((i) => i.id);
}

// Puts the dragged tasks under `parentId`, in their order. One that would go under itself stays where it is.
/** @param {Store} store @param {string} parentId @param {Partial<Task>} [patch] */
function nestDragged(store, parentId, patch = {}) {
  const items = store.get(COLLECTION).items;
  const ids = draggedIds(store, true).filter((id) => id !== parentId);
  const ok = ids.filter((id) => !wouldLoop(items, id, parentId));
  if (ok.length < ids.length) toast(ids.length === 1 ? 'A task cannot go under one of its own subtasks' : 'A task cannot go under one of its own subtasks, so it stayed where it was');
  for (const id of ok) nestUnder(store, id, parentId, patch);
}

// Moves the dragged tasks next to `targetId`, one after another in their order.
/** @param {Store} store @param {string} targetId @param {boolean} after @param {string} parentId @param {Partial<Task>} [patch] */
function moveDragged(store, targetId, after, parentId, patch = {}) {
  let anchor = targetId;
  let side = after;
  for (const id of draggedIds(store, true).filter((x) => x !== targetId)) {
    moveItem(store, id, anchor, side, parentId, patch);
    anchor = id;
    side = true;
  }
}

// Fades every task a drag carries, not only the one under the pointer.
/** @param {Store} store */
function markDragging(store) {
  const ids = new Set(draggedIds(store));
  for (const el of document.querySelectorAll('.todo-item[data-id], .kanban-card[data-id]')) {
    if (ids.has(/** @type {HTMLElement} */ (el).dataset.id ?? '')) el.classList.add('dragging');
  }
}
const unmarkDragging = () => {
  for (const el of document.querySelectorAll('.todo-item.dragging, .kanban-card.dragging')) el.classList.remove('dragging');
};

/**
 * Where a task sits in the list on screen: how deep, the task it shows under, and how many tasks are under it.
 * @typedef {{ depth: number, parentId: string, count: number, collapsed: boolean }} Place
 */

// Lays a list out as a tree, in the list's order: each task is followed by its subtasks, unless it is folded.
// A subtask whose parent is not in the list (filtered out, in another column, deleted) shows at the top level.
// `shown` collects the ids on screen, in screen order, for Shift+click ranges and the selection.
/** @template N @param {Task[]} list @param {(item: Task, place: Place) => N} render @param {string[]} shown @returns {N[]} */
function nestedRows(list, render, shown) {
  const ids = new Set(list.map((i) => i.id));
  const byId = new Map(list.map((i) => [i.id, i]));
  // A parent chain that comes back to the task (bad data) would hide it; such a task stays at the top.
  /** @param {Task} item */
  const nests = (item) => {
    for (let at = item.parentId, n = 0; at && ids.has(at); at = byId.get(at)?.parentId, n++) if (at === item.id || n > list.length) return false;
    return Boolean(item.parentId && ids.has(item.parentId));
  };
  /** @type {Map<string, Task[]>} */
  const kids = new Map();
  /** @type {Task[]} */
  const tops = [];
  for (const item of list) {
    const parent = item.parentId ?? '';
    if (!nests(item)) tops.push(item);
    else kids.set(parent, [...(kids.get(parent) ?? []), item]);
  }
  /** @param {string} id @returns {number} */
  const countUnder = (id) => (kids.get(id) ?? []).reduce((n, k) => n + 1 + countUnder(k.id), 0);
  /** @type {N[]} */
  const out = [];
  /** @param {Task} item @param {number} depth @param {string} parentId */
  const visit = (item, depth, parentId) => {
    const collapsed = view.collapsed.has(item.id);
    shown.push(item.id);
    out.push(render(item, { depth, parentId, count: countUnder(item.id), collapsed }));
    if (!collapsed) for (const k of kids.get(item.id) ?? []) visit(k, depth + 1, item.id);
  };
  for (const item of tops) visit(item, 0, '');
  return out;
}

// The arrow that folds a task's subtasks, with how many there are, so a folded task still says what it holds.
/** @param {Store} store @param {Task} item @param {Place} place */
function subtaskToggle(store, item, place) {
  if (!place.count) return null;
  const what = `${place.count} subtask${place.count === 1 ? '' : 's'}`;
  return h('button', {
    type: 'button',
    class: place.collapsed ? 'subtask-toggle collapsed' : 'subtask-toggle',
    title: place.collapsed ? `Show ${what}` : `Hide ${what}`,
    'aria-label': place.collapsed ? `Show ${what}` : `Hide ${what}`,
    'aria-expanded': String(!place.collapsed),
    onclick: () => {
      if (place.collapsed) view.collapsed.delete(item.id);
      else view.collapsed.add(item.id);
      store.refresh();
    },
  }, icon('chevron-down'), h('span', { class: 'count' }, String(place.count)));
}

// Drop indicator: above or below the row depending on pointer position, or, with `inside`, on its middle to put
// the dragged task under it.
/** @param {DragEvent & { currentTarget: HTMLElement }} e @param {boolean} [inside] */
function dropSide(e, inside = false) {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (inside && y > 0.25 && y < 0.75) return 'inside';
  return y > 0.5 ? 'after' : 'before';
}
/** @param {HTMLElement} el */
function clearDropMarks(el) {
  el.classList.remove('drop-before', 'drop-after', 'drop-inside');
}
/** @param {HTMLElement} el @param {string} side */
function markDrop(el, side) {
  el.classList.toggle('drop-before', side === 'before');
  el.classList.toggle('drop-after', side === 'after');
  el.classList.toggle('drop-inside', side === 'inside');
}

// The project currently being dragged in the sidebar (a task drag uses view.dragId).
/** @type {string | null} */
let dragProjectId = null;

// Sorting by a column replaces the stored order, so drag-to-reorder is off while a sort is active.
// The status sort is stable and keeps the stored order within a status, so tasks of the same status can still be dragged.
const reorderEnabled = () => !view.sort.key || view.sort.key === 'status';
/** @param {Task} item */
const canDropOn = (item) => !view.sort.key || view.dragStatus === statusOf(item);

// --- GitHub issues and pull requests for a task ---

// "#12", "12" or a github.com issue or PR link, as { repo, number }. null when the text is not a reference.
/** @param {unknown} text @param {string} defaultRepo */
function parseIssueRef(text, defaultRepo) {
  const t = String(text ?? '').trim();
  const link = t.match(/github\.com\/([^/\s]+\/[^/\s]+)\/(?:issues|pull)\/(\d+)/);
  if (link) return { repo: link[1], number: Number(link[2]) };
  const number = t.match(/^#?(\d+)$/);
  if (number) return { repo: defaultRepo, number: Number(number[1]) };
  return null;
}

// GitHub answers issues and PRs on the same API; the link says which one it is.
/** @param {{ url: string }} link */
const isPr = (link) => /\/pull\/\d+/.test(link.url);
/** @param {{ repo: string, number: number }} a @param {{ repo: string, number: number }} b */
const sameLink = (a, b) => a.repo.toLowerCase() === b.repo.toLowerCase() && a.number === b.number;
/** @param {TaskLink} l */
const linkTitle = (l) => `${l.repo} #${l.number}${l.title ? `: ${l.title}` : ''}`;

// Adds an issue or a PR to the task's list of its kind, or takes one out.
/** @param {Store} store @param {string} id @param {TaskLink} link */
function saveLink(store, id, link) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    if (isPr(link)) item.prs = [...prsOf(item).filter((l) => !sameLink(l, link)), link];
    else item.issues = [...issuesOf(item).filter((l) => !sameLink(l, link)), link];
    delete item.issue;
  });
}
/** @param {Store} store @param {string} id @param {TaskLink} link */
function unlinkLink(store, id, link) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    if (isPr(link)) item.prs = prsOf(item).filter((l) => !sameLink(l, link));
    else item.issues = issuesOf(item).filter((l) => !sameLink(l, link));
    delete item.issue;
  });
}

// Lists a task's issues and PRs, creates a new issue, or links an existing issue or PR.
// The task keeps each one's repo, number, link and title.
/** @param {Store} store @param {Task} item @param {string[]} repos */
function openIssueDialog(store, item, repos) {
  let repo = repos[0] ?? '';
  let mode = repos.length ? 'create' : 'link';
  const body = h('div', { class: 'stack' });
  const message = h('div', null);
  const dialog = openDialog({ title: 'GitHub issues and PRs', body: h('div', { class: 'stack' }, body, message) });
  const current = () => store.get(COLLECTION).items.find((i) => i.id === item.id) ?? item;

  /** @param {string} text */
  const fail = (text) => message.replaceChildren(notice({ text }));
  /** @param {TaskLink} link */
  const saved = (link) => {
    saveLink(store, item.id, link);
    dialog.close();
  };
  /** @param {string} title @param {string} text */
  const create = (title, text) => {
    createIssue(repo, title, text).then(saved).catch((/** @type {Error} */ err) => fail(err.message));
  };
  /** @param {string} target @param {number} number */
  const link = (target, number) => {
    getIssue(target, number).then(saved).catch((/** @type {Error} */ err) => fail(err.message));
  };

  const paint = () => {
    const task = current();
    const linked = [...issuesOf(task), ...prsOf(task)];
    const list = linked.length
      ? h('ul', { class: 'task-links' }, linked.map((l) =>
          h('li', null,
            h('a', { href: l.url, target: '_blank', rel: 'noopener', class: 'issue-link', title: linkTitle(l) },
              icon(isPr(l) ? 'pull-request' : 'repo'), `${l.repo} #${l.number}`),
            h('span', { class: 'muted small task-link-title' }, l.title),
            h('button', {
              type: 'button',
              class: 'btn-small danger',
              'aria-label': `Unlink ${l.repo} #${l.number}`,
              onclick: () => {
                unlinkLink(store, item.id, l);
                paint();
              },
            }, 'Unlink'))))
      : null;
    const repoPick = repos.length > 1
      ? h('label', { class: 'bill-field' },
          h('span', { class: 'muted small' }, 'Repository'),
          h('select', {
            onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => {
              repo = e.target.value;
              paint();
            },
          }, repos.map((r) => h('option', { value: r, selected: r === repo }, r))))
      : repo ? h('p', { class: 'muted small' }, `Repository: ${repo}`) : null;
    const modes = repos.length
      ? h('div', { class: 'segmented' },
          [['create', 'Create issue'], ['link', 'Link existing']].map(([key, label]) =>
            h('button', {
              type: 'button',
              class: mode === key ? 'seg active' : 'seg',
              onclick: () => {
                mode = key;
                paint();
              },
            }, label)))
      : null;
    const form = mode === 'create'
      ? h('form', {
          class: 'stack',
          onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            create(String(f.get('title') ?? '').trim(), String(f.get('body') ?? '').trim());
          },
        },
          h('input', { name: 'title', value: task.text, required: true, 'aria-label': 'Issue title' }),
          h('textarea', { name: 'body', rows: 4, placeholder: 'Issue description', 'aria-label': 'Issue description' }, task.description ?? ''),
          h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Create issue')))
      : h('form', {
          class: 'stack',
          onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
            e.preventDefault();
            const ref = parseIssueRef(new FormData(e.currentTarget).get('ref'), repo);
            if (!ref?.repo) return fail(repo ? 'Enter a number like 12, or a github.com issue or pull request link.' : 'Enter a github.com issue or pull request link.');
            link(ref.repo, ref.number);
          },
        },
          h('input', { name: 'ref', placeholder: repo ? '#12, or a github.com issue or PR link' : 'A github.com issue or PR link', 'aria-label': 'Issue or PR number or link' }),
          h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Link')));
    body.replaceChildren(.../** @type {HTMLElement[]} */ ([list, repoPick, modes, form].filter(Boolean)));
  };
  paint();
}

// A task's issues and PRs as links (#12, opens in a new tab), shown beside its title where they have room.
// A Dev session started on the task adds the ones it opens. A PR's Vercel or Netlify preview follows it.
// Each is coloured like GitHub: green while open, purple once merged or completed, red once closed unmerged.
/** @param {Store} store @param {Task} item */
function linkChips(store, item) {
  const issues = issuesOf(item);
  const prs = prsOf(item);
  const artifacts = artifactsOf(item);
  const links = item.links ?? [];
  const post = postPill(store, item);
  if (!issues.length && !prs.length && !artifacts.length && !links.length && !post) return null;
  /** @param {TaskLink} l @param {boolean} pr */
  const chip = (l, pr) => {
    const state = linkState(store, l);
    return h('a', {
    href: l.url,
    target: '_blank',
    rel: 'noopener',
    class: `issue-link${state ? ` gh-${state}` : ''}`,
    title: `${pr ? 'Pull request' : 'Issue'} ${linkTitle(l)}${state ? ` · ${STATE_NAMES[state] ?? state}` : ''}`,
    'aria-label': `Open ${pr ? 'pull request' : 'issue'} ${l.repo} #${l.number}`,
  }, icon(pr ? 'pull-request' : 'repo'), `#${l.number}`);
  };
  return h('span', { class: 'task-link-chips' }, issues.map((l) => chip(l, false)), prs.map((l) => chip(l, true)), previewChips(store, prs, 'issue-link'), artifacts.map(artifactChip), links.map(webChip), post);
}

// A claude.ai Artifact a Dev session published, by its title (or "Artifact"), opening in a new tab.
/** @param {TaskArtifact} a */
const artifactChip = (a) => h('a', {
  href: a.url,
  target: '_blank',
  rel: 'noopener',
  class: 'issue-link artifact-link',
  title: `Artifact${a.title ? ` “${a.title}”` : ''} · ${a.url}`,
  'aria-label': `Open the artifact ${a.title || a.url}`,
}, icon('sparkle'), h('span', { class: 'artifact-link-title' }, a.title || 'Artifact'));

// Another page the task led to, such as its LinkedIn post.
/** @param {TaskWebLink} l */
const webChip = (l) => h('a', {
  href: l.url,
  target: '_blank',
  rel: 'noopener',
  class: 'issue-link artifact-link',
  title: `${l.title || 'Link'} · ${l.url}`,
  'aria-label': `Open ${l.title || l.url}`,
}, icon(/linkedin\.com/.test(l.url) ? 'linkedin' : 'link'), h('span', { class: 'artifact-link-title' }, l.title || 'Link'));

// The state of the task's LinkedIn post while it is not out yet (scheduled, failed, missed); a posted one shows as
// its link. A click opens the composer.
/** @type {Record<string, [string, string]>} */
const POST_PILLS = { scheduled: ['Scheduled', 'doing'], posting: ['Posting', 'doing'], failed: ['Failed', 'failed'], missed: ['Missed', 'high'] };
/** @param {Store} store @param {Task} item */
function postPill(store, item) {
  const post = store.get(LINKEDIN).posts.find((p) => p.taskId === item.id && POST_PILLS[p.status]);
  if (!post) return null;
  const [label, tone] = POST_PILLS[post.status];
  const at = post.status === 'scheduled' && post.scheduledAt ? whenText(post.scheduledAt) : '';
  return h('button', {
    type: 'button',
    class: `pill tone-${tone} task-li-pill`,
    title: post.error ? `LinkedIn post: ${post.error}` : `LinkedIn post${at ? `, ${at}` : ''}`,
    onclick: () => openLinkedinComposer(store, { postId: post.id }),
  }, icon('linkedin'), at ? `${label} ${at}` : label);
}

// The actions under an open task's description.
/** @param {Store} store @param {Task} item */
const taskActions = (store, item) => h('div', { class: 'row task-actions' },
  h('button', { type: 'button', class: 'btn-small', onclick: () => openLinkedinComposer(store, { taskId: item.id }) }, icon('linkedin'), 'LinkedIn post'));

// An open task's images with their Add button, and its actions, on one line.
/** @param {Store} store @param {Task} item */
const taskTools = (store, item) => h('div', { class: 'task-tools' }, imageStrip(store, item), taskActions(store, item));

/** @type {Record<string, string>} */
const STATE_NAMES = { open: 'open', merged: 'merged', closed: 'closed', completed: 'closed as completed', not_planned: 'closed as not planned' };

// One button in the actions to see a task's issues and PRs, link more, or create one.
/** @param {Store} store @param {Task} item @param {string[]} repos */
function issueControl(store, item, repos) {
  const any = issuesOf(item).length + prsOf(item).length > 0;
  return h('button', {
    type: 'button',
    class: 'icon-btn',
    title: any ? 'Issues and PRs: link more, or unlink' : 'Create or link a GitHub issue or PR',
    'aria-label': any ? 'Manage GitHub issues and PRs' : 'Create or link a GitHub issue or PR',
    onclick: () => openIssueDialog(store, item, repos),
  }, icon(any ? 'link' : 'repo'));
}

// A task as Markdown: a checklist line with its status, project and deadline, then its description indented, then
// the paths of its images when they were saved for claude.
/** @param {Store} store @param {Task} item @param {Project[]} projects @param {string[]} [images] */
function taskMarkdown(store, item, projects, images = []) {
  const status = statusOf(item);
  const project = projects.find((p) => p.id === item.projectId)?.name;
  const details = [status === 'done' ? '' : statusName(store, status), project, item.due ? `due ${item.due}` : ''].filter(Boolean);
  const head = `- [${status === 'done' ? 'x' : ' '}] ${item.text}${details.length ? ` (${details.join(' · ')})` : ''}`;
  const desc = (item.description ?? '').trim();
  const lines = desc ? desc.split(/\r?\n/) : [];
  if (images.length) lines.push(images.length === 1 ? 'Image (read it):' : 'Images (read them):', ...images.map((p) => `- ${p}`));
  return lines.length ? `${head}\n${lines.map((l) => `  ${l}`).join('\n')}` : head;
}

// A copied task is being handed on, so it moves to "On Deck" (completed ones stay done) and leaves the selection.
/** @param {Store} store @param {Task[]} items */
async function copyTasks(store, items) {
  if (!items.length) return;
  const text = items.map((i) => taskMarkdown(store, i, projectsOf(store))).join('\n');
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    toast('Could not copy: the browser blocked the clipboard');
    return;
  }
  for (const i of items) view.selected.delete(i.id);
  const moving = items.filter((i) => !['done', 'ondeck'].includes(statusOf(i))).map((i) => i.id);
  if (moving.length) updateItems(store, moving, { status: 'ondeck' });
  else store.refresh();
  toast(`${items.length === 1 ? 'Task' : `${items.length} tasks`} copied${moving.length ? ', moved to On Deck' : ''}`);
}

/** @param {Store} store @param {Task} item */
function copyButton(store, item) {
  return h('button', {
    type: 'button',
    class: 'icon-btn copy-btn',
    title: 'Copy',
    'aria-label': `Copy "${item.text}"`,
    onclick: () => copyTasks(store, [item]),
  }, icon('copy'));
}

// The skills a "/" in a task's description or the add field lists: those claude would have in the project's folder
// (the project's own first, then the user's), read through the runner and kept a moment per folder.
const SKILLS_STALE_MS = 30000;
/** @type {Map<string, { at: number, items: Promise<SlashItem[]> }>} */
const skillsByFolder = new Map();
/** @param {Store} store @param {string | null} projectId @returns {Promise<SlashItem[]>} */
function projectSkills(store, projectId) {
  const path = store.get('projects').projects.find((p) => p.id === projectId)?.localPath ?? '';
  const kept = skillsByFolder.get(path);
  if (kept && Date.now() - kept.at < SKILLS_STALE_MS) return kept.items;
  const base = runnerOf(store);
  // A project folder that is gone still leaves the user's own skills.
  const read = listSkills(base, path).catch((err) => (path ? listSkills(base, '') : Promise.reject(err)));
  const items = read.then((data) => {
    const project = data.project.map((s) => ({ name: s.name, description: s.description, hint: 'project' }));
    return [...project, ...data.global.filter((s) => !project.some((p) => p.name === s.name)).map((s) => ({ name: s.name, description: s.description }))];
  });
  skillsByFolder.set(path, { at: Date.now(), items });
  // A failed read (the runner is off) is asked again on the next "/".
  items.catch(() => skillsByFolder.delete(path));
  return items;
}

// Hands tasks to claude in a new Dev terminal, in the folder of the first task's project that has one.
// The terminal starts in the background: the page stays on Tasks, and the task's Dev button opens it.
// The issues and PRs it opens come back to the tasks (task-links.js).
// They are being worked on now, so open ones move to "In progress" (completed ones stay done).
// Their images go along as files the runner saves, named in the prompt. claude is asked for the done signal
// (dev-done.js), which Dev's turns show.
/** @param {Store} store @param {Task[]} items */
async function devTasks(store, items) {
  if (!items.length) return;
  // At the runner's limit the terminal would never start: say so, and leave the tasks where they are.
  const info = await runnerInfo(runnerOf(store)).catch(() => null);
  if (info && info.running >= info.max) {
    toast(`Not started: ${info.max} terminals are already running. Stop one in Dev, or start the board with TERMINAL_MAX set higher.`);
    return;
  }
  /** @type {Map<string, string[]>} */
  let images = new Map();
  if (items.some((i) => imagesOf(i).length)) {
    try {
      images = await imagePathsFor(store, runnerOf(store), items);
    } catch (err) {
      toast(`Starting without the images: ${/** @type {Error} */ (err).message}`);
    }
  }
  const projects = projectsOf(store);
  const list = items.map((i) => taskMarkdown(store, i, projects, images.get(i.id))).join('\n');
  const folder = items.map((i) => projects.find((p) => p.id === i.projectId)).find((p) => p?.localPath);
  const ids = items.map((i) => i.id);
  // Several tasks share one session: the first one that picked an agent or model (or effort) sets it. Unpicked, the
  // project's model and effort run, else its agent's defaults (taskRunOptions).
  const picked = items.find((i) => i.devModel || i.devProvider);
  const pickedEffort = items.find((i) => i.devEffort)?.devEffort ?? '';
  const { agent, model, effort } = taskRunOptions(store, folder, { ...picked, devEffort: pickedEffort });
  // A picked agent runs its own command in place of the project's, unless the project already runs it.
  const devCommand = taskAgentCommand(store, folder, agent);
  let started;
  try {
    started = await startDevSession({ store, claude: true, prompt: `Work on ${items.length === 1 ? 'this task' : 'these tasks'}:\n\n${list}\n\n${DONE_ASK}`, projectId: folder?.id, taskIds: ids, title: items[0].text, model, effort, devCommand });
  } catch (err) {
    // The runner did not answer, or refused: the tasks stay where they are.
    toast(`Not started: ${/** @type {Error} */ (err).message}`);
    return;
  }
  const { id: session, worktree } = started;
  for (const i of items) view.selected.delete(i.id);
  const moving = items.filter((i) => !['done', 'doing'].includes(statusOf(i))).map((i) => i.id);
  if (moving.length) updateItems(store, moving, { status: 'doing' });
  const name = items[0].text.length > 40 ? `${items[0].text.slice(0, 40)}…` : items[0].text;
  toast(`Dev session started on ${items.length === 1 ? `"${name}"` : `${items.length} tasks`}`);
  // The task keeps its terminal: its Dev button shows what the terminal is doing and opens it.
  // It keeps the worktree claude makes too, removed once the task is completed (task-worktrees.js).
  const pick = new Set(ids);
  store.update(COLLECTION, (d) => {
    for (const item of d.items) {
      if (!pick.has(item.id)) continue;
      item.devSession = session;
      // Not on a completed task, or the worktree would be removed as soon as it is made.
      if (worktree && statusOf(item) !== 'done') item.worktrees = [...(item.worktrees ?? []), { ...worktree, session }];
    }
  });
}

// What each task's terminal is doing, asked of the runner every few seconds once Tasks has been shown.
// A task whose terminal the runner no longer has (closed, or forgotten after a month) has no entry.
// A task waits for review once claude quits, once its turn ends with the done signal (its terminal's dot turns
// green), or once it has a PR and claude waits for its user: the runner says waiting only when claude's turn ended
// and no subagent still works, so a PR opened mid-turn does not count yet.
const DEV_POLL_MS = 4000;
// As many sessions as the runner's /status answers for (tools/terminal.js).
const STATUS_MAX = 200;
/** @type {{ status: Record<string, RunnerStatus>, withPr: Set<string>, timer: number, polled: boolean }} */
const devWatch = { status: {}, withPr: new Set(), timer: 0, polled: false };
/** @param {Store} store */
export function watchDevSessions(store) {
  if (devWatch.timer || !store.get(COLLECTION).items.some((t) => t.devSession)) return;
  const poll = async () => {
    devWatch.timer = 0;
    const items = store.get(COLLECTION).items;
    // The runner answers for the first 200 sessions asked: open tasks come first and the newest before the oldest,
    // or a long list of completed tasks would push the sessions still at work out of the answer.
    const newest = [...items].reverse();
    const ids = /** @type {string[]} */ ([...new Set([
      ...newest.filter((t) => statusOf(t) !== 'done'),
      ...newest.filter((t) => statusOf(t) === 'done'),
    ].map((t) => t.devSession).filter(Boolean))].slice(0, STATUS_MAX));
    let status;
    try {
      status = await sessionStatus(runnerOf(store), ids);
    } catch {}
    devWatch.timer ||= setTimeout(poll, DEV_POLL_MS);
    // An unreachable runner says nothing about the sessions, so nothing moves.
    if (!status) return;
    const polled = devWatch.polled;
    devWatch.polled = true;
    addTaskArtifacts(store, Object.fromEntries(Object.entries(status).map(([id, s]) => [id, s.artifacts ?? []])));
    const withPr = new Set(items.filter((t) => prsOf(t).length).map((t) => t.id));
    const { status: was, withPr: hadPr } = devWatch;
    devWatch.withPr = withPr;
    if (JSON.stringify(status) === JSON.stringify(was) && [...withPr].every((id) => hadPr.has(id))) return;
    devWatch.status = status;
    // Only on a change (claude quit, gave the done signal, started waiting, or a PR came while it waits), so a task put back in progress
    // while claude waits stays there. claude waiting on a question or a permission is not done.
    const ready = items.filter((t) => {
      // A task with no session reads no entry.
      const now = status[/** @type {string} */ (t.devSession)]?.state;
      const before = was[/** @type {string} */ (t.devSession)]?.state;
      if (now === 'done') return before !== 'done';
      const s = status[/** @type {string} */ (t.devSession)];
      if (now !== 'waiting' || s?.ask) return false;
      // The done signal says the work is over, with or without a PR.
      if (s?.signalled && !was[/** @type {string} */ (t.devSession)]?.signalled) return true;
      return withPr.has(t.id) && (before !== 'waiting' || !hadPr.has(t.id));
    });
    // A new question or permission is said once, wherever the board is open; not those already asked at load.
    if (polled) for (const [id, s] of Object.entries(status)) {
      if (!s.ask || s.state !== 'waiting' || JSON.stringify(was[id]?.ask) === JSON.stringify(s.ask)) continue;
      const task = items.find((t) => t.devSession === id);
      if (task) toast(`${ASK_LABELS[s.ask.kind] ?? ASK_LABELS.permission}: “${task.text}”`);
    }
    if (ready.length) moveToReview(store, ready.map((t) => t.id));
    if (location.hash.startsWith('#/todos')) store.refresh();
  };
  devWatch.timer = setTimeout(poll, 0);
}

// The Dev button; a right click on it opens the model and effort the task's sessions use.
/** @param {Store} store @param {Task} item */
function devControl(store, item) {
  return h('span', { class: 'dev-control' }, devButton(store, item));
}

// The task's agent, model and effort, in one flat list: Project default leaves the project's agent (or command) to
// choose; each agent's models under its name; the effort, when the agent that runs takes one. Saved on the task, so
// its Dev button starts every session with them. Also a new session.
/** @param {Store} store @param {Task} item @returns {MenuEntry[]} */
function devOptionEntries(store, item) {
  const model = item.devModel ?? '';
  const effort = item.devEffort ?? '';
  const agent = taskAgent(store, item);
  /** @param {Partial<Pick<Task, 'devModel' | 'devEffort' | 'devProvider'>>} patch */
  const set = (patch) => store.update(COLLECTION, (d) => {
    const t = d.items.find((x) => x.id === item.id);
    if (!t) return;
    for (const [field, value] of /** @type {['devModel' | 'devEffort' | 'devProvider', string | undefined][]} */ (Object.entries(patch))) {
      if (value) t[field] = value;
      else delete t[field];
    }
  });
  const name = (/** @type {string} */ v) => DEV_MODEL_NAMES[v] ?? v[0].toUpperCase() + v.slice(1);
  const project = projectsOf(store).find((p) => p.id === item.projectId);
  const own = projectAgent(store, project);
  // A project with a command of its own may run anything: every level is offered.
  const runs = agent ?? own;
  const efforts = runs ? agentEfforts(store, runs) : DEV_EFFORTS;
  // What Default runs: the project's pick, else its agent's.
  const defaults = devDefaults(store, project, agent);
  /** @type {MenuEntry[]} */
  const agentRows = devAgents(store).flatMap((a) => /** @type {MenuEntry[]} */ (a.models.length
    ? ['-', { label: a.name, icon: () => agentLogo(store, a), heading: true }, ...a.models.map((v) => ({
        label: name(v),
        checked: agent?.id === a.id && model === v,
        onSelect: () => set({ devModel: v, devProvider: a.id }),
      }))]
    // An agent with no models is one row, run with the model its program picks.
    : ['-', { label: a.name, icon: () => agentLogo(store, a), hint: 'Its default model', checked: agent?.id === a.id && !model, onSelect: () => set({ devModel: '', devProvider: a.id }) }]));
  return [
    { label: 'Project default', icon: own ? () => agentLogo(store, own) : icon('terminal'), hint: own ? [own.name, devDefaults(store, project).model].filter(Boolean).map((x, i) => (i ? name(x) : x)).join(' · ') : 'Its own command', checked: !agent, onSelect: () => set({ devModel: '', devProvider: '' }) },
    ...agentRows,
    '-',
    efforts.length
      ? { label: 'Effort', hint: effort && efforts.includes(effort) ? name(effort) : 'Default', items: [
          { label: 'Default', hint: defaults.effort && efforts.includes(defaults.effort) ? name(defaults.effort) : '', checked: !effort || !efforts.includes(effort), onSelect: () => set({ devEffort: '' }) },
          '-',
          ...efforts.map((v) => ({ label: name(v), checked: effort === v, onSelect: () => set({ devEffort: v }) })),
        ] }
      : null,
    '-',
    { label: 'Start a new session', icon: icon('terminal'), onSelect: () => devTasks(store, [item]) },
  ];
}

// Starts a Dev session on the task, or, once it has one, opens it in Dev; the colour says what the terminal is doing.
// Shift-click starts a new session anyway.
/** @param {Store} store @param {Task} item */
function devButton(store, item) {
  const status = item.devSession ? devWatch.status[item.devSession] : null;
  if (!status) {
    return h('button', {
      type: 'button',
      class: 'icon-btn copy-btn',
      title: 'Start a Dev session on this task. Right-click for its model and effort.',
      'aria-label': `Start a Dev session on "${item.text}"`,
      onclick: () => devTasks(store, [item]),
    }, icon('terminal'));
  }
  const { key: state, label } = claudeState(status);
  return h('button', {
    type: 'button',
    class: `icon-btn dev-btn is-${state}`,
    title: `Dev: ${label}. Click to open its terminal; Shift-click to start a new session; right-click for its model and effort.`,
    'aria-label': `Open the Dev terminal of "${item.text}" (${label})`,
    onclick: (/** @type {MouseEvent} */ e) => {
      if (e.shiftKey) return devTasks(store, [item]);
      const taskIds = store.get(COLLECTION).items.filter((t) => t.devSession === item.devSession).map((t) => t.id);
      // It has a session: its status was found by it.
      openSession({ id: /** @type {string} */ (item.devSession), cwd: status.cwd, taskIds });
    },
  }, icon('terminal'));
}

// Beside the title while claude waits for its user, so it shows from across the list: what it asks, and a click
// opens its terminal to answer. A question or permission stands out more than a turn that simply ended.
/** @param {Store} store @param {Task} item */
function waitingBadge(store, item) {
  const status = item.devSession ? devWatch.status[item.devSession] : null;
  if (status?.state !== 'waiting') return null;
  const ask = status.ask;
  const label = ask ? (ask.kind === 'question' ? 'Question' : ask.kind === 'plan' ? 'Approve plan' : 'Permission') : 'Your turn';
  const what = ask ? `${ASK_LABELS[ask.kind] ?? ASK_LABELS.permission}${ask.text ? `: ${ask.text}` : ''}` : 'claude finished its turn and waits for you';
  return h('button', {
    type: 'button',
    class: `dev-wait-badge${ask ? ' asks' : ''}`,
    title: `${what}. Click to open its terminal.`,
    'aria-label': `${what}. Open the Dev terminal of "${item.text}"`,
    onclick: () => {
      const taskIds = store.get(COLLECTION).items.filter((t) => t.devSession === item.devSession).map((t) => t.id);
      openSession({ id: /** @type {string} */ (item.devSession), cwd: status.cwd, taskIds });
    },
  }, icon(ask ? 'message' : 'terminal'), label);
}

// On a task a Cron flow made: opens the run that made it, or the flow when the run is gone (or the task predates
// runs keeping it).
/** @param {Store} store @param {Task} item */
function cronButton(store, item) {
  if (item.auto !== 'cron' || !item.autoRef) return null;
  const flow = store.get('cron')?.flows?.find((f) => f.id === item.autoRef);
  const run = item.cronRun ? store.get('cron')?.runs?.find((r) => r.id === item.cronRun) : null;
  const name = flow ? `“${flow.name}”` : 'a Cron flow';
  return h('a', {
    class: 'icon-btn cron-btn',
    href: run ? `#/cron?run=${encodeURIComponent(run.id)}` : `#/cron?flow=${encodeURIComponent(item.autoRef)}`,
    title: run ? `Made by ${name}. Open the run.` : `Made by ${name}. Open the flow.`,
    'aria-label': run ? `Open the Cron run that made "${item.text}"` : `Open the Cron flow that made "${item.text}"`,
  }, icon('repeat'));
}

// On a task a rule made: opens the page that shows what the check found (a site's health, Money, Liquidity Pools).
/** @param {Task} item */
function sourceButton(item) {
  const link = autoSourceLink(item);
  if (!link) return null;
  return h('a', {
    class: 'icon-btn cron-btn',
    href: link.href,
    title: `Made by ${/** @type {Record<string, string>} */ (AUTO_SOURCES)[/** @type {string} */ (item.auto)]}. Open ${link.label}.`,
    'aria-label': `Open ${link.label} for "${item.text}"`,
  }, icon(link.icon));
}

// Marks a task done, or back to "To do" when it already is.
/** @param {Store} store @param {Task} item */
function doneButton(store, item) {
  const done = statusOf(item) === 'done';
  return h('button', {
    type: 'button',
    class: done ? 'icon-btn done-btn on' : 'icon-btn done-btn',
    title: done ? 'Mark as not done' : 'Mark done',
    'aria-label': done ? `Mark "${item.text}" as not done` : `Mark "${item.text}" done`,
    'aria-pressed': String(done),
    onclick: () => updateItem(store, item.id, { status: done ? 'todo' : 'done' }),
  }, icon('check'));
}

// The checkbox picks the task for the batch actions. Shift+click picks the whole range from the last one.
// order: the ids shown, top to bottom.
/** @param {Store} store @param {Task} item @param {string[]} [order] */
function selectBox(store, item, order = []) {
  return h('input', {
    type: 'checkbox',
    class: 'todo-select',
    checked: view.selected.has(item.id),
    title: 'Select (Shift+click for a range)',
    'aria-label': `Select "${item.text}"`,
    onclick: (/** @type {MouseEvent & { currentTarget: HTMLInputElement }} */ e) => {
      const on = e.currentTarget.checked;
      // No task picked yet reads as -1.
      const from = order.indexOf(/** @type {string} */ (view.lastPicked));
      const to = order.indexOf(item.id);
      const ids = e.shiftKey && from >= 0 && to >= 0
        ? order.slice(Math.min(from, to), Math.max(from, to) + 1)
        : [item.id];
      for (const id of ids) on ? view.selected.add(id) : view.selected.delete(id);
      view.lastPicked = item.id;
      store.refresh();
    },
  });
}

// Shown while tasks are ticked: change them all at once, copy them, or delete them.
// Each field opens the same searchable, colored picker as a row's chips; picking a value applies it to every ticked task.
// In the table, the bar takes the table's columns when it is wide enough (see .batch-bar.aligned), so each picker sits above its column.
/**
 * @param {Store} store @param {Task[]} visible @param {Project[]} projects @param {string[]} categories
 * @param {{ aligned?: boolean, showDue?: boolean }} [options]
 */
function batchBar(store, visible, projects, categories, { aligned = false, showDue = true } = {}) {
  const items = store.get(COLLECTION).items.filter((i) => view.selected.has(i.id));
  if (!items.length) return null;
  const ids = items.map((i) => i.id);
  /** @param {Partial<Task>} patch */
  const apply = (patch) => updateItems(store, ids, patch);
  /** @template V @param {string} name @param {PickOption<V>[]} options @param {(value: V) => void} onPick */
  const select = (name, options, onPick) =>
    pickButton({ label: name, title: `Set the ${name.toLowerCase()} of the selected tasks`, options, onPick });
  // The text hides when the bar follows the table's columns, where only the icon fits.
  /** @param {IconName} iconName @param {string} text */
  const labelled = (iconName, text) => [icon(iconName), h('span', { class: 'batch-label' }, text)];
  const deadline = h('input', {
    type: 'date',
    class: 'due-picker',
    tabindex: '-1',
    'aria-hidden': 'true',
    onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => apply({ due: e.target.value }),
  });
  const deadlineControl = h('span', { class: 'due-control' },
    h('button', {
      type: 'button',
      class: 'btn-small',
      title: 'Set the deadline of the selected tasks',
      onclick: () => {
        try { deadline.showPicker(); } catch { deadline.focus(); }
      },
    }, ...(showDue ? [icon('calendar'), 'Deadline'] : labelled('calendar', 'Deadline'))),
    deadline);
  const allShown = visible.length > 0 && visible.every((i) => view.selected.has(i.id));
  const cls = ['batch-bar', aligned ? 'aligned' : '', showDue ? '' : 'no-due'].filter(Boolean).join(' ');
  return h('div', { class: cls, role: 'toolbar', 'aria-label': 'Selected tasks' },
    h('div', { class: 'batch-grid' },
      // Over the handle, checkbox and task columns.
      h('div', { class: 'batch-cell batch-lead' },
        // The count doubles as the way out, so clearing never wraps onto a line of its own.
        h('button', {
          type: 'button',
          class: 'btn-small batch-count',
          title: 'Clear the selection',
          'aria-label': `${items.length} selected, clear the selection`,
          onclick: () => {
            view.selected.clear();
            store.refresh();
          },
        }, `${items.length} selected`, icon('x')),
        allShown
          ? null
          : h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                for (const i of visible) view.selected.add(i.id);
                store.refresh();
              },
            }, `Select all ${visible.length} shown`),
        h('button', { type: 'button', class: 'btn-small', title: 'Mark the selected tasks done', onclick: () => apply({ status: 'done' }) }, icon('check'), 'Done')),
      h('div', { class: 'batch-cell' }, select('Status', statusOptions(store), (v) => apply({ status: v }))),
      h('div', { class: 'batch-cell' },
        select('Priority', PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v })), (v) => apply({ priority: v }))),
      h('div', { class: 'batch-cell' }, select('Project', [
        { value: '__personal', label: 'Personal' },
        ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
      ], (v) => apply({ projectId: v === '__personal' ? null : v }))),
      h('div', { class: 'batch-cell' },
        select('Category', [{ value: NO_CATEGORY, label: 'No category' }, ...categories.map((c) => ({ value: c, label: c, color: categoryColor(store, c) }))],
          (v) => apply({ category: v === NO_CATEGORY ? '' : v }))),
      // Without a deadline column, the deadline button joins the actions, as it does on each row.
      showDue ? h('div', { class: 'batch-cell' }, deadlineControl) : null,
      h('span', { class: 'grow' }),
      h('div', { class: 'batch-cell batch-actions' },
        showDue ? null : deadlineControl,
        h('button', {
          type: 'button',
          class: 'btn-small',
          title: 'Start one Dev session on the selected tasks',
          onclick: () => devTasks(store, items),
        }, ...labelled('terminal', 'Dev')),
        h('button', {
          type: 'button',
          class: 'btn-small',
          title: 'Copy the selected tasks as a Markdown list',
          onclick: () => copyTasks(store, items),
        }, ...labelled('copy', 'Copy')),
        h('button', {
          type: 'button',
          class: 'btn-small danger',
          title: 'Delete the selected tasks',
          onclick: () => removeItems(store, ids),
        }, ...labelled('trash', 'Delete')))));
}

/** @param {Store} store @param {Task[]} visible */
// Ticks or unticks every task shown, from the table header.
function selectAllBox(store, visible) {
  const picked = visible.filter((i) => view.selected.has(i.id)).length;
  const box = h('input', {
    type: 'checkbox',
    class: 'todo-select',
    checked: visible.length > 0 && picked === visible.length,
    disabled: !visible.length,
    title: 'Select all shown',
    'aria-label': 'Select all shown tasks',
    onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
      for (const i of visible) e.target.checked ? view.selected.add(i.id) : view.selected.delete(i.id);
      store.refresh();
    },
  });
  box.indeterminate = picked > 0 && picked < visible.length;
  return box;
}

// One todo row. Title, description, and the pickers all edit in place.
/**
 * @param {Store} store @param {Task} item
 * @param {{ store: Store, projects: Project[], projectLabel: string, order: string[], showDue: boolean }} ctx
 * @param {Place} place
 */
// ctx: { store, projects, projectLabel, order, showDue }. Without a deadline column, its button sits with the actions.
function todoRow(store, item, ctx, place) {
  const expanded = view.expanded.has(item.id);
  const status = statusOf(item);
  const priority = item.priority ?? 'none';
  const hasDescription = Boolean(item.description);
  const repos = ctx.projects.find((p) => p.id === item.projectId)?.github?.repos ?? [];
  const projectOptions = [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }));
  const categoryNames = categoriesFor(store, item.projectId);
  if (item.category && !categoryNames.includes(item.category)) categoryNames.push(item.category);
  // Images dropped anywhere on the row are added to the task.
  const drop = imageDrop(store, item);

  return h('li', {
    class: ['todo-item', status === 'done' ? 'done' : '', view.selected.has(item.id) ? 'selected' : '', place.depth ? 'subtask' : ''].filter(Boolean).join(' '),
    'data-id': item.id,
    style: place.depth ? { '--depth': String(place.depth) } : null,
    ondragstart: (/** @type {DragEvent & { currentTarget: HTMLElement, dataTransfer: DataTransfer }} */ e) => {
      view.dragId = item.id;
      view.dragStatus = statusOf(item);
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id); // Firefox needs data to start a drag
      markDragging(store);
    },
    ondragend: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      view.dragId = null;
      e.currentTarget.draggable = false;
      unmarkDragging();
    },
    // The middle of a row puts the dragged task under it; its top and bottom edges reorder.
    ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      if (dragsFiles(e)) return drop.ondragover(e);
      if (!view.dragId || view.dragId === item.id) return;
      const side = dropSide(e, true);
      if (side !== 'inside' && !(reorderEnabled() && canDropOn(item))) return clearDropMarks(e.currentTarget);
      e.preventDefault();
      markDrop(e.currentTarget, side);
    },
    ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      clearDropMarks(e.currentTarget);
      drop.ondragleave(e);
    },
    ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      if (dragsFiles(e)) return drop.ondrop(e);
      if (!view.dragId) return;
      const side = dropSide(e, true);
      if (side !== 'inside' && !(reorderEnabled() && canDropOn(item))) return;
      e.preventDefault();
      clearDropMarks(e.currentTarget);
      if (side === 'inside') nestDragged(store, item.id);
      else moveDragged(store, item.id, side === 'after', place.parentId);
      view.dragId = null;
    },
  },
    h('div', {
      class: hasDescription || imagesOf(item).length ? 'todo-row expandable' : 'todo-row',
      onclick: (/** @type {MouseEvent} */ e) => {
        if (hasDescription || imagesOf(item).length) toggleFromRow(store, item.id, e);
      },
      oncontextmenu: (/** @type {MouseEvent} */ e) => openTaskMenu(store, item, ctx, repos, e),
    },
      h('span', {
        class: 'grip',
        title: reorderEnabled() ? 'Drag to reorder, or onto a task to put it under that task' : 'Drag onto a task to put it under that task (clear the sort to reorder)',
        'aria-label': 'Drag to reorder',
        // Only the grip makes the row draggable, so text stays selectable.
        onpointerdown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => {
          /** @type {HTMLLIElement} */ (e.currentTarget.closest('li')).draggable = true;
        },
      }, icon('grip')),
      selectBox(store, item, ctx.order),
      h('div', { class: 'todo-title-cell' },
        subtaskToggle(store, item, place),
        editText({
          value: item.text,
          placeholder: 'Untitled',
          className: 'todo-title',
          onSave: (text) => updateItem(store, item.id, { text }),
        }),
        dueChip(item),
        autoBadge(item),
        linkChips(store, item),
        waitingBadge(store, item),
        item.inbox ? h('span', { class: 'muted small' }, `needs ${missingFor(item)}`) : null,
        item.inbox
          ? h('button', {
              type: 'button',
              class: 'btn-small',
              title: 'Take it out of To Organize',
              onclick: () => updateItem(store, item.id, { inbox: false }),
            }, 'Organized')
          : null),
      h('div', { class: 'todo-meta' },
        h('div', { class: 'todo-status' },
          pickChip({
            value: status,
            className: 'pick-status',
            options: statusOptions(store, status),
            onPick: (v) => updateItem(store, item.id, { status: v }),
          }),
          doneButton(store, item)),
        pickChip({
          value: priority,
          className: 'pick-priority',
          options: PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v })),
          onPick: (v) => updateItem(store, item.id, { priority: v }),
        }),
        pickChip({
          value: item.projectId ?? null,
          className: 'pick-project',
          options: projectOptions,
          nullable: true,
          nullLabel: 'Personal',
          onPick: (v) => moveToProject(store, item.id, v),
        }),
        pickChip({
          value: item.category || null,
          className: 'pick-category',
          options: categoryNames.map((c) => ({ value: c, label: c, color: categoryColor(store, c) })),
          nullable: true,
          nullLabel: 'No category',
          allowCreate: true,
          onPick: (v) => updateItem(store, item.id, { category: v ?? '' }),
          onCreate: (name) => updateItem(store, item.id, { category: createTodoCategory(store, name, item.projectId) }),
        }),
        ctx.showDue ? dueControl(store, item) : null),
      h('div', { class: 'todo-actions' },
        // The description and image markers lead: before the deadline button, or the PR button with a deadline column.
        hasDescription
          ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left'))
          : null,
        imageCount(item),
        ctx.showDue ? null : dueControl(store, item),
        repos.length || issuesOf(item).length || prsOf(item).length ? issueControl(store, item, repos) : null,
        cronButton(store, item),
        sourceButton(item),
        devControl(store, item),
        item.email
          ? h('a', { href: `#/inbox?email=${encodeURIComponent(item.email.id)}`, class: 'icon-btn', title: 'Open the email', 'aria-label': 'Open the email this task came from' }, icon('mail'))
          : null,
        copyButton(store, item),
        h('button', {
          type: 'button',
          class: expanded ? 'icon-btn chevron open' : 'icon-btn chevron',
          title: expanded ? 'Hide description' : 'Show description',
          'aria-label': expanded ? 'Hide description' : 'Show description',
          'aria-expanded': String(expanded),
          onclick: () => toggleExpanded(store, item.id),
        }, icon('chevron-down')),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Delete',
          'aria-label': `Delete "${item.text}"`,
          onclick: () => removeItem(store, item.id),
        }, icon('x')))),

    expanded
      ? h('div', { class: 'todo-desc', tabindex: '-1', onpaste: drop.onpaste },
          editText({
            value: item.description,
            placeholder: 'Add a description… paste notes, links, steps',
            rich: true,
            multiline: true,
            allowEmpty: true,
            attach: (field) => slashComplete(field, () => projectSkills(store, item.projectId)),
            onSave: (description) => updateItem(store, item.id, { description }),
          }),
          taskTools(store, item),
          usageNote(store, item))
      : null);
}

// A right click on a task row: first what the click landed on (the Dev arrow's menu on Dev, the statuses on the
// status chip, a link's actions on an issue or PR), then the task's own actions. Text being edited keeps the
// browser's menu, for spelling and paste.
/**
 * @param {Store} store @param {Task} item @param {{ projects: Project[] }} ctx @param {string[]} repos
 * @param {MouseEvent} e
 */
function openTaskMenu(store, item, ctx, repos, e) {
  const target = /** @type {Element} */ (e.target);
  if (target.closest('input, textarea, [contenteditable]')) return;
  e.preventDefault();
  const specific = clickedEntries(store, item, ctx, target);
  openMenu([...specific, specific.length ? '-' : null, ...taskEntries(store, item, ctx, repos)], { x: e.clientX, y: e.clientY });
}

// The status, priority, project and category of a task as menu rows, each a list with a tick on the one it has.
/** @param {Store} store @param {Task} item @param {Project[]} projects */
function fieldRows(store, item, projects) {
  const status = statusOf(item);
  const priority = item.priority ?? 'none';
  const categories = categoriesFor(store, item.projectId);
  if (item.category && !categories.includes(item.category)) categories.push(item.category);
  return {
    /** @returns {MenuEntry[]} */
    status: () => statusOptions(store, status).map((o) => ({ label: o.label, checked: o.value === status, onSelect: () => updateItem(store, item.id, { status: o.value }) })),
    /** @returns {MenuEntry[]} */
    priority: () => PRIORITIES.map(([v, l]) => ({ label: l, checked: v === priority, onSelect: () => updateItem(store, item.id, { priority: v }) })),
    /** @returns {MenuEntry[]} */
    project: () => [
      { label: 'Personal', checked: !item.projectId, onSelect: () => moveToProject(store, item.id, null) },
      '-',
      ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({
        label: p.name, icon: () => projectIcon(p), checked: p.id === item.projectId, onSelect: () => moveToProject(store, item.id, p.id),
      })),
    ],
    /** @returns {MenuEntry[]} */
    category: () => [
      { label: 'No category', checked: !item.category, onSelect: () => updateItem(store, item.id, { category: '' }) },
      '-',
      ...categories.map((c) => ({ label: c, checked: c === item.category, onSelect: () => updateItem(store, item.id, { category: c }) })),
    ],
  };
}

// The rows for the control under the pointer, or none when it is on the row's plain space.
/**
 * @param {Store} store @param {Task} item @param {{ projects: Project[] }} ctx @param {Element} target
 * @returns {MenuEntry[]}
 */
function clickedEntries(store, item, ctx, target) {
  if (target.closest('.dev-control')) return devOptionEntries(store, item);
  const rows = fieldRows(store, item, ctx.projects);
  if (target.closest('.pick-status')) return rows.status();
  if (target.closest('.pick-priority')) return rows.priority();
  if (target.closest('.pick-project')) return rows.project();
  if (target.closest('.pick-category')) return rows.category();
  if (target.closest('.due-control')) return dueEntries(store, item);
  const link = /** @type {HTMLAnchorElement | null} */ (target.closest('a.issue-link'));
  if (link) {
    const tracked = [...issuesOf(item), ...prsOf(item)].find((l) => l.url === link.href);
    return [
      { label: 'Open in a new tab', icon: () => icon('globe'), onSelect: () => window.open(link.href, '_blank', 'noopener') },
      copyItem('Copy link', link.href),
      tracked ? { label: 'Unlink from the task', icon: () => icon('x'), onSelect: () => unlinkLink(store, item.id, tracked) } : null,
    ];
  }
  return [];
}

// Set or change a deadline (the native date picker of the row's deadline control), or clear it.
/** @param {Store} store @param {Task} item @returns {MenuEntry[]} */
function dueEntries(store, item) {
  const pick = () => {
    const input = /** @type {HTMLInputElement | null} */ (document.querySelector(`.todo-item[data-id="${CSS.escape(item.id)}"] .due-picker`));
    try { input?.showPicker(); } catch { input?.focus(); }
  };
  return [
    { label: item.due ? 'Change the deadline…' : 'Set a deadline…', icon: () => icon('calendar'), onSelect: pick },
    { label: 'Due today', onSelect: () => updateItem(store, item.id, { due: todayISO() }) },
    item.due ? { label: 'Clear the deadline', icon: () => icon('x'), onSelect: () => updateItem(store, item.id, { due: '' }) } : null,
  ];
}

// What a task's right-click menu always offers.
/**
 * @param {Store} store @param {Task} item @param {{ projects: Project[] }} ctx @param {string[]} repos
 * @returns {MenuEntry[]}
 */
function taskEntries(store, item, ctx, repos) {
  const done = statusOf(item) === 'done';
  const rows = fieldRows(store, item, ctx.projects);
  const session = item.devSession ? devWatch.status[item.devSession] : null;
  const expanded = view.expanded.has(item.id);
  return [
    { label: done ? 'Mark as not done' : 'Mark done', icon: () => icon('check-square'), onSelect: () => updateItem(store, item.id, { status: done ? 'todo' : 'done' }) },
    { label: 'Status', items: rows.status() },
    { label: 'Priority', items: rows.priority() },
    { label: 'Project', items: rows.project(), search: 'Find a project' },
    { label: 'Category', items: rows.category(), search: 'Find a category' },
    { label: 'Deadline', icon: () => icon('calendar'), items: dueEntries(store, item) },
    '-',
    session
      ? { label: 'Open the Dev terminal', icon: () => icon('terminal'), onSelect: () => openSession({
          id: /** @type {string} */ (item.devSession),
          cwd: session.cwd,
          taskIds: store.get(COLLECTION).items.filter((t) => t.devSession === item.devSession).map((t) => t.id),
        }) }
      : { label: 'Start a Dev session', icon: () => icon('terminal'), onSelect: () => devTasks(store, [item]) },
    { label: 'Dev options', items: devOptionEntries(store, item) },
    repos.length || issuesOf(item).length || prsOf(item).length
      ? { label: 'Issues and PRs…', icon: () => icon('repo'), onSelect: () => openIssueDialog(store, item, repos) }
      : null,
    { label: 'LinkedIn post…', icon: () => icon('linkedin'), onSelect: () => openLinkedinComposer(store, { taskId: item.id }) },
    { label: expanded ? 'Hide the description' : item.description ? 'Show the description' : 'Add a description', icon: () => icon('align-left'), onSelect: () => toggleExpanded(store, item.id) },
    '-',
    { label: 'Copy', icon: () => icon('copy'), hint: 'Markdown', onSelect: () => copyTasks(store, [item]) },
    copyItem('Copy title', item.text),
    '-',
    { label: 'Delete', icon: () => icon('trash'), danger: true, onSelect: () => removeItem(store, item.id) },
  ];
}

// A click on a row's empty space, or its plain text, opens or closes its description and images.
// Clicks on a control, a chip, a menu or the title's editor keep their own meaning, and so does selecting text.
const ROW_CONTROLS = 'a, button, input, select, textarea, label, summary, [role="button"], [role="menu"], [role="listbox"], [role="option"], [contenteditable], .grip, .popover';
/** @param {Store} store @param {string} id @param {MouseEvent} e */
function toggleFromRow(store, id, e) {
  const target = /** @type {Element} */ (e.target);
  if (!target.isConnected || target.closest(ROW_CONTROLS)) return;
  if (String(window.getSelection() ?? '')) return;
  toggleExpanded(store, id);
}

// What the task's claude sessions used, read from their transcripts (dev-usage.js); shown with its details.
/** @param {Store} store @param {Task} item */
function usageNote(store, item) {
  const records = recordsOfTask(store, item.id);
  if (!records.length) return null;
  const sum = sumUsage(records);
  return h('p', { class: 'muted small task-usage', title: usageTitle(sum) }, icon('cpu'), `AI usage: ${usageLine(sum)}`);
}

/** @param {Task} item */
function imageCount(item) {
  const n = imagesOf(item).length;
  if (!n) return null;
  const text = n === 1 ? 'Has an image' : `Has ${n} images`;
  return h('span', { class: 'desc-indicator', title: text, 'aria-label': text }, icon('image'));
}

// --- Board: one column per status; dragging a card to a column changes its status ---

/** @param {Store} store @param {Task} item @param {Project[]} projects @param {string[]} order @param {Place} place */
function boardCard(store, item, projects, order, place) {
  const p = projects.find((x) => x.id === item.projectId);
  const priority = item.priority ?? 'none';
  const expanded = view.expanded.has(item.id);
  const images = imageDrop(store, item);
  return h('article', {
    class: ['kanban-card', view.selected.has(item.id) ? 'selected' : '', place.depth ? 'subtask' : ''].filter(Boolean).join(' '),
    'data-id': item.id,
    style: place.depth ? { '--depth': String(Math.min(place.depth, 3)) } : null,
    draggable: 'true',
    ondragstart: (/** @type {DragEvent & { currentTarget: HTMLElement, dataTransfer: DataTransfer }} */ e) => {
      view.dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id); // Firefox needs data to start a drag
      markDragging(store);
    },
    ondragend: () => {
      view.dragId = null;
      unmarkDragging();
    },
    // A card's middle puts the dragged task under it; its edges place it before or after, beside it in the tree.
    // Both take the column's status, as a drop on the column does.
    ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      if (dragsFiles(e)) return images.ondragover(e);
      if (!view.dragId || view.dragId === item.id) return;
      e.preventDefault();
      markDrop(e.currentTarget, dropSide(e, true));
    },
    ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      clearDropMarks(e.currentTarget);
      images.ondragleave(e);
    },
    ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
      if (dragsFiles(e)) return images.ondrop(e);
      if (!view.dragId || view.dragId === item.id) return;
      e.preventDefault();
      e.stopPropagation();
      clearDropMarks(e.currentTarget);
      e.currentTarget.closest('.kanban-col')?.classList.remove('drop-target');
      const side = dropSide(e, true);
      const patch = { status: statusOf(item) };
      if (side === 'inside') nestDragged(store, item.id, patch);
      else moveDragged(store, item.id, side === 'after', place.parentId, patch);
      view.dragId = null;
    },
  },
    h('div', { class: 'row kanban-title' },
      selectBox(store, item, order),
      subtaskToggle(store, item, place),
      editText({ value: item.text, placeholder: 'Untitled', className: 'todo-title', onSave: (text) => updateItem(store, item.id, { text }) })),
    h('div', { class: 'row kanban-meta' },
      p ? h('span', { class: 'row small' }, projectIcon(p), p.name) : h('span', { class: 'muted small' }, 'Personal'),
      priority !== 'none' ? h('span', { class: `pill tone-${priority}` }, label(PRIORITIES, priority)) : null,
      categoryTag(store, item.category),
      dueChip(item),
      autoBadge(item)),
    h('div', { class: 'row between' },
      h('div', { class: 'todo-status' },
        pickChip({
          value: statusOf(item),
          options: statusOptions(store, statusOf(item)),
          onPick: (v) => updateItem(store, item.id, { status: v }),
        }),
        doneButton(store, item)),
      h('div', { class: 'row kanban-actions' },
        item.description ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left')) : null,
        imageCount(item),
        cronButton(store, item),
        sourceButton(item),
        devControl(store, item),
        copyButton(store, item),
        h('button', {
          type: 'button',
          class: expanded ? 'icon-btn chevron open' : 'icon-btn chevron',
          title: expanded ? 'Hide details' : 'Deadline and description',
          'aria-label': expanded ? 'Hide details' : 'Show deadline and description',
          'aria-expanded': String(expanded),
          onclick: () => toggleExpanded(store, item.id),
        }, icon('chevron-down')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete "${item.text}"`, onclick: () => removeItem(store, item.id) }, icon('x')))),
    // The same details as a table row, so a card never needs the table to be edited.
    expanded
      ? h('div', { class: 'kanban-details', tabindex: '-1', onpaste: images.onpaste },
          h('label', { class: 'row small muted' }, 'Deadline',
            h('input', {
              type: 'date',
              class: 'due-input',
              value: item.due ?? '',
              'aria-label': `Deadline for "${item.text}"`,
              onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => updateItem(store, item.id, { due: e.target.value }),
            })),
          editText({
            value: item.description,
            placeholder: 'Add a description…',
            rich: true,
            multiline: true,
            allowEmpty: true,
            attach: (field) => slashComplete(field, () => projectSkills(store, item.projectId)),
            onSave: (description) => updateItem(store, item.id, { description }),
          }),
          taskTools(store, item),
          usageNote(store, item))
      : null);
}

// `order` is filled with the cards on screen, column by column.
/** @param {Store} store @param {Task[]} items @param {Project[]} projects @param {string[]} order */
function boardView(store, items, projects, order) {
  // A status hidden in Settings → Labels keeps its column only while a task shown is in it.
  const columns = taskStatuses(store).filter((s) => !s.hidden || items.some((i) => statusOf(i) === s.key));
  return h('div', { class: 'kanban' }, columns.map((s) => {
    const { key } = s;
    const cards = items.filter((i) => statusOf(i) === key);
    return h('section', {
      class: 'kanban-col',
      ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        if (!view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      },
      ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        updateItems(store, draggedIds(store), { status: key });
        view.dragId = null;
      },
    },
      h('h3', { class: 'row between' }, pill(s.name, statusLook(s)), h('span', { class: 'count' }, String(cards.length))),
      cards.length ? nestedRows(cards, (item, place) => boardCard(store, item, projects, order, place), order) : h('p', { class: 'muted small' }, 'Drop a task here'));
  }));
}

// --- Sorting and column filters ---

/** @param {Task} item @param {string} key @param {Project[]} projects */
const columnValue = (item, key, projects) => {
  if (key === 'text') return item.text.toLowerCase();
  if (key === 'status') return STATUS_GROUP_ORDER.indexOf(statusOf(item));
  if (key === 'priority') return PRIORITY_ORDER[item.priority ?? 'none'];
  if (key === 'project') return (projects.find((p) => p.id === item.projectId)?.name ?? 'Personal').toLowerCase();
  if (key === 'due') return item.due || '9999-99-99'; // tasks without a deadline sort last
  return (item.category || '￿').toLowerCase(); // empty categories sort last
};

/** @param {Task[]} items @param {Project[]} projects */
function sortItems(items, projects) {
  const { key, dir } = view.sort;
  if (!key) return items;
  const sign = dir === 'desc' ? -1 : 1;
  return [...items].sort((a, b) => {
    const x = columnValue(a, key, projects);
    const y = columnValue(b, key, projects);
    // A column gives numbers for every task or strings for every task.
    const cmp = typeof x === 'number' ? x - /** @type {number} */ (y) : String(x).localeCompare(String(y));
    return cmp * sign;
  });
}

// Click a column title: ascending, then descending, then the manual order.
/** @param {Store} store @param {string} key */
function cycleSort(store, key) {
  if (view.sort.key !== key) view.sort = { key, dir: 'asc' };
  else if (view.sort.dir === 'asc') view.sort = { key, dir: 'desc' };
  else view.sort = { key: '', dir: 'asc' };
  store.refresh();
}

/** @param {string} key */
const sortMark = (key) => (view.sort.key !== key ? '' : view.sort.dir === 'asc' ? ' ↑' : ' ↓');

/** @param {Store} store @param {string} key @param {string} text */
function columnHeader(store, key, text) {
  return h('button', {
    type: 'button',
    class: view.sort.key === key ? 'th-btn sorted' : 'th-btn',
    title: `Sort by ${text}`,
    onclick: () => cycleSort(store, key),
  }, text + sortMark(key));
}

// Filter row under the headers, one control per column, aligned with the rows.
/** @param {Store} store @param {Project[]} projects @param {string[]} categories @param {boolean} showDue */
function columnFilters(store, projects, categories, showDue) {
  const f = view.colFilter;
  /** @param {'text'} key */
  const set = (key) => (/** @type {Event & { target: HTMLInputElement }} */ e) => {
    view.colFilter = { ...view.colFilter, [key]: e.target.value };
    store.refresh();
  };
  // Searchable, and several values can be picked; a task matching any of them is shown.
  /** @param {'status' | 'priority' | 'project' | 'category'} key @param {PickOption<string>[]} options */
  const select = (key, options) =>
    pickMulti({
      key: `todo-filter-${key}`,
      values: f[key],
      options,
      ariaLabel: `Filter ${key}`,
      onChange: (values) => {
        view.colFilter = { ...view.colFilter, [key]: values };
        store.refresh();
      },
    });
  return h('div', { class: 'todo-row todo-filters' },
    h('span'), h('span'),
    h('input', {
      type: 'search',
      value: f.text,
      placeholder: 'Filter titles',
      'aria-label': 'Filter titles',
      onchange: set('text'),
    }),
    select('status', taskStatuses(store).map((s) => ({ value: s.key, label: s.name, ...statusLook(s) }))),
    select('priority', PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v }))),
    select('project', [{ value: 'none', label: 'Personal' },
      ...[...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }))]),
    select('category', [{ value: NO_CATEGORY, label: 'No category' }, ...categories.map((c) => ({ value: c, label: c, color: categoryColor(store, c) }))]),
    showDue ? h('span') : null,
    h('span', null, Object.values(f).some((v) => v.length) || !isDefaultSort(view.sort)
      ? h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            view.colFilter = emptyColFilter();
            view.sort = { ...DEFAULT_SORT };
            store.refresh();
          },
        }, 'Reset')
      : null));
}

// --- AI: tidy todo titles (task 3) ---

/** @param {Store} store */
async function runTidy(store) {
  const open = store.get(COLLECTION).items.filter((i) => statusOf(i) !== 'done').slice(0, 40);
  if (!open.length) {
    view.tidy = { status: 'ok', items: [] };
    return store.refresh();
  }
  view.tidy = { status: 'loading', items: [] };
  store.refresh();
  try {
    const reply = await ask(store, 'task-tidy', [
      { role: 'system', content: systemPrompt(store, 'tidy') },
      {
        role: 'user',
        content: JSON.stringify({
          items: open.map((i) => ({ id: i.id, title: i.text, category: i.category || '', priority: i.priority ?? 'none', projectId: i.projectId ?? null })),
          profiles: profilesFor(store.get('projects').projects, open.map((i) => i.projectId)),
        }),
      },
    ]);
    const parsed = parseJson(reply);
    /** @type {{ id: string, title?: unknown, category?: unknown, priority?: string }[]} */
    const list = Array.isArray(parsed) ? parsed : parsed.items ?? [];
    const known = new Map(open.map((i) => [i.id, i]));
    const items = list
      .filter((s) => s && known.has(s.id))
      .map((s) => {
        // Only ids of the tasks sent are kept above.
        const before = /** @type {Task} */ (known.get(s.id));
        const priority = PRIORITIES.some(([k]) => k === s.priority) ? /** @type {string} */ (s.priority) : before.priority ?? 'none';
        return { id: s.id, title: String(s.title ?? '').trim() || before.text, category: String(s.category ?? '').trim(), priority };
      })
      .filter((s) => s.title !== /** @type {Task} */ (known.get(s.id)).text || s.category !== (/** @type {Task} */ (known.get(s.id)).category || '') || s.priority !== (/** @type {Task} */ (known.get(s.id)).priority ?? 'none'));
    view.tidy = { status: 'ok', items };
  } catch (err) {
    // An error shows no suggestions.
    view.tidy = /** @type {typeof view.tidy} */ ({ status: 'error', error: /** @type {Error} */ (err).message });
  }
  store.refresh();
}

/** @param {Store} store @param {TidySuggestion} s */
function applyTidy(store, s) {
  updateItem(store, s.id, { text: s.title, category: s.category, priority: s.priority });
  view.tidy.items = view.tidy.items.filter((x) => x.id !== s.id);
  store.refresh();
}

/** @param {Store} store */
function tidyPanel(store) {
  const t = view.tidy;
  if (t.status === 'idle' && !hasOpenRouter(store)) return setupBanner('openrouter', 'Tidy with AI needs an OpenRouter key.');
  const dismiss = h('button', { type: 'button', class: 'btn-small', onclick: () => { view.tidy = { status: 'idle', items: [] }; store.refresh(); } }, 'Dismiss');
  if (t.status === 'loading') return h('div', { class: 'panel-mini' }, 'Asking the model…');
  if (t.status === 'error') return notice({ text: t.error, actions: [dismiss] });
  if (t.status !== 'ok') return null;
  if (!t.items.length) return h('div', { class: 'panel-mini' }, 'Nothing to tidy. ', dismiss);
  const items = store.get(COLLECTION).items;
  return h('div', { class: 'panel-mini' },
    h('div', { class: 'row between' },
      h('strong', null, `${t.items.length} suggestion${t.items.length > 1 ? 's' : ''}`),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn-small primary',
          onclick: () => {
            t.items.forEach((s) => updateItem(store, s.id, { text: s.title, category: s.category, priority: s.priority }));
            view.tidy = { status: 'idle', items: [] };
            store.refresh();
          },
        }, 'Apply all'),
        dismiss)),
    h('ul', { class: 'tidy-list' },
      t.items.map((s) => {
        const before = items.find((i) => i.id === s.id);
        return h('li', null,
          h('span', { class: 'muted' }, before?.text ?? ''),
          h('span', { class: 'arrow' }, '→'),
          h('strong', null, s.title),
          categoryTag(store, s.category),
          s.priority !== 'none' ? h('span', { class: `pill tone-${s.priority}` }, label(PRIORITIES, s.priority)) : null,
          h('button', { type: 'button', class: 'btn-small', onclick: () => applyTidy(store, s) }, 'Apply'));
      })));
}

// --- Project bar and details ---

// Project summary under the title. "Show more" reveals the project's details.
// The labels a project carries, as objects with names.
/** @param {Store} store @param {Project} p */
const labelsFor = (store, p) => /** @type {ProjectLabel[]} */ (labelsOf(p)
  .map((id) => (store.get('projects').categories ?? []).find((c) => c.id === id))
  .filter(Boolean));

// Beside the pencil: opens the project's website in a new tab, when it has one.
/** @param {Project | undefined} p */
const projectWebsiteButton = (p) => p?.website
  ? h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'icon-btn', title: `Open ${p.website}`, 'aria-label': 'Open project website' }, icon('globe'))
  : null;

// After the website: each repo on GitHub (the org when there is no repo), then Dev's Explorer and a terminal in the
// project's local folder.
/** @param {Project | undefined} p */
function projectLinkButtons(p) {
  if (!p) return [];
  const gh = (/** @type {string} */ path) => h('a', {
    href: `https://github.com/${path}`, target: '_blank', rel: 'noopener', class: 'icon-btn', title: `Open ${path} on GitHub`, 'aria-label': `Open ${path} on GitHub`,
  }, icon('github'));
  const repos = p.github.repos.length ? p.github.repos : p.github.org ? [p.github.org] : [];
  return [
    ...repos.map(gh),
    p.localPath ? h('a', { href: `#/dev?project=${p.id}&side=files`, class: 'icon-btn', title: `Browse ${p.localPath} in Dev`, 'aria-label': 'Open the project folder in Dev' }, icon('folder')) : null,
    p.localPath ? h('a', { href: `#/dev?project=${p.id}`, class: 'icon-btn', title: `Open a terminal in ${p.localPath}`, 'aria-label': 'Open a terminal in the project folder' }, icon('terminal')) : null,
  ];
}

// Inline after the title: labels, open count, and a toggle for the details panel.
/** @param {Store} store @param {Project | undefined} p */
function projectMeta(store, p) {
  if (!p) return null;
  const open = store.get(COLLECTION).items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  return h('span', { class: 'row meta-inline' },
    labelsFor(store, p).map((l) => h('span', { class: 'pill tone-custom', style: { '--c': labelColor(l) } }, l.name)),
    h('span', { class: 'muted small' }, `${open} open`),
    h('button', {
      type: 'button',
      class: 'btn-small',
      'aria-expanded': String(view.showProject),
      onclick: () => {
        view.showProject = !view.showProject;
        store.refresh();
      },
    }, view.showProject ? 'Less' : 'More'));
}

/** @param {Store} store @param {Project} p */
function projectDetails(store, p) {
  const items = store.get(COLLECTION).items.filter((i) => i.projectId === p.id);
  const done = items.filter((i) => statusOf(i) === 'done').length;
  // Repo counts load in the background; the page refreshes when they arrive, but only while on this list.
  const onLoad = () => {
    if (location.hash.startsWith('#/todos')) store.refresh();
  };
  return h('div', { class: 'project-details stack' },
    p.description ? h('p', null, p.description) : h('p', { class: 'muted' }, 'No description yet. Use the pencil to add one.'),
    h('div', { class: 'stats' },
      h('div', null, h('strong', null, String(items.length - done)), h('span', { class: 'muted' }, 'open')),
      h('div', null, h('strong', null, String(done)), h('span', { class: 'muted' }, 'done')),
      labelsFor(store, p).length
        ? h('div', null, h('strong', null, labelsFor(store, p).map((l) => l.name).join(', ')), h('span', { class: 'muted' }, 'labels'))
        : null),
    p.website ? h('p', null, h('a', { href: p.website, target: '_blank', rel: 'noopener' }, p.website)) : null,
    p.github.org ? h('p', null, 'GitHub: ', githubLink(p.github.org)) : null,
    p.github.repos.length
      ? h('ul', { class: 'repo-summary' },
          p.github.repos.map((r) => {
            const s = /** @type {RepoState} */ (repoStats(r, onLoad));
            const text = s.status === 'ok' ? `${s.issues} issues · ${s.prs} PRs` : s.status === 'loading' ? 'loading…' : s.error;
            return h('li', null,
              githubLink(r),
              h('span', { class: 'muted' }, text));
          }))
      : null);
}

// --- Page ---

// Each keystroke re-renders the list; the shell keeps focus and the caret in the box across the render. It has to run
// inside the input event: a render from a timer counts as a background one and is held while the box has focus.
/** @param {Store} store */
function searchBox(store) {
  const input = h('input', {
    type: 'search',
    value: view.query,
    placeholder: 'Search tasks',
    title: `Search tasks: ${QUERY_HINT}`,
    'aria-label': 'Search tasks',
    autocomplete: 'off',
    oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
      view.query = e.target.value;
      store.refresh();
    },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Escape' && view.query) {
        e.stopPropagation();
        view.query = '';
        store.refresh();
      }
    },
  });
  return h('label', { class: view.query ? 'todo-search active' : 'todo-search' }, icon('search'), input);
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  watchDevSessions(store);
  if (view.focusTask) {
    const id = view.focusTask;
    view.focusTask = '';
    requestAnimationFrame(() => {
      // The page on screen: a patched redraw keeps the old elements, not those of this render.
      const el = document.querySelector(`main.view [data-id="${CSS.escape(id)}"]`);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      el.classList.add('flash');
    });
  }
  const projects = projectsOf(store);
  const { items } = store.get(COLLECTION);
  if (isProjectFilter(view.filter) && !projects.some((p) => p.id === view.filter)) view.filter = 'all';

  // Settings → Labels sets the order.
  const categories = taskCategoryNames(store);
  view.category = view.category.filter((c) => c === NO_CATEGORY || categories.includes(c));

  /** @param {(i: Task) => boolean} pred */
  const openCount = (pred) => items.filter((i) => statusOf(i) !== 'done' && pred(i)).length;
  /** @param {string | null} id */
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
  const currentLabel =
    /** @type {Record<string, string | undefined>} */ ({ all: 'All', personal: 'Personal', today: 'Today', organize: 'To Organize', auto: 'Automated' })[view.filter] ?? projectName(view.filter);
  const listHint = /** @type {Record<string, string | undefined>} */ ({
    today: 'Tasks whose deadline is today or has passed.',
    organize: 'Tasks that arrived without a project or a deadline, for example from Telegram. Give them both, or press Organized.',
    auto: 'Tasks the board created by itself. Each one says why in its description.',
  })[view.filter];

  // Personal and project lists accept dropped todos; "All" does not, since it has no project.
  /** @param {string} key @param {string} text @param {number} count @param {Node} [leading] */
  const navItem = (key, text, count, leading) => {
    const accepts = key === 'personal' || isProjectFilter(key);
    return h('button', {
      type: 'button',
      class: view.filter === key ? 'nav-item active' : 'nav-item',
      onclick: () => {
        view.filter = key;
        store.refresh();
      },
      ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      },
      ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        updateItems(store, draggedIds(store), { projectId: key === 'personal' ? null : key });
        view.dragId = null;
      },
    },
      leading ?? null,
      h('span', { class: 'grow' }, text),
      h('span', { class: 'count' }, String(count)));
  };

  // Filters first, then the sort. Manual order is kept when no sort is active.
  // A search that names a status (is:done) overrides the "Show" filter, so done tasks can be found.
  const matchesQuery = taskMatcher(view.query, projects);
  const visible = sortItems(
    items.filter((i) => matchesFilter(i) && (matchesQuery.hasStatus || matchesStatus(i)) && matchesCategory(i) && matchesColumns(i) && matchesQuery(i)),
    projects,
  );
  const columnsActive = Object.values(view.colFilter).some((v) => v.length);

  // The ids on screen in screen order, filled as the rows are drawn (a folded task's subtasks are not on screen).
  /** @type {string[]} */
  const order = [];
  // A deadline column with nothing in it only takes room, so it shows once a task on screen has one.
  const showDue = visible.some((i) => i.due);
  /** @param {Task[]} rows */
  const rowsOf = (rows) => nestedRows(rows, (item, place) =>
    todoRow(store, item, { store, projects, order, showDue, projectLabel: view.filter === 'all' ? projectName(item.projectId) : '' }, place), order);
  /** @param {[string, Task[]][]} groups */
  const grouped = (groups) => h('div', { class: 'todo-groups' },
    groups.filter(([, rows]) => rows.length).map(([name, rows]) =>
      h('section', { class: 'todo-group' },
        h('h3', { class: 'row' }, name, h('span', { class: 'count' }, String(rows.length))),
        h('ul', { class: 'todo-list' }, rowsOf(rows)))));
  let listBody;
  if (!visible.length) {
    listBody = h('p', { class: 'empty' }, matchesQuery.active
      ? `No task matches “${view.query.trim()}”${(view.status.includes('open') || view.status.includes('ready')) && !view.status.includes('done') && !matchesQuery.hasStatus ? ' among open tasks. Add is:done to look in completed ones.' : '.'}`
      : columnsActive ? 'No todo matches these filters.' : 'Nothing matches these filters.');
  } else if (view.layout === 'board') {
    listBody = boardView(store, visible, projects, order);
  } else if (view.layout === 'project') {
    listBody = grouped([['Personal', visible.filter((i) => !i.projectId)], ...projectTree(projects).map(({ project: p }) => /** @type {[string, Task[]]} */ ([p.name, visible.filter((i) => i.projectId === p.id)]))]);
  } else if (view.layout === 'status') {
    listBody = grouped(STATUS_GROUP_ORDER.map((key) => [statusName(store, key), visible.filter((i) => statusOf(i) === key)]));
  } else {
    listBody = h('ul', { class: 'todo-list' }, rowsOf(visible));
  }
  // The selection only holds tasks on screen, so a batch never touches one hidden by a filter or a folded parent, or
  // deleted elsewhere.
  for (const id of view.selected) if (!order.includes(id)) view.selected.delete(id);
  const onScreen = visible.filter((i) => order.includes(i.id));
  // The section patches the field in place, so the "/" list attached on its first draw stays; it reads the
  // project when asked, not when attached.
  const addField = /** @type {HTMLInputElement} */ (h('input', {
    name: 'todo',
    placeholder: 'Add a task… #project to file it, paste several lines for a description, or an image',
    'aria-label': 'New todo',
    autocomplete: 'off',
    'data-autofocus': true,
    onpaste: (/** @type {ClipboardEvent} */ e) => pasteAsTodo(store, e),
    ondragover: (/** @type {DragEvent} */ e) => dragsFiles(e) && e.preventDefault(),
    ondrop: (/** @type {DragEvent & { dataTransfer: DataTransfer }} */ e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      const files = imageFiles(e.dataTransfer);
      if (files.length) takePending(files);
      else toast('Only PNG, JPEG, GIF and WebP images can be added');
    },
  }));
  slashComplete(addField, () => projectSkills(store, addFieldProject(store, addField.value)));

  root.replaceChildren(
    resizableSide(h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('div', { class: 'row between' },
          h('h2', null, 'Lists'),
          h('span', { class: 'muted small' }, 'drag onto a list to move')),
        navItem('all', 'All', openCount(() => true)),
        navItem('today', 'Today', openCount((i) => Boolean(i.due) && /** @type {string} */ (i.due) <= todayISO()), icon('clock')),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        navItem('organize', 'To Organize', openCount((i) => Boolean(i.inbox)), icon('inbox')),
        navItem('auto', 'Automated', openCount((i) => Boolean(i.auto)), icon('zap')),
        h('div', { class: 'row between' },
          h('h2', null, 'Projects'),
          h('div', { class: 'row' },
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'New project',
              'aria-label': 'New project',
              onclick: () => {
                view.creatingProject = !view.creatingProject;
                store.refresh();
              },
            }, icon('plus')),
            h('a', { href: '#/projects', class: 'icon-btn', title: 'Edit projects', 'aria-label': 'Edit projects' }, icon('pencil')))),
        view.creatingProject
          ? h('form', {
              class: 'stack',
              onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
                e.preventDefault();
                const name = formValues(e.currentTarget).name.trim();
                if (!name) return;
                const { project } = createProject(store, name);
                view.filter = project.id;
                view.creatingProject = false;
                store.refresh();
              },
            },
              h('input', { name: 'name', placeholder: 'Project name, Enter', 'aria-label': 'New project name', autocomplete: 'off', 'data-autofocus': true }))
          : null,
        projectTree(projects).map(({ project: p, depth }) =>
          h('div', {
            class: 'tree-row',
            style: { paddingLeft: `${depth * 14}px` },
            ondragstart: (/** @type {DragEvent & { currentTarget: HTMLElement, dataTransfer: DataTransfer }} */ e) => {
              dragProjectId = p.id;
              e.dataTransfer.effectAllowed = 'move';
              e.dataTransfer.setData('text/plain', p.id); // Firefox needs data to start a drag
              e.currentTarget.classList.add('dragging');
            },
            ondragend: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
              dragProjectId = null;
              e.currentTarget.draggable = false;
              e.currentTarget.classList.remove('dragging');
            },
            ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
              if (!dragProjectId || dragProjectId === p.id) return;
              e.preventDefault();
              const side = dropSide(e);
              e.currentTarget.classList.toggle('drop-before', side === 'before');
              e.currentTarget.classList.toggle('drop-after', side === 'after');
            },
            ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
            ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
              if (!dragProjectId) return;
              e.preventDefault();
              e.currentTarget.classList.remove('drop-before', 'drop-after');
              moveProject(store, dragProjectId, p.id, dropSide(e) === 'after');
              dragProjectId = null;
            },
          },
            h('span', {
              class: 'grip project-grip',
              title: 'Drag to reorder projects',
              'aria-label': 'Drag to reorder project',
              // Only the grip makes the row draggable; a task dragged onto the name still files the task.
              onpointerdown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => {
                /** @type {HTMLElement} */ (e.currentTarget.closest('.tree-row')).draggable = true;
              },
            }, icon('grip')),
            navItem(p.id, p.name, openCount((i) => i.projectId === p.id), projectIcon(p))))),

      h('section', { class: 'card main-pane' },
        h('div', { class: 'head-bar' },
          h('div', { class: 'row head-title' },
            h('h2', null, currentLabel),
            isProjectFilter(view.filter)
              ? h('a', { href: `#/projects?project=${view.filter}`, class: 'icon-btn', title: 'Open project', 'aria-label': 'Open project' }, icon('pencil'))
              : null,
            projectWebsiteButton(projects.find((p) => p.id === view.filter)),
            projectLinkButtons(projects.find((p) => p.id === view.filter)),
            isProjectFilter(view.filter) ? projectMeta(store, projects.find((p) => p.id === view.filter)) : null),
          h('div', { class: 'row head-actions' },
            searchBox(store),
            // Searchable, and several values can be picked; a task matching any of them is shown.
            h('label', { class: 'inline' }, 'Show',
              pickMulti({
                key: 'todo-show-status',
                values: view.status,
                options: statusFilters(store),
                anyLabel: 'All',
                ariaLabel: 'Filter by status',
                onChange: (values) => {
                  view.status = values;
                  store.refresh();
                },
              })),
            categories.length
              ? h('label', { class: 'inline' }, 'Category',
                  pickMulti({
                    key: 'todo-show-category',
                    values: view.category,
                    options: [{ value: NO_CATEGORY, label: 'No category' }, ...categories.map((c) => ({ value: c, label: c, color: categoryColor(store, c) }))],
                    anyLabel: 'All',
                    ariaLabel: 'Filter by category',
                    onChange: (values) => {
                      view.category = values;
                      store.refresh();
                    },
                  }))
              : null,
            h('button', {
              type: 'button',
              class: 'btn-small',
              disabled: view.tidy.status === 'loading',
              onclick: () => runTidy(store),
            }, 'Tidy with AI'),
            h('a', { href: '#/settings?section=categories', class: 'btn-small', title: 'Statuses and categories, in Settings' }, 'Labels'),
            h('div', { class: 'segmented layout-seg', role: 'group', 'aria-label': 'View' },
              LAYOUTS.map(([key, text, iconName]) =>
                h('button', {
                  type: 'button',
                  class: view.layout === key ? 'seg active' : 'seg',
                  title: `${text} view`,
                  'aria-label': `${text} view`,
                  'aria-pressed': String(view.layout === key),
                  onclick: () => {
                    view.layout = key;
                    store.refresh();
                  },
                }, icon(iconName), view.layout === key ? text : null))),
            h('span', { class: 'muted small' }, `${visible.length} shown`))),

        listHint ? h('p', { class: 'muted small' }, listHint) : null,

        isProjectFilter(view.filter) && view.showProject
          // The list is reset to All above when its project is gone.
          ? projectDetails(store, /** @type {Project} */ (projects.find((p) => p.id === view.filter)))
          : null,

        tidyPanel(store),

        // While tasks are ticked, their actions take the place of the add field, so the list below stays put.
        batchBar(store, onScreen, projects, categories, { aligned: view.layout === 'table', showDue }) ?? h('form', {
          class: 'quick',
          onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
            e.preventDefault();
            const input = /** @type {HTMLInputElement} */ (e.currentTarget.querySelector('input[name="todo"]'));
            // The section patches in place and keeps the field, so empty it here or a second Enter adds the task again.
            if (addItem(store, input.value)) input.value = '';
          },
        },
          addField,
          h('button', { class: 'primary', type: 'submit' }, 'Add'),
          // Adds the task and starts a Dev session on it, when the listed project has a folder for Dev to open.
          projects.find((p) => p.id === view.filter)?.localPath
            ? h('button', {
                type: 'button',
                title: 'Add the task and start a Dev session on it',
                onclick: (/** @type {MouseEvent & { currentTarget: HTMLButtonElement }} */ e) => {
                  const input = /** @type {HTMLInputElement} */ (e.currentTarget.form?.querySelector('input[name="todo"]'));
                  const task = addItem(store, input.value);
                  if (!task) return;
                  input.value = '';
                  devTasks(store, [task]);
                },
              }, icon('terminal'), 'Dev')
            : null,
          pendingImagesStrip()),

        h('div', { class: ['todo-table', view.layout === 'table' ? '' : 'no-columns', showDue ? '' : 'no-due'].filter(Boolean).join(' ') },
          h('div', { class: 'todo-row todo-head' },
            h('span'), selectAllBox(store, onScreen),
            columnHeader(store, 'text', 'Task'),
            columnHeader(store, 'status', 'Status'),
            columnHeader(store, 'priority', 'Priority'),
            columnHeader(store, 'project', 'Project'),
            columnHeader(store, 'category', 'Category'),
            showDue ? columnHeader(store, 'due', 'Deadline') : null,
            h('span')),
          columnFilters(store, projects, categories, showDue),
          listBody))), 'todos', { def: 280, min: 200, max: 520 }));
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'todos',
  title: 'Tasks',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { items: [], categories: [] },
  render: draw,
  // Tasks are keyed by data-id; the quick-add images strip is data-own (drawn in place through pendingStrip).
  patch: true,
  // View state kept in the URL, so a refresh returns to the same list.
  serialize: () => ({
    view: view.layout === 'table' ? '' : view.layout,
    filter: view.filter,
    q: view.query,
    // An empty status list shows everything; it is written as "all" so a reload does not fall back to Open.
    status: view.status.length ? view.status.join(',') : 'all',
    category: view.category.join(','),
    more: view.showProject ? '1' : '',
    sort: isDefaultSort(view.sort) ? '' : view.sort.key ? `${view.sort.key}.${view.sort.dir}` : 'manual',
  }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.layout = LAYOUTS.some(([k]) => k === p.view) ? p.view : 'table';
    view.filter = p.filter || 'all';
    view.query = p.q || '';
    view.status = !p.status ? ['open'] : p.status === 'all' ? [] : p.status.split(',');
    view.category = p.category ? p.category.split(',') : [];
    view.showProject = p.more === '1';
    if (p.task) {
      view.focusTask = p.task;
      view.expanded.add(p.task);
    }
    const [key = '', dir = 'asc'] = (p.sort ?? '').split('.');
    view.sort = p.sort === 'manual'
      ? { key: '', dir: 'asc' }
      : ['text', 'status', 'priority', 'project', 'category', 'due'].includes(key)
        ? { key, dir: dir === 'desc' ? 'desc' : 'asc' }
        : { ...DEFAULT_SORT };
  },
});
