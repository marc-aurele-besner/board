// @ts-check
// Model chip and the model dialog: searchable by name, filterable by provider, reads-images and free,
// sortable by price or context, with per-million-token costs and a details panel.
import { h, icon } from './ui.js';
import { openDialog } from './modal.js';

const MODELS_URL = 'https://openrouter.ai/api/v1/models';
/** @type {Promise<CatalogModel[]> | null} */
let catalog = null; // Promise<model[]>, loaded once per page

/**
 * A model as OpenRouter lists it: the fields read here.
 * @typedef {{ id: string, name?: string, description?: string, context_length?: number,
 *   architecture?: { input_modalities?: string[] }, pricing?: { prompt?: string, completion?: string } }} OpenRouterModel
 */
/** @typedef {ReturnType<typeof normalize>} CatalogModel */

/** @param {unknown} v */
const perMillion = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n * 1e6 : null;
};

/** @param {OpenRouterModel} m */
function normalize(m) {
  const inputs = m.architecture?.input_modalities ?? ['text'];
  const prompt = perMillion(m.pricing?.prompt);
  const completion = perMillion(m.pricing?.completion);
  return {
    id: m.id,
    name: m.name ?? m.id,
    provider: m.id.split('/')[0],
    description: m.description ?? '',
    context: m.context_length ?? null,
    prompt,
    completion,
    free: prompt === 0 && completion === 0,
    images: inputs.includes('image'),
    inputs,
  };
}

/** @returns {Promise<CatalogModel[]>} */
export function getCatalog() {
  catalog ??= fetch(MODELS_URL)
    .then((res) => {
      if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
      return /** @type {Promise<{ data: OpenRouterModel[] }>} */ (res.json());
    })
    .then(({ data }) => data.map(normalize))
    .catch((err) => {
      catalog = null; // allow a retry
      throw err;
    });
  return catalog;
}

/** @param {number | null} v */
const money = (v) => (v === null ? '—' : v === 0 ? 'Free' : v < 0.01 ? `$${v.toFixed(4)}` : `$${v.toFixed(2)}`);
/** @template T @param {T[]} list @param {(x: T) => string} key */
const countBy = (list, key) => list.reduce((acc, x) => ((acc[key(x)] = (acc[key(x)] ?? 0) + 1), acc), /** @type {Record<string, number>} */ ({}));

/** @type {Record<string, (a: CatalogModel, b: CatalogModel) => number>} */
const SORTERS = {
  name: (a, b) => a.name.localeCompare(b.name),
  price: (a, b) => (a.prompt ?? Infinity) - (b.prompt ?? Infinity) || a.name.localeCompare(b.name),
  context: (a, b) => (b.context ?? 0) - (a.context ?? 0),
};

// A button that shows the chosen model id and opens the dialog.
/**
 * @typedef {{ value?: string | null, nullable?: boolean, nullLabel?: string, requireImages?: boolean, onPick: (id: string | null) => void }} PickerOptions
 */

/** @param {PickerOptions & { placeholder?: string }} options */
export function modelChip({ value = '', placeholder = 'Choose a model', nullable = false, nullLabel = 'Use default', requireImages = false, onPick }) {
  const empty = !value;
  return h('button', {
    type: 'button',
    class: empty ? 'chip-pick model-chip is-empty' : 'chip-pick model-chip',
    'aria-haspopup': 'dialog',
    onclick: () => openModelPicker({ value, nullable, nullLabel, requireImages, onPick }),
  },
    h('span', { class: 'model-id' }, empty ? (nullable ? nullLabel : placeholder) : value),
    icon('chevron-down'));
}

/** @param {PickerOptions} options */
export function openModelPicker({ value = '', nullable = false, nullLabel = 'Use default', requireImages = false, onPick }) {
  const state = { q: '', provider: '', sort: 'name', images: requireImages, free: false, selected: value || '' };
  /** @type {CatalogModel[]} */
  let models = [];
  const status = h('p', { class: 'muted small' }, 'Loading models from OpenRouter…');
  const toolbar = h('div', { class: 'mp-toolbar' });
  const table = h('div', { class: 'mp-table' });
  const details = h('div', { class: 'mp-details' });
  const dialog = openDialog({
    title: 'Choose a model',
    wide: true,
    body: h('div', { class: 'mp' }, toolbar, status, table, details),
  });

  /** @param {string | null} id */
  const choose = (id) => {
    dialog.close();
    onPick(id || null);
  };

  const filtered = () => {
    const q = state.q.trim().toLowerCase();
    return models
      .filter((m) => !state.provider || m.provider === state.provider)
      .filter((m) => !state.images || m.images)
      .filter((m) => !state.free || m.free)
      .filter((m) => !q || `${m.name} ${m.id} ${m.description}`.toLowerCase().includes(q))
      .sort(SORTERS[state.sort]);
  };

  const paintDetails = () => {
    const m = models.find((x) => x.id === state.selected);
    if (!m) {
      details.replaceChildren(h('p', { class: 'muted' }, 'Select a model to see its details and cost.'));
      return;
    }
    details.replaceChildren(
      h('div', { class: 'mp-detail-head' },
        h('div', null,
          h('h3', null, m.name),
          h('div', { class: 'muted small' }, m.id)),
        h('div', { class: 'row' },
          nullable ? h('button', { type: 'button', onclick: () => choose(null) }, nullLabel) : null,
          h('button', { type: 'button', class: 'primary', onclick: () => choose(m.id) }, 'Use this model'))),
      h('div', { class: 'stats' },
        h('div', null, h('strong', null, money(m.prompt)), h('span', { class: 'muted small' }, 'input / 1M tokens')),
        h('div', null, h('strong', null, money(m.completion)), h('span', { class: 'muted small' }, 'output / 1M tokens')),
        h('div', null, h('strong', null, m.context ? `${Math.round(m.context / 1000)}k` : '—'), h('span', { class: 'muted small' }, 'context')),
        h('div', null, h('strong', null, m.inputs.join(', ')), h('span', { class: 'muted small' }, 'reads'))),
      m.description ? h('p', { class: 'mp-desc' }, m.description) : h('p', { class: 'muted small' }, 'No description published.'));
  };

  const paintTable = () => {
    const list = filtered();
    const shown = list.slice(0, 300);
    table.replaceChildren(
      h('p', { class: 'muted small' }, `${list.length} model${list.length === 1 ? '' : 's'}${list.length > shown.length ? `, showing the first ${shown.length}` : ''}`),
      h('div', { class: 'mp-scroll' },
        h('table', { class: 'mp-grid' },
          h('thead', null, h('tr', null,
            h('th', null, 'Model'),
            h('th', null, 'Provider'),
            h('th', { class: 'num' }, 'Context'),
            h('th', { class: 'num' }, 'Input / 1M'),
            h('th', { class: 'num' }, 'Output / 1M'),
            h('th', null, 'Reads'))),
          h('tbody', null, shown.map((m) =>
            h('tr', {
              class: m.id === state.selected ? 'selected' : '',
              onclick: () => {
                state.selected = m.id;
                paintTable();
                paintDetails();
              },
              ondblclick: () => choose(m.id),
            },
              h('td', null, h('strong', null, m.name), h('div', { class: 'muted small' }, m.id)),
              h('td', null, m.provider),
              h('td', { class: 'num' }, m.context ? `${Math.round(m.context / 1000)}k` : '—'),
              h('td', { class: 'num' }, money(m.prompt)),
              h('td', { class: 'num' }, money(m.completion)),
              h('td', null, m.images ? h('span', { class: 'pill tone-doing' }, 'text + image') : h('span', { class: 'muted small' }, 'text'))))))));
  };

  const paint = () => {
    const providers = countBy(models, (m) => m.provider);
    toolbar.replaceChildren(
      h('input', {
        type: 'search',
        class: 'mp-search',
        placeholder: 'Search name, id or description',
        'aria-label': 'Search models',
        value: state.q,
        /** @param {{ target: HTMLInputElement }} e */
        oninput: (e) => {
          state.q = e.target.value;
          paintTable();
        },
      }),
      h('select', {
        value: state.provider,
        'aria-label': 'Provider',
        /** @param {{ target: HTMLSelectElement }} e */
        onchange: (e) => {
          state.provider = e.target.value;
          paint();
        },
      },
        h('option', { value: '' }, `All providers (${models.length})`),
        Object.keys(providers).sort().map((p) => h('option', { value: p }, `${p} (${providers[p]})`))),
      h('select', {
        value: state.sort,
        'aria-label': 'Sort',
        /** @param {{ target: HTMLSelectElement }} e */
        onchange: (e) => {
          state.sort = e.target.value;
          paint();
        },
      },
        h('option', { value: 'name' }, 'Sort: name'),
        h('option', { value: 'price' }, 'Sort: cheapest input'),
        h('option', { value: 'context' }, 'Sort: largest context')),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.images, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => { state.images = e.target.checked; paint(); } }),
        ' Reads images'),
      h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.free, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => { state.free = e.target.checked; paint(); } }),
        ' Free only'));
    paintTable();
    paintDetails();
  };

  getCatalog()
    .then((list) => {
      models = list;
      status.remove();
      paint();
    })
    .catch((/** @type {Error} */ err) => {
      status.textContent = `Could not load models: ${err.message}. Check your connection and try again.`;
      status.className = 'error';
    });
}
