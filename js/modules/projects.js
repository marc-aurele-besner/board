import { h, uid, now, icon, empty, statusOf } from '../ui.js';

const COLLECTION = 'projects';
const PALETTE = ['#2f6f4e', '#3b6ea8', '#a3432b', '#8a5a9e', '#b08416', '#2e8a8a'];
const SLUG = /^[\w.-]+$/;

// View state. mode: 'view' | 'edit' | 'new'. draft keeps typed values when validation fails.
const view = { selectedId: null, mode: 'view', error: '', draft: null };

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const formValues = (form) => Object.fromEntries(new FormData(form));
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
    github: { org: '', repos: [] },
    created: now(),
    ...fields,
  };
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

function quickCreate(store, name) {
  const { projects } = store.get(COLLECTION);
  const existing = projects.find((p) => sameName(p.name, name));
  if (existing) {
    view.selectedId = existing.id;
    view.error = `"${existing.name}" already exists.`;
    view.mode = 'view';
    return store.refresh();
  }
  const project = makeProject(projects.length, { name });
  view.selectedId = project.id;
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.update(COLLECTION, (d) => d.projects.push(project));
}

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

  const fields = { name, description: v.description.trim(), color: v.color || PALETTE[0], website, github: { org, repos } };
  if (editingId) {
    store.update(COLLECTION, (d) => {
      const p = d.projects.find((x) => x.id === editingId);
      if (p) Object.assign(p, fields);
    });
  } else {
    const project = makeProject(projects.length, fields);
    view.selectedId = project.id;
    store.update(COLLECTION, (d) => d.projects.push(project));
  }
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.refresh();
}

function deleteProject(store, project) {
  if (!confirm(`Delete project "${project.name}"? Its todos stay, but move to Personal.`)) return;
  store.update('todos', (t) => {
    t.items.forEach((i) => {
      if (i.projectId === project.id) i.projectId = null;
    });
  });
  store.update(COLLECTION, (d) => {
    d.projects = d.projects.filter((p) => p.id !== project.id);
  });
  view.selectedId = null;
  view.mode = 'view';
}

const select = (store, id) => {
  view.selectedId = id;
  view.mode = 'view';
  view.error = '';
  view.draft = null;
  store.refresh();
};

const githubSummary = (p) => {
  if (p.github.org) return p.github.org;
  if (p.github.repos.length) return `${p.github.repos.length} repo${p.github.repos.length > 1 ? 's' : ''}`;
  return 'No GitHub';
};

function projectList(store, projects, items) {
  if (!projects.length) return empty('No projects yet. Create one above.');
  return h('ul', { class: 'project-list' },
    [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => {
      const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
      return h('li', {
        class: p.id === view.selectedId ? 'project-item active' : 'project-item',
        onclick: () => select(store, p.id),
      },
        projectIcon(p),
        h('div', { class: 'grow' },
          h('strong', null, p.name),
          h('div', { class: 'muted' }, p.website ? new URL(p.website).host : githubSummary(p))),
        h('span', { class: 'count', title: 'Open todos' }, String(open)));
    }));
}

function projectView(store, p, items) {
  const open = items.filter((i) => i.projectId === p.id && statusOf(i) !== 'done').length;
  const done = items.filter((i) => i.projectId === p.id && statusOf(i) === 'done').length;
  const hasGithub = p.github.org || p.github.repos.length;
  const link = (href, text, iconName) =>
    h('li', null, icon(iconName), h('a', { href, target: '_blank', rel: 'noopener' }, text));

  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      h('h2', { class: 'row' }, projectIcon(p, 'project-icon large'), p.name),
      h('div', { class: 'row' },
        h('button', { type: 'button', onclick: () => { view.mode = 'edit'; view.draft = null; view.error = ''; store.refresh(); } },
          icon('pencil'), 'Edit'),
        h('button', { type: 'button', class: 'danger', onclick: () => deleteProject(store, p) }, icon('x'), 'Delete'))),
    p.description ? h('p', null, p.description) : h('p', { class: 'muted' }, 'No description yet.'),

    p.website
      ? h('section', { class: 'stack' },
          h('h3', null, 'Website'),
          h('ul', { class: 'links' }, link(p.website, p.website, 'globe')))
      : null,

    h('section', { class: 'stack' },
      h('h3', null, 'GitHub'),
      hasGithub
        ? h('ul', { class: 'links' },
            p.github.org ? link(`https://github.com/${p.github.org}`, p.github.org, 'building') : null,
            p.github.repos.map((r) => link(`https://github.com/${r}`, r, 'repo')))
        : h('p', { class: 'muted' }, 'Not linked to GitHub. Fine for non-coding projects.')),

    h('section', { class: 'stack' },
      h('h3', null, 'Todos'),
      h('p', null, `${open} open · ${done} done`)));
}

function projectForm(store, project, projectCount) {
  const isNew = !project;
  const draft = view.draft ?? (project
    ? {
        name: project.name,
        description: project.description,
        color: project.color,
        website: project.website,
        org: project.github.org,
        repos: project.github.repos.join('\n'),
      }
    : { name: '', description: '', color: PALETTE[projectCount % PALETTE.length], website: '', org: '', repos: '' });

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
    h('label', null, 'Description',
      h('textarea', { name: 'description', rows: 2, placeholder: 'What is this project about?' }, draft.description)),
    h('label', null, 'Website (its favicon becomes the project icon)',
      h('input', { name: 'website', value: draft.website, placeholder: 'example.com', inputmode: 'url', autocomplete: 'off' })),

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

function draw(root, store) {
  const { projects } = store.get(COLLECTION);
  const { items } = store.get('todos');
  if (view.selectedId && !projects.some((p) => p.id === view.selectedId)) {
    view.selectedId = null;
    view.mode = 'view';
  }
  const selected = projects.find((p) => p.id === view.selectedId) ?? null;

  let detail;
  if (view.mode === 'new') detail = projectForm(store, null, projects.length);
  else if (selected && view.mode === 'edit') detail = projectForm(store, selected, projects.length);
  else if (selected) detail = projectView(store, selected, items);
  else detail = empty('Pick a project on the left, or create one.');

  root.replaceChildren(
    h('div', { class: 'split' },
      h('section', { class: 'card side-pane' },
        h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.currentTarget.querySelector('input[name="name"]');
            const name = input.value.trim();
            if (name) quickCreate(store, name);
          },
        },
          h('input', { name: 'name', placeholder: 'Quick add: project name, Enter', 'aria-label': 'Quick add project name', autocomplete: 'off', 'data-autofocus': true }),
          h('div', { class: 'row' },
            h('button', { class: 'primary', type: 'submit' }, 'Add'),
            h('button', {
              type: 'button',
              onclick: (e) => {
                const name = e.currentTarget.closest('form').querySelector('input[name="name"]').value.trim();
                view.mode = 'new';
                view.selectedId = null;
                view.error = '';
                view.draft = { name, description: '', color: PALETTE[projects.length % PALETTE.length], website: '', org: '', repos: '' };
                store.refresh();
              },
            }, 'Detailed…'))),
        h('div', { class: 'list-scroll' }, projectList(store, projects, items))),

      h('section', { class: 'card main-pane' }, detail)));
}

export default {
  id: 'projects',
  title: 'Projects',
  icon: 'folder',
  collection: COLLECTION,
  defaults: { projects: [] },
  render: draw,
};
