// The Brand block of a project's page: its images, colour swatches, fonts, style links and notes, edited by hand as
// "Label: value" lines, or found with AI from the local folder and the website (js/brand.js).
/** @import { Store, Project, ProjectBrand, BrandItem } from '../../types/data' */
/** @import { BrandList } from '../brand.js' */
import { h, icon, refreshIcon, notice, copyable } from '../ui.js';
import { richText } from '../rich.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { readFile } from '../terminal.js';
import { runnerOf } from '../dev-core.js';
import { fmtCost } from '../dev-usage.js';
import { BRAND_LISTS, brandOf, hasBrand, hasBrandSources, findBrand, cleanItems, isUrl, nameOf } from '../brand.js';

/** @type {Record<BrandList, { title: string, placeholder: string }>} */
const LISTS = {
  images: { title: 'Images', placeholder: 'Logo: https://example.com/logo.svg\nFavicon: ~/code/my-app/public/favicon.ico' },
  colors: { title: 'Colours', placeholder: 'Primary: #2f6f4e\nBackground (dark): #111418' },
  fonts: { title: 'Fonts', placeholder: 'Headings: Inter\nBody: Source Serif' },
  links: { title: 'Style sheets and links', placeholder: 'Stylesheet: https://example.com/style.css\nTokens: ~/code/my-app/src/tokens.css' },
};

// Per project id: { status: 'loading' | 'error' | 'done', step?, error? }. Editing holds the id being edited.
/** @type {Map<string, { status: string, step?: string, error?: string }>} */
const findState = new Map();
const brandView = { editing: /** @type {string | null} */ (null) };

// Local SVG files are read through the runner and shown from their text; other local images cannot be shown.
/** @type {Map<string, string>} */
const svgCache = new Map();

/** @param {Store} store @param {Project} p */
async function runFind(store, p) {
  const state = { status: 'loading', step: 'Reading the folder and the website…' };
  findState.set(p.id, state);
  store.refresh();
  try {
    const { added } = await findBrand(store, p, {
      onStep: (step) => {
        state.step = step;
        store.refresh();
      },
    });
    findState.set(p.id, { status: 'done', step: added ? `Added ${added} new ${added === 1 ? 'item' : 'items'}.` : 'Nothing new was found.' });
  } catch (err) {
    findState.set(p.id, { status: 'error', error: /** @type {Error} */ (err).message });
  }
  store.refresh();
}

/** @param {Store} store @param {string} id @param {Partial<ProjectBrand>} patch */
function saveBrand(store, id, patch) {
  store.update('projects', (d) => {
    const x = d.projects.find((q) => q.id === id);
    if (x) x.brand = { ...brandOf(x), ...patch };
  });
}

// "Label: value" per line; a line without a label is the value alone. URLs keep their colon: the label needs a space
// after its colon.
/** @param {BrandList} list @param {string} text */
export function parseLines(list, text) {
  const items = text.split('\n').map((l) => l.trim()).filter(Boolean).map((line) => {
    const m = line.match(/^([^:]*\S)\s*:\s+(\S.*)$/);
    return m && !isUrl(line) ? { label: m[1], value: m[2] } : { label: '', value: line };
  });
  return cleanItems(list, items);
}

/** @param {BrandItem[]} items */
const toLines = (items) => items.map((i) => (i.label ? `${i.label}: ${i.value}` : i.value)).join('\n');

/** @param {Store} store @param {string} value */
function imageThumb(store, value) {
  /** @param {string} src */
  const img = (src) => h('img', {
    src,
    alt: '',
    loading: 'lazy',
    // Its real size shows in the corner, so a favicon and a share image read at a glance.
    onload: (/** @type {Event & { target: HTMLImageElement }} */ e) => {
      const size = e.target.parentElement?.querySelector('.brand-size');
      if (size && e.target.naturalWidth) size.textContent = `${e.target.naturalWidth} × ${e.target.naturalHeight}`;
    },
    onerror: (/** @type {Event & { target: HTMLImageElement }} */ e) => e.target.replaceWith(h('span', { class: 'brand-thumb-none' }, icon('image'))),
  });
  if (isUrl(value)) return img(value);
  if (!/\.svg$/i.test(value)) return h('span', { class: 'brand-thumb-none', title: 'Only SVG files in the local folder can be shown' }, icon('image'));
  const cached = svgCache.get(value);
  if (cached) return img(cached);
  const slot = h('span', { class: 'brand-thumb-none' }, icon('image'));
  readFile(runnerOf(store), value).then((r) => {
    if (typeof r.text !== 'string') return;
    // An <img> runs no script in an SVG, so the file's text is safe to show this way.
    const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(r.text)}`;
    svgCache.set(value, src);
    slot.replaceWith(img(src));
  }, () => {});
  return slot;
}

// An address opens in a new tab; a local path is copied.
/** @param {string} value */
const target = (value) => (isUrl(value)
  ? h('a', { href: value, target: '_blank', rel: 'noopener', class: 'muted small brand-addr' }, value.replace(/^https?:\/\//, ''))
  : copyable(value));

/** @param {string} title @param {HTMLElement} body */
const group = (title, body) => h('div', { class: 'stack' }, h('h4', { class: 'brand-sub' }, title), body);

/** @param {Store} store @param {ProjectBrand} brand */
function brandDisplay(store, brand) {
  return h('div', { class: 'stack' },
    brand.colors.length ? group('Colours', h('div', { class: 'brand-swatches' }, brand.colors.map((c) => h('div', { class: 'brand-swatch' },
      // The swatch shows the project's own colour, which is data, not a theme colour.
      h('span', { class: 'brand-chip', style: { background: c.value } }),
      h('span', { class: 'small' }, c.label || ' '),
      copyable(c.value))))) : null,
    brand.images.length ? group('Images', h('div', { class: 'brand-images' }, brand.images.map((i) => h('div', { class: 'brand-image' },
      h('div', { class: 'brand-thumb' }, imageThumb(store, i.value), h('span', { class: 'brand-size' })),
      h('strong', { class: 'small' }, i.label || nameOf(i.value)),
      target(i.value))))) : null,
    brand.fonts.length ? group('Fonts', h('ul', { class: 'brand-list' }, brand.fonts.map((f) => h('li', null,
      h('span', { class: 'muted small' }, f.label || 'Font'),
      // Shown in the font itself when this machine has it.
      h('span', { class: 'brand-font', style: { fontFamily: `"${f.value.replace(/"/g, '')}", var(--font)` } }, f.value))))) : null,
    brand.links.length ? group('Style sheets and links', h('ul', { class: 'brand-list' }, brand.links.map((l) => h('li', null,
      h('span', { class: 'muted small' }, l.label || nameOf(l.value)),
      target(l.value))))) : null,
    brand.notes.trim() ? group('Notes', h('div', { class: 'small' }, richText(brand.notes))) : null);
}

/** @param {Store} store @param {Project} p @param {ProjectBrand} brand */
function brandForm(store, p, brand) {
  const fields = Object.fromEntries(BRAND_LISTS.map((list) => [list, h('textarea', {
    name: `brand-${list}`,
    rows: Math.min(10, Math.max(3, brand[list].length + 1)),
    placeholder: LISTS[list].placeholder,
    value: toLines(brand[list]),
  })]));
  const notes = h('textarea', { name: 'brand-notes', rows: 3, placeholder: 'Tone, light or dark, shapes…', value: brand.notes });
  const close = () => {
    brandView.editing = null;
    store.refresh();
  };
  return h('div', { class: 'stack' },
    h('p', { class: 'muted small' }, 'One per line, as "Label: value". Images and links take a URL or a path in the local folder.'),
    BRAND_LISTS.map((list) => h('label', null, LISTS[list].title, fields[list])),
    h('label', null, 'Notes', notes),
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn-small primary',
        onclick: () => {
          brandView.editing = null;
          /** @type {Partial<ProjectBrand>} */
          const patch = { notes: notes.value.trim() };
          for (const list of BRAND_LISTS) patch[list] = parseLines(list, /** @type {HTMLTextAreaElement} */ (fields[list]).value);
          saveBrand(store, p.id, patch);
        },
      }, 'Save'),
      h('button', { type: 'button', class: 'btn-small', onclick: close }, 'Cancel')));
}

/** @param {Store} store @param {ProjectBrand} brand */
function brandMeta(store, brand) {
  const call = brand.usageId ? store.get('usage').entries.find((e) => e.id === brand.usageId) : null;
  return [
    brand.updated ? `Found with AI ${new Date(brand.updated).toLocaleDateString()}` : '',
    call?.model ?? '',
    call && call.cost !== null && call.cost !== undefined ? fmtCost(call.cost) : '',
  ].filter(Boolean).join(' · ');
}

/** @param {Store} store @param {Project} p */
export function brandBlock(store, p) {
  const brand = brandOf(p);
  const state = findState.get(p.id);
  const busy = state?.status === 'loading';
  const ai = hasOpenRouter(store);
  const head = h('h3', null, 'Brand');
  if (brandView.editing === p.id) return h('section', { class: 'pp-block' }, head, brandForm(store, p, brand));

  const filled = hasBrand(brand);
  return h('section', { class: 'pp-block' },
    head,
    filled
      ? brandDisplay(store, brand)
      : h('p', { class: 'muted small' }, 'The logo, favicon, colours, fonts and style sheets of this project, in one place. Add them by hand, or let AI find them in the local folder and on the website.'),
    filled && brand.updated ? h('div', { class: 'muted small' }, brandMeta(store, brand)) : null,
    h('div', { class: 'row' },
      h('button', {
        type: 'button',
        class: 'btn-small',
        disabled: busy,
        onclick: () => {
          brandView.editing = p.id;
          store.refresh();
        },
      }, icon('pencil'), filled ? 'Edit' : 'Add by hand'),
      ai ? h('button', {
        type: 'button',
        class: 'btn-small',
        disabled: busy || !hasBrandSources(p),
        'aria-busy': busy ? 'true' : null,
        title: hasBrandSources(p) ? 'Read the local folder and the website, and add what is new' : 'Add a local folder or a website first',
        onclick: () => runFind(store, p),
      }, busy ? refreshIcon(true) : icon('sparkle'), busy ? 'Finding…' : 'Find with AI') : null),
    ai ? null : setupBanner('openrouter', 'Finding the brand with AI needs an OpenRouter key.'),
    busy || state?.status === 'done' ? h('p', { class: 'muted small' }, state?.step) : null,
    state?.status === 'error' ? notice({ text: state.error ?? '' }) : null);
}
