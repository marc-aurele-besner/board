import { h, uid, now, todayISO, empty } from '../ui.js';

const COLLECTION = 'recipes';
const STATUSES = [
  ['idea', 'Ideas'],
  ['testing', 'Testing'],
  ['final', 'Final'],
];

// View state: which status tab, search text, and the open recipe.
const view = { tab: 'testing', query: '', selectedId: null };

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const splitTags = (text) => [...new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
const formValues = (form) => Object.fromEntries(new FormData(form));
const findRecipe = (d, id) => d.recipes.find((r) => r.id === id);

const averageRating = (versions) => {
  const rated = versions.map((v) => v.rating).filter(Number.isFinite);
  return rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
};
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));

function addRecipe(store, v) {
  const title = v.title.trim();
  if (!title) return;
  const id = uid();
  view.selectedId = id;
  store.update(COLLECTION, (d) =>
    d.recipes.push({
      id,
      title,
      status: STATUSES.some(([key]) => key === v.status) ? v.status : view.tab,
      tags: splitTags(v.tags),
      ingredients: [],
      steps: [],
      notes: '',
      versions: [],
      created: now(),
    }));
}

function saveRecipe(store, id, v) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (!r) return;
    r.title = v.title.trim() || r.title;
    r.status = v.status;
    r.tags = splitTags(v.tags);
    r.ingredients = splitLines(v.ingredients);
    r.steps = splitLines(v.steps);
    r.notes = v.notes;
  });
  view.tab = v.status;
}

function logIteration(store, id, v) {
  const changes = v.changes.trim();
  const notes = v.notes.trim();
  if (!changes && !notes) return;
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (!r) return;
    r.versions.push({
      id: uid(),
      date: v.date || todayISO(),
      changes,
      rating: Number(v.rating) || null,
      notes,
    });
    if (r.status === 'idea') r.status = 'testing';
  });
}

function setStatus(store, id, status) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) r.status = status;
  });
  view.tab = status;
}

function deleteRecipe(store, id) {
  if (!confirm('Delete this recipe and its iteration history?')) return;
  view.selectedId = null;
  store.update(COLLECTION, (d) => {
    d.recipes = d.recipes.filter((r) => r.id !== id);
  });
}

function recipeList(store, recipes, onSelect) {
  const q = view.query.trim().toLowerCase();
  const shown = recipes
    .filter((r) => r.status === view.tab)
    .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)))
    .sort((a, b) => a.title.localeCompare(b.title));
  if (!shown.length) return empty(q ? 'No matches.' : 'Nothing in this list yet.');
  return h('ul', { class: 'recipe-list' },
    shown.map((r) => {
      const avg = averageRating(r.versions);
      return h('li', {
        class: r.id === view.selectedId ? 'recipe-item active' : 'recipe-item',
        onclick: () => onSelect(r.id),
      },
        h('div', { class: 'grow' },
          h('strong', null, r.title),
          r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null),
        h('div', { class: 'meta' },
          avg !== null ? h('span', { title: `Average of ${r.versions.length} tries` }, stars(avg)) : null,
          h('span', null, `${r.versions.length} tries`)));
    }));
}

function recipeDetail(store, r) {
  const versions = [...r.versions].reverse();
  return h('div', { class: 'stack-lg' },
    h('div', { class: 'row between' },
      h('h2', null, r.title),
      h('div', { class: 'row' },
        r.status !== 'final'
          ? h('button', { type: 'button', class: 'primary', onclick: () => setStatus(store, r.id, 'final') }, 'Promote to final')
          : null,
        h('button', { type: 'button', class: 'danger', onclick: () => deleteRecipe(store, r.id) }, 'Delete'))),

    h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        saveRecipe(store, r.id, formValues(e.currentTarget));
      },
    },
      h('details', { open: r.ingredients.length === 0 && r.steps.length === 0 },
        h('summary', null, 'Recipe'),
        h('label', null, 'Title', h('input', { name: 'title', value: r.title, required: true })),
        h('div', { class: 'row' },
          h('label', { class: 'grow' }, 'Status',
            h('select', { name: 'status', value: r.status },
              STATUSES.map(([key, label]) => h('option', { value: key }, label)))),
          h('label', { class: 'grow' }, 'Tags (comma separated)',
            h('input', { name: 'tags', value: r.tags.join(', ') }))),
        h('label', null, 'Ingredients (one per line)',
          h('textarea', { name: 'ingredients', rows: 6 }, r.ingredients.join('\n'))),
        h('label', null, 'Steps (one per line)',
          h('textarea', { name: 'steps', rows: 6 }, r.steps.join('\n'))),
        h('label', null, 'Notes',
          h('textarea', { name: 'notes', rows: 3 }, r.notes))),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Save recipe'))),

    h('section', { class: 'stack' },
      h('h3', null, 'Log an iteration'),
      h('form', {
        class: 'stack card-inset',
        onsubmit: (e) => {
          e.preventDefault();
          logIteration(store, r.id, formValues(e.currentTarget));
        },
      },
        h('div', { class: 'row' },
          h('label', { class: 'grow' }, 'Date', h('input', { type: 'date', name: 'date', value: todayISO() })),
          h('label', { class: 'grow' }, 'Rating',
            h('select', { name: 'rating' },
              h('option', { value: '' }, '—'),
              [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${n} ★`))))),
        h('label', null, 'What did you change?',
          h('textarea', { name: 'changes', rows: 2, placeholder: 'e.g. 20% less sugar, rested dough 2h' })),
        h('label', null, 'Result notes',
          h('input', { name: 'notes', placeholder: 'Texture, timing, what to try next' })),
        h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Log iteration'))),
      versions.length
        ? h('ol', { class: 'versions' },
            versions.map((v) =>
              h('li', null,
                h('div', { class: 'meta' },
                  h('span', null, v.date),
                  v.rating ? h('span', null, stars(v.rating)) : null),
                v.changes ? h('p', null, v.changes) : null,
                v.notes ? h('p', { class: 'muted' }, v.notes) : null)))
        : empty('No iterations yet.')));
}

function draw(root, store) {
  const { recipes } = store.get(COLLECTION);
  const selected = recipes.find((r) => r.id === view.selectedId) ?? null;
  if (!selected) view.selectedId = null;

  const list = h('div', { class: 'recipe-list-wrap' });
  const renderList = () => list.replaceChildren(recipeList(store, recipes, (id) => {
    view.selectedId = id;
    store.refresh();
  }));
  renderList();

  root.replaceChildren(
    h('div', { class: 'split kitchen' },
      h('section', { class: 'card side-pane' },
        h('div', { class: 'segmented' },
          STATUSES.map(([key, label]) =>
            h('button', {
              type: 'button',
              class: key === view.tab ? 'seg active' : 'seg',
              onclick: () => {
                view.tab = key;
                store.refresh();
              },
            }, `${label} (${recipes.filter((r) => r.status === key).length})`))),
        h('input', {
          type: 'search',
          placeholder: 'Search title or tag',
          'aria-label': 'Search recipes',
          value: view.query,
          // Update only the list here so the search box keeps focus while typing.
          oninput: (e) => {
            view.query = e.target.value;
            renderList();
          },
        }),
        list,
        h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            addRecipe(store, formValues(e.currentTarget));
          },
        },
          h('h3', null, 'New recipe'),
          h('input', { name: 'title', placeholder: 'Recipe name', 'aria-label': 'New recipe name', autocomplete: 'off', 'data-autofocus': true }),
          h('input', { name: 'tags', placeholder: 'Tags, comma separated', 'aria-label': 'Tags', autocomplete: 'off' }),
          h('div', { class: 'row' },
            h('select', { name: 'status', 'aria-label': 'Status', value: view.tab },
              STATUSES.map(([key, label]) => h('option', { value: key }, label))),
            h('button', { class: 'primary', type: 'submit' }, 'Add')))),

      h('section', { class: 'card main-pane' },
        selected
          ? recipeDetail(store, selected)
          : empty('Pick a recipe on the left, or add a new one.'))));
}

export default {
  id: 'kitchen',
  title: 'Kitchen',
  icon: 'chef-hat',
  collection: COLLECTION,
  defaults: { recipes: [] },
  render: draw,
};
