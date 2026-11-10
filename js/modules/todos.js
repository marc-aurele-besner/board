import { h, uid, now, icon } from '../ui.js';
import { makeProject } from './projects.js';

const COLLECTION = 'todos';

// View state lives here so it survives re-renders.
// filter: 'all' | 'personal' | <project id>. expanded: ids with the description editor open.
const view = { filter: 'all', showDone: false, expanded: new Set(), dragId: null };

const isProjectFilter = (f) => f !== 'all' && f !== 'personal';
const matchesFilter = (item) =>
  view.filter === 'all' || (view.filter === 'personal' ? item.projectId === null : item.projectId === view.filter);
const projectsOf = (store) => store.get('projects').projects;
const formValues = (form) => Object.fromEntries(new FormData(form));

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
    d.items.push({ id: uid(), text, description, done: false, projectId, created: now() }));
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

const toggleItem = (store, id, done) =>
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.done = done;
  });

const removeItem = (store, id) =>
  store.update(COLLECTION, (d) => {
    d.items = d.items.filter((i) => i.id !== id);
  });

function saveDescription(store, id, description) {
  view.expanded.delete(id);
  store.update(COLLECTION, (d) => {
    const item = d.items.find((i) => i.id === id);
    if (item) item.description = description.trim();
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

function todoItem(store, item, projectLabel) {
  const expanded = view.expanded.has(item.id);
  const hasDescription = Boolean(item.description);

  const li = h('li', {
    class: item.done ? 'todo-item done' : 'todo-item',
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
        checked: item.done,
        'aria-label': `Mark "${item.text}" done`,
        onchange: (e) => toggleItem(store, item.id, e.target.checked),
      }),
      h('span', { class: 'grow todo-text' }, item.text),
      projectLabel ? h('span', { class: 'badge' }, projectLabel) : null,
      h('button', {
        type: 'button',
        class: hasDescription ? 'icon-btn desc-btn has-desc' : 'icon-btn desc-btn',
        title: hasDescription ? 'Show description' : 'Add description',
        'aria-label': hasDescription ? 'Show description' : 'Add description',
        'aria-expanded': String(expanded),
        onclick: () => toggleExpanded(store, item.id),
      }, icon('align-left')),
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
            saveDescription(store, item.id, formValues(e.currentTarget).description);
          },
        },
          h('textarea', { name: 'description', rows: 4, placeholder: 'Notes, links, steps… paste freely', 'aria-label': 'Description' }, item.description),
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

  const openCount = (pred) => items.filter((i) => !i.done && pred(i)).length;
  const projectName = (id) => projects.find((p) => p.id === id)?.name ?? '';
  const currentLabel =
    view.filter === 'all' ? 'All' : view.filter === 'personal' ? 'Personal' : projectName(view.filter);

  const navItem = (key, label, count, color) =>
    h('button', {
      type: 'button',
      class: view.filter === key ? 'nav-item active' : 'nav-item',
      onclick: () => {
        view.filter = key;
        store.refresh();
      },
    },
      color ? h('span', { class: 'dot', style: { background: color } }) : null,
      h('span', { class: 'grow' }, label),
      h('span', { class: 'count' }, String(count)));

  // Stored order is the display order, so the list is not re-sorted here.
  const visible = items.filter((i) => (view.showDone || !i.done) && matchesFilter(i));

  root.replaceChildren(
    h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('h2', null, 'Lists'),
        navItem('all', 'All', openCount(() => true)),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        h('h2', null, 'Projects'),
        [...projects].sort((a, b) => a.name.localeCompare(b.name))
          .map((p) => navItem(p.id, p.name, openCount((i) => i.projectId === p.id), p.color)),
        h('a', { href: '#/projects', class: 'side-link' }, icon('folder'), 'Manage projects')),

      h('section', { class: 'card main-pane' },
        h('div', { class: 'row between' },
          h('h2', null, currentLabel),
          h('label', { class: 'check' },
            h('input', {
              type: 'checkbox',
              checked: view.showDone,
              onchange: (e) => {
                view.showDone = e.target.checked;
                store.refresh();
              },
            }),
            ' Show done')),

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
                todoItem(store, item, view.filter === 'all' ? projectName(item.projectId) : ''))
            )
          : h('p', { class: 'empty' }, 'Nothing here yet. Type above and press Enter.'))));
}

export default {
  id: 'todos',
  title: 'Todos',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { items: [] },
  render: draw,
};
