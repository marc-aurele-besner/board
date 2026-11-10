import { h, uid, now, todayISO, empty, icon, notice } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { makeTask } from '../capture.js';
import { toast } from '../toast.js';

const COLLECTION = 'recipes';
const STATUSES = [
  ['idea', 'Ideas'],
  ['testing', 'Testing'],
  ['final', 'Final'],
];
const STATUS_TONE = { idea: 'todo', testing: 'doing', final: 'done' };

// View state: status tab, search text, the open recipe, and whether the "New" and "Log" forms are open.
// tab: 'all' or a status. layout: 'cards' or 'list'.
const view = { tab: 'all', layout: 'cards', query: '', selectedId: null, adding: false, logOpen: false };

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

// Image links in the page text (markdown `![alt](url)`). Pictures are linked, not downloaded, so the recipe keeps them as URLs.
const IMAGE_LINK = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const MAX_IMAGE_CANDIDATES = 60;
const MAX_RECIPE_IMAGES = 3;

function imageCandidates(text) {
  const found = [...text.matchAll(IMAGE_LINK)].map((m) => m[1]).filter((u) => !/\.svg(\?|$)/i.test(u));
  return [...new Set(found)].slice(0, MAX_IMAGE_CANDIDATES);
}

// Adds a recipe as an idea, with its source link. Its fields come from the model's reading of the page.
function addImportedRecipe(store, data, url, images) {
  const id = uid();
  view.selectedId = id;
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
      images,
      versions: [],
      created: now(),
    }));
}

// Turns the page text into a recipe with the model, then adds it.
async function importFromText(store, text, url) {
  importState.status = 'loading';
  store.refresh();
  try {
    const candidates = imageCandidates(text);
    const reply = await ask(store, 'task-recipe', [
      {
        role: 'system',
        content: `You extract a recipe from web page text. Reply with JSON only: {"title": string, "tags": string[], "ingredients": string[], "steps": string[], "notes": string, "images": string[]}. Ingredients one per item, with quantities. Steps in order. Tags: a few short words such as cuisine or kind of dish. Notes: a short summary of anything special (serves, time, tips). Images: up to ${MAX_RECIPE_IMAGES} URLs copied exactly from the "Image URLs" list that show the finished dish or the recipe's method; leave out logos, icons, ads and author photos. Leave out page menus, ads and comments.`,
      },
      { role: 'user', content: `${text.slice(0, 40000)}\n\nImage URLs:\n${candidates.join('\n') || '(none)'}` },
    ]);
    const data = parseJson(reply);
    // Only links that were on the page count, so the model cannot add a picture of its own.
    const images = [...new Set((data.images ?? []).map(String))].filter((u) => candidates.includes(u)).slice(0, MAX_RECIPE_IMAGES);
    addImportedRecipe(store, data, url, images);
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

// --- Gallery ---

const matches = (r, q) => !q || `${r.title} ${r.tags.join(' ')} ${r.ingredients.join(' ')}`.toLowerCase().includes(q);
const statusLabel = (status) => STATUSES.find(([k]) => k === status)?.[1] ?? status;
const open = (store, r) => {
  view.selectedId = r.id;
  view.logOpen = false;
  store.refresh();
};

// A stable colour for a recipe without a picture, so its card still looks like its own.
function hueOf(text) {
  let hash = 0;
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return hash;
}

// The picture of a recipe: its first imported image, or its initial on its own colour.
function cover(r, cls) {
  const letter = () => h('span', { class: 'r-letter', 'aria-hidden': 'true' }, r.title.slice(0, 1).toUpperCase());
  const box = h('div', { class: cls, style: { '--hue': hueOf(r.title) } });
  const src = r.images?.[0];
  if (src) box.append(h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (e) => e.currentTarget.replaceWith(letter()) }));
  else box.append(letter());
  return box;
}

function recipeCard(store, r) {
  const avg = averageRating(r.versions);
  const blurb = r.notes || r.ingredients.slice(0, 4).join(' · ') || 'No notes yet. Open it to add ingredients and steps.';
  const card = cover(r, 'r-cover');
  card.append(h('span', { class: `pill tone-${STATUS_TONE[r.status]} r-status` }, statusLabel(r.status)));
  if (avg !== null) card.append(h('span', { class: 'r-rate' }, h('span', { class: 'stars' }, stars(avg)), ` ${avg.toFixed(1)}`));
  return h('li', null,
    h('button', { type: 'button', class: 'r-card', onclick: () => open(store, r) },
      card,
      h('div', { class: 'r-body' },
        h('strong', { class: 'r-title' }, r.title),
        r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null,
        h('p', { class: 'muted small r-blurb' }, blurb),
        h('div', { class: 'row between muted small r-foot' },
          h('span', null, attempts(r)),
          h('span', null, `${r.versions.length ? 'last tried' : 'added'} ${lastActivity(r)}`)))));
}

function recipeTable(store, shown) {
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table r-table' },
      h('thead', null, h('tr', null, ['Recipe', 'Status', 'Rating', 'Tries', 'Last tried', 'Notes'].map((t) => h('th', null, t)))),
      h('tbody', null, shown.map((r) => {
        const avg = averageRating(r.versions);
        return h('tr', { tabindex: '0', onclick: () => open(store, r), onkeydown: (e) => { if (e.key === 'Enter') open(store, r); } },
          h('td', null, h('div', { class: 'row r-name' }, cover(r, 'r-thumb'),
            h('div', null, h('strong', null, r.title), r.tags.length ? h('div', { class: 'tags' }, r.tags.map((t) => h('span', { class: 'tag' }, t))) : null))),
          h('td', null, h('span', { class: `pill tone-${STATUS_TONE[r.status]}` }, statusLabel(r.status))),
          h('td', null, avg !== null ? [h('span', { class: 'stars' }, stars(avg)), h('span', { class: 'muted small' }, ` ${avg.toFixed(1)}`)] : h('span', { class: 'muted small' }, 'Not rated')),
          h('td', null, String(r.versions.length)),
          h('td', null, r.versions.length ? lastActivity(r) : h('span', { class: 'muted small' }, 'Never')),
          h('td', { class: 'muted small r-note' }, r.notes || r.ingredients.slice(0, 4).join(' · ')));
      }))));
}

// The recipes that match the search and the tab, as cards or as a list.
function results(store, recipes) {
  const q = view.query.trim().toLowerCase();
  const shown = recipes
    .filter((r) => (view.tab === 'all' || r.status === view.tab) && matches(r, q))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  if (!shown.length) return empty(q ? 'No recipes match.' : 'Nothing here yet.');
  return view.layout === 'list' ? recipeTable(store, shown) : h('ul', { class: 'r-grid' }, shown.map((r) => recipeCard(store, r)));
}

function gallery(store, recipes) {
  const box = h('div', { class: 'r-results' });
  const tabs = h('div', { class: 'segmented r-tabs' });
  // Only the results and the tab counts refill while typing, so the search box keeps focus.
  const fill = () => {
    const q = view.query.trim().toLowerCase();
    const found = recipes.filter((r) => matches(r, q));
    tabs.replaceChildren(...[['all', 'All'], ...STATUSES].map(([key, label]) =>
      h('button', {
        type: 'button',
        class: key === view.tab ? 'seg active' : 'seg',
        'aria-pressed': String(key === view.tab),
        onclick: () => {
          view.tab = key;
          store.refresh();
        },
      }, `${label} · ${key === 'all' ? found.length : found.filter((r) => r.status === key).length}`)));
    box.replaceChildren(results(store, recipes));
  };
  fill();
  const layout = (key, label, iconName) =>
    h('button', {
      type: 'button',
      class: view.layout === key ? 'seg active' : 'seg',
      'aria-pressed': String(view.layout === key),
      onclick: () => {
        view.layout = key;
        store.refresh();
      },
    }, icon(iconName), label);
  const testing = recipes.filter((r) => r.status === 'testing').length;
  return h('div', { class: 'stack-lg kitchen' },
    h('header', null,
      h('h2', null, 'Kitchen'),
      h('p', { class: 'muted small' }, `${recipes.length} recipe${recipes.length === 1 ? '' : 's'} · ${testing} in testing. Each attempt is an iteration, so you can see what changed and what to try next.`)),
    h('div', { class: 'r-bar' },
      h('label', { class: 'r-search' }, icon('search'),
        h('input', {
          type: 'search',
          placeholder: 'Search recipes by name, tag or ingredient',
          'aria-label': 'Search recipes',
          value: view.query,
          oninput: (e) => {
            view.query = e.target.value;
            fill();
          },
        })),
      tabs,
      h('div', { class: 'segmented r-layout', role: 'group', 'aria-label': 'View' }, layout('cards', 'Cards', 'cards'), layout('list', 'List', 'list')),
      h('button', {
        type: 'button',
        class: 'primary',
        onclick: () => {
          view.adding = !view.adding;
          store.refresh();
        },
      }, icon('plus'), 'New recipe')),
    view.adding
      ? h('form', {
          class: 'k-new card-inset',
          onsubmit: (e) => {
            e.preventDefault();
            const v = formValues(e.currentTarget);
            const title = v.title.trim();
            if (title) addRecipe(store, title, v.status);
          },
        },
          h('input', { name: 'title', placeholder: 'Recipe name, Enter', 'aria-label': 'New recipe name', autocomplete: 'off', 'data-autofocus': true }),
          h('select', { name: 'status', value: view.tab === 'all' ? 'testing' : view.tab, 'aria-label': 'Status' },
            STATUSES.map(([k, l]) => h('option', { value: k }, l))),
          h('button', { class: 'primary', type: 'submit' }, 'Add'))
      : null,
    h('div', { class: 'r-import' }, importBlock(store)),
    box);
}

// --- Detail ---

const block = (title, child) => h('div', { class: 'k-block' }, h('h3', null, title), child);

// Pictures taken from the web page. They are hotlinked, so a removed picture only leaves the recipe's list.
function removeImage(store, id, src) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) r.images = (r.images ?? []).filter((u) => u !== src);
  });
}

function photos(store, r) {
  if (!r.images?.length) return null;
  return h('div', { class: 'k-photos' },
    r.images.map((src) =>
      h('figure', { class: 'k-photo' },
        h('img', { src, alt: r.title, loading: 'lazy', referrerpolicy: 'no-referrer' }),
        h('button', {
          type: 'button',
          class: 'icon-btn k-photo-remove',
          title: 'Remove picture',
          'aria-label': 'Remove picture',
          onclick: () => removeImage(store, r.id, src),
        }, icon('x')))));
}

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
    h('div', null, h('button', {
      type: 'button',
      class: 'btn-small',
      onclick: () => {
        view.selectedId = null;
        store.refresh();
      },
    }, icon('arrow-left'), 'All recipes')),
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
    photos(store, r),
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
        display: (text) => h('ul', { class: 'k-steps' }, splitLines(text).map((step) => h('li', null, step))),
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
        disabled: !r.ingredients.length,
        title: 'One task per ingredient, in Personal',
        onclick: () => {
          store.update('todos', (d) => d.items.push(...r.ingredients.map((text) => makeTask({ text, description: `For ${r.title}`, category: 'shopping' }))));
          toast(`${r.ingredients.length} ingredient${r.ingredients.length === 1 ? '' : 's'} added to Tasks`);
        },
      }, icon('check-square'), 'Add ingredients to Tasks'),
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

function draw(root, store) {
  const { recipes } = store.get(COLLECTION);
  if (view.selectedId && !recipes.some((r) => r.id === view.selectedId)) view.selectedId = null;
  const selected = recipes.find((r) => r.id === view.selectedId) ?? null;
  root.replaceChildren(selected ? detailPane(store, selected) : gallery(store, recipes));
}

export default {
  id: 'kitchen',
  title: 'Kitchen',
  icon: 'chef-hat',
  collection: COLLECTION,
  defaults: { recipes: [] },
  render: draw,
  serialize: () => ({ tab: view.tab === 'all' ? '' : view.tab, view: view.layout === 'list' ? 'list' : '', recipe: view.selectedId ?? '', q: view.query }),
  restore: (p = {}) => {
    view.tab = ['idea', 'testing', 'final'].includes(p.tab) ? p.tab : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    view.selectedId = p.recipe || null;
    view.query = p.q || '';
    view.logOpen = false;
    view.adding = false;
  },
};
