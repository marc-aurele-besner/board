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
import { JUMPS, openShortcuts } from './shortcuts.js';
import { sampleFolder } from './sample.js';
import { toast } from './toast.js';

const app = document.getElementById('app');
const STATUS_LABELS = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' };
// With sample data nothing reaches the disk, so the status never claims a save.
const statusText = (status) => (sample ? 'Not saved' : STATUS_LABELS[status]);

let store = null;
let sample = false; // exploring with sample data, kept in memory only
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
  // An address that names no section opens Home. Say so once; syncUrl below then corrects the address.
  const asked = readRoute().id;
  if (asked !== mod.id) toast(`There is no page at “${asked}”. Showing ${mod.title}.`);
  const main = h('main', { class: 'view' });
  // Only a change of section plays the entrance animation; edits within a section re-render silently.
  if (mod.id !== lastSection) {
    main.classList.add('enter');
    lastSection = mod.id;
  }
  mod.render(main, store);
  syncUrl(mod);
  // replaceChildren would print a null as text, so the parts that may be absent are filtered out.
  app.replaceChildren(...[
    h('header', { class: 'topbar' },
      h('a', { href: '#/home', class: 'brand' }, 'Board'),
      h('nav', { class: 'tabs' },
        modules.filter((m) => !m.hidden).map((m) =>
          h('a', { href: `#/${m.id}`, class: m.id === mod.id ? 'tab active' : 'tab', title: m.title, 'aria-current': m.id === mod.id ? 'page' : null },
            icon(m.icon), h('span', { class: 'tab-label' }, m.short ?? m.title)))),
      h('div', { class: 'topbar-end' },
        h('button', { type: 'button', class: 'search-btn', title: 'Search or jump', onclick: () => openPalette(store, modules) },
          icon('search'), h('span', { class: 'grow' }, 'Search or jump…'), h('kbd', null, isMac ? '⌘K' : 'Ctrl K')),
        h('span', { id: 'save-status', class: `status ${store.status}` }, statusText(store.status)),
        bell(store),
        // Settings lives here as an icon, not in the section tabs.
        h('a', {
          href: '#/settings',
          class: mod.id === 'settings' ? 'icon-btn settings-link active' : 'icon-btn settings-link',
          title: 'Settings',
          'aria-label': 'Settings',
          'aria-current': mod.id === 'settings' ? 'page' : null,
        }, icon('settings')),
        h('button', {
          type: 'button',
          class: 'icon-btn theme-toggle',
          title: isDark() ? 'Switch to light theme' : 'Switch to dark theme',
          'aria-label': isDark() ? 'Switch to light theme' : 'Switch to dark theme',
          onclick: toggleTheme,
        }, icon(isDark() ? 'sun' : 'moon')))),
    sample
      ? h('div', { class: 'sample-bar' },
          icon('info'),
          h('span', { class: 'grow' }, 'This is sample data. Changes stay in this tab and are gone when you reload.'),
          fsSupported()
            ? h('button', { type: 'button', class: 'btn-small primary', onclick: () => window.dispatchEvent(new CustomEvent('board:pick-folder')) }, 'Choose data folder')
            : h('span', { class: 'muted small' }, 'Open the board in Chrome or Edge to keep your own data.'))
      : null,
    main,
  ].filter(Boolean));
  main.querySelector('[data-autofocus]')?.focus();
}

function updateStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.textContent = statusText(status);
  el.className = `status ${status}`;
}

function renderConnect() {
  const explore = h('button', { onclick: exploreSample }, 'Explore with sample data');
  if (!fsSupported()) {
    app.replaceChildren(h('section', { class: 'card connect' },
      h('h1', null, 'Board'),
      h('p', { class: 'error' }, 'This app needs the File System Access API. Open it in Chrome or Edge.'),
      h('p', { class: 'muted small' }, 'You can still look around with sample data. Nothing is saved.'),
      h('div', { class: 'actions' }, explore)));
    return;
  }
  const actions = [];
  if (pendingHandle) {
    actions.push(h('button', { class: 'primary', onclick: reconnect }, `Reconnect “${pendingHandle.name}”`));
    actions.push(h('button', { onclick: chooseFolder }, 'Pick another folder'));
  } else {
    actions.push(h('button', { class: 'primary', onclick: chooseFolder }, 'Choose data folder'));
  }
  actions.push(explore);
  app.replaceChildren(h('section', { class: 'card connect' },
    h('h1', null, 'Board'),
    h('p', null, 'Your data lives as plain JSON files in a folder you choose. Pick a folder outside this repo.'),
    connectError ? h('p', { class: 'error' }, connectError) : null,
    h('div', { class: 'actions' }, actions)));
}

// Opens the board on a folder that lives in memory. The background jobs stay off, so nothing is checked or sent
// on behalf of placeholder projects.
function exploreSample() {
  sample = true;
  return open(sampleFolder());
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
  if (!sample) startBackground(store);
}

const CHORD_MS = 1500;
let chordAt = 0; // when "g" was pressed, waiting for the letter of a section

// Cmd/Ctrl+K anywhere opens the search palette. The single keys only work outside a field and with nothing open
// over the page: "/" and "n" open the palette, "?" lists the shortcuts, and "g" then a letter jumps to a section.
function onShortcut(e) {
  if (!store) return;
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
  const combo = (e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k';
  if (combo || (e.key === '/' && !typing)) {
    e.preventDefault();
    return openPalette(store, modules);
  }
  if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
  if (document.querySelector('.modal-overlay, .palette-overlay, .drawer-overlay, .popover')) return;
  const key = e.key.toLowerCase();
  if (Date.now() - chordAt < CHORD_MS) {
    chordAt = 0;
    const id = JUMPS.find(([letter]) => letter === key)?.[1];
    if (!id) return;
    e.preventDefault();
    location.hash = `#/${id}`;
  } else if (key === 'g') {
    chordAt = Date.now();
  } else if (key === 'n') {
    e.preventDefault();
    openPalette(store, modules);
  } else if (e.key === '?') {
    e.preventDefault();
    openShortcuts();
  }
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
  // Settings › Data folder asks for another folder.
  // The page reloads on the new folder, so timers and caches that belong to the old one are dropped with it.
  window.addEventListener('board:pick-folder', async () => {
    try {
      await store?.flush();
      await pickFolder();
      location.reload();
    } catch (err) {
      if (err.name !== 'AbortError') console.error('Could not open folder', err);
    }
  });
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
