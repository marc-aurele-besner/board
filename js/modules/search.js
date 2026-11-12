// Full-page search, opened from the last row of the palette. "All" shows a few matches of each kind; a tab per kind
// shows every match of that kind.
/** @import { Store, IconName } from '../../types/data' */
/** @import { SearchResult } from '../search.js' */
import { h, icon, empty } from '../ui.js';
import { searchAll, GROUPS } from '../search.js';
import { QUERY_HINT } from '../task-query.js';
import { modules } from './index.js';

const PREVIEW = 5;
/** @type {[string, string, IconName][]} */
const TABS = [['all', 'All', 'search'], ...GROUPS];

// query: the search text. tab: 'all' or a GROUPS key.
const view = { query: '', tab: 'all' };

/** @param {SearchResult} item */
function resultRow(item) {
  const body = [icon(item.iconName), h('span', { class: 'grow' }, item.label), item.hint ? h('span', { class: 'muted small' }, item.hint) : null];
  return h('li', { class: item.done ? 'search-row done' : 'search-row' },
    item.href ? h('a', { href: item.href }, ...body) : h('button', { type: 'button', onclick: item.run }, ...body));
}

/** @param {Store} store @param {string} key @param {string} label @param {SearchResult[]} items @param {number} limit */
function groupBlock(store, key, label, items, limit) {
  const shown = limit ? items.slice(0, limit) : items;
  const tasksLink = key === 'tasks'
    ? h('a', { class: 'btn-small', href: `#/todos?${new URLSearchParams({ filter: 'all', status: 'all', q: view.query.trim() })}` }, icon('list'), 'Filter in Tasks')
    : null;
  return h('section', { class: 'search-group' },
    h('h3', { class: 'row' }, label, h('span', { class: 'count' }, String(items.length)), h('span', { class: 'grow' }), tasksLink),
    h('ul', { class: 'search-list' }, shown.map(resultRow)),
    limit && items.length > limit
      ? h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            view.tab = key;
            store.refresh();
          },
        }, `Show all ${items.length} ${label.toLowerCase()}`)
      : null);
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  const box = h('div', { class: 'search-results' });
  const tabs = h('div', { class: 'segmented r-tabs search-tabs', role: 'group', 'aria-label': 'Result kinds' });
  // Only the tabs and results refill while typing, so the search box keeps focus.
  const fill = () => {
    const found = searchAll(store, modules, view.query);
    const total = GROUPS.reduce((n, [key]) => n + found[key].length, 0);
    tabs.replaceChildren(...TABS.map(([key, label, iconName]) =>
      h('button', {
        type: 'button',
        class: key === view.tab ? 'seg active' : 'seg',
        'aria-pressed': String(key === view.tab),
        onclick: () => {
          view.tab = key;
          store.refresh();
        },
      }, icon(iconName), `${label} · ${key === 'all' ? total : found[key].length}`)));
    if (!view.query.trim()) {
      box.replaceChildren(empty(`Type to search tasks, projects, recipes, sections and settings. Tasks also take filters: ${QUERY_HINT}.`));
    } else if (view.tab === 'all') {
      const blocks = GROUPS.filter(([key]) => found[key].length).map(([key, label]) => groupBlock(store, key, label, found[key], PREVIEW));
      box.replaceChildren(...(blocks.length ? blocks : [empty(`Nothing matches “${view.query.trim()}”.`)]));
    } else {
      // restore() only keeps a tab that exists.
      const [key, label] = /** @type {[string, string, IconName]} */ (GROUPS.find(([k]) => k === view.tab));
      box.replaceChildren(found[key].length ? groupBlock(store, key, label, found[key], 0) : empty(`No ${label.toLowerCase()} match “${view.query.trim()}”.`));
    }
  };
  fill();
  /** @type {number | null} */
  let urlTimer = null;
  root.append(h('div', { class: 'stack-lg search-page' },
    h('header', null, h('h2', null, 'Search')),
    h('label', { class: 'r-search' }, icon('search'),
      h('input', {
        type: 'search',
        placeholder: 'Search everything',
        'aria-label': 'Search everything',
        autocomplete: 'off',
        value: view.query,
        'data-autofocus': true,
        oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
          view.query = e.target.value;
          fill();
          // The address follows the search without re-rendering the page.
          clearTimeout(/** @type {number} */ (urlTimer));
          urlTimer = setTimeout(() => {
            const params = new URLSearchParams(Object.entries(serialize()).filter(([, v]) => v));
            history.replaceState(null, '', `#/search${params.size ? `?${params}` : ''}`);
          }, 300);
        },
      })),
    tabs,
    box));
}

const serialize = () => ({ q: view.query, tab: view.tab === 'all' ? '' : view.tab });

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'search',
  title: 'Search',
  icon: 'search',
  hidden: true, // opened from the palette
  render: draw,
  serialize,
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.query = p.q || '';
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'all';
  },
});
