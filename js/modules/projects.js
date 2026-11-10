import { h, uid, now, icon, empty, statusOf } from '../ui.js';
import { repoStats, refreshRepo, openItems } from '../github.js';
import { ask } from '../ai.js';

const COLLECTION = 'projects';
const PALETTE = ['#2f6f4e', '#3b6ea8', '#a3432b', '#8a5a9e', '#b08416', '#2e8a8a'];
const SLUG = /^[\w.-]+$/;
const DEFAULT_CATEGORIES = [
  { id: 'cat-personal', name: 'Personal' },
  { id: 'cat-web', name: 'Web' },
  { id: 'cat-crypto', name: 'Crypto' },
];

// View state. mode: 'view' | 'edit' | 'new' | 'categories'. draft keeps typed values when validation fails.
// category filter: 'all' | 'none' | <category id>.
let liveStore = null;
const view = { selectedId: null, mode: 'view', error: '', draft: null, query: '', category: 'all' };

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const formValues = (form) => Object.fromEntries(new FormData(form));
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const categoryById = (categories, id) => categories.find((c) => c.id === id) ?? null;

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
    categoryId: null,
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
  const fallback = () => h('span', { class: 'dot', style: { background: p.color } });
  if (!p.website) return fallback();
  return h('img', {
    class: className,
    src: `${p.website}/favicon.ico`,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    onerror: (e) => e.currentTarget.replaceWith(fallback()),
  });
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

function saveForm(store, v) {
  const fail = (error) => {
    view.error = error;
    view.draft = v;
    store.refresh();
  };
  const name = v.name.trim();
  if (!name) return fail('Name is required.');

  const { projects } = store.get(COLLECTION);
  const editingId = view.mode === 'edit' ? view.selectedId : null;
  if (projects.some((p) => p.id !== editingId && sameName(p.name, name))) return fail(`A project named "${name}" already exists.`);

  const website = normalizeWebsite(v.website);
  if (website === null) return fail('Website must be a valid http or https address, such as example.com.');

  const org = normalizeOrg(v.org);
  if (org === null) return fail('GitHub org must be a name or a github.com/<org> URL.');

  const repos = [];
  for (const line of splitLines(v.repos)) {
    const repo = normalizeRepo(line);
    if (!repo) return fail(`"${line}" is not a repo. Use owner/repo or a github.com URL.`);
    if (!repos.includes(repo)) repos.push(repo);
  }

  const fields = {
    name,
    description: v.description.trim(),
    color: v.color || PALETTE[0],
    website,
    categoryId: v.categoryId || null,
    github: { org, repos },
  };
  if (editingId) {
    store.update(COLLECTION, (d) => {
      const p = d.projects.find((x) => x.id === editingId);
      if (p) Object.assign(p, fields);
    });
  } else {
    const { project } = createProject(store, name, fields);
    view.selectedId = project.id;
  }
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.refresh();
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
    // Todo categories scoped to this project have nothing left to apply to.
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
  store.update(COLLECTION, (d) => d.categories.push({ id: uid(), name }));
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
  const count = projects.filter((p) => p.categoryId === category.id).length;
  if (!confirm(`Delete category "${category.name}"? ${count} project${count === 1 ? '' : 's'} will become uncategorized.`)) return;
  store.update(COLLECTION, (d) => {
    d.categories = d.categories.filter((c) => c.id !== category.id);
    d.projects.forEach((p) => {
      if (p.categoryId === category.id) p.categoryId = null;
    });
  });
  const todos = store.get('todos');
  if (Array.isArray(todos.categories)) {
    store.update('todos', (t) => {
      t.categories = t.categories.filter((c) => !(c.scope === 'projectCategory' && c.projectCategoryId === category.id));
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
function moveProject(store, id, targetId, after) {
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
const dropSide = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? 'after' : 'before';
};

function projectList(store, projects, items, categories) {
  if (!projects.length) return empty('No projects match. Try another filter, or create one above.');
  return h('ul', { class: 'project-list' },
    projects.map((p) => {
      const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
      const category = categoryById(categories, p.categoryId);
      return h('li', {
        class: p.id === view.selectedId ? 'project-item active' : 'project-item',
        'data-id': p.id,
        onclick: () => select(store, p.id),
        ondragstart: (e) => {
          dragId = p.id;
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', p.id); // Firefox needs data to start a drag
          e.currentTarget.classList.add('dragging');
        },
        ondragend: (e) => {
          dragId = null;
          e.currentTarget.draggable = false;
          e.currentTarget.classList.remove('dragging');
        },
        ondragover: (e) => {
          if (!dragId || dragId === p.id) return;
          e.preventDefault();
          const side = dropSide(e);
          e.currentTarget.classList.toggle('drop-before', side === 'before');
          e.currentTarget.classList.toggle('drop-after', side === 'after');
        },
        ondragleave: (e) => e.currentTarget.classList.remove('drop-before', 'drop-after'),
        ondrop: (e) => {
          if (!dragId) return;
          e.preventDefault();
          e.currentTarget.classList.remove('drop-before', 'drop-after');
          moveProject(store, dragId, p.id, dropSide(e) === 'after');
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
          h('div', { class: 'muted' }, category ? `${category.name} · ${githubLine(p)}` : githubLine(p))),
        h('span', { class: 'count', title: 'Open todos' }, String(open)));
    }));
}

function repoTable(store, p) {
  return h('table', { class: 'repo-table' },
    h('thead', null, h('tr', null,
      h('th', null, 'Repository'), h('th', { class: 'num' }, 'Issues'), h('th', { class: 'num' }, 'PRs'), h('th', null, ''), h('th', null, ''))),
    h('tbody', null, p.github.repos.map((r) => {
      const s = repoStats(r, onRepoChange);
      const ok = s.status === 'ok';
      return h('tr', null,
        h('td', null, h('a', { href: `https://github.com/${r}`, target: '_blank', rel: 'noopener' }, r)),
        h('td', { class: 'num' }, ok ? String(s.issues) : '—'),
        h('td', { class: 'num' }, ok ? String(s.prs) : '—'),
        h('td', { class: 'muted' }, s.status === 'loading' ? 'Loading…' : s.status === 'error' ? s.error : ''),
        h('td', null, h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Refresh counts',
          'aria-label': `Refresh ${r}`,
          onclick: () => {
            refreshRepo(r, onRepoChange);
            store.refresh();
          },
        }, icon('refresh'))));
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
          content: 'You triage GitHub issues and pull requests. Given the open items as JSON, reply in plain text: first what needs attention now, then what looks stale (no update in 30 days or more), then one suggested next action per item in a single line. Be concise.',
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
  const mine = triage.projectId === p.id ? triage : { status: 'idle' };
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: mine.status === 'loading',
    onclick: () => runTriage(store, p),
  }, 'Triage with AI');
  if (mine.status === 'idle') return h('div', { class: 'row' }, button);
  if (mine.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Reading issues and PRs…'));
  if (mine.status === 'error') return h('div', { class: 'stack' }, button, h('p', { class: 'error small', role: 'alert' }, mine.text));
  return h('div', { class: 'stack' }, button, h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, mine.text)));
}

function projectView(store, p, items, categories) {
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  const done = items.filter((i) => i.projectId === p.id && statusOf(i) === 'done').length;
  const category = categoryById(categories, p.categoryId);
  const t = githubTotals(p);
  const gh = (n) => (p.github.repos.length === 0 ? '—' : t.pending ? '…' : String(n));
  const link = (href, text, iconName) =>
    h('li', null, icon(iconName), h('a', { href, target: '_blank', rel: 'noopener' }, text));

  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      h('div', { class: 'stack' },
        h('h2', { class: 'row' }, projectIcon(p, 'project-icon large'), p.name),
        h('div', { class: 'row' },
          category ? h('span', { class: 'pill category' }, category.name) : h('span', { class: 'muted' }, 'No category'))),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => { view.mode = 'edit'; view.draft = null; view.error = ''; store.refresh(); } },
          icon('pencil'), 'Edit'),
        h('button', { type: 'button', class: 'danger', onclick: () => deleteProject(store, p) }, icon('x'), 'Delete'))),

    h('div', { class: 'stats' },
      h('div', { class: 'card-inset' }, h('strong', null, String(open)), h('span', { class: 'muted' }, 'open todos')),
      h('div', { class: 'card-inset' }, h('strong', null, String(done)), h('span', { class: 'muted' }, 'done todos')),
      h('div', { class: 'card-inset' }, h('strong', null, gh(t.issues)), h('span', { class: 'muted' }, 'open issues')),
      h('div', { class: 'card-inset' }, h('strong', null, gh(t.prs)), h('span', { class: 'muted' }, 'open PRs'))),

    p.description ? h('p', null, p.description) : h('p', { class: 'muted' }, 'No description yet.'),
    triageBlock(store, p),

    p.website
      ? h('section', { class: 'stack' },
          h('h3', null, 'Website'),
          h('ul', { class: 'links' }, link(p.website, p.website, 'globe')))
      : null,

    h('section', { class: 'stack' },
      h('h3', null, 'GitHub'),
      p.github.repos.length || p.github.org
        ? h('div', { class: 'stack' },
            p.github.org ? h('ul', { class: 'links' }, link(`https://github.com/${p.github.org}`, p.github.org, 'building')) : null,
            p.github.repos.length ? repoTable(store, p) : null)
        : h('p', { class: 'muted' }, 'Not linked to GitHub. Fine for non-coding projects.')));
}

function projectForm(store, project, projectCount, categories) {
  const isNew = !project;
  const draft = view.draft ?? (project
    ? {
        name: project.name,
        description: project.description,
        color: project.color,
        website: project.website,
        categoryId: project.categoryId ?? '',
        org: project.github.org,
        repos: project.github.repos.join('\n'),
      }
    : { name: '', description: '', color: PALETTE[projectCount % PALETTE.length], website: '', categoryId: '', org: '', repos: '' });

  return h('form', {
    class: 'stack-lg',
    onsubmit: (e) => {
      e.preventDefault();
      saveForm(store, formValues(e.currentTarget));
    },
  },
    h('h2', null, isNew ? 'New project' : 'Edit project'),
    view.error ? h('p', { class: 'error', role: 'alert' }, view.error) : null,
    h('div', { class: 'row' },
      h('label', { class: 'grow' }, 'Name', h('input', { name: 'name', value: draft.name, required: true, autocomplete: 'off', 'data-autofocus': true })),
      h('label', null, 'Color', h('input', { name: 'color', type: 'color', value: draft.color }))),
    h('div', { class: 'row' },
      h('label', { class: 'grow' }, 'Category',
        h('select', { name: 'categoryId', value: draft.categoryId },
          h('option', { value: '' }, 'No category'),
          categories.map((c) => h('option', { value: c.id }, c.name)))),
      h('label', { class: 'grow' }, 'Website (its favicon becomes the project icon)',
        h('input', { name: 'website', value: draft.website, placeholder: 'example.com', inputmode: 'url', autocomplete: 'off' }))),
    h('label', null, 'Description',
      h('textarea', { name: 'description', rows: 2, placeholder: 'What is this project about?' }, draft.description)),

    h('div', { class: 'card-inset stack' },
      h('h3', null, 'GitHub (optional)'),
      h('p', { class: 'muted' }, 'Link an organization, one or more repositories, or leave both empty for non-coding projects.'),
      h('label', null, 'Organization',
        h('input', { name: 'org', value: draft.org, placeholder: 'my-org or https://github.com/my-org', autocomplete: 'off' })),
      h('label', null, 'Repositories (one per line)',
        h('textarea', { name: 'repos', rows: 3, placeholder: 'owner/repo or a GitHub URL' }, draft.repos))),

    h('div', { class: 'row end' },
      h('button', {
        type: 'button',
        onclick: () => {
          view.mode = 'view';
          view.draft = null;
          view.error = '';
          store.refresh();
        },
      }, 'Cancel'),
      h('button', { class: 'primary', type: 'submit' }, isNew ? 'Create project' : 'Save changes')));
}

function categoriesPanel(store, categories, projects) {
  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      h('h2', null, 'Categories'),
      h('button', {
        type: 'button',
        onclick: () => {
          view.mode = 'view';
          view.error = '';
          store.refresh();
        },
      }, 'Done')),
    h('p', { class: 'muted' }, 'Categories group projects (Personal, Web, Crypto…). Todo categories can be scoped to one of them in the Todos section.'),
    view.error ? h('p', { class: 'error', role: 'alert' }, view.error) : null,
    h('ul', { class: 'stack' },
      categories.map((c) => {
        const count = projects.filter((p) => p.categoryId === c.id).length;
        return h('li', { class: 'row category-row' },
          h('form', {
            class: 'row grow',
            onsubmit: (e) => {
              e.preventDefault();
              renameCategory(store, c, formValues(e.currentTarget).name.trim());
            },
          },
            h('input', { name: 'name', value: c.name, 'aria-label': 'Category name', class: 'grow' }),
            h('button', { type: 'submit' }, 'Save')),
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
      (view.category === 'all' || (view.category === 'none' ? !p.categoryId : p.categoryId === view.category)) &&
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
  else if (view.mode === 'new') detail = projectForm(store, null, projects.length, categories);
  else if (selected && view.mode === 'edit') detail = projectForm(store, selected, projects.length, categories);
  else if (selected) detail = projectView(store, selected, items, categories);
  else detail = empty('Pick a project on the left, or create one.');

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
        h('div', { class: 'chips' },
          chip('all', 'All'),
          chip('none', 'None'),
          categories.map((c) => chip(c.id, c.name))),
        h('form', {
          class: 'stack quick-project',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.currentTarget.querySelector('input[name="name"]');
            const name = input.value.trim();
            if (name) quickCreate(store, name);
          },
        },
          h('input', { name: 'name', placeholder: 'Quick add: project name, Enter', 'aria-label': 'Quick add project name', autocomplete: 'off' }),
          h('div', { class: 'row' },
            h('button', { class: 'primary', type: 'submit' }, 'Add'),
            h('button', {
              type: 'button',
              onclick: (e) => {
                const name = e.currentTarget.closest('form').querySelector('input[name="name"]').value.trim();
                view.mode = 'new';
                view.selectedId = null;
                view.error = '';
                view.draft = { name, description: '', color: PALETTE[projects.length % PALETTE.length], website: '', categoryId: '', org: '', repos: '' };
                store.refresh();
              },
            }, 'Detailed…'),
            h('button', {
              type: 'button',
              onclick: () => {
                view.mode = 'categories';
                view.error = '';
                store.refresh();
              },
            }, 'Categories'))),
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
    view.mode = ['edit', 'new', 'categories'].includes(p.mode) ? p.mode : 'view';
    view.category = p.category || 'all';
    view.query = p.q || '';
    view.error = '';
    view.draft = null;
  },
};
