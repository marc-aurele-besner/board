// Shell: folder connection, hash router, and top navigation.
import { fsSupported, pickFolder, loadHandle, hasPermission } from './storage.js';
import { createStore } from './store.js';
import { h, icon } from './ui.js';
import { configure } from './github.js';
import { ensureTasks, applyAppearance } from './modules/settings.js';
import { modules } from './modules/index.js';
import { migrateLegacyProjects, migrateProjectShape } from './modules/projects.js';
import { bell, COLLECTION as NOTIFICATIONS, DEFAULTS as NOTIFICATION_DEFAULTS } from './notifications.js';
import { openPalette } from './palette.js';
import { startBackground } from './background.js';

const app = document.getElementById('app');
const STATUS_LABELS = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' };

let store = null;
let lastSection = null;
let pendingHandle = null; // remembered folder that still needs permission
let connectError = '';

const THEME_KEY = 'board:theme';

// No saved choice means "follow the OS", so resolve the effective theme from both.
const isDark = () =>
  (document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')) === 'dark';

function toggleTheme() {
  const next = isDark() ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  render();
}

// One file per section, plus notifications.json, which belongs to the top bar and not to a section.
const collectionDefaults = () => ({
  ...Object.fromEntries(modules.filter((m) => m.collection).map((m) => [m.collection, m.defaults])),
  [NOTIFICATIONS]: NOTIFICATION_DEFAULTS,
});
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// The URL is #/<section>?<view params>. The params restore each section's view after a refresh.
function readRoute() {
  const [path = '', query = ''] = location.hash.replace(/^#\//, '').split('?');
  return { id: path || 'home', params: Object.fromEntries(new URLSearchParams(query)) };
}
const currentModule = () => modules.find((m) => m.id === readRoute().id) ?? modules[0];

// Writes the section's view into the URL without adding history entries.
function syncUrl(mod) {
  const params = mod.serialize?.() ?? {};
  const kept = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false);
  const query = new URLSearchParams(kept).toString();
  const hash = `#/${mod.id}${query ? `?${query}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

function render() {
  if (!store) return renderConnect();
  const mod = currentModule();
  const main = h('main', { class: 'view' });
  // Only a change of section plays the entrance animation; edits within a section re-render silently.
  if (mod.id !== lastSection) {
    main.classList.add('enter');
    lastSection = mod.id;
  }
  mod.render(main, store);
  syncUrl(mod);
  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('a', { href: '#/home', class: 'brand' }, 'Board'),
      h('nav', { class: 'tabs' },
        modules.filter((m) => !m.hidden).map((m) =>
          h('a', { href: `#/${m.id}`, class: m.id === mod.id ? 'tab active' : 'tab', title: m.title, 'aria-current': m.id === mod.id ? 'page' : null },
            icon(m.icon), h('span', { class: 'tab-label' }, m.short ?? m.title)))),
      h('div', { class: 'topbar-end' },
        h('button', { type: 'button', class: 'search-btn', title: 'Search or jump', onclick: () => openPalette(store, modules) },
          icon('search'), h('span', { class: 'grow' }, 'Search or jump…'), h('kbd', null, isMac ? '⌘K' : 'Ctrl K')),
        h('span', { id: 'save-status', class: `status ${store.status}` }, STATUS_LABELS[store.status]),
        bell(store),
        h('button', {
          type: 'button',
          class: 'icon-btn theme-toggle',
          title: isDark() ? 'Switch to light theme' : 'Switch to dark theme',
          'aria-label': isDark() ? 'Switch to light theme' : 'Switch to dark theme',
          onclick: toggleTheme,
        }, icon(isDark() ? 'sun' : 'moon')))),
    main,
  );
  main.querySelector('[data-autofocus]')?.focus();
}

function updateStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = STATUS_LABELS[status];
  el.className = `status ${status}`;
}

function renderConnect() {
  if (!fsSupported()) {
    app.replaceChildren(h('section', { class: 'card connect' },
      h('h1', null, 'Board'),
      h('p', { class: 'error' }, 'This app needs the File System Access API. Open it in Chrome or Edge.')));
    return;
  }
  const actions = [];
  if (pendingHandle) {
    actions.push(h('button', { class: 'primary', onclick: reconnect }, `Reconnect “${pendingHandle.name}”`));
    actions.push(h('button', { onclick: chooseFolder }, 'Pick another folder'));
  } else {
    actions.push(h('button', { class: 'primary', onclick: chooseFolder }, 'Choose data folder'));
  }
  app.replaceChildren(h('section', { class: 'card connect' },
    h('h1', null, 'Board'),
    h('p', null, 'Your data lives as plain JSON files in a folder you choose. Pick a folder outside this repo.'),
    connectError ? h('p', { class: 'error' }, connectError) : null,
    h('div', { class: 'actions' }, actions)));
}

async function open(handle) {
  const next = createStore(handle, collectionDefaults());
  try {
    await next.load();
  } catch (err) {
    connectError = `Could not read data: ${err.message}`;
    return renderConnect();
  }
  store = next;
  configure(store.get('settings').github);
  migrateLegacyProjects(store);
  migrateProjectShape(store);
  ensureTasks(store);
  store.subscribe(render);
  store.onStatus(updateStatus);
  connectError = '';
  currentModule().restore?.(readRoute().params);
  render();
  startBackground(store);
}

// Cmd/Ctrl+K anywhere, or "/" outside a field, opens the search palette.
function onShortcut(e) {
  if (!store) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const combo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if (!combo && !(e.key === '/' && !typing)) return;
  e.preventDefault();
  openPalette(store, modules);
}

async function chooseFolder() {
  try {
    await open(await pickFolder());
  } catch (err) {
    if (err.name !== 'AbortError') connectError = `Could not open folder: ${err.message}`;
    renderConnect();
  }
}

async function reconnect() {
  try {
    if (await hasPermission(pendingHandle, true)) return open(pendingHandle);
    connectError = 'Permission was not granted.';
  } catch (err) {
    connectError = `Could not reconnect: ${err.message}`;
  }
  renderConnect();
}

async function boot() {
  applyAppearance();
  // A link or the back button changed the route: load that section's view from the URL, then render.
  window.addEventListener('hashchange', () => {
    if (!store) return;
    currentModule().restore?.(readRoute().params);
    render();
  });
  window.addEventListener('beforeunload', () => store?.flush());
  document.addEventListener('keydown', onShortcut);
  if (!fsSupported()) return renderConnect();
  try {
    pendingHandle = await loadHandle();
  } catch {
    pendingHandle = null;
  }
  if (pendingHandle && (await hasPermission(pendingHandle))) return open(pendingHandle);
  renderConnect();
}

boot();
