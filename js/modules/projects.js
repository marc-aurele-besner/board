/** @import { Store, Project, ProjectLabel, ProjectProfile, Task, IconName } from '../../types/data' */
/** @typedef {Partial<Project> & { org?: string, repos?: string, npmOrg?: string, npmPackages?: string }} ProjectPatch */
// What projects.js reads of repoStats() and packageStats(): the counts are there when status is 'ok'.
/** @typedef {{ status: string, issues: number, prs: number, error?: string | null }} RepoState */
/** @typedef {{ status: string, version?: string, modified?: string, deprecated?: boolean, weekly?: number | null, error?: string | null }} PackageState */
import { h, uid, now, icon, refreshIcon, empty, statusOf, notice } from '../ui.js';
import { repoStats, refreshRepo, openItems, githubLink } from '../github.js';
import { ask } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { richText } from '../rich.js';
import { editText, pickChip } from '../inline.js';
import { colorPicker } from '../color-picker.js';
import { siteIcon, clearFaviconCache } from '../favicon.js';
import { fetchRepoOverview } from '../github.js';
import { npmOf, normalizeNpmOrg, normalizePackage, packageStats, orgStats, refreshNpm, npmBusy, projectPackages, packageLink, orgUrl, ORG_PACKAGES_READ } from '../npm.js';
import { makeTask } from '../capture.js';
import { withoutLabel } from '../task-labels.js';
import { connectedGmailOf } from '../gmail.js';
import { connectedCalendarsOf } from '../gcal.js';
import { resendSettings } from '../resend.js';
import { DEFAULT_DEV_COMMAND, devPresets, runnerOf } from './dev.js';
import { pickFolder } from '../folder-picker.js';
import { openDialog } from '../modal.js';
import { buildProfile, profileOf, hasProfileSources, profilesFor } from '../profile.js';
import { fmtCost } from '../dev-usage.js';
import { brandBlock } from './project-brand.js';
import { resizableSide } from '../side-resize.js';
import { PALETTE, makeProject, createProject } from '../projects-core.js';

export { makeProject, createProject };

const COLLECTION = 'projects';
const SLUG = /^[\w.-]+$/;
const DEFAULT_CATEGORIES = [
  { id: 'cat-personal', name: 'Personal', color: '#2f6f4e' },
  { id: 'cat-web', name: 'Web', color: '#3b6ea8' },
  { id: 'cat-crypto', name: 'Crypto', color: '#b08416' },
];

// The colour a label is shown in. Chosen in Settings > Appearance.
/** @param {{ color?: string } | null | undefined} label */
export const labelColor = (label) => label?.color || PALETTE[0];

// View state. mode: 'view' | 'categories'. Projects are edited in place, so there is no edit or new mode.
// category filter: 'all' | 'none' | <category id>.
/** @type {Store | null} */
let liveStore = null;
/** @type {{ selectedId: string | null, mode: string, error: string, draft: null, query: string, category: string, notice: string }} */
const view = { selectedId: null, mode: 'view', error: '', draft: null, query: '', category: 'all', notice: '' };

/** @param {string} text */
const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
// The forms here hold only text fields.
/** @param {HTMLFormElement} form */
const formValues = (form) => /** @type {Record<string, string>} */ (Object.fromEntries(new FormData(form)));
/** @param {string} a @param {string} b */
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** @param {ProjectLabel[]} categories @param {string} id */
const categoryById = (categories, id) => categories.find((c) => c.id === id) ?? null;

// Labels are many-to-many: a project can carry several. `categoryId` is the older single-category field.
/** @param {Partial<Project>} p @returns {string[]} */
export const labelsOf = (p) => p.labels ?? (p.categoryId ? [p.categoryId] : []);

// Whether a thing with a project and maybe its own label (a calendar, a Gmail account) falls under a project label:
// its own label is it, or its project carries it.
/** @param {Project[]} projects @param {string | null | undefined} projectId @param {string | null | undefined} ownLabelId @param {string} labelId */
export function underLabel(projects, projectId, ownLabelId, labelId) {
  if (ownLabelId === labelId) return true;
  const project = projectId ? projects.find((p) => p.id === projectId) : null;
  return Boolean(project && labelsOf(project).includes(labelId));
}

// Every project below the given one, at any depth. Used to stop a project becoming its own ancestor.
/** @param {Project[]} projects @param {string} id */
export function descendantIds(projects, id) {
  /** @type {Set<string>} */
  const out = new Set();
  const stack = [id];
  while (stack.length) {
    const current = stack.pop();
    for (const p of projects) {
      if (p.parentId === current && !out.has(p.id)) {
        out.add(p.id);
        stack.push(p.id);
      }
    }
  }
  return out;
}

// Projects as a tree, depth-first, siblings in stored order. A missing parent makes a project a root.
/** @param {Project[]} projects */
export function projectTree(projects) {
  const ids = new Set(projects.map((p) => p.id));
  /** @type {{ project: Project, depth: number }[]} */
  const out = [];
  const seen = new Set();
  /** @param {string | null} parentId @param {number} depth */
  const visit = (parentId, depth) => {
    for (const p of projects) {
      const isChild = parentId === null ? !p.parentId || !ids.has(p.parentId) : p.parentId === parentId;
      if (!isChild || seen.has(p.id)) continue;
      seen.add(p.id);
      out.push({ project: p, depth });
      visit(p.id, depth + 1);
    }
  };
  visit(null, 0);
  return out;
}

// Brings projects saved before labels and parents existing up to the current shape. Runs once on open.
/** @param {Store} store */
export function migrateProjectShape(store) {
  // Labels saved before colours existed get one from the palette, in order.
  if (store.get(COLLECTION).categories.some((c) => !c.color)) {
    store.update(COLLECTION, (d) => {
      d.categories.forEach((c, i) => {
        if (!c.color) c.color = PALETTE[i % PALETTE.length];
      });
    });
  }
  const needsUpdate = store.get(COLLECTION).projects.some((p) => !Array.isArray(p.labels) || p.parentId === undefined || 'categoryId' in p);
  if (!needsUpdate) return;
  store.update(COLLECTION, (d) => {
    for (const p of d.projects) {
      p.labels = labelsOf(p);
      delete p.categoryId;
      p.parentId = p.parentId ?? null;
    }
  });
}

const GITHUB_PREFIX = /^(?:https?:\/\/)?(?:www\.)?github\.com\//i;
/** @param {string} text */
const cleanPath = (text) => text.trim().replace(GITHUB_PREFIX, '').replace(/^\/+|\/+$/g, '');

// Returns 'owner' or '' for empty, or null when the text is not a GitHub org.
/** @param {string} text */
export function normalizeOrg(text) {
  const org = cleanPath(text);
  if (!org) return '';
  return SLUG.test(org) ? org : null;
}

// Accepts owner/repo or any github.com/owner/repo[/...] URL. Returns 'owner/repo' or null.
/** @param {string} text */
export function normalizeRepo(text) {
  const [owner, repo] = cleanPath(text).replace(/\.git$/, '').split('/');
  return owner && repo && SLUG.test(owner) && SLUG.test(repo) ? `${owner}/${repo}` : null;
}

// Accepts "example.com", "www.example.com/docs" or a full URL. Returns the origin
// (https://example.com), '' for empty, or null when it is not an http(s) address.
/** @param {string} text */
export function normalizeWebsite(text) {
  const raw = text.trim();
  if (!raw) return '';
  try {
    const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.origin : null;
  } catch {
    return null;
  }
}

// The site's own /favicon.ico. Browsers show cross-origin images without CORS, so this
// works without a third-party favicon service. Sites without one fall back to a dot.
/** @param {Project} p @param {string} [className] */
export function projectIcon(p, className = 'project-icon') {
  return siteIcon(p, className);
}

// Projects used to live inside todos.json. Move them into projects.json once.
/** @param {Store} store */
export function migrateLegacyProjects(store) {
  const legacy = store.get('todos');
  if (!('projects' in legacy)) return;
  const old = legacy.projects ?? [];
  store.update(COLLECTION, (d) => {
    for (const p of old) {
      if (!d.projects.some((x) => x.id === p.id)) d.projects.push(makeProject(d.projects.length, { ...p, github: { org: '', repos: [], ...p.github } }));
    }
  });
  store.update('todos', (t) => {
    delete t.projects;
  });
}

// --- GitHub totals, read from the cache in github.js ---

const onRepoChange = () => {
  if (liveStore && view.mode === 'view') liveStore.refresh();
};

// Sums issues and PRs over a project's repos. `state` is 'ok', 'pending' or 'none'.
/** @param {Project} p */
function githubTotals(p) {
  const totals = { issues: 0, prs: 0, pending: 0, failed: 0, repos: p.github.repos.length };
  for (const r of p.github.repos) {
    const s = /** @type {RepoState} */ (repoStats(r, onRepoChange));
    if (s.status === 'ok') {
      totals.issues += s.issues;
      totals.prs += s.prs;
    } else if (s.status === 'loading') totals.pending += 1;
    else totals.failed += 1;
  }
  return totals;
}

/** @param {Project} p */
function githubLine(p) {
  if (!p.github.repos.length) return p.github.org || 'No GitHub';
  const t = githubTotals(p);
  if (t.pending) return `${p.github.repos.length} repo${p.github.repos.length > 1 ? 's' : ''} · loading…`;
  return `${t.issues} issues · ${t.prs} PRs`;
}

// --- Actions ---

export const LOCAL_PATH_ERROR = 'The local folder must be a full path, such as ~/code/my-app or /Users/me/code/my-app.';

// A project's local folder without its trailing slash; null when it is not a full path. Empty clears it.
/** @param {unknown} text */
export function cleanLocalPath(text) {
  const localPath = String(text ?? '').trim().replace(/(.)[\\/]+$/, '$1');
  return localPath && !/^(~|\/|[A-Za-z]:[\\/])/.test(localPath) ? null : localPath;
}

// Shows a problem with one field on the project page. The field keeps its old value until it is fixed.
/** @param {Store} store @param {string} message */
function flashError(store, message) {
  view.error = message;
  store.refresh();
}

// Saves a change to a project straight away: no save button. Fields are validated first, and a problem
// is shown on the page instead of being saved.
/** @param {Store} store @param {string} id @param {ProjectPatch} patch */
function updateProject(store, id, patch) {
  const { projects } = store.get(COLLECTION);
  const current = projects.find((p) => p.id === id);
  if (!current) return;
  if (patch.name !== undefined) {
    const name = patch.name.trim();
    if (!name) return flashError(store, 'A project needs a name.');
    if (projects.some((p) => p.id !== id && sameName(p.name, name))) return flashError(store, `A project named "${name}" already exists.`);
    patch = { ...patch, name };
  }
  if (patch.website !== undefined) {
    const website = normalizeWebsite(patch.website);
    if (website === null) return flashError(store, 'Website must be a valid http or https address, such as example.com.');
    patch = { ...patch, website };
  }
  if (patch.org !== undefined || patch.repos !== undefined) {
    const org = patch.org !== undefined ? normalizeOrg(patch.org) : current.github.org;
    if (org === null) return flashError(store, 'GitHub org must be a name or a github.com/<org> URL.');
    let repos = current.github.repos;
    if (patch.repos !== undefined) {
      repos = [];
      for (const line of splitLines(patch.repos)) {
        const repo = normalizeRepo(line);
        if (!repo) return flashError(store, `"${line}" is not a repo. Use owner/repo or a github.com URL.`);
        if (!repos.includes(repo)) repos.push(repo);
      }
    }
    // A pasted repo names its owner, so an empty org is filled from the first repo.
    const owner = patch.repos !== undefined && !org && repos.length ? repos[0].split('/')[0] : org;
    const { org: _org, repos: _repos, ...rest } = patch;
    patch = { ...rest, github: { org: owner, repos } };
  }
  if (patch.npmOrg !== undefined || patch.npmPackages !== undefined) {
    const npm = npmOf(current);
    const org = patch.npmOrg !== undefined ? normalizeNpmOrg(patch.npmOrg) : npm.org;
    if (org === null) return flashError(store, 'npm org must be a name, @name or an npmjs.com/org/<name> URL.');
    let packages = npm.packages;
    if (patch.npmPackages !== undefined) {
      packages = [];
      for (const line of splitLines(patch.npmPackages)) {
        const name = normalizePackage(line);
        if (!name) return flashError(store, `"${line}" is not an npm package. Use a name, @scope/name or an npmjs.com URL.`);
        if (!packages.includes(name)) packages.push(name);
      }
    }
    const { npmOrg: _org, npmPackages: _packages, ...rest } = patch;
    patch = { ...rest, npm: { org, packages } };
  }
  if (patch.localPath !== undefined) {
    const localPath = cleanLocalPath(patch.localPath);
    if (localPath === null) return flashError(store, LOCAL_PATH_ERROR);
    patch = { ...patch, localPath };
  }
  if (patch.iconUrl !== undefined) {
    const iconUrl = patch.iconUrl.trim();
    if (iconUrl && !/^https?:\/\//i.test(iconUrl)) return flashError(store, 'The icon must be an http or https image address.');
    patch = { ...patch, iconUrl };
  }
  if (patch.parentId !== undefined) return setParent(store, id, patch.parentId);
  view.error = '';
  store.update(COLLECTION, (d) => {
    const p = d.projects.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  });
}

// Adds or removes one label on a project.
/** @param {Store} store @param {Project} p @param {string} labelId @param {boolean} on */
function toggleLabel(store, p, labelId, on) {
  const labels = labelsOf(p);
  const next = on ? [...new Set([...labels, labelId])] : labels.filter((x) => x !== labelId);
  updateProject(store, p.id, { labels: next });
}

/** @param {Store} store @param {string} name */
function quickCreate(store, name) {
  const { project, created } = createProject(store, name);
  view.selectedId = project.id;
  view.mode = 'view';
  view.draft = null;
  view.error = created ? '' : `"${project.name}" already exists.`;
  store.refresh();
}

/** @param {Store} store @param {Project} project */
function deleteProject(store, project) {
  if (!confirm(`Delete project "${project.name}"? Its todos stay, but move to Personal.`)) return;
  store.update('todos', (t) => {
    t.items.forEach((i) => {
      if (i.projectId === project.id) i.projectId = null;
    });
    // Task categories scoped to this project have nothing left to apply to.
    if (Array.isArray(t.categories)) t.categories = t.categories.filter((c) => !(c.scope === 'project' && c.projectId === project.id));
  });
  store.update(COLLECTION, (d) => {
    d.projects = d.projects.filter((p) => p.id !== project.id);
  });
  view.selectedId = null;
  view.mode = 'view';
}

// Category management. Deleting a category clears it from its projects and removes
// the todo categories that were scoped to it.
/** @param {Store} store @param {string} name */
function addCategory(store, name) {
  const { categories } = store.get(COLLECTION);
  if (categories.some((c) => sameName(c.name, name))) {
    view.error = `"${name}" already exists.`;
    return store.refresh();
  }
  view.error = '';
  store.update(COLLECTION, (d) => d.categories.push({ id: uid(), name, color: PALETTE[d.categories.length % PALETTE.length] }));
}

/** @param {Store} store @param {ProjectLabel} category @param {string} name */
function renameCategory(store, category, name) {
  const { categories } = store.get(COLLECTION);
  if (!name) return;
  if (categories.some((c) => c.id !== category.id && sameName(c.name, name))) {
    view.error = `"${name}" already exists.`;
    return store.refresh();
  }
  view.error = '';
  store.update(COLLECTION, (d) => {
    const c = d.categories.find((x) => x.id === category.id);
    if (c) c.name = name;
  });
}

/** @param {Store} store @param {ProjectLabel} category */
function deleteCategory(store, category) {
  const { projects } = store.get(COLLECTION);
  const count = projects.filter((p) => labelsOf(p).includes(category.id)).length;
  if (!confirm(`Delete category "${category.name}"? ${count} project${count === 1 ? '' : 's'} will become uncategorized.`)) return;
  store.update(COLLECTION, (d) => {
    d.categories = d.categories.filter((c) => c.id !== category.id);
    d.projects.forEach((p) => {
      p.labels = labelsOf(p).filter((x) => x !== category.id);
    });
  });
  const todos = store.get('todos');
  if (Array.isArray(todos.categories)) {
    store.update('todos', (t) => {
      t.categories = withoutLabel(t.categories, category.id);
    });
  }
}

/** @param {Store} store @param {string} id */
const select = (store, id) => {
  view.selectedId = id;
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.refresh();
};

// --- Views ---

// Stored array order is the display order. Dragging a project moves it in that array.
/** @type {string | null} */
let dragId = null;
/** @param {Store} store @param {string} id @param {string} targetId @param {boolean} after */
export function moveProject(store, id, targetId, after) {
  if (id === targetId) return;
  store.update(COLLECTION, (d) => {
    const from = d.projects.findIndex((p) => p.id === id);
    if (from < 0) return;
    const [project] = d.projects.splice(from, 1);
    let to = d.projects.findIndex((p) => p.id === targetId);
    if (to < 0) to = from;
    d.projects.splice(after ? to + 1 : to, 0, project);
  });
}
// Three drop zones on a row: the top and bottom quarters reorder, the middle nests under the row.
/** @param {DragEvent & { currentTarget: HTMLElement }} e */
const dropSide = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (y < 0.25) return 'before';
  if (y > 0.75) return 'after';
  return 'inside';
};

// Makes `id` a child of `parentId` (null for top level). A project cannot go under itself or its own children.
/** @param {Store} store @param {string} id @param {string | null} parentId */
function setParent(store, id, parentId) {
  if (parentId && (parentId === id || descendantIds(store.get(COLLECTION).projects, id).has(parentId))) {
    view.notice = 'A project cannot be placed under itself or one of its sub-projects.';
    return store.refresh();
  }
  view.notice = '';
  store.update(COLLECTION, (d) => {
    const p = d.projects.find((x) => x.id === id);
    if (p) p.parentId = parentId;
  });
}

/** @param {Store} store @param {Project[]} projects @param {Task[]} items @param {ProjectLabel[]} categories */
function projectList(store, projects, items, categories) {
  if (!projects.length) return empty('No projects match. Try another filter, or create one above.');
  return h('ul', { class: 'project-list' },
    // Visible only while dragging: drop here to move a project back to the top level.
    h('li', {
      class: 'root-drop',
      ondragover: (/** @type {DragEvent} */ e) => {
        if (!dragId) return;
        e.preventDefault();
      },
      ondrop: (/** @type {DragEvent} */ e) => {
        if (!dragId) return;
        e.preventDefault();
        setParent(store, dragId, null);
        dragId = null;
      },
    }, 'Drop here to make top level'),
    projectTree(projects).map(({ project: p, depth }) => {
      const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
      const labels = /** @type {ProjectLabel[]} */ (labelsOf(p).map((id) => categoryById(categories, id)).filter(Boolean));
      return h('li', {
        class: p.id === view.selectedId ? 'project-item active' : 'project-item',
        style: { paddingLeft: `${8 + depth * 18}px` },
        'data-id': p.id,
        onclick: () => select(store, p.id),
        ondragstart: (/** @type {DragEvent & { currentTarget: HTMLElement, dataTransfer: DataTransfer }} */ e) => {
          dragId = p.id;
          document.body.classList.add('project-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id); // Firefox needs data to start a drag
          e.currentTarget.classList.add('dragging');
        },
        ondragend: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
          dragId = null;
          document.body.classList.remove('project-dragging');
          e.currentTarget.draggable = false;
          e.currentTarget.classList.remove('dragging');
        },
        ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
          if (!dragId || dragId === p.id) return;
          e.preventDefault();
          const side = dropSide(e);
          e.currentTarget.classList.toggle('drop-before', side === 'before');
          e.currentTarget.classList.toggle('drop-after', side === 'after');
          e.currentTarget.classList.toggle('drop-inside', side === 'inside');
        },
        ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => e.currentTarget.classList.remove('drop-before', 'drop-after', 'drop-inside'),
        ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
          if (!dragId) return;
          e.preventDefault();
          const side = dropSide(e);
          e.currentTarget.classList.remove('drop-before', 'drop-after', 'drop-inside');
          if (side === 'inside') setParent(store, dragId, p.id);
          else moveProject(store, dragId, p.id, side === 'after');
          dragId = null;
        },
      },
        h('span', {
          class: 'grip',
          title: 'Drag to reorder',
          'aria-label': 'Drag to reorder',
          onclick: (/** @type {MouseEvent} */ e) => e.stopPropagation(),
          onpointerdown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => {
            e.stopPropagation();
            /** @type {HTMLLIElement} */ (e.currentTarget.closest('li')).draggable = true;
          },
        }, icon('grip')),
        projectIcon(p),
        h('div', { class: 'grow' },
          h('strong', null, p.name),
          h('div', { class: 'muted small' }, [labels.map((l) => l.name).join(', '), githubLine(p)].filter(Boolean).join(' · '))),
        h('span', { class: 'count', title: 'Open tasks' }, String(open)));
    }));
}

// The Gmail and Google Calendar accounts connected to a project, one logo and address each, plus Resend when it has a key; nothing when none are.
/** @param {Store} store @param {Project} p */
function googleField(store, p) {
  const badges = /** @type {[IconName, string, string[]][]} */ ([
    ['gmail', 'Gmail', connectedGmailOf(store, p.id)],
    ['gcal', 'Google Calendar', connectedCalendarsOf(store, p.id)],
  ]).flatMap(([name, label, emails]) => emails.map((email) =>
    h('span', { class: 'service-badge', title: `${label}: ${email}` }, icon(name), h('span', { class: 'sr-only' }, `${label}: `), email)));
  if (resendSettings(store).keys?.[p.id]) badges.push(h('span', { class: 'service-badge', title: 'Resend key set up' }, icon('resend'), 'Resend'));
  return badges.length
    ? h('div', { class: 'pp-field' }, h('span', { class: 'pp-label' }, 'Connected'), h('div', { class: 'pp-chips' }, badges))
    : null;
}

// The logos of a project's connected services, for the overview rows and the project page header: Gmail and Google Calendar (hover lists the addresses) and Resend.
/** @param {Store} store @param {Project} p */
function serviceMarks(store, p) {
  /** @param {IconName} name @param {string} title @param {string} label */
  const mark = (name, title, label) => h('span', { class: 'service-mark', title, role: 'img', 'aria-label': `${label} connected` }, icon(name));
  const marks = /** @type {[IconName, string, string[]][]} */ ([
    ['gmail', 'Gmail', connectedGmailOf(store, p.id)],
    ['gcal', 'Google Calendar', connectedCalendarsOf(store, p.id)],
  ]).filter(([, , emails]) => emails.length)
    .map(([name, label, emails]) => mark(name, `${label}: ${emails.join(', ')}`, label));
  if (resendSettings(store).keys?.[p.id]) marks.push(mark('resend', 'Resend key set up', 'Resend'));
  return marks.length ? h('span', { class: 'service-marks' }, marks) : null;
}

/** @param {Store} store @param {Project} p */
function repoTable(store, p) {
  return h('table', { class: 'repo-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Repository'), h('th', { class: 'num' }, 'Issues'), h('th', { class: 'num' }, 'PRs'), h('th', null, ''), h('th', null, ''))),
    h('tbody', null, p.github.repos.map((r) => {
      const s = /** @type {RepoState} */ (repoStats(r, onRepoChange));
      const ok = s.status === 'ok';
      return h('tr', null,
        h('td', null, githubLink(r)),
        h('td', { class: 'num' }, ok ? String(s.issues) : '—'),
        h('td', { class: 'num' }, ok ? String(s.prs) : '—'),
        h('td', { class: 'muted' }, s.status === 'loading' ? 'Loading…' : s.status === 'error' ? s.error : ''),
        h('td', null, h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Refresh counts',
          'aria-label': `Refresh ${r}`,
          disabled: s.status === 'loading',
          'aria-busy': s.status === 'loading' ? 'true' : null,
          onclick: () => {
            refreshRepo(r, onRepoChange);
            store.refresh();
          },
        }, refreshIcon(s.status === 'loading'))));
    })));
}

/** @param {number | null | undefined} n */
const fmtCount = (n) => (n == null ? '—' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// The project's npm packages: those it lists, then its org's, each with its latest version, last publish and
// weekly downloads, read by the runners into npm.json.
/** @param {Store} store @param {Project} p */
function npmTable(store, p) {
  const { org } = npmOf(p);
  const orgState = org ? /** @type {PackageState} */ (orgStats(org, onRepoChange)) : null;
  const names = projectPackages(p);
  const shown = names.slice(0, npmOf(p).packages.length + ORG_PACKAGES_READ);
  const rows = shown.map((name) => /** @type {[string, PackageState]} */ ([name, packageStats(name, onRepoChange)]));
  const loading = npmBusy(p) || orgState?.status === 'loading' || rows.some(([, s]) => s.status === 'loading');
  return h('section', { class: 'stack' },
    h('div', { class: 'row' },
      h('h3', { class: 'grow' }, 'npm packages'),
      orgState?.status === 'error' ? h('span', { class: 'muted small' }, `${org}: ${orgState.error}`) : null,
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Read again from npm',
        'aria-label': 'Refresh npm packages',
        disabled: loading,
        'aria-busy': loading ? 'true' : null,
        onclick: () => {
          refreshNpm(p, onRepoChange);
          store.refresh();
        },
      }, refreshIcon(loading))),
    rows.length
      ? h('table', { class: 'repo-table' },
          h('thead', null, h('tr', null,
            h('th', null, 'Package'), h('th', null, 'Latest'), h('th', null, 'Published'), h('th', { class: 'num' }, 'Weekly'))),
          h('tbody', null, rows.map(([name, s]) => {
            const ok = s.status === 'ok';
            return h('tr', null,
              h('td', null, packageLink(name), ok && s.deprecated ? ' ' : null, ok && s.deprecated ? h('span', { class: 'pill tone-high' }, 'deprecated') : null),
              h('td', { class: s.status === 'ok' ? null : 'muted' }, ok ? s.version : s.status === 'loading' ? 'Loading…' : s.error),
              h('td', { class: 'muted' }, ok && s.modified ? s.modified.slice(0, 10) : ''),
              h('td', { class: 'num' }, ok ? fmtCount(s.weekly) : '—'));
          })))
      : h('p', { class: 'muted small' }, orgState?.status === 'loading' ? 'Reading the org’s packages…' : 'No packages found.'),
    names.length > shown.length ? h('p', { class: 'muted small' }, `${names.length - shown.length} more in ${org} are not shown.`) : null);
}

// "Triage with AI" (task 5): what needs attention across a project's repos.
/** @type {{ projectId: string | null, status: string, text: string }} */
const triage = { projectId: null, status: 'idle', text: '' };

/** @param {Store} store @param {Project} p */
async function runTriage(store, p) {
  triage.projectId = p.id;
  triage.status = 'loading';
  store.refresh();
  try {
    const repos = p.github.repos.slice(0, 3);
    const lists = await Promise.all(repos.map(async (repo) => (await openItems(repo)).map((i) => ({ repo, ...i }))));
    const all = lists.flat();
    if (!all.length) {
      triage.status = 'ok';
      triage.text = 'No open issues or pull requests in these repos.';
    } else {
      triage.text = (await ask(store, 'task-review', [
        {
          role: 'system',
          content: systemPrompt(store, 'triage'),
        },
        { role: 'user', content: JSON.stringify({ items: all, profiles: profilesFor([p], [p.id]) }) },
      ])).trim();
      triage.status = 'ok';
    }
  } catch (err) {
    triage.status = 'error';
    triage.text = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

/** @param {Store} store @param {Project} p */
function triageBlock(store, p) {
  if (!p.github.repos.length) return null;
  if (!hasOpenRouter(store)) return setupBanner('openrouter', 'Triage with AI needs an OpenRouter key.');
  // An idle block shows only the button, so it needs no text.
  const mine = triage.projectId === p.id ? triage : /** @type {{ status: string, text: string }} */ ({ status: 'idle' });
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: mine.status === 'loading',
    onclick: () => runTriage(store, p),
  }, 'Triage with AI');
  if (mine.status === 'idle') return h('div', { class: 'row' }, button);
  if (mine.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Reading issues and PRs…'));
  if (mine.status === 'error') return h('div', { class: 'stack' }, button, notice({ text: mine.text }));
  return h('div', { class: 'stack' }, button, h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, mine.text)));
}

// --- Profile: the saved text that says what the project is (js/profile.js) ---

// Per project id: { status: 'loading' | 'error', step?, error? }. Editing holds the id being edited.
/** @type {Map<string, { status: string, step?: string, error?: string }>} */
const profileState = new Map();
/** @type {{ editing: string | null }} */
const profileView = { editing: null };

/** @param {Store} store @param {Project} p */
async function runProfile(store, p) {
  const state = { status: 'loading', step: 'Reading README, commits and website…' };
  profileState.set(p.id, state);
  store.refresh();
  try {
    await buildProfile(store, p, {
      onStep: (step) => {
        state.step = step;
        store.refresh();
      },
    });
    profileState.delete(p.id);
  } catch (err) {
    profileState.set(p.id, { status: 'error', error: /** @type {Error} */ (err).message });
  }
  store.refresh();
}

// A refresh replaces the text; text changed by hand is only replaced once the user says so.
/** @param {Store} store @param {Project} p */
function refreshProfile(store, p) {
  if (!profileOf(p).edited) return runProfile(store, p);
  const dialog = openDialog({
    title: 'Replace your edits?',
    body: h('div', { class: 'stack' },
      h('p', null, 'This profile was changed by hand. Building it again replaces the text with a new one from the sources.'),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'primary',
          onclick: () => {
            dialog.close();
            runProfile(store, p);
          },
        }, 'Replace'),
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Keep my edits'))),
  });
}

/** @param {Store} store @param {string} id @param {Partial<ProjectProfile>} patch */
function saveProfile(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const x = d.projects.find((q) => q.id === id);
    if (x) x.profile = { ...profileOf(x), ...patch };
  });
}

// Extra URLs, one per line. Lines that are not http(s) addresses are dropped.
/** @param {string} text */
function cleanSources(text) {
  /** @type {string[]} */
  const out = [];
  for (const line of text.split('\n').map((l) => l.trim()).filter(Boolean)) {
    try {
      const url = new URL(/^https?:\/\//i.test(line) ? line : `https://${line}`);
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !out.includes(url.href)) out.push(url.href);
    } catch {
      /* not an address */
    }
  }
  return out;
}

// The profile's Markdown: "## " lines as headings, the rest as rich text (bullets and link chips).
/** @param {string} text */
function profileMarkdown(text) {
  return h('div', { class: 'profile-text' }, text.split('\n').map((line) => {
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    const plain = line.replace(/\*\*(.+?)\*\*/g, '$1');
    return heading ? h('h4', null, heading[1].replace(/\*\*/g, '')) : richText(plain);
  }));
}

/** @param {string} iso */
function relativeTime(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!Number.isFinite(s)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`;
  return new Date(iso).toLocaleDateString();
}

/** @param {Store} store @param {ProjectProfile} profile */
function profileMeta(store, profile) {
  const call = profile.usageId ? store.get('usage').entries.find((e) => e.id === profile.usageId) : null;
  return [
    profile.updated ? `Updated ${relativeTime(profile.updated)}` : '',
    profile.edited ? 'edited' : '',
    call?.model ?? '',
    call && call.cost !== null && call.cost !== undefined ? fmtCost(call.cost) : '',
  ].filter(Boolean).join(' · ');
}

/** @param {Store} store @param {Project} p */
function profileBlock(store, p) {
  const profile = profileOf(p);
  const state = profileState.get(p.id);
  const busy = state?.status === 'loading';
  const canBuild = hasProfileSources(p);
  const editing = profileView.editing === p.id;
  const sources = h('div', { class: 'stack' },
    h('span', { class: 'muted small' }, 'Extra pages to read, such as the blog or docs'),
    editText({
      value: profile.sources.join('\n'),
      placeholder: 'One URL per line',
      multiline: true,
      allowEmpty: true,
      className: 'pp-lines',
      onSave: (/** @type {string} */ text) => saveProfile(store, p.id, { sources: cleanSources(text) }),
    }));
  const status = [
    busy ? h('p', { class: 'muted small' }, state.step) : null,
    state?.status === 'error' ? notice({ text: state.error }) : null,
  ];
  /** @param {string} label @param {() => void} onclick */
  const buildButton = (label, onclick) => h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: busy || !canBuild,
    'aria-busy': busy ? 'true' : null,
    onclick,
  }, refreshIcon(busy), busy ? 'Building…' : label);

  if (editing) {
    const field = h('textarea', { name: 'profile-text', 'aria-label': 'Profile', class: 'profile-edit', rows: 16, value: profile.text });
    return h('section', { class: 'pp-block' },
      h('h3', null, 'Profile'),
      field,
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn-small primary',
          onclick: () => {
            profileView.editing = null;
            const text = field.value.trim();
            if (text === profile.text.trim()) return store.refresh();
            saveProfile(store, p.id, { text, edited: true, updated: now() });
          },
        }, 'Save'),
        h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            profileView.editing = null;
            store.refresh();
          },
        }, 'Cancel')),
      sources);
  }

  if (!profile.text) {
    return h('section', { class: 'pp-block' },
      h('h3', null, 'Profile'),
      h('p', { class: 'muted small' }, 'A short saved text on what this project is, its stack, how to work on it, and what its website says. The board’s AI features read it as context.'),
      hasOpenRouter(store)
        ? h('div', { class: 'row' }, buildButton('Build profile', () => runProfile(store, p)))
        : setupBanner('openrouter', 'Building a profile needs an OpenRouter key.'),
      canBuild ? null : h('p', { class: 'muted small' }, 'Add a local folder, a repository or a website first, so there is something to read.'),
      ...status,
      sources);
  }

  return h('section', { class: 'pp-block' },
    h('h3', null, 'Profile'),
    h('div', { class: 'card-inset' }, profileMarkdown(profile.text)),
    h('div', { class: 'muted small' }, profileMeta(store, profile)),
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn-small',
        disabled: busy,
        onclick: () => {
          profileView.editing = p.id;
          store.refresh();
        },
      }, 'Edit'),
      hasOpenRouter(store) ? buildButton('Refresh', () => refreshProfile(store, p)) : null),
    hasOpenRouter(store) ? null : setupBanner('openrouter', 'Refreshing the profile needs an OpenRouter key.'),
    ...status,
    sources);
}

// The project page. Every field is edited where it is shown; a change is saved when the field is left.
// Repo overview: what a repo is, read from GitHub (description, languages, files, README), with an optional AI explanation.
/** @typedef {{ status: string, data?: Awaited<ReturnType<typeof fetchRepoOverview>>, error?: string, summary?: { status: string, text?: string } }} OverviewEntry */
/** @type {Map<string, OverviewEntry>} */
const overviews = new Map(); // repo -> { status, data?, error?, summary? }

/** @param {Store} store @param {string} repo */
function loadOverview(store, repo) {
  overviews.set(repo, { status: 'loading' });
  store.refresh();
  fetchRepoOverview(repo)
    .then((data) => overviews.set(repo, { status: 'ok', data }))
    .catch((/** @type {Error} */ err) => overviews.set(repo, { status: 'error', error: err.message }))
    .finally(() => store.refresh());
}

/** @param {Store} store @param {string} repo @param {OverviewEntry} entry */
async function explainRepo(store, repo, entry) {
  entry.summary = { status: 'loading' };
  store.refresh();
  // Only offered once the overview is read.
  const d = /** @type {NonNullable<OverviewEntry['data']>} */ (entry.data);
  try {
    const text = await ask(store, 'task-summary', [
      {
        role: 'system',
        content: systemPrompt(store, 'repo-summary'),
      },
      {
        role: 'user',
        content: JSON.stringify({
          repo,
          description: d.description,
          topics: d.topics,
          languages: d.languages,
          files: d.files.map((f) => (f.type === 'dir' ? `${f.name}/` : f.name)),
          readme: d.readme,
        }),
      },
    ]);
    entry.summary = { status: 'ok', text: text.trim() };
  } catch (err) {
    entry.summary = { status: 'error', text: /** @type {Error} */ (err).message };
  }
  store.refresh();
}

/** @param {Store} store @param {Project} p */
function overviewBlock(store, p) {
  if (!p.github.repos.length) return null;
  return h('section', { class: 'pp-block' },
    h('h3', null, 'Understand the repo'),
    p.github.repos.map((repo) => {
      /** @type {OverviewEntry} */
      const entry = overviews.get(repo) ?? { status: 'idle' };
      const head = h('div', { class: 'row between' },
        h('strong', null, repo),
        entry.status === 'idle'
          ? null
          : h('button', {
            type: 'button',
            class: 'btn-small',
            disabled: entry.status === 'loading',
            'aria-busy': entry.status === 'loading' ? 'true' : null,
            onclick: () => loadOverview(store, repo),
          }, refreshIcon(entry.status === 'loading'), entry.status === 'loading' ? 'Refreshing…' : 'Refresh'));
      if (entry.status === 'idle') {
        return h('div', { class: 'overview' }, head,
          h('button', { type: 'button', class: 'btn-small', onclick: () => loadOverview(store, repo) }, 'Read repo'));
      }
      if (entry.status === 'loading') return h('div', { class: 'overview' }, head, h('p', { class: 'muted small' }, 'Reading the repo…'));
      if (entry.status === 'error') return h('div', { class: 'overview' }, head, notice({ text: entry.error }));

      // Past the states above, the overview is read.
      const d = /** @type {NonNullable<OverviewEntry['data']>} */ (entry.data);
      const facts = [d.languages.join(', '), d.defaultBranch ? `branch ${d.defaultBranch}` : '', d.pushedAt ? `last push ${d.pushedAt.slice(0, 10)}` : '']
        .filter(Boolean)
        .join(' · ');
      return h('div', { class: 'overview' }, head,
        d.contentAccess
          ? null
          : notice({
              tone: 'info',
              text: 'The README and file list could not be read. Give the GitHub token Contents: Read-only in Settings.',
              actions: [h('a', { href: '#/settings?section=github', class: 'btn-small primary-link' }, 'Open GitHub settings')],
            }),
        d.description ? h('p', null, d.description) : null,
        facts ? h('div', { class: 'muted small' }, facts) : null,
        d.topics.length ? h('div', { class: 'tags' }, d.topics.map((t) => h('span', { class: 'tag' }, t))) : null,
        d.files.length
          ? h('div', { class: 'tags' }, d.files.map((f) => h('span', { class: f.type === 'dir' ? 'tag tag-dir' : 'tag' }, f.type === 'dir' ? `${f.name}/` : f.name)))
          : null,
        d.readme ? h('pre', { class: 'readme' }, d.readme) : null,
        hasOpenRouter(store)
          ? h('div', { class: 'row' },
              h('button', {
                type: 'button',
                class: 'btn-small',
                disabled: entry.summary?.status === 'loading',
                onclick: () => explainRepo(store, repo, entry),
              }, 'Explain with AI'))
          : setupBanner('openrouter', 'Explaining the repo needs an OpenRouter key.'),
        entry.summary?.status === 'loading' ? h('p', { class: 'muted small' }, 'Reading…') : null,
        entry.summary?.status === 'error' ? notice({ text: entry.summary.text }) : null,
        entry.summary?.status === 'ok' ? h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, entry.summary.text)) : null);
    }));
}

// The project's open tasks, with a quick add, so the page is enough for a short look. Tasks has the full table.
/** @param {Store} store @param {Project} p @param {Task[]} items */
function projectTasks(store, p, items) {
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done');
  /** @param {string} id */
  const finish = (id) => store.update('todos', (d) => {
    const t = d.items.find((x) => x.id === id);
    if (!t) return;
    t.status = 'done';
    delete t.done;
  });
  return h('section', { class: 'pp-block' },
    h('div', { class: 'row between' },
      h('h3', null, 'Tasks'),
      h('a', { href: `#/todos?filter=${p.id}`, class: 'btn-link' }, 'Open in Tasks')),
    h('form', {
      class: 'quick',
      onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
        e.preventDefault();
        const text = /** @type {string} */ (new FormData(e.currentTarget).get('todo')).trim();
        if (text) store.update('todos', (d) => d.items.push(makeTask({ text, projectId: p.id })));
      },
    },
      h('input', { name: 'todo', placeholder: `Add a task to ${p.name}…`, 'aria-label': 'New task in this project', autocomplete: 'off' }),
      h('button', { class: 'primary', type: 'submit' }, 'Add')),
    open.length
      ? h('ul', { class: 'board-list' }, open.map((i) =>
          h('li', null,
            h('input', { type: 'checkbox', 'aria-label': `Mark "${i.text}" done`, onchange: () => finish(i.id) }),
            h('span', { class: 'grow' }, i.text),
            i.due ? h('span', { class: 'muted small' }, i.due) : null,
            i.priority && i.priority !== 'none' ? h('span', { class: `pill tone-${i.priority}` }, i.priority) : null)))
      : h('p', { class: 'muted small' }, 'No open tasks.'));
}

// The project's tasks in Tasks, filtered by status: 'open', 'done' or 'all'.
/** @param {Project} p @param {string} status @param {string} text */
const tasksLink = (p, status, text) => h('a', { href: `#/todos?filter=${p.id}&status=${status}`, title: `Show ${status === 'all' ? 'all' : status} tasks of ${p.name} in Tasks` }, text);

/** @param {Store} store @param {Project} p @param {Task[]} items @param {ProjectLabel[]} categories */
function projectView(store, p, items, categories) {
  const projects = store.get(COLLECTION).projects;
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  const done = items.filter((i) => i.projectId === p.id && statusOf(i) === 'done').length;
  const ownLabels = labelsOf(p);
  const labels = /** @type {ProjectLabel[]} */ (ownLabels.map((id) => categoryById(categories, id)).filter(Boolean));
  const freeLabels = categories.filter((c) => !ownLabels.includes(c.id));
  const children = projects.filter((x) => x.parentId === p.id);
  const parentChoices = projects.filter((x) => x.id !== p.id && !descendantIds(projects, p.id).has(x.id));
  const t = githubTotals(p);
  /** @param {number} n */
  const gh = (n) => (p.github.repos.length === 0 ? '—' : t.pending ? '…' : String(n));

  return h('div', { class: 'stack-lg project-page' },
    view.error ? notice({ text: view.error }) : null,

    h('header', { class: 'pp-head' },
      h('div', { class: 'pp-title' },
        h('label', { class: 'pp-color', title: 'Change the color' },
          h('span', { class: 'dot big', style: { background: p.color } }),
          h('input', {
            type: 'color',
            value: p.color,
            class: 'sr-only',
            'aria-label': 'Project color',
            onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => updateProject(store, p.id, { color: e.target.value }),
          })),
        projectIcon(p, 'project-icon large'),
        editText({
          value: p.name,
          placeholder: 'Untitled project',
          className: 'pp-name',
          onSave: (/** @type {string} */ name) => updateProject(store, p.id, { name }),
        }),
        serviceMarks(store, p)),
      h('button', { type: 'button', class: 'btn-small danger', onclick: () => deleteProject(store, p) }, icon('x'), 'Delete')),

    h('div', { class: 'pp-meta' },
      h('div', { class: 'pp-field' },
        h('span', { class: 'pp-label' }, 'Labels'),
        h('div', { class: 'pp-chips' },
          labels.map((l) => h('span', { class: 'pill tone-custom pill-x', style: { '--c': labelColor(l) } },
            l.name,
            h('button', {
              type: 'button',
              class: 'pill-remove',
              'aria-label': `Remove label ${l.name}`,
              onclick: () => toggleLabel(store, p, l.id, false),
            }, icon('x')))),
          freeLabels.length
            ? pickChip({
                value: null,
                options: freeLabels.map((c) => ({ value: c.id, label: c.name, color: labelColor(c) })),
                placeholder: '+ Add label',
                onPick: (/** @type {string | null} */ id) => {
                  if (id) toggleLabel(store, p, id, true);
                },
              })
            : h('span', { class: 'muted small' }, 'No more labels. Create them under Manage labels.'))),

      h('div', { class: 'pp-field' },
        h('span', { class: 'pp-label' }, 'Parent'),
        pickChip({
          value: p.parentId ?? null,
          options: parentChoices.map((x) => ({ value: x.id, label: x.name })),
          nullable: true,
          nullLabel: 'None (top level)',
          onPick: (/** @type {string | null} */ parentId) => setParent(store, p.id, parentId),
        }),
        children.length
          ? h('span', { class: 'muted small' }, `Sub-projects: ${children.map((x) => x.name).join(', ')}`)
          : null),

      h('div', { class: 'pp-field' },
        h('span', { class: 'pp-label' }, 'Open / done'),
        h('span', null,
          tasksLink(p, 'open', `${open} open`), ' · ',
          tasksLink(p, 'done', `${done} done`), ' · ',
          tasksLink(p, 'all', `${open + done} all`))),

      googleField(store, p)),

    h('section', { class: 'pp-block' },
      h('h3', null, 'Description'),
      editText({
        value: p.description,
        placeholder: 'Add a description… links and lists work',
        multiline: true,
        allowEmpty: true,
        rich: true,
        onSave: (/** @type {string} */ description) => updateProject(store, p.id, { description }),
      })),

    h('div', { class: 'pp-grid' },
      h('section', { class: 'pp-block' },
        h('h3', null, 'Website'),
        editText({
          value: p.website,
          placeholder: 'example.com',
          allowEmpty: true,
          onSave: (/** @type {string} */ website) => updateProject(store, p.id, { website }),
        }),
        p.website ? h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'muted small' }, p.website) : null),
      h('section', { class: 'pp-block' },
        h('h3', null, 'Local folder'),
        h('div', { class: 'pp-icon-row' },
          editText({
            value: p.localPath ?? '',
            placeholder: '~/code/my-app',
            allowEmpty: true,
            onSave: (/** @type {string} */ localPath) => updateProject(store, p.id, { localPath }),
          }),
          h('button', {
            type: 'button',
            title: 'Find the folder on this machine',
            onclick: () => pickFolder({ base: runnerOf(store), start: p.localPath, onPick: (localPath) => updateProject(store, p.id, { localPath }) }),
          }, icon('folder'), 'Browse')),
        p.localPath ? h('a', { href: `#/dev?project=${p.id}`, class: 'muted small' }, 'Open a terminal here') : null),
      devCommandBlock(store, p),
      h('section', { class: 'pp-block' },
        h('h3', null, 'Icon'),
        h('div', { class: 'pp-icon-row' },
          siteIcon(p, 'project-icon large'),
          editText({
            value: p.iconUrl ?? '',
            placeholder: p.website ? 'Found from the website. Paste an image URL to override' : 'Paste an image URL',
            allowEmpty: true,
            onSave: (/** @type {string} */ iconUrl) => updateProject(store, p.id, { iconUrl }),
          }))),
      h('section', { class: 'pp-block' },
        h('h3', null, 'GitHub organization'),
        editText({
          value: p.github.org,
          placeholder: 'my-org or github.com/my-org',
          allowEmpty: true,
          onSave: (/** @type {string} */ org) => updateProject(store, p.id, { org }),
        }),
        p.github.org ? githubLink(p.github.org) : null),
      h('section', { class: 'pp-block' },
        h('h3', null, 'Repositories'),
        editText({
          value: p.github.repos.join('\n'),
          placeholder: 'One per line: owner/repo',
          multiline: true,
          allowEmpty: true,
          className: 'pp-lines',
          onSave: (/** @type {string} */ repos) => updateProject(store, p.id, { repos }),
        }),
        p.github.repos.map((r) => githubLink(r))),
      h('section', { class: 'pp-block' },
        h('h3', null, 'npm organization'),
        editText({
          value: npmOf(p).org,
          placeholder: 'my-org, or an npm user',
          allowEmpty: true,
          onSave: (/** @type {string} */ npmOrg) => updateProject(store, p.id, { npmOrg }),
        }),
        npmOf(p).org ? h('a', { href: orgUrl(npmOf(p).org), target: '_blank', rel: 'noopener', class: 'muted small' }, `npmjs.com/~${npmOf(p).org}`) : null),
      h('section', { class: 'pp-block' },
        h('h3', null, 'npm packages'),
        editText({
          value: npmOf(p).packages.join('\n'),
          placeholder: 'One per line: my-package or @scope/my-package',
          multiline: true,
          allowEmpty: true,
          className: 'pp-lines',
          onSave: (/** @type {string} */ npmPackages) => updateProject(store, p.id, { npmPackages }),
        }))),

    h('div', { class: 'pp-stats' },
      stat(open, 'open tasks'),
      stat(done, 'done tasks'),
      stat(gh(t.issues), 'open issues'),
      stat(gh(t.prs), 'open PRs')),

    projectTasks(store, p, items),

    p.github.repos.length ? repoTable(store, p) : null,
    npmOf(p).org || npmOf(p).packages.length ? npmTable(store, p) : null,
    profileBlock(store, p),
    brandBlock(store, p),
    overviewBlock(store, p),
    triageBlock(store, p));
}

// The command a task goes to Dev with: a preset from Settings → Dev environment, or the project's own.
/** @param {Store} store @param {Project} p */
function devCommandBlock(store, p) {
  const presets = devPresets(store);
  const preset = presets.find((x) => x.id === p.devPreset);
  return h('section', { class: 'pp-block' },
    h('h3', null, 'Dev command'),
    presets.length
      ? pickChip({
          value: preset ? preset.id : null,
          options: presets.map((x) => ({ value: x.id, label: x.name })),
          nullable: true,
          nullLabel: 'Own command',
          onPick: (/** @type {string | null} */ devPreset) => updateProject(store, p.id, { devPreset: devPreset ?? '' }),
        })
      : null,
    preset
      ? h('code', { class: 'muted small' }, preset.command)
      : editText({
          value: p.devCommand ?? '',
          placeholder: DEFAULT_DEV_COMMAND,
          allowEmpty: true,
          onSave: (/** @type {string} */ devCommand) => updateProject(store, p.id, { devCommand: devCommand.trim() }),
        }),
    h('span', { class: 'muted small' }, 'Runs with the task as its prompt when a task goes to Dev. Empty uses the default. Presets are set in ',
      h('a', { href: '#/settings?section=dev' }, 'Settings → Dev environment'), '.'));
}

/** @param {Store} store @param {ProjectLabel[]} categories @param {Project[]} projects */
function categoriesPanel(store, categories, projects) {
  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      h('h2', null, 'Labels'),
      h('button', {
        type: 'button',
        onclick: () => {
          view.mode = 'view';
          view.error = '';
          store.refresh();
        },
      }, 'Done')),
    h('p', { class: 'muted' }, 'Labels group projects (Personal, Web, Crypto…). A project can have several. Task categories can be scoped to a label in the Tasks section.'),
    view.error ? h('p', { class: 'error', role: 'alert' }, view.error) : null,
    h('ul', { class: 'stack' },
      categories.map((c) => {
        const count = projects.filter((p) => labelsOf(p).includes(c.id)).length;
        return h('li', { class: 'row category-row' },
          colorPicker({
            value: labelColor(c),
            name: c.name,
            onPick: (/** @type {string} */ color) => store.update(COLLECTION, (d) => {
              const label = d.categories.find((x) => x.id === c.id);
              if (label) label.color = color;
            }),
          }),
          editText({
            value: c.name,
            placeholder: 'Name',
            className: 'grow',
            onSave: (/** @type {string} */ name) => renameCategory(store, c, name),
          }),
          h('span', { class: 'muted' }, `${count} project${count === 1 ? '' : 's'}`),
          h('button', { type: 'button', class: 'danger', onclick: () => deleteCategory(store, c) }, icon('x'), 'Delete'));
      })),
    h('form', {
      class: 'row',
      onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
        e.preventDefault();
        const name = formValues(e.currentTarget).name.trim();
        if (name) addCategory(store, name);
      },
    },
      h('input', { name: 'name', placeholder: 'New category, e.g. Health', 'aria-label': 'New category', class: 'grow', autocomplete: 'off' }),
      h('button', { class: 'primary', type: 'submit' }, 'Add')));
}

/** @param {number | string} n @param {string} label */
const stat = (n, label) => h('div', null, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));

// Shown in the detail pane when no project is selected: an overview across all projects.
/** @param {Store} store @param {Project[]} projects @param {Task[]} items @param {ProjectLabel[]} categories */
function projectsRecap(store, projects, items, categories) {
  if (!projects.length) return empty('No projects yet. Create one on the left to get started.');
  /** @param {Project} p */
  const openOf = (p) => items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  const openAll = items.filter((i) => statusOf(i) !== 'done').length;
  const linked = projects.filter((p) => p.github.repos.length || p.github.org);
  const totals = linked.map(githubTotals);
  const issues = totals.reduce((s, t) => s + t.issues, 0);
  const prs = totals.reduce((s, t) => s + t.prs, 0);
  const pending = totals.some((t) => t.pending);
  const labelRows = categories
    .map((c) => ({ c, n: projects.filter((p) => labelsOf(p).includes(c.id)).length }))
    .filter((r) => r.n > 0);

  return h('div', { class: 'recap stack-lg' },
    h('div', null,
      h('h2', null, 'Projects overview'),
      h('p', { class: 'muted small' }, 'Pick a project on the left to see its details, issues and tasks.')),
    h('div', { class: 'stats' },
      stat(projects.length, 'projects'),
      stat(openAll, 'open tasks'),
      stat(linked.length, 'linked to GitHub'),
      stat(pending ? '…' : issues, 'open issues'),
      stat(pending ? '…' : prs, 'open PRs')),
    h('section', { class: 'stack' },
      h('h3', null, 'Projects'),
      h('ul', { class: 'recap-list' },
        projectTree(projects).map(({ project: p, depth }) => {
          const labels = /** @type {ProjectLabel[]} */ (labelsOf(p).map((id) => categoryById(categories, id)).filter(Boolean));
          return h('li', {
            class: 'recap-row',
            style: { paddingLeft: `${8 + depth * 18}px` },
            onclick: () => select(store, p.id),
          },
            projectIcon(p),
            h('strong', null, p.name),
            labels.length ? h('span', { class: 'muted small' }, labels.map((l) => l.name).join(', ')) : null,
            h('span', { class: 'muted small grow' }, githubLine(p)),
            serviceMarks(store, p),
            h('span', { class: 'count' }, `${openOf(p)} open`));
        }))),
    labelRows.length
      ? h('section', { class: 'stack' },
          h('h3', null, 'By label'),
          h('ul', { class: 'recap-list' },
            labelRows.map(({ c, n }) => h('li', { class: 'recap-row', onclick: () => { view.category = c.id; store.refresh(); } },
              h('strong', { class: 'grow' }, c.name),
              h('span', { class: 'muted small' }, `${n} project${n === 1 ? '' : 's'}`)))))
      : null);
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  liveStore = store;
  const { projects, categories } = store.get(COLLECTION);
  const { items } = store.get('todos');
  if (view.selectedId && !projects.some((p) => p.id === view.selectedId)) {
    view.selectedId = null;
    view.mode = 'view';
  }
  if (view.category !== 'all' && view.category !== 'none' && !categoryById(categories, view.category)) view.category = 'all';
  const selected = projects.find((p) => p.id === view.selectedId) ?? null;

  // The list is refilled on its own while typing in search, so the search box keeps focus.
  const listBox = h('div', { class: 'list-scroll' });
  const fillList = () => {
    const q = view.query.trim().toLowerCase();
    const shown = projects.filter((p) =>
      (view.category === 'all' || (view.category === 'none' ? labelsOf(p).length === 0 : labelsOf(p).includes(view.category))) &&
      (!q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q)));
    listBox.replaceChildren(projectList(store, shown, items, categories));
  };
  fillList();

  /** @param {string} key @param {string} text */
  const chip = (key, text) =>
    h('button', {
      type: 'button',
      class: view.category === key ? 'chip active' : 'chip',
      onclick: () => {
        view.category = key;
        store.refresh();
      },
    }, text);

  let detail;
  if (view.mode === 'categories') detail = categoriesPanel(store, categories, projects);
  else if (selected) detail = projectView(store, selected, items, categories);
  else detail = projectsRecap(store, projects, items, categories);

  root.replaceChildren(
    resizableSide(h('div', { class: 'split' },
      h('section', { class: 'card side-pane' },
        h('input', {
          type: 'search',
          placeholder: 'Search projects',
          'aria-label': 'Search projects',
          value: view.query,
          oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
            view.query = e.target.value;
            fillList();
          },
        }),
        h('div', { class: 'side-tools' },
          view.notice ? notice({ text: view.notice }) : null,
          h('div', { class: 'chips' },
            chip('all', 'All'),
            chip('none', 'None'),
            categories.map((c) => chip(c.id, c.name))),
          h('form', {
            class: 'quick-project',
            onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
              e.preventDefault();
              const input = /** @type {HTMLInputElement} */ (e.currentTarget.querySelector('input[name="name"]'));
              const name = input.value.trim();
              if (name) quickCreate(store, name);
            },
          },
            h('input', { name: 'name', placeholder: 'New project…', 'aria-label': 'New project name', autocomplete: 'off' }),
            h('button', { class: 'icon-btn primary-icon', type: 'submit', title: 'Add project', 'aria-label': 'Add project' }, icon('plus'))),
          h('div', { class: 'side-links' },
            h('button', {
              type: 'button',
              class: 'linkish',
              title: 'Search every project website again for its icon',
              onclick: () => {
                clearFaviconCache(store.get(COLLECTION).projects.map((p) => p.website).filter(Boolean));
                store.refresh();
              },
            }, 'Re-run icons'),
            h('button', {
              type: 'button',
              class: 'linkish',
              onclick: () => {
                view.mode = 'categories';
                view.error = '';
                store.refresh();
              },
            }, 'Manage labels'))),
        listBox),

      h('section', { class: 'card main-pane' }, detail)), 'projects', { def: 300, min: 220, max: 560 }));
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'projects',
  title: 'Projects',
  icon: 'folder',
  collection: COLLECTION,
  defaults: { projects: [], categories: DEFAULT_CATEGORIES },
  render: draw,
  serialize: () => ({
    project: view.selectedId ?? '',
    mode: view.mode === 'view' ? '' : view.mode,
    category: view.category === 'all' ? '' : view.category,
    q: view.query,
  }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.selectedId = p.project || null;
    view.mode = p.mode === 'categories' ? 'categories' : 'view';
    view.category = p.category || 'all';
    view.query = p.q || '';
    view.error = '';
    view.draft = null;
  },
});
