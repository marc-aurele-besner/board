import { h, uid, now, todayISO, empty, icon, notice } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';

const COLLECTION = 'recipes';
const STATUSES = [
  ['idea', 'Ideas'],
  ['testing', 'Testing'],
  ['final', 'Final'],
];
const STATUS_TONE = { idea: 'todo', testing: 'doing', final: 'done' };

// View state: status tab, search text, the open recipe, and whether the "New" and "Log" forms are open.
const view = { tab: 'testing', query: '', selectedId: null, adding: false, logOpen: false };

const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
const splitTags = (text) => [...new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
const formValues = (form) => Object.fromEntries(new FormData(form));
const findRecipe = (d, id) => d.recipes.find((r) => r.id === id);

const averageRating = (versions) => {
  const rated = versions.map((v) => v.rating).filter(Number.isFinite);
  return rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
};
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
const lastActivity = (r) => r.versions.reduce((latest, v) => (v.date > latest ? v.date : latest), r.created.slice(0, 10));
const attempts = (r) => `${r.versions.length} ${r.versions.length === 1 ? 'try' : 'tries'}`;

// Every change goes through one of these, so the store saves and re-renders.
function updateRecipe(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) Object.assign(r, patch);
  });
}

function addRecipe(store, title, status) {
  const id = uid();
  view.selectedId = id;
  view.tab = status;
  view.adding = false;
  store.update(COLLECTION, (d) =>
    d.recipes.push({ id, title, status, tags: [], ingredients: [], steps: [], notes: '', versions: [], created: now() }));
}

function deleteRecipe(store, id) {
  if (!confirm('Delete this recipe and its iteration history?')) return;
  view.selectedId = null;
  store.update(COLLECTION, (d) => {
    d.recipes = d.recipes.filter((r) => r.id !== id);
  });
}

function logIteration(store, id, v) {
  const changes = v.changes.trim();
  const notes = v.notes.trim();
  if (!changes && !notes) return;
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (!r) return;
    r.versions.push({ id: uid(), date: v.date || todayISO(), changes, rating: Number(v.rating) || null, notes });
    if (r.status === 'idea') r.status = 'testing';
  });
  view.logOpen = false;
}

function removeVersion(store, id, versionId) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) r.versions = r.versions.filter((v) => v.id !== versionId);
  });
}

// --- Suggest variations (task 4) ---

const ideas = { recipeId: null, status: 'idle', text: '' };

async function runIdeas(store, r) {
  ideas.recipeId = r.id;
  ideas.status = 'loading';
  store.refresh();
  try {
    ideas.text = (await ask(store, 'task-recipe', [
      {
        role: 'system',
        content: 'You help a home cook improve a recipe. Given the recipe and its past attempts as JSON, suggest three concrete variations to test next. For each, give the change and a one-line reason. Plain text, concise.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          title: r.title,
          ingredients: r.ingredients,
          steps: r.steps,
          notes: r.notes,
          attempts: r.versions.map((v) => ({ date: v.date, changes: v.changes, rating: v.rating, notes: v.notes })),
        }),
      },
    ])).trim();
    ideas.status = 'ok';
  } catch (err) {
    ideas.status = 'error';
    ideas.text = err.message;
  }
  store.refresh();
}

function ideasBlock(r) {
  if (ideas.recipeId !== r.id || ideas.status === 'idle') return null;
  if (ideas.status === 'loading') return h('p', { class: 'muted small' }, 'Thinking about variations…');
  if (ideas.status === 'error') return notice({ text: ideas.text });
  return h('div', { class: 'card-inset k-ideas' }, h('pre', { class: 'ai-text' }, ideas.text));
}

// --- Import a recipe from a web page ---

// The page is read through a reader service that returns its text with CORS, since most recipe sites cannot be read directly.
const READER = 'https://r.jina.ai/';
const importState = { status: 'idle', error: '', url: '', pasting: false };

async function fetchPageText(url) {
  const res = await fetch(READER + url, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`The page could not be read (${res.status}). Some sites do not allow it.`);
  return res.text();
}

// Adds a recipe as an idea, with its source link. Its fields come from the model's reading of the page.
function addImportedRecipe(store, data, url) {
  const id = uid();
  view.selectedId = id;
  view.tab = 'idea';
  store.update(COLLECTION, (d) =>
    d.recipes.push({
      id,
      title: String(data.title ?? '').trim() || 'Imported recipe',
      status: 'idea',
      tags: [...new Set((data.tags ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))],
      ingredients: (data.ingredients ?? []).map((x) => String(x).trim()).filter(Boolean),
      steps: (data.steps ?? []).map((x) => String(x).trim()).filter(Boolean),
      notes: String(data.notes ?? '').trim(),
      source: url,
      versions: [],
      created: now(),
    }));
}

// Turns the page text into a recipe with the model, then adds it.
async function importFromText(store, text, url) {
  importState.status = 'loading';
  store.refresh();
  try {
    const reply = await ask(store, 'task-recipe', [
      {
        role: 'system',
        content: 'You extract a recipe from web page text. Reply with JSON only: {"title": string, "tags": string[], "ingredients": string[], "steps": string[], "notes": string}. Ingredients one per item, with quantities. Steps in order. Tags: a few short words such as cuisine or kind of dish. Notes: a short summary of anything special (serves, time, tips). Leave out page menus, ads and comments.',
      },
      { role: 'user', content: text.slice(0, 40000) },
    ]);
    addImportedRecipe(store, parseJson(reply), url);
    importState.status = 'idle';
    importState.pasting = false;
    importState.url = '';
  } catch (err) {
    importState.status = 'error';
    importState.error = err.message;
  }
  store.refresh();
}

async function importFromUrl(store, url) {
  importState.url = url;
  importState.status = 'loading';
  importState.pasting = false;
  store.refresh();
  try {
    const text = await fetchPageText(url);
    if (text.trim().length < 300) throw new Error('The page had too little text to read a recipe.');
    await importFromText(store, text, url);
  } catch (err) {
    importState.status = 'error';
    importState.error = `${err.message} You can paste the recipe text instead.`;
    importState.pasting = true;
    store.refresh();
  }
}

// The import box at the top of the recipe list: a link, or pasted text when the page cannot be read.
function importBlock(store) {
  const s = importState;
  return h('div', { class: 'k-import stack' },
    h('form', {
      class: 'k-import-form',
      onsubmit: (e) => {
        e.preventDefault();
        const url = String(new FormData(e.currentTarget).get('url') ?? '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) {
          s.status = 'error';
          s.error = 'Enter a full link that starts with https://';
          return store.refresh();
        }
        importFromUrl(store, url);
      },
    },
      h('input', { name: 'url', type: 'url', placeholder: 'Import a recipe from a link', 'aria-label': 'Recipe link', inputmode: 'url', autocomplete: 'off' }),
      h('button', { class: 'btn-small primary', type: 'submit', disabled: s.status === 'loading' }, s.status === 'loading' ? 'Reading…' : 'Import')),
    hasOpenRouter(store) ? null : setupBanner('openrouter', 'Importing a recipe needs an OpenRouter key.'),
    s.status === 'error' ? notice({ text: s.error }) : null,
    s.pasting
      ? h('form', {
          class: 'stack',
          onsubmit: (e) => {
            e.preventDefault();
            importFromText(store, String(new FormData(e.currentTarget).get('text') ?? ''), s.url);
          },
        },
          h('p', { class: 'muted small' }, 'Copy the recipe text from the page and paste it here.'),
          h('textarea', { name: 'text', rows: 5, 'aria-label': 'Recipe text' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn-small primary', type: 'submit' }, 'Import text')))
      : null);
}

// --- List ---

function recipeCards(store, recipes) {
  const q = view.query.trim().toLowerCase();
  const shown = recipes
    .filter((r) => r.status === view.tab)
    .filter((r) => !q || r.title.toLowerCase().includes(q) || r.tags.some((t) => t.includes(q)))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  if (!shown.length) return empty(q ? 'No recipes match.' : 'Nothing here yet.');
  return h('ul', { class: 'k-list' },
    shown.map((r) => {
      const avg = averageRating(r.versions);
      const open = () => {
        view.selectedId = r.id;
        store.refresh();
      };
      return h('li', {
        class: r.id === view.selectedId ? 'k-card active' : 'k-card',
        tabindex: '0',
        onclick: open,
        onkeydown: (e) => {
          if (e.key === 'Enter') open();
        },
      },
        h('strong', { class: 'k-card-title' }, r.title),
        r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
        h('div', { class: 'k-card-meta muted small' },
          avg !== null ? h('span', { class: 'stars' }, stars(avg)) : null,
          h('span', null, attempts(r)),
          h('span', null, lastActivity(r))));
    }));
}

function listPane(store, recipes) {
  const box = h('div', { class: 'k-list-box' });
  const fill = () => box.replaceChildren(recipeCards(store, recipes));
  fill();
  return h('section', { class: 'card k-side' },
    h('div', { class: 'row between' },
      h('h2', null, 'Recipes'),
      h('button', {
        type: 'button',
        class: 'btn-small primary',
        onclick: () => {
          view.adding = !view.adding;
          store.refresh();
        },
      }, icon('plus'), 'New')),
    view.adding
      ? h('form', {
          class: 'k-new',
          onsubmit: (e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            const title = v.title.trim();
            if (title) addRecipe(store, title, v.status);
          },
        },
          h('input', { name: 'title', placeholder: 'Recipe name, Enter', 'aria-label': 'New recipe name', autocomplete: 'off', 'data-autofocus': true }),
          h('select', { name: 'status', value: view.tab, 'aria-label': 'Status' },
            STATUSES.map(([k, l]) => h('option', { value: k }, l))))
      : null,
    importBlock(store),
    h('div', { class: 'segmented' },
      STATUSES.map(([key, label]) =>
        h('button', {
          type: 'button',
          class: key === view.tab ? 'seg active' : 'seg',
          onclick: () => {
            view.tab = key;
            view.selectedId = null;
            store.refresh();
          },
        }, `${label} · ${recipes.filter((r) => r.status === key).length}`))),
    h('input', {
      type: 'search',
      class: 'k-search',
      placeholder: 'Search title or tag',
      'aria-label': 'Search recipes',
      value: view.query,
      // Only the list refills while typing, so the search box keeps focus.
      oninput: (e) => {
        view.query = e.target.value;
        fill();
      },
    }),
    box);
}

// --- Detail ---

const block = (title, child) => h('div', { class: 'k-block' }, h('h3', null, title), child);

function iterationCard(store, r, v) {
  return h('li', { class: 'timeline-item' },
    h('span', { class: 'timeline-dot', 'aria-hidden': 'true' }),
    h('div', { class: 'timeline-body' },
      h('div', { class: 'row between' },
        h('span', { class: 'muted small' }, v.date),
        h('div', { class: 'row' },
          v.rating ? h('span', { class: 'stars' }, stars(v.rating)) : null,
          h('button', {
            type: 'button',
            class: 'icon-btn',
            title: 'Delete iteration',
            'aria-label': 'Delete iteration',
            onclick: () => removeVersion(store, r.id, v.id),
          }, icon('x')))),
      v.changes ? h('p', { class: 'iter-changes' }, v.changes) : null,
      v.notes ? h('p', { class: 'muted small' }, v.notes) : null));
}

function logForm(store, r) {
  return h('form', {
    class: 'card-inset k-log',
    onsubmit: (e) => {
      e.preventDefault();
      logIteration(store, r.id, formValues(e.currentTarget));
      store.refresh();
    },
  },
    h('div', { class: 'row' },
      h('input', { name: 'date', type: 'date', value: todayISO(), 'aria-label': 'Date' }),
      h('select', { name: 'rating', 'aria-label': 'Rating' },
        h('option', { value: '' }, 'No rating'),
        [5, 4, 3, 2, 1].map((n) => h('option', { value: n }, `${n} ★`)))),
    h('textarea', { name: 'changes', rows: 2, placeholder: 'What did you change? e.g. 20% less sugar, rested dough 2h' }),
    h('input', { name: 'notes', placeholder: 'Result: texture, timing, what to try next', autocomplete: 'off' }),
    h('div', { class: 'row end' }, h('button', { class: 'primary btn-small', type: 'submit' }, 'Log iteration')));
}

function detailPane(store, r) {
  const avg = averageRating(r.versions);
  const versions = [...r.versions].sort((a, b) => b.date.localeCompare(a.date));
  return h('section', { class: 'card k-main' },
    h('header', { class: 'k-head' },
      h('div', { class: 'k-title' },
        editText({
          value: r.title,
          placeholder: 'Untitled recipe',
          className: 'k-h1',
          onSave: (title) => updateRecipe(store, r.id, { title }),
        }),
        h('div', { class: 'k-meta row' },
          pickChip({
            value: r.status,
            options: STATUSES.map(([v, l]) => ({ value: v, label: l, tone: STATUS_TONE[v] })),
            onPick: (status) => {
              updateRecipe(store, r.id, { status });
              view.tab = status;
            },
          }),
          h('span', { class: 'muted small' }, attempts(r)),
          avg !== null ? h('span', { class: 'stars' }, `${stars(avg)} ${avg.toFixed(1)}`) : null,
          h('span', { class: 'muted small' }, `last tried ${lastActivity(r)}`))),
      h('div', { class: 'row' },
        r.status !== 'final'
          ? h('button', {
              type: 'button',
              class: 'btn-small primary',
              onclick: () => {
                view.tab = 'final';
                updateRecipe(store, r.id, { status: 'final' });
              },
            }, 'Promote to final')
          : null,
        h('button', { type: 'button', class: 'btn-small danger', onclick: () => deleteRecipe(store, r.id) }, 'Delete'))),

    h('div', { class: 'k-tags' },
      h('span', { class: 'muted small' }, 'Tags'),
      editText({
        value: r.tags.join(', '),
        placeholder: 'Add tags, comma separated',
        allowEmpty: true,
        onSave: (v) => updateRecipe(store, r.id, { tags: splitTags(v) }),
      })),

    r.source ? h('a', { href: r.source, target: '_blank', rel: 'noopener', class: 'btn-link' }, 'Open the original recipe') : null,
    h('div', { class: 'k-grid' },
      block('Ingredients', editText({
        value: r.ingredients.join('\n'),
        placeholder: 'One ingredient per line',
        multiline: true,
        allowEmpty: true,
        className: 'k-list-text',
        onSave: (v) => updateRecipe(store, r.id, { ingredients: splitLines(v) }),
      })),
      block('Steps', editText({
        value: r.steps.join('\n'),
        placeholder: 'One step per line',
        multiline: true,
        allowEmpty: true,
        className: 'k-list-text',
        onSave: (v) => updateRecipe(store, r.id, { steps: splitLines(v) }),
      })),
      block('Notes', editText({
        value: r.notes,
        placeholder: 'What you learned, what to watch for',
        rich: true,
        multiline: true,
        allowEmpty: true,
        className: 'k-list-text',
        onSave: (v) => updateRecipe(store, r.id, { notes: v.trim() }),
      }))),

    hasOpenRouter(store) ? null : setupBanner('openrouter', 'Suggesting variations needs an OpenRouter key.'),
    h('div', { class: 'k-actions' },
      h('button', {
        type: 'button',
        class: 'btn-small',
        disabled: ideas.status === 'loading',
        onclick: () => runIdeas(store, r),
      }, 'Suggest variations with AI')),
    ideasBlock(r),

    h('section', { class: 'k-iter' },
      h('div', { class: 'row between' },
        h('h3', null, 'Iterations'),
        h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            view.logOpen = !view.logOpen;
            store.refresh();
          },
        }, view.logOpen ? 'Close' : 'Log an iteration')),
      view.logOpen ? logForm(store, r) : null,
      versions.length
        ? h('ol', { class: 'timeline' }, versions.map((v) => iterationCard(store, r, v)))
        : empty('No iterations yet. Log one after each attempt.')));
}

function emptyDetail(store) {
  return h('section', { class: 'card k-main k-empty' },
    h('h2', null, 'Pick a recipe'),
    h('p', { class: 'muted' }, 'Recipes you are testing live here. Each attempt is an iteration, so you can see what changed, how it turned out, and what to try next.'),
    h('button', {
      type: 'button',
      class: 'btn-small primary',
      onclick: () => {
        view.adding = true;
        store.refresh();
      },
    }, icon('plus'), 'New recipe'));
}

function draw(root, store) {
  const { recipes } = store.get(COLLECTION);
  if (view.selectedId && !recipes.some((r) => r.id === view.selectedId)) view.selectedId = null;
  const selected = recipes.find((r) => r.id === view.selectedId) ?? null;
  root.replaceChildren(
    h('div', { class: 'kitchen-shell' },
      listPane(store, recipes),
      selected ? detailPane(store, selected) : emptyDetail(store)));
}

export default {
  id: 'kitchen',
  title: 'Kitchen',
  icon: 'chef-hat',
  collection: COLLECTION,
  defaults: { recipes: [] },
  render: draw,
  serialize: () => ({ tab: view.tab, recipe: view.selectedId ?? '', q: view.query }),
  restore: (p = {}) => {
    view.tab = ['idea', 'testing', 'final'].includes(p.tab) ? p.tab : 'testing';
    view.selectedId = p.recipe || null;
    view.query = p.q || '';
    view.logOpen = false;
    view.adding = false;
  },
};
