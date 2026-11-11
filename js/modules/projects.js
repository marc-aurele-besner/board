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
import { makeTask } from '../capture.js';
import { withoutLabel } from '../task-labels.js';
import { connectedGmailOf } from '../gmail.js';
import { connectedCalendarsOf } from '../gcal.js';

const COLLECTION = 'projects';
const PALETTE = ['#2f6f4e', '#3b6ea8', '#a3432b', '#8a5a9e', '#b08416', '#2e8a8a'];
const SLUG = /^[\w.-]+$/;
const DEFAULT_CATEGORIES = [
  { id: 'cat-personal', name: 'Personal', color: '#2f6f4e' },
  { id: 'cat-web', name: 'Web', color: '#3b6ea8' },
  { id: 'cat-crypto', name: 'Crypto', color: '#b08416' },
];

// The colour a label is shown in. Chosen in Settings > Appearance.
export const labelColor = (label) => label?.color || PALETTE[0];

// View state. mode: 'view' | 'categories'. Projects are edited in place, so there is no edit or new mode.
// category filter: 'all' | 'none' | <category id>.
let liveStore = null;
const view = { selectedId: null, mode: 'view', error: '', draft: null, query: '', category: 'all', notice: '' };

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const formValues = (form) => Object.fromEntries(new FormData(form));
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const categoryById = (categories, id) => categories.find((c) => c.id === id) ?? null;

// Labels are many-to-many: a project can carry several. `categoryId` is the older single-category field.
export const labelsOf = (p) => p.labels ?? (p.categoryId ? [p.categoryId] : []);

// Whether a thing with a project and maybe its own label (a calendar, a Gmail account) falls under a project label:
// its own label is it, or its project carries it.
export function underLabel(projects, projectId, ownLabelId, labelId) {
  if (ownLabelId === labelId) return true;
  const project = projectId ? projects.find((p) => p.id === projectId) : null;
  return Boolean(project && labelsOf(project).includes(labelId));
}

// Every project below the given one, at any depth. Used to stop a project becoming its own ancestor.
export function descendantIds(projects, id) {
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
export function projectTree(projects) {
  const ids = new Set(projects.map((p) => p.id));
  const out = [];
  const seen = new Set();
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
const cleanPath = (text) => text.trim().replace(GITHUB_PREFIX, '').replace(/^\/+|\/+$/g, '');

// Returns 'owner' or '' for empty, or null when the text is not a GitHub org.
export function normalizeOrg(text) {
  const org = cleanPath(text);
  if (!org) return '';
  return SLUG.test(org) ? org : null;
}

// Accepts owner/repo or any github.com/owner/repo[/...] URL. Returns 'owner/repo' or null.
export function normalizeRepo(text) {
  const [owner, repo] = cleanPath(text).replace(/\.git$/, '').split('/');
  return owner && repo && SLUG.test(owner) && SLUG.test(repo) ? `${owner}/${repo}` : null;
}

// Accepts "example.com", "www.example.com/docs" or a full URL. Returns the origin
// (https://example.com), '' for empty, or null when it is not an http(s) address.
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

// Shared by the todos module, so a #tag can create a project on the fly.
// Every project has the same shape; fields are optional and default to empty.
export function makeProject(existingCount, fields = {}) {
  return {
    id: uid(),
    name: '',
    color: PALETTE[existingCount % PALETTE.length],
    description: '',
    website: '',
    labels: [],
    parentId: null,
    github: { org: '', repos: [] },
    created: now(),
    ...fields,
  };
}

// Creates a project unless one with the same name exists. Returns { project, created }.
// The caller sets any view state it needs, then calls store.refresh().
export function createProject(store, name, fields = {}) {
  const { projects } = store.get(COLLECTION);
  const existing = projects.find((p) => sameName(p.name, name));
  if (existing) return { project: existing, created: false };
  const project = makeProject(projects.length, { name, ...fields });
  store.update(COLLECTION, (d) => d.projects.push(project));
  return { project, created: true };
}

// The site's own /favicon.ico. Browsers show cross-origin images without CORS, so this
// works without a third-party favicon service. Sites without one fall back to a dot.
export function projectIcon(p, className = 'project-icon') {
  return siteIcon(p, className);
}

// Projects used to live inside todos.json. Move them into projects.json once.
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
function githubTotals(p) {
  const totals = { issues: 0, prs: 0, pending: 0, failed: 0, repos: p.github.repos.length };
  for (const r of p.github.repos) {
    const s = repoStats(r, onRepoChange);
    if (s.status === 'ok') {
      totals.issues += s.issues;
      totals.prs += s.prs;
    } else if (s.status === 'loading') totals.pending += 1;
    else totals.failed += 1;
  }
  return totals;
}

function githubLine(p) {
  if (!p.github.repos.length) return p.github.org || 'No GitHub';
  const t = githubTotals(p);
  if (t.pending) return `${p.github.repos.length} repo${p.github.repos.length > 1 ? 's' : ''} · loading…`;
  return `${t.issues} issues · ${t.prs} PRs`;
}

// --- Actions ---

// Shows a problem with one field on the project page. The field keeps its old value until it is fixed.
function flashError(store, message) {
  view.error = message;
  store.refresh();
}

// Saves a change to a project straight away: no save button. Fields are validated first, and a problem
// is shown on the page instead of being saved.
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
function toggleLabel(store, p, labelId, on) {
  const labels = labelsOf(p);
  const next = on ? [...new Set([...labels, labelId])] : labels.filter((x) => x !== labelId);
  updateProject(store, p.id, { labels: next });
}

function quickCreate(store, name) {
  const { project, created } = createProject(store, name);
  view.selectedId = project.id;
  view.mode = 'view';
  view.draft = null;
  view.error = created ? '' : `"${project.name}" already exists.`;
  store.refresh();
}

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
function addCategory(store, name) {
  const { categories } = store.get(COLLECTION);
  if (categories.some((c) => sameName(c.name, name))) {
    view.error = `"${name}" already exists.`;
    return store.refresh();
  }
  view.error = '';
  store.update(COLLECTION, (d) => d.categories.push({ id: uid(), name, color: PALETTE[d.categories.length % PALETTE.length] }));
}

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

const select = (store, id) => {
  view.selectedId = id;
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.refresh();
};

// --- Views ---

// Stored array order is the display order. Dragging a project moves it in that array.
let dragId = null;
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
const dropSide = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  const y = (e.clientY - r.top) / r.height;
  if (y < 0.25) return 'before';
  if (y > 0.75) return 'after';
  return 'inside';
};

// Makes `id` a child of `parentId` (null for top level). A project cannot go under itself or its own children.
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

function projectList(store, projects, items, categories) {
  if (!projects.length) return empty('No projects match. Try another filter, or create one above.');
  return h('ul', { class: 'project-list' },
    // Visible only while dragging: drop here to move a project back to the top level.
    h('li', {
      class: 'root-drop',
      ondragover: (e) => {
        if (!dragId) return;
        e.preventDefault();
      },
      ondrop: (e) => {
        if (!dragId) return;
        e.preventDefault();
        setParent(store, dragId, null);
        dragId = null;
      },
    }, 'Drop here to make top level'),
    projectTree(projects).map(({ project: p, depth }) => {
      const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
      const labels = labelsOf(p).map((id) => categoryById(categories, id)).filter(Boolean);
      return h('li', {
        class: p.id === view.selectedId ? 'project-item active' : 'project-item',
        style: { paddingLeft: `${8 + depth * 18}px` },
        'data-id': p.id,
        onclick: () => select(store, p.id),
        ondragstart: (e) => {
          dragId = p.id;
          document.body.classList.add('project-dragging');
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id); // Firefox needs data to start a drag
          e.currentTarget.classList.add('dragging');
        },
        ondragend: (e) => {
          dragId = null;
          document.body.classList.remove('project-dragging');
          e.currentTarget.draggable = false;
          e.currentTarget.classList.remove('dragging');
        },
        ondragover: (e) => {
          if (!dragId || dragId === p.id) return;
          e.preventDefault();
          const side = dropSide(e);
          e.currentTarget.classList.toggle('drop-before', side === 'before');
          e.currentTarget.classList.toggle('drop-after', side === 'after');
          e.currentTarget.classList.toggle('drop-inside', side === 'inside');
        },
        ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after', 'drop-inside'),
        ondrop: (e) => {
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
          onclick: (e) => e.stopPropagation(),
          onpointerdown: (e) => {
            e.stopPropagation();
            e.currentTarget.closest('li').draggable = true;
          },
        }, icon('grip')),
        projectIcon(p),
        h('div', { class: 'grow' },
          h('strong', null, p.name),
          h('div', { class: 'muted small' }, [labels.map((l) => l.name).join(', '), githubLine(p)].filter(Boolean).join(' · '))),
        h('span', { class: 'count', title: 'Open tasks' }, String(open)));
    }));
}

// The Gmail and Google Calendar accounts connected to a project, one logo and address each; nothing when none are.
function googleField(store, p) {
  const badges = [
    ['gmail', 'Gmail', connectedGmailOf(store, p.id)],
    ['gcal', 'Google Calendar', connectedCalendarsOf(store, p.id)],
  ].flatMap(([name, label, emails]) => emails.map((email) =>
    h('span', { class: 'service-badge', title: `${label}: ${email}` }, icon(name), h('span', { class: 'sr-only' }, `${label}: `), email)));
  return badges.length
    ? h('div', { class: 'pp-field' }, h('span', { class: 'pp-label' }, 'Connected'), h('div', { class: 'pp-chips' }, badges))
    : null;
}

function repoTable(store, p) {
  return h('table', { class: 'repo-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Repository'), h('th', { class: 'num' }, 'Issues'), h('th', { class: 'num' }, 'PRs'), h('th', null, ''), h('th', null, ''))),
    h('tbody', null, p.github.repos.map((r) => {
      const s = repoStats(r, onRepoChange);
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

// "Triage with AI" (task 5): what needs attention across a project's repos.
const triage = { projectId: null, status: 'idle', text: '' };

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
        { role: 'user', content: JSON.stringify(all) },
      ])).trim();
      triage.status = 'ok';
    }
  } catch (err) {
    triage.status = 'error';
    triage.text = err.message;
  }
  store.refresh();
}

function triageBlock(store, p) {
  if (!p.github.repos.length) return null;
  if (!hasOpenRouter(store)) return setupBanner('openrouter', 'Triage with AI needs an OpenRouter key.');
  const mine = triage.projectId === p.id ? triage : { status: 'idle' };
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

// The project page. Every field is edited where it is shown; a change is saved when the field is left.
// Repo overview: what a repo is, read from GitHub (description, languages, files, README), with an optional AI explanation.
const overviews = new Map(); // repo -> { status, data?, error?, summary? }

function loadOverview(store, repo) {
  overviews.set(repo, { status: 'loading' });
  store.refresh();
  fetchRepoOverview(repo)
    .then((data) => overviews.set(repo, { status: 'ok', data }))
    .catch((err) => overviews.set(repo, { status: 'error', error: err.message }))
    .finally(() => store.refresh());
}

async function explainRepo(store, repo, entry) {
  entry.summary = { status: 'loading' };
  store.refresh();
  const d = entry.data;
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
    entry.summary = { status: 'error', text: err.message };
  }
  store.refresh();
}

function overviewBlock(store, p) {
  if (!p.github.repos.length) return null;
  return h('section', { class: 'pp-block' },
    h('h3', null, 'Understand the repo'),
    p.github.repos.map((repo) => {
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

      const d = entry.data;
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
function projectTasks(store, p, items) {
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done');
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
      onsubmit: (e) => {
        e.preventDefault();
        const text = new FormData(e.currentTarget).get('todo').trim();
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

function projectView(store, p, items, categories) {
  const projects = store.get(COLLECTION).projects;
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  const done = items.filter((i) => i.projectId === p.id && statusOf(i) === 'done').length;
  const ownLabels = labelsOf(p);
  const labels = ownLabels.map((id) => categoryById(categories, id)).filter(Boolean);
  const freeLabels = categories.filter((c) => !ownLabels.includes(c.id));
  const children = projects.filter((x) => x.parentId === p.id);
  const parentChoices = projects.filter((x) => x.id !== p.id && !descendantIds(projects, p.id).has(x.id));
  const t = githubTotals(p);
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
            onchange: (e) => updateProject(store, p.id, { color: e.target.value }),
          })),
        projectIcon(p, 'project-icon large'),
        editText({
          value: p.name,
          placeholder: 'Untitled project',
          className: 'pp-name',
          onSave: (name) => updateProject(store, p.id, { name }),
        })),
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
                onPick: (id) => {
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
          onPick: (parentId) => setParent(store, p.id, parentId),
        }),
        children.length
          ? h('span', { class: 'muted small' }, `Sub-projects: ${children.map((x) => x.name).join(', ')}`)
          : null),

      h('div', { class: 'pp-field' },
        h('span', { class: 'pp-label' }, 'Open / done'),
        h('span', null, `${open} open · ${done} done`)),

      googleField(store, p)),

    h('section', { class: 'pp-block' },
      h('h3', null, 'Description'),
      editText({
        value: p.description,
        placeholder: 'Add a description… links and lists work',
        multiline: true,
        allowEmpty: true,
        rich: true,
        onSave: (description) => updateProject(store, p.id, { description }),
      })),

    h('div', { class: 'pp-grid' },
      h('section', { class: 'pp-block' },
        h('h3', null, 'Website'),
        editText({
          value: p.website,
          placeholder: 'example.com',
          allowEmpty: true,
          onSave: (website) => updateProject(store, p.id, { website }),
        }),
        p.website ? h('a', { href: p.website, target: '_blank', rel: 'noopener', class: 'muted small' }, p.website) : null),
      h('section', { class: 'pp-block' },
        h('h3', null, 'Icon'),
        h('div', { class: 'pp-icon-row' },
          siteIcon(p, 'project-icon large'),
          editText({
            value: p.iconUrl ?? '',
            placeholder: p.website ? 'Found from the website. Paste an image URL to override' : 'Paste an image URL',
            allowEmpty: true,
            onSave: (iconUrl) => updateProject(store, p.id, { iconUrl }),
          }))),
      h('section', { class: 'pp-block' },
        h('h3', null, 'GitHub organization'),
        editText({
          value: p.github.org,
          placeholder: 'my-org or github.com/my-org',
          allowEmpty: true,
          onSave: (org) => updateProject(store, p.id, { org }),
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
          onSave: (repos) => updateProject(store, p.id, { repos }),
        }))),

    h('div', { class: 'pp-stats' },
      stat(open, 'open tasks'),
      stat(done, 'done tasks'),
      stat(gh(t.issues), 'open issues'),
      stat(gh(t.prs), 'open PRs')),

    projectTasks(store, p, items),

    p.github.repos.length ? repoTable(store, p) : null,
    overviewBlock(store, p),
    triageBlock(store, p));
}

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
            onPick: (color) => store.update(COLLECTION, (d) => {
              const label = d.categories.find((x) => x.id === c.id);
              if (label) label.color = color;
            }),
          }),
          editText({
            value: c.name,
            placeholder: 'Name',
            className: 'grow',
            onSave: (name) => renameCategory(store, c, name),
          }),
          h('span', { class: 'muted' }, `${count} project${count === 1 ? '' : 's'}`),
          h('button', { type: 'button', class: 'danger', onclick: () => deleteCategory(store, c) }, icon('x'), 'Delete'));
      })),
    h('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const name = formValues(e.currentTarget).name.trim();
        if (name) addCategory(store, name);
      },
    },
      h('input', { name: 'name', placeholder: 'New category, e.g. Health', 'aria-label': 'New category', class: 'grow', autocomplete: 'off' }),
      h('button', { class: 'primary', type: 'submit' }, 'Add')));
}

const stat = (n, label) => h('div', null, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));

// Shown in the detail pane when no project is selected: an overview across all projects.
function projectsRecap(store, projects, items, categories) {
  if (!projects.length) return empty('No projects yet. Create one on the left to get started.');
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
          const labels = labelsOf(p).map((id) => categoryById(categories, id)).filter(Boolean);
          return h('li', {
            class: 'recap-row',
            style: { paddingLeft: `${8 + depth * 18}px` },
            onclick: () => select(store, p.id),
          },
            projectIcon(p),
            h('strong', null, p.name),
            labels.length ? h('span', { class: 'muted small' }, labels.map((l) => l.name).join(', ')) : null,
            h('span', { class: 'muted small grow' }, githubLine(p)),
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
    h('div', { class: 'split' },
      h('section', { class: 'card side-pane' },
        h('input', {
          type: 'search',
          placeholder: 'Search projects',
          'aria-label': 'Search projects',
          value: view.query,
          oninput: (e) => {
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
            onsubmit: (e) => {
              e.preventDefault();
              const input = e.currentTarget.querySelector('input[name="name"]');
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

      h('section', { class: 'card main-pane' }, detail)));
}

export default {
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
  restore: (p = {}) => {
    view.selectedId = p.project || null;
    view.mode = p.mode === 'categories' ? 'categories' : 'view';
    view.category = p.category || 'all';
    view.query = p.q || '';
    view.error = '';
    view.draft = null;
  },
};
