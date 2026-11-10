import { h, uid, now, icon, statusOf, empty } from '../ui.js';
import { createProject, projectIcon } from './projects.js';
import { editText, pickChip } from '../inline.js';

const COLLECTION = 'todos';
const STATUSES = [
  ['todo', 'To do'],
  ['doing', 'Doing'],
  ['done', 'Done'],
];
const PRIORITIES = [
  ['none', 'No priority'],
  ['low', 'Low'],
  ['medium', 'Medium'],
  ['high', 'High'],
];
const STATUS_FILTERS = [['open', 'Open'], ['all', 'All'], ...STATUSES];

// View state lives here so it survives re-renders.
// filter: 'all' | 'personal' | <project id>. status: a STATUS_FILTERS key. category: '' means any.
// managingCategories shows the category manager; creatingProject shows the "+" form in the sidebar.
const view = {
  filter: 'all',
  status: 'open',
  category: '',
  expanded: new Set(),
  dragId: null,
  managingCategories: false,
  creatingProject: false,
  catError: '',
};

const isProjectFilter = (f) => f !== 'all' && f !== 'personal';
const matchesFilter = (item) =>
  view.filter === 'all' || (view.filter === 'personal' ? item.projectId === null : item.projectId === view.filter);
const matchesStatus = (item) => {
  const s = statusOf(item);
  if (view.status === 'open') return s !== 'done';
  return view.status === 'all' || s === view.status;
};
const matchesCategory = (item) => !view.category || item.category === view.category;
const projectsOf = (store) => store.get('projects').projects;
const formValues = (form) => Object.fromEntries(new FormData(form));
const sameLower = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Todo categories. Each has a scope: 'all' (every project), 'project' (one project),
// or 'projectCategory' (every project in a project category such as Web).
const todoCategories = (store) => store.get(COLLECTION).categories ?? [];

// Names a todo in this project can use: general ones, plus those scoped to the project or its category.
function categoriesFor(store, projectId) {
  const project = projectsOf(store).find((p) => p.id === projectId);
  return todoCategories(store)
    .filter((c) =>
      c.scope === 'all' ||
      (c.scope === 'project' && c.projectId === projectId) ||
      (c.scope === 'projectCategory' && Boolean(project) && project.categoryId === c.projectCategoryId))
    .map((c) => c.name);
}

// Select values: "all", "project:<id>", "category:<project category id>".
function parseScope(value) {
  if (value.startsWith('project:')) return { scope: 'project', projectId: value.slice(8), projectCategoryId: null };
  if (value.startsWith('category:')) return { scope: 'projectCategory', projectId: null, projectCategoryId: value.slice(9) };
  return { scope: 'all', projectId: null, projectCategoryId: null };
}
function scopeValue(c) {
  if (c.scope === 'project') return `project:${c.projectId}`;
  if (c.scope === 'projectCategory') return `category:${c.projectCategoryId}`;
  return 'all';
}

// "buy milk #home" files the item under project "home" (created if missing).
// Extra lines from a multi-line paste arrive as the description.
function addItem(store, raw, description = '') {
  let text = raw.trim();
  const tag = text.match(/(?:^|\s)#([\w-]+)/);
  if (tag) text = text.replace(tag[0], ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;

  let projectId = isProjectFilter(view.filter) ? view.filter : null;
  if (tag) {
    const project = projectsOf(store).find((p) => p.name.toLowerCase() === tag[1].toLowerCase())
      ?? createProject(store, tag[1]).project;
    projectId = project.id;
  }
  store.update(COLLECTION, (d) =>
    d.items.push({ id: uid(), text, description, status: 'todo', priority: 'none', category: '', projectId, created: now() }));
}

// Pasting several lines: first non-empty line is the title, the rest is the description.
function pasteAsTodo(store, e) {
  const raw = e.clipboardData?.getData('text/plain') ?? '';
  if (!/\r?\n/.test(raw.trim())) return; // single line: let the browser paste normally
  e.preventDefault();
  const lines = raw.split(/\r?\n/);
  const first = lines.findIndex((l) => l.trim());
  if (first < 0) return;
  addItem(store, lines[first], lines.slice(first + 1).join('\n').trim());
}

// Every edit to a todo goes through here. A status change also drops the legacy `done` flag.
function updateItem(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    Object.assign(item, patch);
    if ('status' in patch) delete item.done;
  });
}

const removeItem = (store, id) =>
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });

// Creates a todo category from a todo's category picker. It is scoped to that todo's project, if it has one.
function createTodoCategory(store, name, projectId) {
  const existing = todoCategories(store).find((c) => sameLower(c.name, name));
  if (!existing) {
    store.update(COLLECTION, (d) =>
      d.categories.push({ id: uid(), name, ...(projectId ? parseScope(`project:${projectId}`) : parseScope('all')) }));
  }
  return name;
}

function saveTodoCategory(store, id, name, scope) {
  if (!name) return;
  if (todoCategories(store).some((c) => c.id !== id && sameLower(c.name, name))) {
    view.catError = `"${name}" already exists.`;
    return store.refresh();
  }
  view.catError = '';
  store.update(COLLECTION, (d) => {
    const c = d.categories.find((x) => x.id === id);
    if (c) Object.assign(c, { name }, parseScope(scope));
  });
}

function addTodoCategory(store, v) {
  const name = v.name.trim();
  if (!name) return;
  if (todoCategories(store).some((c) => sameLower(c.name, name))) {
    view.catError = `"${name}" already exists.`;
    return store.refresh();
  }
  view.catError = '';
  store.update(COLLECTION, (d) => d.categories.push({ id: uid(), name, ...parseScope(v.scope) }));
}

function deleteTodoCategory(store, c) {
  if (!confirm(`Delete category "${c.name}"? Todos keep their label.`)) return;
  store.update(COLLECTION, (d) => {
    d.categories = d.categories.filter((x) => x.id !== c.id);
  });
}

const toggleExpanded = (store, id) => {
  if (view.expanded.has(id)) view.expanded.delete(id);
  else view.expanded.add(id);
  store.refresh();
};

// Used by drag-and-drop onto a sidebar list. projectId null means Personal.
const moveToProject = (store, id, projectId) => updateItem(store, id, { projectId });

// Move `id` next to `targetId` (before it, or after it when `after` is true).
// The stored array order is the display order, so this is the reorder.
function moveItem(store, id, targetId, after) {
  if (id === targetId) return;
  store.update(COLLECTION, (d) => {
    const from = d.items.findIndex((i) => i.id === id);
    if (from < 0) return;
    const [item] = d.items.splice(from, 1);
    let to = d.items.findIndex((i) => i.id === targetId);
    if (to < 0) to = from;
    d.items.splice(after ? to + 1 : to, 0, item);
  });
}

// Drop indicator: above or below the row depending on pointer position.
function dropSide(e) {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2 ? 'after' : 'before';
}
function clearDropMarks(el) {
  el.classList.remove('drop-before', 'drop-after');
}

// One todo row. Title, description, and the pickers all edit in place.
// ctx: { store, projects, projectLabel }
function todoRow(store, item, ctx) {
  const expanded = view.expanded.has(item.id);
  const status = statusOf(item);
  const priority = item.priority ?? 'none';
  const hasDescription = Boolean(item.description);
  const projectOptions = [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
    .map((p) => ({ value: p.id, label: p.name, color: p.color }));
  const categoryNames = categoriesFor(store, item.projectId);
  if (item.category && !categoryNames.includes(item.category)) categoryNames.push(item.category);

  return h('li', {
    class: status === 'done' ? 'todo-item done' : 'todo-item',
    'data-id': item.id,
    ondragstart: (e) => {
      view.dragId = item.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.id); // Firefox needs data to start a drag
      e.currentTarget.classList.add('dragging');
    },
    ondragend: (e) => {
      view.dragId = null;
      e.currentTarget.draggable = false;
      e.currentTarget.classList.remove('dragging');
    },
    ondragover: (e) => {
      if (!view.dragId || view.dragId === item.id) return;
      e.preventDefault();
      const side = dropSide(e);
      e.currentTarget.classList.toggle('drop-before', side === 'before');
      e.currentTarget.classList.toggle('drop-after', side === 'after');
    },
    ondragleave: (e) => clearDropMarks(e.currentTarget),
    ondrop: (e) => {
      if (!view.dragId) return;
      e.preventDefault();
      const after = dropSide(e) === 'after';
      clearDropMarks(e.currentTarget);
      moveItem(store, view.dragId, item.id, after);
      view.dragId = null;
    },
  },
    h('div', { class: 'todo-row' },
      h('span', {
        class: 'grip',
        title: 'Drag to reorder',
        'aria-label': 'Drag to reorder',
        // Only the grip makes the row draggable, so text stays selectable.
        onpointerdown: (e) => {
          e.currentTarget.closest('li').draggable = true;
        },
      }, icon('grip')),
      h('input', {
        type: 'checkbox',
        checked: status === 'done',
        'aria-label': `Mark "${item.text}" done`,
        onchange: (e) => updateItem(store, item.id, { status: e.target.checked ? 'done' : 'todo' }),
      }),
      h('div', { class: 'todo-title-cell' },
        editText({
          value: item.text,
          placeholder: 'Untitled',
          className: 'todo-title',
          onSave: (text) => updateItem(store, item.id, { text }),
        })),
      h('div', { class: 'todo-meta' },
        pickChip({
          value: status,
          options: STATUSES.map(([v, l]) => ({ value: v, label: l, tone: v })),
          onPick: (v) => updateItem(store, item.id, { status: v }),
        }),
        pickChip({
          value: priority,
          options: PRIORITIES.map(([v, l]) => ({ value: v, label: l, tone: v === 'none' ? 'plain' : v })),
          onPick: (v) => updateItem(store, item.id, { priority: v }),
        }),
        pickChip({
          value: item.projectId ?? null,
          options: projectOptions,
          nullable: true,
          nullLabel: 'Personal',
          onPick: (v) => moveToProject(store, item.id, v),
        }),
        pickChip({
          value: item.category || null,
          options: categoryNames.map((c) => ({ value: c, label: c })),
          nullable: true,
          nullLabel: 'No category',
          allowCreate: true,
          onPick: (v) => updateItem(store, item.id, { category: v ?? '' }),
          onCreate: (name) => updateItem(store, item.id, { category: createTodoCategory(store, name, item.projectId) }),
        })),
      h('div', { class: 'todo-actions' },
        hasDescription
          ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left'))
          : null,
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
      ? h('div', { class: 'todo-desc' },
          editText({
            value: item.description,
            placeholder: 'Add a description… paste notes, links, steps',
            multiline: true,
            allowEmpty: true,
            onSave: (description) => updateItem(store, item.id, { description }),
          }))
      : null);
}

// Manager card: name and scope of every todo category, edited in place.
function categoriesManager(store) {
  const projects = projectsOf(store);
  const projectCategories = store.get('projects').categories ?? [];
  const scopeOptions = () => [
    h('option', { value: 'all' }, 'All projects'),
    h('optgroup', { label: 'One project' },
      [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => h('option', { value: `project:${p.id}` }, p.name))),
    h('optgroup', { label: 'Projects in a category' },
      projectCategories.map((c) => h('option', { value: `category:${c.id}` }, c.name))),
  ];
  const scopeLabel = (c) => {
    if (c.scope === 'project') return projects.find((p) => p.id === c.projectId)?.name ?? 'Missing project';
    if (c.scope === 'projectCategory') return `Category: ${projectCategories.find((x) => x.id === c.projectCategoryId)?.name ?? 'Missing'}`;
    return 'All projects';
  };
  const cats = todoCategories(store);

  return h('section', { class: 'card manager stack-lg' },
    h('div', { class: 'row between' },
      h('h3', null, 'Todo categories'),
      h('button', {
        type: 'button',
        onclick: () => {
          view.managingCategories = false;
          store.refresh();
        },
      }, 'Done')),
    h('p', { class: 'muted' }, 'General categories apply to every project. Scope one to a single project, or to all projects in a project category. Click a name or scope to change it.'),
    view.catError ? h('p', { class: 'error', role: 'alert' }, view.catError) : null,
    cats.length
      ? h('ul', { class: 'cat-list' },
          cats.map((c) =>
            h('li', { class: 'cat-row' },
              editText({
                value: c.name,
                placeholder: 'Name',
                className: 'cat-name',
                onSave: (name) => saveTodoCategory(store, c.id, name, scopeValue(c)),
              }),
              h('label', { class: 'cat-scope' },
                h('select', {
                  value: scopeValue(c),
                  'aria-label': `Applies to for ${c.name}`,
                  onchange: (e) => saveTodoCategory(store, c.id, c.name, e.target.value),
                }, scopeOptions())),
              h('span', { class: 'muted small' }, scopeLabel(c)),
              h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': `Delete ${c.name}`, onclick: () => deleteTodoCategory(store, c) }, icon('x')))))
      : empty('No todo categories yet. Add one below.'),
    h('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        addTodoCategory(store, formValues(e.currentTarget));
      },
    },
      h('input', { name: 'name', placeholder: 'New category, e.g. errands', 'aria-label': 'New category', class: 'grow', autocomplete: 'off' }),
      h('select', { name: 'scope', 'aria-label': 'Applies to' }, scopeOptions()),
      h('button', { class: 'primary', type: 'submit' }, 'Add')));
}

function draw(root, store) {
  const projects = projectsOf(store);
  const { items } = store.get(COLLECTION);
  if (isProjectFilter(view.filter) && !projects.some((p) => p.id === view.filter)) view.filter = 'all';

  const categories = [...new Set([...todoCategories(store).map((c) => c.name), ...items.map((i) => i.category).filter(Boolean)])]
    .sort((a, b) => a.localeCompare(b));
  if (view.category && !categories.includes(view.category)) view.category = '';

  const openCount = (pred) => items.filter((i) => statusOf(i) !== 'done' && pred(i)).length;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
  const currentLabel =
    view.filter === 'all' ? 'All' : view.filter === 'personal' ? 'Personal' : projectName(view.filter);

  // Personal and project lists accept dropped todos; "All" does not, since it has no project.
  const navItem = (key, text, count, leading) => {
    const accepts = key !== 'all';
    return h('button', {
      type: 'button',
      class: view.filter === key ? 'nav-item active' : 'nav-item',
      onclick: () => {
        view.filter = key;
        store.refresh();
      },
      ondragover: (e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.add('drop-target');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('drop-target'),
      ondrop: (e) => {
        if (!accepts || !view.dragId) return;
        e.preventDefault();
        e.currentTarget.classList.remove('drop-target');
        moveToProject(store, view.dragId, key === 'personal' ? null : key);
        view.dragId = null;
      },
    },
      leading ?? null,
      h('span', { class: 'grow' }, text),
      h('span', { class: 'count' }, String(count)));
  };

  // Stored order is the display order, so the list is not re-sorted here.
  const visible = items.filter((i) => matchesFilter(i) && matchesStatus(i) && matchesCategory(i));

  root.replaceChildren(
    h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('h2', null, 'Lists'),
        h('p', { class: 'hint' }, 'Drag a todo onto a list to move it.'),
        navItem('all', 'All', openCount(() => true)),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        h('div', { class: 'row between' },
          h('h2', null, 'Projects'),
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
          h('a', { href: '#/projects', class: 'icon-btn', title: 'Edit projects', 'aria-label': 'Edit projects' }, icon('pencil'))),
        view.creatingProject
          ? h('form', {
              class: 'stack',
              onsubmit: (e) => {
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
        [...projects].sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => navItem(p.id, p.name, openCount((i) => i.projectId === p.id), projectIcon(p)))),

      h('section', { class: 'card main-pane' },
        h('div', { class: 'row between' },
          h('h2', null, currentLabel),
          h('button', {
            type: 'button',
            onclick: () => {
              view.managingCategories = !view.managingCategories;
              view.catError = '';
              store.refresh();
            },
          }, 'Manage categories')),
        view.managingCategories ? categoriesManager(store) : null,

        h('div', { class: 'toolbar' },
          h('label', null, 'Show',
            h('select', {
              value: view.status,
              'aria-label': 'Filter by status',
              onchange: (e) => {
                view.status = e.target.value;
                store.refresh();
              },
            }, STATUS_FILTERS.map(([k, l]) => h('option', { value: k }, l)))),
          categories.length
            ? h('label', null, 'Category',
                h('select', {
                  value: view.category,
                  'aria-label': 'Filter by category',
                  onchange: (e) => {
                    view.category = e.target.value;
                    store.refresh();
                  },
                }, h('option', { value: '' }, 'All categories'),
                  categories.map((c) => h('option', { value: c }, c))))
            : null),

        h('form', {
          class: 'quick',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.currentTarget.querySelector('input[name="todo"]');
            addItem(store, input.value);
          },
        },
          h('input', {
            name: 'todo',
            placeholder: 'Add a todo… use #project to file it, paste several lines for a description',
            'aria-label': 'New todo',
            autocomplete: 'off',
            'data-autofocus': true,
            onpaste: (e) => pasteAsTodo(store, e),
          }),
          h('button', { class: 'primary', type: 'submit' }, 'Add')),

        visible.length
          ? h('div', { class: 'todo-table' },
              h('div', { class: 'todo-head', 'aria-hidden': 'true' },
                h('span', null), h('span', null), h('span', null, 'Task'),
                h('span', null, 'Status'), h('span', null, 'Priority'), h('span', null, 'Project'),
                h('span', null, 'Category'), h('span', null, '')),
              h('ul', { class: 'todo-list' },
                visible.map((item) =>
                  todoRow(store, item, {
                    store,
                    projects,
                    projectLabel: view.filter === 'all' ? projectName(item.projectId) : '',
                  }))))
          : h('p', { class: 'empty' }, 'Nothing matches these filters.'))));
}

export default {
  id: 'todos',
  title: 'Todos',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { items: [], categories: [] },
  render: draw,
};
