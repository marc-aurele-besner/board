import { h, uid, now, icon, statusOf } from '../ui.js';
import { makeProject, projectIcon } from './projects.js';

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
// expanded: ids with the details editor open.
const view = { filter: 'all', status: 'open', category: '', expanded: new Set(), dragId: null };

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
const label = (list, key) => list.find(([k]) => k === key)?.[1] ?? '';

// "buy milk #home" files the item under project "home" (created if missing).
// Extra lines from a multi-line paste arrive as the description.
function addItem(store, raw, description = '') {
  let text = raw.trim();
  const tag = text.match(/(?:^|\s)#([\w-]+)/);
  if (tag) text = text.replace(tag[0], ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;

  let projectId = isProjectFilter(view.filter) ? view.filter : null;
  if (tag) {
    const projects = projectsOf(store);
    let project = projects.find((p) => p.name.toLowerCase() === tag[1].toLowerCase());
    if (!project) {
      project = makeProject(projects.length, { name: tag[1] });
      store.update('projects', (d) => d.projects.push(project));
    }
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

// Checkbox: done or back to to-do.
const setStatus = (store, id, status) =>
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) {
      item.status = status;
      delete item.done;
    }
  });

const removeItem = (store, id) =>
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });

function saveDetails(store, id, v) {
  view.expanded.delete(id);
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (!item) return;
    item.status = STATUSES.some(([k]) => k === v.status) ? v.status : 'todo';
    item.priority = PRIORITIES.some(([k]) => k === v.priority) ? v.priority : 'none';
    item.category = v.category.trim();
    item.projectId = v.project || null; // empty value means Personal
    item.description = v.description.trim();
    delete item.done;
  });
}

// Used by drag-and-drop onto a sidebar list. projectId null means Personal.
function moveToProject(store, id, projectId) {
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.projectId = projectId;
  });
}

function toggleExpanded(store, id) {
  if (view.expanded.has(id)) view.expanded.delete(id);
  else view.expanded.add(id);
  store.refresh();
}

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

// ctx: { projects, categories, projectLabel }
function todoItem(store, item, ctx) {
  const expanded = view.expanded.has(item.id);
  const status = statusOf(item);
  const hasDescription = Boolean(item.description);
  const priority = item.priority ?? 'none';

  const li = h('li', {
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
        onchange: (e) => setStatus(store, item.id, e.target.checked ? 'done' : 'todo'),
      }),
      h('span', { class: 'grow todo-text' }, item.text),
      ctx.projectLabel ? h('span', { class: 'badge' }, ctx.projectLabel) : null,
      status === 'doing' ? h('span', { class: 'pill doing' }, 'Doing') : null,
      priority !== 'none' ? h('span', { class: `pill priority-${priority}` }, label(PRIORITIES, priority)) : null,
      item.category ? h('span', { class: 'tag' }, item.category) : null,
      hasDescription
        ? h('span', { class: 'desc-indicator', title: 'Has a description', 'aria-label': 'Has a description' }, icon('align-left'))
        : null,
      h('button', {
        type: 'button',
        class: expanded ? 'icon-btn chevron open' : 'icon-btn chevron',
        title: expanded ? 'Close details' : 'Open details',
        'aria-label': expanded ? 'Close details' : 'Open details',
        'aria-expanded': String(expanded),
        onclick: () => toggleExpanded(store, item.id),
      }, icon('chevron-down')),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Delete',
        'aria-label': `Delete "${item.text}"`,
        onclick: () => removeItem(store, item.id),
      }, icon('x'))),

    expanded
      ? h('form', {
          class: 'todo-desc',
          onsubmit: (e) => {
            e.preventDefault();
            saveDetails(store, item.id, formValues(e.currentTarget));
          },
        },
          h('div', { class: 'row' },
            h('label', { class: 'grow' }, 'Status',
              h('select', { name: 'status', value: status },
                STATUSES.map(([k, l]) => h('option', { value: k }, l)))),
            h('label', { class: 'grow' }, 'Priority',
              h('select', { name: 'priority', value: priority },
                PRIORITIES.map(([k, l]) => h('option', { value: k }, l))))),
          h('div', { class: 'row' },
            h('label', { class: 'grow' }, 'Project',
              h('select', { name: 'project', value: item.projectId ?? '' },
                h('option', { value: '' }, 'Personal'),
                [...ctx.projects].sort((a, b) => a.name.localeCompare(b.name))
                  .map((p) => h('option', { value: p.id }, p.name)))),
            h('label', { class: 'grow' }, 'Category',
              h('input', {
                name: 'category',
                value: item.category ?? '',
                list: 'todo-categories',
                placeholder: 'e.g. errands, research',
                autocomplete: 'off',
              }))),
          h('label', null, 'Description',
            h('textarea', { name: 'description', rows: 4, placeholder: 'Notes, links, steps… paste freely' }, item.description)),
          h('div', { class: 'row end' },
            h('button', {
              type: 'button',
              onclick: () => {
                view.expanded.delete(item.id);
                store.refresh();
              },
            }, 'Close'),
            h('button', { class: 'primary', type: 'submit' }, 'Save')))
      : null);

  return li;
}

function draw(root, store) {
  const projects = projectsOf(store);
  const { items } = store.get(COLLECTION);
  if (isProjectFilter(view.filter) && !projects.some((p) => p.id === view.filter)) view.filter = 'all';

  const categories = [...new Set(items.map((i) => i.category).filter(Boolean))].sort((a, b) => a.localeCompare(b));
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
        h('h2', null, 'Projects'),
        [...projects].sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => navItem(p.id, p.name, openCount((i) => i.projectId === p.id), projectIcon(p))),
        h('a', { href: '#/projects', class: 'side-link' }, icon('folder'), 'Manage projects')),

      h('section', { class: 'card main-pane' },
        h('div', { class: 'row between' },
          h('h2', null, currentLabel)),

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

        h('datalist', { id: 'todo-categories' }, categories.map((c) => h('option', { value: c }))),

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
          ? h('ul', { class: 'todo-list' },
              visible.map((item) =>
                todoItem(store, item, {
                  projects,
                  projectLabel: view.filter === 'all' ? projectName(item.projectId) : '',
                })))
          : h('p', { class: 'empty' }, 'Nothing matches these filters.'))));
}

export default {
  id: 'todos',
  title: 'Todos',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { items: [] },
  render: draw,
};
