// Settings → Labels: task statuses and categories, project labels and Money categories in one place. Each can be
// recoloured, renamed and reordered (the order is the one every picker shows); deleting one that is in use moves
// what uses it to another label or category first.
import { h, icon, empty, notice, uid, statusOf } from '../ui.js';
import { editText, pill, pickChip, pickButton } from '../inline.js';
import { openDialog } from '../modal.js';
import { colorPicker, SWATCHES } from '../color-picker.js';
import { labelsOf, labelColor, projectIcon } from './projects.js';
import { taskStatuses, statusLook, ALWAYS_SHOWN, categoryLabelIds, withoutLabel } from '../task-labels.js';

/** @import { Store, TaskCategory, ProjectLabel, StatusOverride } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @typedef {DragEvent & { currentTarget: HTMLElement }} RowDrag */

const UNCATEGORIZED = 'Uncategorized';
/** @param {string} a @param {string} b */
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();
/** @param {number} n @param {string} one @param {string} [many] */
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** @param {string[]} parts */
const list = (parts) => (parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] ?? '');

// The last error per section, shown above its list.
const labelsView = { tasks: '', projects: '', money: '' };
// Where a new task category applies, picked beside the add form. Kept here so a re-render does not reset it.
let newTaskCategoryScope = 'all';

// --- Reordering ---

// The row being dragged, and its list, so a row of another list is not a drop target.
/** @type {{ list: string, key: string } | null} */
let drag = null;

// `keys` with `from` moved before or after `to`.
/** @param {string[]} keys @param {string} from @param {string} to @param {boolean} after */
function moveKey(keys, from, to, after) {
  const rest = keys.filter((k) => k !== from);
  const at = rest.indexOf(to);
  if (at < 0 || !keys.includes(from)) return keys;
  rest.splice(after ? at + 1 : at, 0, from);
  return rest;
}

/** @param {RowDrag} e */
const dropAfter = (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  return e.clientY > r.top + r.height / 2;
};
/** @param {HTMLElement} el */
const clearDrop = (el) => el.classList.remove('drop-before', 'drop-after');

// Row props and grip for a reorderable list. `keys` is the list's order; `save(nextKeys)` stores a new one.
// The grip also moves its row with the up and down arrow keys, and keeps focus after the re-render. Settings → Dev
// environment orders its agents with it too.
/** @param {string} list @param {string[]} keys @param {(keys: string[]) => void} save */
export function sortable(list, keys, save) {
  /** @param {string} from @param {string} to @param {boolean} after */
  const move = (from, to, after) => {
    const next = moveKey(keys, from, to, after);
    if (next.some((k, i) => k !== keys[i])) save(next);
  };
  /** @param {string} key */
  const row = (key) => ({
    /** @param {RowDrag} e */
    ondragstart: (e) => {
      drag = { list, key };
      // A drag that starts always carries a dataTransfer.
      /** @type {DataTransfer} */ (e.dataTransfer).effectAllowed = 'move';
      /** @type {DataTransfer} */ (e.dataTransfer).setData('text/plain', key); // Firefox needs data to start a drag
      e.currentTarget.classList.add('dragging');
    },
    /** @param {RowDrag} e */
    ondragend: (e) => {
      drag = null;
      e.currentTarget.draggable = false;
      e.currentTarget.classList.remove('dragging');
    },
    /** @param {RowDrag} e */
    ondragover: (e) => {
      if (drag?.list !== list || drag.key === key) return;
      e.preventDefault();
      const after = dropAfter(e);
      e.currentTarget.classList.toggle('drop-before', !after);
      e.currentTarget.classList.toggle('drop-after', after);
    },
    /** @param {RowDrag} e */
    ondragleave: (e) => clearDrop(e.currentTarget),
    /** @param {RowDrag} e */
    ondrop: (e) => {
      if (drag?.list !== list) return;
      e.preventDefault();
      clearDrop(e.currentTarget);
      move(drag.key, key, dropAfter(e));
      drag = null;
    },
  });
  /** @param {string} key @param {string} name */
  const grip = (key, name) => h('button', {
    type: 'button',
    class: 'grip',
    'data-grip': `${list}:${key}`,
    title: 'Drag to reorder, or press the up and down arrows',
    'aria-label': `Move ${name}`,
    // Only the grip makes the row draggable, so the name field stays editable.
    onpointerdown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => { /** @type {HTMLLIElement} */ (e.currentTarget.closest('li')).draggable = true; },
    onpointerup: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => { /** @type {HTMLLIElement} */ (e.currentTarget.closest('li')).draggable = false; },
    /** @param {KeyboardEvent} e */
    onkeydown: (e) => {
      if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
      e.preventDefault();
      const to = keys[keys.indexOf(key) + (e.key === 'ArrowUp' ? -1 : 1)];
      if (to === undefined) return;
      move(key, to, e.key === 'ArrowDown');
      // The store re-renders on the next frame; this callback runs after it.
      requestAnimationFrame(() => /** @type {HTMLElement | null} */ (document.querySelector(`[data-grip="${CSS.escape(`${list}:${key}`)}"]`))?.focus());
    },
  }, icon('grip'));
  return { row, grip };
}

// A section title with an optional button beside it, such as "Sort A–Z".
/** @param {string} title @param {Child} action */
const sectionHead = (title, action) => h('div', { class: 'row label-head' }, h('h3', null, title), h('span', { class: 'grow' }), action);
/** @param {string} label @param {string} title @param {() => void} onclick */
const sortButton = (label, title, onclick) => h('button', { type: 'button', class: 'btn-small', title, onclick }, label);

// --- Task statuses ---

// Saves one status's override, and drops it once it is back to the defaults so todos.json stays small.
/** @param {Store} store @param {string} key @param {StatusOverride} patch */
function setStatus(store, key, patch) {
  store.update('todos', (d) => {
    const next = { ...(d.statuses?.[key] ?? {}), ...patch };
    for (const k of /** @type {(keyof StatusOverride)[]} */ (Object.keys(next))) if (!next[k]) delete next[k];
    d.statuses = { ...(d.statuses ?? {}) };
    if (Object.keys(next).length) d.statuses[key] = next;
    else delete d.statuses[key];
  });
}

/** @param {Store} store */
function taskStatusesSection(store) {
  const { items, statusOrder } = store.get('todos');
  const statuses = taskStatuses(store);
  const order = sortable('statuses', statuses.map((s) => s.key), (keys) => store.update('todos', (d) => { d.statusOrder = keys; }));
  return h('div', { class: 'svc-section' },
    sectionHead('Task statuses', statusOrder?.length
      ? sortButton('Reset order', 'Put the statuses back in their original order', () => store.update('todos', (d) => { delete d.statusOrder; }))
      : null),
    h('p', { class: 'muted small' }, 'The eight statuses are fixed, so search (is:doing), the board and automations keep working, but each can be renamed, recoloured and dragged into another order; the pickers and the board columns follow it. Clear a name to go back to the original. A hidden status leaves the pickers and the board; tasks already in it keep it.'),
    h('ul', { class: 'label-list' }, statuses.map((st) => {
      const count = items.filter((i) => statusOf(i) === st.key).length;
      const fixed = ALWAYS_SHOWN.includes(st.key);
      return h('li', { class: st.hidden ? 'is-hidden' : '', ...order.row(st.key) },
        order.grip(st.key, st.name),
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
            onchange: (/** @type {{ target: HTMLInputElement }} */ e) => setStatus(store, st.key, { hidden: !e.target.checked }),
          }),
          'In pickers'));
    })));
}

// --- Task categories ---

// Tasks store a category by name, so renaming or deleting one also rewrites the tasks that carry it.
/** @param {Store} store */
const taskCategories = (store) => store.get('todos').categories ?? [];
/** @param {Store} store @param {string} name */
const taskCategoryUse = (store, name) => store.get('todos').items.filter((i) => i.category && sameName(i.category, name)).length;

// Select values: "all", "project:<id>", "category:<project label id>". A label scope can hold several labels;
// the picker sets the first one and the others are added beside it.
/** @param {string} value */
function parseScope(value) {
  if (value.startsWith('project:')) return { scope: 'project', projectId: value.slice(8), projectCategoryIds: [] };
  if (value.startsWith('category:')) return { scope: 'projectCategory', projectId: null, projectCategoryIds: [value.slice(9)] };
  return { scope: 'all', projectId: null, projectCategoryIds: [] };
}
/** @param {TaskCategory} c */
function scopeValue(c) {
  if (c.scope === 'project') return `project:${c.projectId}`;
  if (c.scope === 'projectCategory') return `category:${categoryLabelIds(c)[0]}`;
  return 'all';
}

// Where a category applies. A label scope shows every label as a pill in one field, with a + to add another and
// a chevron to change the scope; any other scope is the plain picker.
/** @param {Store} store @param {TaskCategory} c */
function scopeField(store, c) {
  const ids = categoryLabelIds(c);
  if (!ids.length) return scopePicker(store, scopeValue(c), (v) => editTaskCategory(store, c, parseScope(v)));
  const labels = store.get('projects').categories ?? [];
  /** @param {string[]} next */
  const setIds = (next) => editTaskCategory(store, c, { projectCategoryIds: next });
  const free = labels.filter((l) => !ids.includes(l.id));
  return h('div', { class: 'scope-field' },
    ids.map((id) => {
      const l = labels.find((x) => x.id === id);
      if (!l) return null;
      // The last label stays: a label scope with none would apply to no project.
      return h('span', { class: 'pill tone-custom pill-x', style: { '--c': labelColor(l) } },
        l.name,
        ids.length > 1
          ? h('button', {
              type: 'button',
              class: 'pill-remove',
              'aria-label': `Remove label ${l.name} from ${c.name}`,
              onclick: () => setIds(ids.filter((x) => x !== id)),
            }, icon('x'))
          : null);
    }),
    free.length
      ? pickChip({
          value: null,
          options: free.map((l) => ({ value: l.id, label: l.name, color: labelColor(l) })),
          placeholder: '+ Label',
          className: 'scope-add',
          onPick: (id) => {
            if (id) setIds([...ids, id]);
          },
        })
      : null,
    pickButton({
      label: '',
      title: `Change where ${c.name} applies`,
      className: 'scope-change',
      options: scopeOptions(store),
      onPick: (v) => editTaskCategory(store, c, parseScope(v)),
    }));
}

// Options for the searchable scope picker: every project label in its colour, and every project with its icon.
/** @param {Store} store */
function scopeOptions(store) {
  const { projects, categories } = store.get('projects');
  return [
    { value: 'all', label: 'All projects', plainIcon: () => icon('globe') },
    ...categories.map((c) => ({ value: `category:${c.id}`, label: c.name, color: labelColor(c) })),
    ...[...projects].sort((a, b) => a.name.localeCompare(b.name))
      .map((p) => ({ value: `project:${p.id}`, label: p.name, plainIcon: () => projectIcon(p) })),
  ];
}

/** @param {Store} store @param {string} value @param {(value: string) => void} onPick */
function scopePicker(store, value, onPick) {
  return pickChip({ value, options: scopeOptions(store), placeholder: 'Where it applies', className: 'scope-pick', onPick });
}

// The wider scopes a category can move up to: from one project to one of that project's labels or to all
// projects, and from a label to all projects.
/** @param {Store} store @param {TaskCategory} c */
function promoteTargets(store, c) {
  const options = scopeOptions(store);
  if (c.scope === 'project') {
    const project = store.get('projects').projects.find((p) => p.id === c.projectId);
    const labels = project ? labelsOf(project).map((/** @type {string} */ id) => `category:${id}`) : [];
    // The project's labels come first: they are the next level up, before all projects.
    return [...options.filter((o) => labels.includes(o.value)), ...options.filter((o) => o.value === 'all')];
  }
  if (c.scope === 'projectCategory') return options.filter((o) => o.value === 'all');
  return [];
}

/** @param {Store} store @param {TaskCategory} c */
function promoteControl(store, c) {
  const targets = promoteTargets(store, c);
  if (!targets.length) return null;
  /** @param {string} value */
  const promote = (value) => editTaskCategory(store, c, parseScope(value));
  if (targets.length === 1) {
    const [only] = targets;
    return h('button', {
      type: 'button',
      class: 'btn-small',
      title: `Make ${c.name} apply to ${only.value === 'all' ? 'all projects' : `every ${only.label} project`}`,
      onclick: () => promote(only.value),
    }, icon('arrow-up'), 'Promote');
  }
  return pickButton({ label: 'Promote', title: `Make ${c.name} apply more widely`, options: targets, onPick: promote });
}

/** @param {Store} store @param {string} name @param {string} scope */
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

/** @param {Store} store @param {TaskCategory} cat @param {Partial<TaskCategory>} patch */
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
    // The single-label field of older files gives way to the list.
    if (patch.projectCategoryIds) delete c.projectCategoryId;
    if (!c.projectCategoryIds?.length) delete c.projectCategoryIds;
    if (name !== oldName) for (const i of d.items) if (i.category && sameName(i.category, oldName)) i.category = name;
  });
}

/** @param {Store} store @param {TaskCategory} cat */
function confirmDeleteTaskCategory(store, cat) {
  const count = taskCategoryUse(store, cat.name);
  const others = taskCategories(store).filter((c) => c.id !== cat.id);
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

// Task categories and project labels are both `{ id, name }` objects, saved in the order of `ids`.
/** @template {{ id: string }} T @param {T[]} list @param {string[]} ids */
const byIds = (list, ids) => /** @type {T[]} */ (ids.map((id) => list.find((c) => c.id === id)).filter(Boolean));
/** @param {{ name: string }} a @param {{ name: string }} b */
const byName = (a, b) => a.name.localeCompare(b.name);

/** @param {Store} store */
function taskCategoriesSection(store) {
  const cats = taskCategories(store);
  const order = sortable('task-categories', cats.map((c) => c.id), (ids) => store.update('todos', (d) => { d.categories = byIds(d.categories, ids); }));
  return h('div', { class: 'svc-section' },
    sectionHead('Task categories', cats.length > 1
      ? sortButton('Sort A–Z', 'Put the task categories in alphabetical order', () => store.update('todos', (d) => { d.categories = [...d.categories].sort(byName); }))
      : null),
    h('p', { class: 'muted small' }, 'Categories sort tasks within a project (errands, bugs, ideas…). A general one applies to every project; scope one to a single project, or to every project with one of its labels (add more with + Label). Promote one to widen it, from a project to that project’s label or to all projects. Renaming one renames it on its tasks. Drag the grip to reorder them; the category pickers and filters follow this order.'),
    labelsView.tasks ? notice({ tone: 'error', text: labelsView.tasks }) : null,
    cats.length
      ? h('ul', { class: 'label-list' }, cats.map((c) =>
          h('li', order.row(c.id),
            order.grip(c.id, c.name),
            colorPicker({ value: c.color ?? '', name: c.name, onPick: (color) => editTaskCategory(store, c, { color }), onClear: () => editTaskCategory(store, c, { color: '' }) }),
            editText({ value: c.name, placeholder: 'Name', className: 'label-name', onSave: (name) => editTaskCategory(store, c, { name: name.trim() }) }),
            pill(c.name, { color: c.color }),
            scopeField(store, c),
            promoteControl(store, c),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted small' }, plural(taskCategoryUse(store, c.name), 'task')),
            h('button', { type: 'button', class: 'btn-small danger', 'aria-label': `Delete ${c.name}`, onclick: () => confirmDeleteTaskCategory(store, c) }, icon('x'), 'Delete'))))
      : empty('No task categories yet.'),
    addForm('New task category, e.g. Errands', (name) => addTaskCategory(store, name, newTaskCategoryScope),
      scopePicker(store, newTaskCategoryScope, (v) => {
        newTaskCategoryScope = v;
        store.refresh();
      })));
}

// --- Project labels ---

// What uses a project label: the projects that carry it and the task categories scoped to it.
/** @param {Store} store @param {string} id */
function projectLabelUse(store, id) {
  const projects = store.get('projects').projects.filter((p) => labelsOf(p).includes(id)).length;
  const taskCategories = (store.get('todos').categories ?? []).filter((c) => categoryLabelIds(c).includes(id)).length;
  return { projects, taskCategories, total: projects + taskCategories };
}

/** @param {Store} store @param {string} name */
function addProjectLabel(store, name) {
  const { categories } = store.get('projects');
  if (categories.some((c) => sameName(c.name, name))) {
    labelsView.projects = `"${name}" already exists.`;
    return store.refresh();
  }
  labelsView.projects = '';
  store.update('projects', (d) => d.categories.push({ id: uid(), name, color: SWATCHES[d.categories.length % SWATCHES.length] }));
}

/** @param {Store} store @param {ProjectLabel} label @param {string} name */
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
// without one, the label is removed from its projects and task categories, and a category left with no label goes.
/** @param {Store} store @param {ProjectLabel} label @param {string | null} targetId */
function deleteProjectLabel(store, label, targetId) {
  store.update('projects', (d) => {
    d.categories = d.categories.filter((c) => c.id !== label.id);
    for (const p of d.projects) {
      /** @type {string[]} */
      const own = labelsOf(p);
      if (!own.includes(label.id)) continue;
      p.labels = own.filter((x) => x !== label.id);
      if (targetId && !p.labels.includes(targetId)) p.labels.push(targetId);
    }
  });
  if (Array.isArray(store.get('todos').categories)) {
    store.update('todos', (t) => {
      t.categories = withoutLabel(t.categories, label.id, targetId);
    });
  }
}

/** @param {Store} store @param {ProjectLabel} label */
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

/** @param {Store} store */
function projectLabelsSection(store) {
  const labels = store.get('projects').categories ?? [];
  const order = sortable('project-labels', labels.map((l) => l.id), (ids) => store.update('projects', (d) => { d.categories = byIds(d.categories, ids); }));
  /** @param {string} id @param {string} color */
  const setColor = (id, color) => store.update('projects', (d) => {
    const c = d.categories.find((x) => x.id === id);
    if (c) c.color = color;
  });

  return h('div', { class: 'svc-section' },
    sectionHead('Project labels', labels.length > 1
      ? sortButton('Sort A–Z', 'Put the project labels in alphabetical order', () => store.update('projects', (d) => { d.categories = [...d.categories].sort(byName); }))
      : null),
    h('p', { class: 'muted small' }, 'Labels group projects (Personal, Web, Crypto…). The colour shows on projects, tasks, the project tiles and in the label picker. Drag the grip to reorder them; the label pickers and filters follow this order.'),
    labelsView.projects ? notice({ tone: 'error', text: labelsView.projects }) : null,
    labels.length
      ? h('ul', { class: 'label-list' }, labels.map((l) => {
          const use = projectLabelUse(store, l.id);
          return h('li', order.row(l.id),
            order.grip(l.id, l.name),
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

// Every Money category: the saved list in its order, then any other name an entry or a recurring item uses, A to Z.
/** @param {Store} store */
function moneyCategories(store) {
  const fin = store.get('finance');
  const used = [...fin.entries.map((e) => e.category), ...(fin.recurring ?? []).map((r) => r.category)];
  const extra = [...new Set(used.filter((n) => n && !fin.categories.includes(n)))].sort((a, b) => a.localeCompare(b));
  return [...fin.categories, ...extra];
}

/** @param {Store} store @param {string} name */
function moneyCategoryUse(store, name) {
  const fin = store.get('finance');
  const entries = fin.entries.filter((e) => e.category === name).length;
  const recurring = (fin.recurring ?? []).filter((r) => r.category === name).length;
  const budget = fin.budgets?.[name] ? 1 : 0;
  return { entries, recurring, budget, total: entries + recurring + budget };
}

// Moves everything filed under `from` to `to` and forgets `from`. Used by rename (to a new name) and delete.
// A budget follows unless the target already has one; a colour follows only to a name that has none.
/** @param {Store} store @param {string} from @param {string} to */
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

/** @param {Store} store @param {string} name */
function addMoneyCategory(store, name) {
  if (moneyCategories(store).some((c) => sameName(c, name))) {
    labelsView.money = `"${name}" already exists.`;
    return store.refresh();
  }
  labelsView.money = '';
  store.update('finance', (d) => d.categories.push(name));
}

/** @param {Store} store @param {string} from @param {string} name */
function renameMoneyCategory(store, from, name) {
  if (!name || name === from) return;
  const existing = moneyCategories(store).find((c) => c !== from && sameName(c, name));
  if (existing && !confirm(`"${existing}" already exists. Merge "${from}" into it?`)) return;
  labelsView.money = '';
  moveMoneyCategory(store, from, existing ?? name);
}

/** @param {Store} store @param {string} name */
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

/** @param {Store} store */
function moneyCategoriesSection(store) {
  const names = moneyCategories(store);
  const colors = store.get('finance').categoryColors ?? {};
  /** @param {string} name @param {string} color */
  const setColor = (name, color) => store.update('finance', (d) => {
    d.categoryColors = { ...(d.categoryColors ?? {}), [name]: color };
  });
  /** @param {string} name */
  const clearColor = (name) => store.update('finance', (d) => {
    const next = { ...(d.categoryColors ?? {}) };
    delete next[name];
    d.categoryColors = next;
  });

  // Reordering saves every name shown, so one only an entry used joins the saved list in its new place.
  const order = sortable('money', names, (next) => store.update('finance', (d) => { d.categories = next; }));

  return h('div', { class: 'svc-section' },
    sectionHead('Money categories', names.length > 1
      ? sortButton('Sort A–Z', 'Put the Money categories in alphabetical order', () => store.update('finance', (d) => { d.categories = [...names].sort((a, b) => a.localeCompare(b)); }))
      : null),
    h('p', { class: 'muted small' }, 'Categories file Money entries, recurring items and budgets. The colour shows on the category wherever it appears, and in the category breakdown. Drag the grip to reorder them; the category pickers follow this order.'),
    labelsView.money ? notice({ tone: 'error', text: labelsView.money }) : null,
    names.length
      ? h('ul', { class: 'label-list' }, names.map((name) => {
          const use = moneyCategoryUse(store, name);
          return h('li', order.row(name),
            order.grip(name, name),
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
/** @param {string} placeholder @param {(name: string, form: HTMLFormElement) => void} onAdd @param {Child} [extra] */
function addForm(placeholder, onAdd, extra = null) {
  return h('form', {
    class: 'row label-add',
    /** @param {SubmitEvent & { currentTarget: HTMLFormElement & { elements: { name: HTMLInputElement } } }} e */
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
/** @param {{ title: string, text: string, target: HTMLSelectElement | null, onDelete: () => void }} options */
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

/** @param {Store} store */
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
