// Settings → Labels: task statuses and categories, project labels and Money categories in one place. Each can be
// recoloured and renamed; deleting one that is in use moves what uses it to another label or category first.
import { h, icon, empty, notice, uid, statusOf } from '../ui.js';
import { editText, pill } from '../inline.js';
import { openDialog } from '../modal.js';
import { colorPicker, SWATCHES } from '../color-picker.js';
import { labelsOf, labelColor } from './projects.js';
import { taskStatuses, statusLook, ALWAYS_SHOWN } from '../task-labels.js';

const UNCATEGORIZED = 'Uncategorized';
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const list = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '');

// The last error per section, shown above its list.
const labelsView = { tasks: '', projects: '', money: '' };

// --- Task statuses ---

// Saves one status's override, and drops it once it is back to the defaults so todos.json stays small.
function setStatus(store, key, patch) {
  store.update('todos', (d) => {
    const next = { ...(d.statuses?.[key] ?? {}), ...patch };
    for (const k of Object.keys(next)) if (!next[k]) delete next[k];
    d.statuses = { ...(d.statuses ?? {}) };
    if (Object.keys(next).length) d.statuses[key] = next;
    else delete d.statuses[key];
  });
}

function taskStatusesSection(store) {
  const items = store.get('todos').items;
  return h('div', { class: 'svc-section' },
    h('h3', null, 'Task statuses'),
    h('p', { class: 'muted small' }, 'The seven statuses are fixed, so search (is:doing), the board and automations keep working, but each can be renamed and recoloured. Clear a name to go back to the original. A hidden status leaves the pickers and the board; tasks already in it keep it.'),
    h('ul', { class: 'label-list' }, taskStatuses(store).map((st) => {
      const count = items.filter((i) => statusOf(i) === st.key).length;
      const fixed = ALWAYS_SHOWN.includes(st.key);
      return h('li', { class: st.hidden ? 'is-hidden' : '' },
        colorPicker({ value: st.color, name: st.name, onPick: (color) => setStatus(store, st.key, { color }), onClear: () => setStatus(store, st.key, { color: '' }) }),
        editText({
          value: st.name === st.defaultName ? '' : st.name,
          placeholder: st.defaultName,
          className: 'label-name',
          allowEmpty: true,
          onSave: (name) => setStatus(store, st.key, { name: name.trim() === st.defaultName ? '' : name.trim() }),
        }),
        pill(st.name, statusLook(st)),
        h('span', { class: 'grow' }),
        h('span', { class: 'muted small' }, plural(count, 'task')),
        h('label', { class: 'row check small', title: fixed ? 'New tasks start here, or the done button moves them here' : '' },
          h('input', {
            type: 'checkbox',
            checked: !st.hidden,
            disabled: fixed,
            'aria-label': `Offer ${st.name} in pickers`,
            onchange: (e) => setStatus(store, st.key, { hidden: !e.target.checked }),
          }),
          'In pickers'));
    })));
}

// --- Task categories ---

// Tasks store a category by name, so renaming or deleting one also rewrites the tasks that carry it.
const taskCategories = (store) => store.get('todos').categories ?? [];
const taskCategoryUse = (store, name) => store.get('todos').items.filter((i) => i.category && sameName(i.category, name)).length;

// Select values: "all", "project:<id>", "category:<project label id>".
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

function scopeOptions(store) {
  const { projects, categories } = store.get('projects');
  return [
    h('option', { value: 'all' }, 'All projects'),
    projects.length
      ? h('optgroup', { label: 'One project' },
          [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => h('option', { value: `project:${p.id}` }, p.name)))
      : null,
    categories.length
      ? h('optgroup', { label: 'Projects with a label' }, categories.map((c) => h('option', { value: `category:${c.id}` }, c.name)))
      : null,
  ];
}

function addTaskCategory(store, name, scope) {
  if (taskCategories(store).some((c) => sameName(c.name, name))) {
    labelsView.tasks = `"${name}" already exists.`;
    return store.refresh();
  }
  labelsView.tasks = '';
  store.update('todos', (d) => {
    d.categories = [...(d.categories ?? []), { id: uid(), name, ...parseScope(scope) }];
  });
}

function editTaskCategory(store, cat, patch) {
  const name = patch.name ?? cat.name;
  if (!name) return;
  if (taskCategories(store).some((c) => c.id !== cat.id && sameName(c.name, name))) {
    labelsView.tasks = `"${name}" already exists. Delete "${cat.name}" and move its tasks there to merge them.`;
    return store.refresh();
  }
  labelsView.tasks = '';
  // `cat` may be the stored object itself, so its old name is read before the patch changes it.
  const oldName = cat.name;
  store.update('todos', (d) => {
    const c = d.categories.find((x) => x.id === cat.id);
    if (!c) return;
    Object.assign(c, patch);
    if (!c.color) delete c.color;
    if (name !== oldName) for (const i of d.items) if (i.category && sameName(i.category, oldName)) i.category = name;
  });
}

function confirmDeleteTaskCategory(store, cat) {
  const count = taskCategoryUse(store, cat.name);
  const others = taskCategories(store).filter((c) => c.id !== cat.id).sort((a, b) => a.name.localeCompare(b.name));
  const target = h('select', { 'aria-label': 'Move to' },
    h('option', { value: '' }, 'No category'),
    others.map((c) => h('option', { value: c.name }, c.name)));
  deleteDialog({
    title: `Delete “${cat.name}”`,
    text: count
      ? `${plural(count, 'task')} ${count === 1 ? 'uses' : 'use'} this category. ${count === 1 ? 'It moves' : 'They move'} to the category you pick.`
      : 'No task uses this category.',
    target: count ? target : null,
    onDelete: () => store.update('todos', (d) => {
      d.categories = d.categories.filter((c) => c.id !== cat.id);
      for (const i of d.items) if (i.category && sameName(i.category, cat.name)) i.category = target.value;
    }),
  });
}

function taskCategoriesSection(store) {
  const cats = [...taskCategories(store)].sort((a, b) => a.name.localeCompare(b.name));
  const scopeSelect = (attrs) => h('select', attrs, scopeOptions(store));
  return h('div', { class: 'svc-section' },
    h('h3', null, 'Task categories'),
    h('p', { class: 'muted small' }, 'Categories sort tasks within a project (errands, bugs, ideas…). A general one applies to every project; scope one to a single project, or to every project with a label. Renaming one renames it on its tasks.'),
    labelsView.tasks ? notice({ tone: 'error', text: labelsView.tasks }) : null,
    cats.length
      ? h('ul', { class: 'label-list' }, cats.map((c) =>
          h('li', null,
            colorPicker({ value: c.color ?? '', name: c.name, onPick: (color) => editTaskCategory(store, c, { color }), onClear: () => editTaskCategory(store, c, { color: '' }) }),
            editText({ value: c.name, placeholder: 'Name', className: 'label-name', onSave: (name) => editTaskCategory(store, c, { name: name.trim() }) }),
            pill(c.name, { color: c.color }),
            scopeSelect({ value: scopeValue(c), 'aria-label': `Where ${c.name} applies`, onchange: (e) => editTaskCategory(store, c, parseScope(e.target.value)) }),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted small' }, plural(taskCategoryUse(store, c.name), 'task')),
            h('button', { type: 'button', class: 'btn-small danger', 'aria-label': `Delete ${c.name}`, onclick: () => confirmDeleteTaskCategory(store, c) }, icon('x'), 'Delete'))))
      : empty('No task categories yet.'),
    addForm('New task category, e.g. Errands', (name, form) => addTaskCategory(store, name, form.elements.scope.value),
      scopeSelect({ name: 'scope', 'aria-label': 'Where it applies' })));
}

// --- Project labels ---

// What uses a project label: the projects that carry it and the task categories scoped to it.
function projectLabelUse(store, id) {
  const projects = store.get('projects').projects.filter((p) => labelsOf(p).includes(id)).length;
  const taskCategories = (store.get('todos').categories ?? []).filter((c) => c.scope === 'projectCategory' && c.projectCategoryId === id).length;
  return { projects, taskCategories, total: projects + taskCategories };
}

function addProjectLabel(store, name) {
  const { categories } = store.get('projects');
  if (categories.some((c) => sameName(c.name, name))) {
    labelsView.projects = `"${name}" already exists.`;
    return store.refresh();
  }
  labelsView.projects = '';
  store.update('projects', (d) => d.categories.push({ id: uid(), name, color: SWATCHES[d.categories.length % SWATCHES.length] }));
}

function renameProjectLabel(store, label, name) {
  if (!name || name === label.name) return;
  if (store.get('projects').categories.some((c) => c.id !== label.id && sameName(c.name, name))) {
    labelsView.projects = `"${name}" already exists. Delete "${label.name}" and move its projects there to merge them.`;
    return store.refresh();
  }
  labelsView.projects = '';
  store.update('projects', (d) => {
    const c = d.categories.find((x) => x.id === label.id);
    if (c) c.name = name;
  });
}

// Deletes a label. With a target, its projects get the target label and its scoped task categories follow it;
// without one, the label is only removed from its projects and the task categories scoped to it go too.
function deleteProjectLabel(store, label, targetId) {
  store.update('projects', (d) => {
    d.categories = d.categories.filter((c) => c.id !== label.id);
    for (const p of d.projects) {
      const own = labelsOf(p);
      if (!own.includes(label.id)) continue;
      p.labels = own.filter((x) => x !== label.id);
      if (targetId && !p.labels.includes(targetId)) p.labels.push(targetId);
    }
  });
  if (Array.isArray(store.get('todos').categories)) {
    store.update('todos', (t) => {
      if (targetId) {
        for (const c of t.categories) if (c.scope === 'projectCategory' && c.projectCategoryId === label.id) c.projectCategoryId = targetId;
      } else {
        t.categories = t.categories.filter((c) => !(c.scope === 'projectCategory' && c.projectCategoryId === label.id));
      }
    });
  }
}

function confirmDeleteProjectLabel(store, label) {
  const use = projectLabelUse(store, label.id);
  const others = store.get('projects').categories.filter((c) => c.id !== label.id);
  const parts = [use.projects ? plural(use.projects, 'project') : '', use.taskCategories ? plural(use.taskCategories, 'task category', 'task categories') : ''].filter(Boolean);
  const target = h('select', { 'aria-label': 'Move to' },
    h('option', { value: '' }, 'No label (remove it from them)'),
    others.map((c) => h('option', { value: c.id }, c.name)));
  deleteDialog({
    title: `Delete “${label.name}”`,
    text: use.total
      ? `${list(parts)} ${use.total === 1 ? 'uses' : 'use'} this label. Move ${use.total === 1 ? 'it' : 'them'} to another label first, or remove the label from ${use.total === 1 ? 'it' : 'them'}.`
      : 'Nothing uses this label.',
    target: use.total && others.length ? target : null,
    onDelete: () => deleteProjectLabel(store, label, target.value || null),
  });
}

function projectLabelsSection(store) {
  const labels = [...(store.get('projects').categories ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const setColor = (id, color) => store.update('projects', (d) => {
    const c = d.categories.find((x) => x.id === id);
    if (c) c.color = color;
  });

  return h('div', { class: 'svc-section' },
    h('h3', null, 'Project labels'),
    h('p', { class: 'muted small' }, 'Labels group projects (Personal, Web, Crypto…). The colour shows on projects, tasks, the project tiles and in the label picker.'),
    labelsView.projects ? notice({ tone: 'error', text: labelsView.projects }) : null,
    labels.length
      ? h('ul', { class: 'label-list' }, labels.map((l) => {
          const use = projectLabelUse(store, l.id);
          return h('li', null,
            colorPicker({ value: labelColor(l), name: l.name, onPick: (c) => setColor(l.id, c) }),
            editText({ value: l.name, placeholder: 'Name', className: 'label-name', onSave: (name) => renameProjectLabel(store, l, name.trim()) }),
            pill(l.name, { color: labelColor(l) }),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted small' }, plural(use.projects, 'project')),
            h('button', { type: 'button', class: 'btn-small danger', 'aria-label': `Delete ${l.name}`, onclick: () => confirmDeleteProjectLabel(store, l) }, icon('x'), 'Delete'));
        }))
      : empty('No project labels yet.'),
    addForm('New project label, e.g. Health', (name) => addProjectLabel(store, name)));
}

// --- Money categories ---

// Every Money category: the saved list plus any name an entry or a recurring item uses.
function moneyCategories(store) {
  const fin = store.get('finance');
  const names = [...fin.categories, ...fin.entries.map((e) => e.category), ...(fin.recurring ?? []).map((r) => r.category)].filter(Boolean);
  const out = [];
  for (const n of names) if (!out.some((x) => x === n)) out.push(n);
  return out.sort((a, b) => a.localeCompare(b));
}

function moneyCategoryUse(store, name) {
  const fin = store.get('finance');
  const entries = fin.entries.filter((e) => e.category === name).length;
  const recurring = (fin.recurring ?? []).filter((r) => r.category === name).length;
  const budget = fin.budgets?.[name] ? 1 : 0;
  return { entries, recurring, budget, total: entries + recurring + budget };
}

// Moves everything filed under `from` to `to` and forgets `from`. Used by rename (to a new name) and delete.
// A budget follows unless the target already has one; a colour follows only to a name that has none.
function moveMoneyCategory(store, from, to) {
  store.update('finance', (d) => {
    for (const e of d.entries) if (e.category === from) e.category = to;
    for (const r of d.recurring ?? []) if (r.category === from) r.category = to;
    d.budgets = { ...(d.budgets ?? {}) };
    if (to && d.budgets[from] && !d.budgets[to]) d.budgets[to] = d.budgets[from];
    delete d.budgets[from];
    d.categoryColors = { ...(d.categoryColors ?? {}) };
    if (d.categoryColors[from] && !d.categoryColors[to] && to !== UNCATEGORIZED) d.categoryColors[to] = d.categoryColors[from];
    delete d.categoryColors[from];
    d.categories = d.categories.filter((c) => c !== from);
    if (to && !d.categories.some((c) => sameName(c, to))) d.categories.push(to);
  });
}

function addMoneyCategory(store, name) {
  if (moneyCategories(store).some((c) => sameName(c, name))) {
    labelsView.money = `"${name}" already exists.`;
    return store.refresh();
  }
  labelsView.money = '';
  store.update('finance', (d) => d.categories.push(name));
}

function renameMoneyCategory(store, from, name) {
  if (!name || name === from) return;
  const existing = moneyCategories(store).find((c) => c !== from && sameName(c, name));
  if (existing && !confirm(`"${existing}" already exists. Merge "${from}" into it?`)) return;
  labelsView.money = '';
  moveMoneyCategory(store, from, existing ?? name);
}

function confirmDeleteMoneyCategory(store, name) {
  const use = moneyCategoryUse(store, name);
  const others = moneyCategories(store).filter((c) => c !== name && c !== UNCATEGORIZED);
  const parts = [
    use.entries ? plural(use.entries, 'entry', 'entries') : '',
    use.recurring ? plural(use.recurring, 'recurring item') : '',
    use.budget ? 'a budget' : '',
  ].filter(Boolean);
  const target = h('select', { 'aria-label': 'Move to' },
    h('option', { value: UNCATEGORIZED }, UNCATEGORIZED),
    others.map((c) => h('option', { value: c }, c)));
  const inUse = use.entries + use.recurring;
  deleteDialog({
    title: `Delete “${name}”`,
    text: inUse
      ? `${list(parts)} ${use.total === 1 ? 'uses' : 'use'} this category. ${inUse === 1 ? 'It moves' : 'They move'} to the category you pick${use.budget ? ', and the budget goes with them unless that category has one' : ''}.`
      : use.budget ? 'Only a budget uses this category. It is deleted with it.' : 'No entry uses this category.',
    target: inUse ? target : null,
    onDelete: () => (inUse ? moveMoneyCategory(store, name, target.value) : moveMoneyCategory(store, name, '')),
  });
}

function moneyCategoriesSection(store) {
  const names = moneyCategories(store);
  const colors = store.get('finance').categoryColors ?? {};
  const setColor = (name, color) => store.update('finance', (d) => {
    d.categoryColors = { ...(d.categoryColors ?? {}), [name]: color };
  });
  const clearColor = (name) => store.update('finance', (d) => {
    const next = { ...(d.categoryColors ?? {}) };
    delete next[name];
    d.categoryColors = next;
  });

  return h('div', { class: 'svc-section' },
    h('h3', null, 'Money categories'),
    h('p', { class: 'muted small' }, 'Categories file Money entries, recurring items and budgets. The colour shows on the category wherever it appears, and in the category breakdown.'),
    labelsView.money ? notice({ tone: 'error', text: labelsView.money }) : null,
    names.length
      ? h('ul', { class: 'label-list' }, names.map((name) => {
          const use = moneyCategoryUse(store, name);
          return h('li', null,
            colorPicker({ value: colors[name] ?? '', name, onPick: (c) => setColor(name, c), onClear: () => clearColor(name) }),
            editText({ value: name, placeholder: 'Name', className: 'label-name', onSave: (next) => renameMoneyCategory(store, name, next.trim()) }),
            pill(name, { color: colors[name] }),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted small' }, plural(use.entries, 'entry', 'entries')),
            h('button', { type: 'button', class: 'btn-small danger', 'aria-label': `Delete ${name}`, onclick: () => confirmDeleteMoneyCategory(store, name) }, icon('x'), 'Delete'));
        }))
      : empty('No categories yet. They appear here once an entry uses one.'),
    addForm('New Money category, e.g. Travel', (name) => addMoneyCategory(store, name)));
}

// --- Shared pieces ---

// `extra` is any other field the form needs, such as a task category's scope; onAdd gets the form to read it.
function addForm(placeholder, onAdd, extra = null) {
  return h('form', {
    class: 'row label-add',
    onsubmit: (e) => {
      e.preventDefault();
      const input = e.currentTarget.elements.name;
      const name = input.value.trim();
      if (name) onAdd(name, e.currentTarget);
    },
  },
    h('input', { name: 'name', placeholder, 'aria-label': placeholder, class: 'grow', autocomplete: 'off' }),
    extra,
    h('button', { class: 'primary', type: 'submit' }, icon('plus'), 'Add'));
}

// A small dialog: what uses the item, where to move it, and Delete.
function deleteDialog({ title, text, target, onDelete }) {
  const dialog = openDialog({
    title,
    body: h('div', { class: 'stack' },
      h('p', null, text),
      target ? h('label', { class: 'stack' }, h('span', { class: 'muted small' }, 'Move to'), target) : null,
      h('div', { class: 'row end' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            dialog.close();
            onDelete();
          },
        }, icon('x'), 'Delete'))),
  });
}

export function labelsCard(store) {
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Labels'),
        h('p', { class: 'muted' }, 'Every label and category the board uses, by section. Click a name to rename it, the swatch to change its colour. Deleting one that is in use moves what uses it first.'))),
    taskStatusesSection(store),
    taskCategoriesSection(store),
    projectLabelsSection(store),
    moneyCategoriesSection(store));
}
