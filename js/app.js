// Shell: folder connection, hash router, and top navigation.
import { fsSupported, pickFolder, loadHandle, hasPermission } from './storage.js';
import { createStore } from './store.js';
import { h, icon } from './ui.js';
import { configure } from './github.js';
import { modules } from './modules/index.js';
import { migrateLegacyProjects } from './modules/projects.js';

const app = document.getElementById('app');
const STATUS_LABELS = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' };

let store = null;
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

const collectionDefaults = () => Object.fromEntries(modules.filter((m) => m.collection).map((m) => [m.collection, m.defaults]));
const currentModule = () => modules.find((m) => m.id === (location.hash.replace(/^#\//, '') || 'home')) ?? modules[0];

function render() {
  if (!store) return renderConnect();
  const mod = currentModule();
  const main = h('main', { class: 'view' });
  mod.render(main, store);
  app.replaceChildren(
    h('header', { class: 'topbar' },
      h('a', { href: '#/home', class: 'brand' }, 'Board'),
      h('nav', { class: 'tabs' },
        modules.filter((m) => !m.hidden).map((m) => h('a', { href: `#/${m.id}`, class: m.id === mod.id ? 'tab active' : 'tab' }, icon(m.icon), m.title))),
      h('div', { class: 'topbar-end' },
        h('span', { id: 'save-status', class: `status ${store.status}` }, STATUS_LABELS[store.status]),
        h('a', { href: '#/settings', class: 'icon-btn settings-link', title: 'Settings', 'aria-label': 'Settings' }, icon('settings')),
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
  configure(store.get('settings').github?.token ?? '');
  migrateLegacyProjects(store);
  store.subscribe(render);
  store.onStatus(updateStatus);
  connectError = '';
  render();
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
  window.addEventListener('hashchange', () => store && render());
  window.addEventListener('beforeunload', () => store?.flush());
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
