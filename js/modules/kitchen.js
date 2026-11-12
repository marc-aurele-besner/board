import { h, uid, now, todayISO, empty, icon, notice, progress } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { makeTask } from '../capture.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
/** @import { Store, Recipe, RecipeVersion, RecipesData, IconName } from '../../types/data' */
/**
 * A recipe as the model read it from a page or a photo: its JSON, as far as it is read.
 * @typedef {{ title?: unknown, tags?: unknown[], ingredients?: unknown[], steps?: unknown[], notes?: unknown, images?: unknown[] }} ReadRecipe
 */

const COLLECTION = 'recipes';
/** @type {[string, string][]} */
const STATUSES = [
  ['idea', 'Ideas'],
  ['testing', 'Testing'],
  ['final', 'Final'],
];
/** @type {Record<string, string>} */
const STATUS_TONE = { idea: 'todo', testing: 'doing', final: 'done' };

// View state: status tab, search text, the open recipe, and whether the "New" and "Log" forms are open.
// tab: 'all' or a status. layout: 'cards' or 'list'.
/** @type {{ tab: string, layout: string, query: string, selectedId: string | null, adding: boolean, logOpen: boolean }} */
const view = { tab: 'all', layout: 'cards', query: '', selectedId: null, adding: false, logOpen: false };

/** @param {string} text */
const splitLines = (text) => text.split('\n').map((s) => s.trim()).filter(Boolean);
/** @param {string} text */
const splitTags = (text) => [...new Set(text.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean))];
// The forms here have text fields only.
/** @param {HTMLFormElement} form */
const formValues = (form) => /** @type {Record<string, string>} */ (Object.fromEntries(new FormData(form)));
/**
 * @param {RecipesData} d
 * @param {string} id
 */
const findRecipe = (d, id) => d.recipes.find((r) => r.id === id);

/** @param {RecipeVersion[]} versions */
const averageRating = (versions) => {
  // Number.isFinite drops the unrated ones.
  const rated = /** @type {number[]} */ (versions.map((v) => v.rating).filter(Number.isFinite));
  return rated.length ? rated.reduce((a, b) => a + b, 0) / rated.length : null;
};
/** @param {number} n */
const stars = (n) => '★'.repeat(Math.round(n)) + '☆'.repeat(5 - Math.round(n));
/** @param {Recipe} r */
const lastActivity = (r) => r.versions.reduce((latest, v) => (v.date > latest ? v.date : latest), r.created.slice(0, 10));
/** @param {Recipe} r */
const attempts = (r) => `${r.versions.length} ${r.versions.length === 1 ? 'try' : 'tries'}`;

// Every change goes through one of these, so the store saves and re-renders.
/**
 * @param {Store} store
 * @param {string} id
 * @param {Partial<Recipe>} patch
 */
function updateRecipe(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) Object.assign(r, patch);
  });
}

/**
 * @param {Store} store
 * @param {string} title
 * @param {string} status
 */
function addRecipe(store, title, status) {
  const id = uid();
  view.selectedId = id;
  view.adding = false;
  store.update(COLLECTION, (d) =>
    d.recipes.push({ id, title, status, tags: [], ingredients: [], steps: [], notes: '', versions: [], created: now() }));
}

// Deleting is immediate, with a few seconds to take it back. The recipe returns to its place in the list.
/**
 * @param {Store} store
 * @param {string} id
 */
function deleteRecipe(store, id) {
  const recipes = store.get(COLLECTION).recipes;
  const index = recipes.findIndex((r) => r.id === id);
  if (index < 0) return;
  const removed = recipes[index];
  view.selectedId = null;
  store.update(COLLECTION, (d) => {
    d.recipes = d.recipes.filter((r) => r.id !== id);
  });
  toast(`“${removed.title}” deleted`, { undo: () => store.update(COLLECTION, (d) => d.recipes.splice(Math.min(index, d.recipes.length), 0, removed)) });
}

/**
 * @param {Store} store
 * @param {string} id
 * @param {Record<string, string>} v
 */
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

/**
 * @param {Store} store
 * @param {string} id
 * @param {string} versionId
 */
function removeVersion(store, id, versionId) {
  const versions = findRecipe(store.get(COLLECTION), id)?.versions ?? [];
  const index = versions.findIndex((v) => v.id === versionId);
  if (index < 0) return;
  const removed = versions[index];
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) r.versions = r.versions.filter((v) => v.id !== versionId);
  });
  toast('Iteration deleted', {
    undo: () => store.update(COLLECTION, (d) => {
      const r = findRecipe(d, id);
      if (r) r.versions.splice(Math.min(index, r.versions.length), 0, removed);
    }),
  });
}

// --- Suggest variations (task 4) ---

/** @type {{ recipeId: string | null, status: string, text: string }} */
const ideas = { recipeId: null, status: 'idle', text: '' };

/**
 * @param {Store} store
 * @param {Recipe} r
 */
async function runIdeas(store, r) {
  ideas.recipeId = r.id;
  ideas.status = 'loading';
  store.refresh();
  try {
    ideas.text = (await ask(store, 'task-recipe', [
      {
        role: 'system',
        content: systemPrompt(store, 'recipe-ideas'),
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
    ideas.text = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

/** @param {Recipe} r */
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

/** @param {string} url */
async function fetchPageText(url) {
  const res = await fetch(READER + url, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error(`The page could not be read (${res.status}). Some sites do not allow it.`);
  return res.text();
}

// Image links in the page text (markdown `![alt](url)`). Pictures are linked, not downloaded, so the recipe keeps them as URLs.
const IMAGE_LINK = /!\[[^\]]*\]\((https?:\/\/[^)\s]+)\)/g;
const MAX_IMAGE_CANDIDATES = 60;
const MAX_RECIPE_IMAGES = 3;

/** @param {string} text */
function imageCandidates(text) {
  const found = [...text.matchAll(IMAGE_LINK)].map((m) => m[1]).filter((u) => !/\.svg(\?|$)/i.test(u));
  return [...new Set(found)].slice(0, MAX_IMAGE_CANDIDATES);
}

// Adds a recipe as an idea. Its fields come from the model's reading of a page or a photo;
// `extra` holds where it came from (a source link and its pictures, or the saved photos).
/**
 * @param {Store} store
 * @param {ReadRecipe} data
 * @param {{ id?: string, source?: string, images?: string[], scans?: string[] }} [where]
 */
function addImportedRecipe(store, data, { id = uid(), ...extra } = {}) {
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
      images: [],
      ...extra,
      versions: [],
      created: now(),
    }));
}

// Turns the page text into a recipe with the model, then adds it.
/**
 * @param {Store} store
 * @param {string} text
 * @param {string} url
 */
async function importFromText(store, text, url) {
  importState.status = 'loading';
  store.refresh();
  try {
    const candidates = imageCandidates(text);
    const reply = await ask(store, 'task-recipe', [
      {
        role: 'system',
        content: systemPrompt(store, 'recipe-import', { maxImages: MAX_RECIPE_IMAGES }),
      },
      { role: 'user', content: `${text.slice(0, 40000)}\n\nImage URLs:\n${candidates.join('\n') || '(none)'}` },
    ]);
    /** @type {ReadRecipe} */
    const data = parseJson(reply);
    // Only links that were on the page count, so the model cannot add a picture of its own.
    const images = [...new Set((data.images ?? []).map(String))].filter((u) => candidates.includes(u)).slice(0, MAX_RECIPE_IMAGES);
    addImportedRecipe(store, data, { source: url, images });
    importState.status = 'idle';
    importState.pasting = false;
    importState.url = '';
  } catch (err) {
    importState.status = 'error';
    importState.error = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

// Also started from the search palette, when a link is pasted there.
/**
 * @param {Store} store
 * @param {string} url
 */
export async function importFromUrl(store, url) {
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
    importState.error = `${/** @type {Error} */ (err).message} You can paste the recipe text instead.`;
    importState.pasting = true;
    store.refresh();
  }
}

// The link import, in the side column: a link, or pasted text when the page cannot be read.
/** @param {Store} store */
function importBlock(store) {
  const s = importState;
  return h('div', { class: 'k-import stack' },
    h('form', {
      class: 'k-import-form',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const url = String(new FormData(/** @type {HTMLFormElement} */ (e.currentTarget)).get('url') ?? '').trim();
        if (!/^https?:\/\/\S+$/i.test(url)) {
          s.status = 'error';
          s.error = 'Enter a full link that starts with https://';
          return store.refresh();
        }
        importFromUrl(store, url);
      },
    },
      h('input', { name: 'url', type: 'url', placeholder: 'https://…', 'aria-label': 'Recipe link', inputmode: 'url', autocomplete: 'off' }),
      h('button', { class: 'btn-small primary', type: 'submit', disabled: s.status === 'loading' }, s.status === 'loading' ? 'Reading…' : 'Import')),
    s.status === 'error' ? notice({ text: s.error }) : null,
    s.pasting
      ? h('form', {
          class: 'stack',
          onsubmit: (/** @type {SubmitEvent} */ e) => {
            e.preventDefault();
            importFromText(store, String(new FormData(/** @type {HTMLFormElement} */ (e.currentTarget)).get('text') ?? ''), s.url);
          },
        },
          h('p', { class: 'muted small' }, 'Copy the recipe text from the page and paste it here.'),
          h('textarea', { name: 'text', rows: 5, 'aria-label': 'Recipe text' }),
          h('div', { class: 'row end' }, h('button', { class: 'btn-small primary', type: 'submit' }, 'Import text')))
      : null);
}

// --- Read a photo of a recipe (handwritten or printed) ---

const MAX_PHOTOS = 4;
// Long edge in pixels. Enough for handwriting, small enough to keep the call and the saved file light.
const PHOTO_EDGE = 1600;
const photoState = { status: 'idle', stage: '', error: '' };

// Draws the photo smaller, as a JPEG. createImageBitmap also applies the camera's rotation.
/**
 * @param {File} file
 * @returns {Promise<Blob>}
 */
async function shrinkPhoto(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error(`“${file.name}” could not be opened. Use a JPG, PNG or WebP photo; export iPhone HEIC photos as JPG first.`);
  }
  const scale = Math.min(1, PHOTO_EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d')).drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not prepare the photo.'))), 'image/jpeg', 0.85));
}

/**
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
const readAsDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    // readAsDataURL gives a string.
    reader.onload = () => resolve(/** @type {string} */ (reader.result));
    reader.onerror = () => reject(new Error('Could not read the photo.'));
    reader.readAsDataURL(blob);
  });

// Several photos are read as the pages of one recipe, in the order they were picked.
/**
 * @param {Store} store
 * @param {File[] | FileList} fileList
 */
async function readRecipePhotos(store, fileList) {
  const files = [...fileList].filter((f) => f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name));
  /** @param {string} stage */
  const say = (stage) => {
    photoState.stage = stage;
    store.refresh();
  };
  photoState.status = 'loading';
  photoState.error = '';
  say('Preparing the photo…');
  try {
    if (!files.length) throw new Error('Drop a photo of a recipe: JPG, PNG or WebP.');
    if (files.length > MAX_PHOTOS) toast(`Only the first ${MAX_PHOTOS} photos are read.`);
    const blobs = await Promise.all(files.slice(0, MAX_PHOTOS).map(shrinkPhoto));
    const urls = await Promise.all(blobs.map(readAsDataUrl));
    say('Asking the model to read and rewrite the recipe…');
    const reply = await ask(store, 'task-recipe-photo', [
      { role: 'system', content: systemPrompt(store, 'recipe-photo') },
      {
        role: 'user',
        content: [
          { type: 'text', text: urls.length > 1 ? `${urls.length} photos of one recipe, in order.` : 'A photo of a recipe.' },
          ...urls.map((url) => ({ type: 'image_url', image_url: { url } })),
        ],
      },
    ]);
    /** @type {ReadRecipe} */
    const data = parseJson(reply);
    // The original is kept in the data folder (recipes/), so the handwriting can be checked later.
    say('Saving the original photo…');
    const id = uid();
    /** @type {string[]} */
    let scans = [];
    try {
      scans = await Promise.all(blobs.map((blob, i) => store.files.write(`recipes/${id}-${i + 1}.jpg`, blob)));
    } catch {
      toast('The recipe was added, but its photo could not be saved.');
    }
    addImportedRecipe(store, data, { id, scans });
    photoState.status = 'idle';
  } catch (err) {
    photoState.status = 'error';
    photoState.error = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

/** @param {Store} store */
function photoBlock(store) {
  if (photoState.status === 'loading') return h('div', { class: 'panel-mini' }, progress(photoState.stage || 'Reading…'));
  const input = h('input', {
    type: 'file',
    accept: 'image/*',
    multiple: true,
    class: 'sr-only',
    'aria-label': 'Choose a photo of a recipe',
    onchange: (/** @type {Event} */ e) => {
      const files = [...(/** @type {HTMLInputElement} */ (e.target).files ?? [])];
      /** @type {HTMLInputElement} */ (e.target).value = '';
      if (files.length) readRecipePhotos(store, files);
    },
  });
  const pick = () => input.click();
  return h('div', { class: 'stack' },
    input,
    h('div', {
      class: 'dropzone k-photo-drop',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Drop a photo of a recipe here, or click to choose one',
      onclick: pick,
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          pick();
        }
      },
      ondragover: (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).classList.add('over');
      },
      ondragleave: (/** @type {DragEvent} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.remove('over'),
      ondrop: (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        /** @type {HTMLElement} */ (e.currentTarget).classList.remove('over');
        // A drop always carries a dataTransfer.
        if (/** @type {DataTransfer} */ (e.dataTransfer).files?.length) readRecipePhotos(store, /** @type {DataTransfer} */ (e.dataTransfer).files);
      },
    },
      icon('plus'),
      h('strong', null, 'Drop a photo of a recipe'),
      h('span', { class: 'muted small' }, `Handwritten or printed, up to ${MAX_PHOTOS} pages. AI rewrites it as a recipe and keeps the photo.`)),
    photoState.status === 'error'
      ? notice({
          text: photoState.error,
          actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => { photoState.status = 'idle'; store.refresh(); } }, 'Dismiss')],
        })
      : null);
}

// Opens the photos a recipe was read from, from the data folder.
/**
 * @param {Store} store
 * @param {Recipe} r
 */
async function showScans(store, r) {
  const body = h('div', { class: 'stack' });
  openDialog({ title: `${r.title}: original`, wide: true, body });
  // Shown only for a recipe that has scans.
  for (const path of /** @type {string[]} */ (r.scans)) {
    try {
      const url = URL.createObjectURL(await store.files.read(path));
      body.append(h('img', { class: 'bill-img', src: url, alt: `Original photo of ${r.title}` }));
    } catch {
      body.append(empty('This photo is no longer in the data folder.'));
    }
  }
}

// --- Gallery ---

/**
 * @param {Recipe} r
 * @param {string} q
 */
const matches = (r, q) => !q || `${r.title} ${r.tags.join(' ')} ${r.ingredients.join(' ')}`.toLowerCase().includes(q);
/** @param {string} status */
const statusLabel = (status) => STATUSES.find(([k]) => k === status)?.[1] ?? status;
/**
 * @param {Store} store
 * @param {Recipe} r
 */
const open = (store, r) => {
  view.selectedId = r.id;
  view.logOpen = false;
  store.refresh();
};

// A stable colour for a recipe without a picture, so its card still looks like its own.
/** @param {string} text */
function hueOf(text) {
  let hash = 0;
  for (const c of String(text)) hash = (hash * 31 + c.charCodeAt(0)) % 360;
  return hash;
}

// The picture of a recipe: its first imported image, or its initial on its own colour.
/**
 * @param {Recipe} r
 * @param {string} cls
 */
function cover(r, cls) {
  const letter = () => h('span', { class: 'r-letter', 'aria-hidden': 'true' }, r.title.slice(0, 1).toUpperCase());
  const box = h('div', { class: cls, style: { '--hue': hueOf(r.title) } });
  const src = r.images?.[0];
  if (src) box.append(h('img', { src, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer', onerror: (/** @type {Event} */ e) => /** @type {HTMLImageElement} */ (e.currentTarget).replaceWith(letter()) }));
  else box.append(letter());
  return box;
}

/**
 * @param {Store} store
 * @param {Recipe} r
 */
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

/**
 * @param {Store} store
 * @param {Recipe[]} shown
 */
function recipeTable(store, shown) {
  return h('div', { class: 'card mon-scroll' },
    h('table', { class: 'mon-table r-table' },
      h('thead', null, h('tr', null, ['Recipe', 'Status', 'Rating', 'Tries', 'Last tried', 'Notes'].map((t) => h('th', null, t)))),
      h('tbody', null, shown.map((r) => {
        const avg = averageRating(r.versions);
        return h('tr', { tabindex: '0', onclick: () => open(store, r), onkeydown: (/** @type {KeyboardEvent} */ e) => { if (e.key === 'Enter') open(store, r); } },
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
/**
 * @param {Store} store
 * @param {Recipe[]} recipes
 */
function results(store, recipes) {
  const q = view.query.trim().toLowerCase();
  const shown = recipes
    .filter((r) => (view.tab === 'all' || r.status === view.tab) && matches(r, q))
    .sort((a, b) => lastActivity(b).localeCompare(lastActivity(a)));
  if (!shown.length) return empty(q ? 'No recipes match.' : 'Nothing here yet.');
  return view.layout === 'list' ? recipeTable(store, shown) : h('ul', { class: 'r-grid' }, shown.map((r) => recipeCard(store, r)));
}

/**
 * @param {Store} store
 * @param {Recipe[]} recipes
 */
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
  /**
   * @param {string} key
   * @param {string} label
   * @param {IconName} iconName
   */
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
          oninput: (/** @type {Event} */ e) => {
            view.query = /** @type {HTMLInputElement} */ (e.target).value;
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
          onsubmit: (/** @type {SubmitEvent} */ e) => {
            e.preventDefault();
            const v = formValues(/** @type {HTMLFormElement} */ (e.currentTarget));
            const title = v.title.trim();
            if (title) addRecipe(store, title, v.status);
          },
        },
          h('input', { name: 'title', placeholder: 'Recipe name, Enter', 'aria-label': 'New recipe name', autocomplete: 'off', 'data-autofocus': true }),
          h('select', { name: 'status', value: view.tab === 'all' ? 'testing' : view.tab, 'aria-label': 'Status' },
            STATUSES.map(([k, l]) => h('option', { value: k }, l))),
          h('button', { class: 'primary', type: 'submit' }, 'Add'))
      : null,
    // Laid out like Money: the recipes, and a side column of cards to add one from a photo or a link.
    h('div', { class: 'k-grid' },
      h('div', { class: 'k-main' }, box),
      h('aside', { class: 'k-side stack-lg' },
        hasOpenRouter(store) ? null : setupBanner('openrouter', 'Reading a photo or a link needs an OpenRouter key.'),
        h('section', { class: 'card stack' },
          h('h3', null, 'Add a recipe from a photo'),
          photoBlock(store)),
        h('section', { class: 'card stack' },
          h('h3', null, 'Import from a link'),
          importBlock(store)))));
}

// --- Detail ---

/**
 * @param {string} title
 * @param {Node} child
 */
const block = (title, child) => h('div', { class: 'k-block' }, h('h3', null, title), child);

// Pictures taken from the web page. They are hotlinked, so a removed picture only leaves the recipe's list.
/**
 * @param {Store} store
 * @param {string} id
 * @param {string} src
 */
function removeImage(store, id, src) {
  store.update(COLLECTION, (d) => {
    const r = findRecipe(d, id);
    if (r) r.images = (r.images ?? []).filter((u) => u !== src);
  });
}

/**
 * @param {Store} store
 * @param {Recipe} r
 */
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

/**
 * @param {Store} store
 * @param {Recipe} r
 * @param {RecipeVersion} v
 */
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

/**
 * @param {Store} store
 * @param {Recipe} r
 */
function logForm(store, r) {
  return h('form', {
    class: 'card-inset k-log',
    onsubmit: (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      logIteration(store, r.id, formValues(/** @type {HTMLFormElement} */ (e.currentTarget)));
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

/**
 * @param {Store} store
 * @param {Recipe} r
 */
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
    r.scans?.length
      ? h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: () => showScans(store, r) }, `View the original photo${r.scans.length > 1 ? 's' : ''}`))
      : null,
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

/**
 * @param {HTMLElement} root
 * @param {Store} store
 */
function draw(root, store) {
  const { recipes } = store.get(COLLECTION);
  if (view.selectedId && !recipes.some((r) => r.id === view.selectedId)) view.selectedId = null;
  const selected = recipes.find((r) => r.id === view.selectedId) ?? null;
  root.replaceChildren(selected ? detailPane(store, selected) : gallery(store, recipes));
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'kitchen',
  title: 'Kitchen',
  icon: 'chef-hat',
  collection: COLLECTION,
  defaults: { recipes: [] },
  render: draw,
  serialize: () => ({ tab: view.tab === 'all' ? '' : view.tab, view: view.layout === 'list' ? 'list' : '', recipe: view.selectedId ?? '', q: view.query }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.tab = ['idea', 'testing', 'final'].includes(p.tab) ? p.tab : 'all';
    view.layout = p.view === 'list' ? 'list' : 'cards';
    view.selectedId = p.recipe || null;
    view.query = p.q || '';
    view.logOpen = false;
    view.adding = false;
  },
});
