import { h, uid, now, icon } from '../ui.js';

const COLLECTION = 'todos';
const PALETTE = ['#2f6f4e', '#3b6ea8', '#a3432b', '#8a5a9e', '#b08416', '#2e8a8a'];

// View state lives here so it survives re-renders. filter: 'all' | 'personal' | <project id>
const view = { filter: 'all', showDone: false };

const isProjectFilter = (f) => f !== 'all' && f !== 'personal';
const matchesFilter = (item) =>
  view.filter === 'all' || (view.filter === 'personal' ? item.projectId === null : item.projectId === view.filter);

// "buy milk #home" files the item under project "home" (created if missing).
function addItem(store, raw) {
  let text = raw.trim();
  const tag = text.match(/(?:^|\s)#([\w-]+)/);
  if (tag) text = text.replace(tag[0], ' ').replace(/\s+/g, ' ').trim();
  if (!text) return;
  const tagName = tag?.[1];
  store.update(COLLECTION, (d) => {
    let projectId = isProjectFilter(view.filter) ? view.filter : null;
    if (tagName) {
      let project = d.projects.find((p) => p.name.toLowerCase() === tagName.toLowerCase());
      if (!project) {
        project = { id: uid(), name: tagName, color: PALETTE[d.projects.length % PALETTE.length] };
        d.projects.push(project);
      }
      projectId = project.id;
    }
    d.items.push({ id: uid(), text, done: false, projectId, created: now() });
  });
}

function addProject(store, name) {
  store.update(COLLECTION, (d) => {
    if (d.projects.some((p) => p.name.toLowerCase() === name.toLowerCase())) return;
    d.projects.push({ id: uid(), name, color: PALETTE[d.projects.length % PALETTE.length] });
  });
}

function deleteProject(store, project) {
  if (!confirm(`Delete project "${project.name}"? Its todos move to Personal.`)) return;
  store.update(COLLECTION, (d) => {
    d.projects = d.projects.filter((p) => p.id !== project.id);
    d.items.forEach((i) => {
      if (i.projectId === project.id) i.projectId = null;
    });
  });
  if (view.filter === project.id) view.filter = 'all';
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

function draw(root, store) {
  const { projects, items } = store.get(COLLECTION);
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

  const visible = items
    .filter((i) => (view.showDone || !i.done) && matchesFilter(i))
    .sort((a, b) => Number(a.done) - Number(b.done) || a.created.localeCompare(b.created));

  root.replaceChildren(
    h('div', { class: 'split' },
      h('aside', { class: 'card side' },
        h('h2', null, 'Lists'),
        navItem('all', 'All', openCount(() => true)),
        navItem('personal', 'Personal', openCount((i) => i.projectId === null)),
        h('h2', null, 'Projects'),
        projects.map((p) =>
          h('div', { class: 'nav-row' },
            navItem(p.id, p.name, openCount((i) => i.projectId === p.id), p.color),
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: `Delete ${p.name}`,
              'aria-label': `Delete project ${p.name}`,
              onclick: () => deleteProject(store, p),
            }, icon('x')))),
        h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            const input = e.currentTarget.querySelector('input[name="name"]');
            const name = input.value.trim();
            if (name) addProject(store, name);
          },
        },
          h('input', { name: 'name', placeholder: 'New project', 'aria-label': 'New project name', autocomplete: 'off' }))),

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
            placeholder: 'Add a todo… use #project to file it',
            'aria-label': 'New todo',
            autocomplete: 'off',
            'data-autofocus': true,
          }),
          h('button', { class: 'primary', type: 'submit' }, 'Add')),

        visible.length
          ? h('ul', { class: 'todo-list' },
              visible.map((item) =>
                h('li', { class: item.done ? 'done' : '' },
                  h('input', {
                    type: 'checkbox',
                    checked: item.done,
                    'aria-label': `Mark "${item.text}" done`,
                    onchange: (e) => toggleItem(store, item.id, e.target.checked),
                  }),
                  h('span', { class: 'grow' }, item.text),
                  view.filter === 'all' && item.projectId
                    ? h('span', { class: 'badge' }, projectName(item.projectId))
                    : null,
                  h('button', {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Delete',
                    'aria-label': `Delete "${item.text}"`,
                    onclick: () => removeItem(store, item.id),
                  }, icon('x')))))
          : h('p', { class: 'empty' }, 'Nothing here yet. Type above and press Enter.'))));
}

export default {
  id: 'todos',
  title: 'Todos',
  icon: 'check-square',
  collection: COLLECTION,
  defaults: { projects: [], items: [] },
  render: draw,
};
