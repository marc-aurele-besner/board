// Shell: folder connection, hash router, and top navigation.
import { fsSupported, pickFolder, loadHandle, hasPermission } from './storage.js';
import { createStore } from './store.js';
import { h, icon, uid, keepImages, steadyAnimations, patch } from './ui.js';
import { configure } from './github.js';
import { ensureTasks } from './modules/settings.js';
import { applyAppearance, startSection, hiddenSections, linksInNewTab, THEME_KEY } from './appearance.js';
import { modules } from './modules/index.js';
import { migrateLegacyProjects, migrateProjectShape } from './modules/projects.js';
import { bell, COLLECTION as NOTIFICATIONS, DEFAULTS as NOTIFICATION_DEFAULTS } from './notifications.js';
import { openPalette } from './palette.js';
import { watchRunners, runnersOnline, runnersKnown } from './runners.js';
import { watchAttention, attentionOf, attentionTitle } from './attention.js';
import { GOOGLE, GOOGLE_DEFAULTS, useGoogleStore } from './google.js';
import { CALENDAR, CALENDAR_DEFAULTS } from './gcal.js';
import { GITHUB, GITHUB_DEFAULTS, useGithubStore } from './github.js';
import { NPM, NPM_DEFAULTS, useNpmStore } from './npm.js';
import { WEBSTATS, WEBSTATS_DEFAULTS } from './webstats.js';
import { SOCIALS, SOCIALS_DEFAULTS } from './socials.js';
import { LINKEDIN, LINKEDIN_DEFAULTS } from './linkedin-core.js';
import { CONTACTS, CONTACTS_DEFAULTS } from './contacts-core.js';
import { FX, FX_DEFAULTS, useFxStore } from './fx.js';
import { JUMPS, openShortcuts } from './shortcuts.js';
import { sampleFolder } from './sample.js';
import { toast } from './toast.js';
import { watchKeepAwake } from './wake-lock.js';
import { markDrawn, snapshot, restore, holding, watchCommits } from './keep-fields.js';
import { watchAppVersion, takeCarried } from './app-version.js';

/** @import { Store, Module } from '../types/data' */

// index.html always has it.
const app = /** @type {HTMLElement} */ (document.getElementById('app'));
const STATUS_LABELS = { saved: 'Saved', saving: 'Saving…', error: 'Save failed' };
// With sample data nothing reaches the disk, so the status never claims a save.
/** @param {keyof typeof STATUS_LABELS} status */
const statusText = (status) => (sample ? 'Not saved' : STATUS_LABELS[status]);
// The status is an icon shown only while something is not on disk: orange while saving (or with sample data), red when a save failed.
/** @param {keyof typeof STATUS_LABELS} status */
const statusClass = (status) => `status ${sample ? 'unsaved' : status}`;
/** @param {keyof typeof STATUS_LABELS} status */
const statusHidden = (status) => !sample && status === 'saved';

/** @type {Store | null} */
let store = null;
let sample = false; // exploring with sample data, kept in memory only
/** @type {string | null} */
let lastSection = null;
/** @type {FileSystemDirectoryHandle | null | undefined} */
let pendingHandle = null; // remembered folder that still needs permission
let connectError = '';
let held = false; // a rebuild is waiting for the user to leave the field they are typing in

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

// One file per section, plus notifications.json (the top bar's) and google.json, which belong to no section.
const collectionDefaults = () => ({
  ...Object.fromEntries(modules.filter((m) => m.collection).map((m) => [m.collection, m.defaults])),
  [NOTIFICATIONS]: NOTIFICATION_DEFAULTS,
  // Google sign-ins and account pictures, shared by Gmail, Calendar, Analytics and Search Console.
  [GOOGLE]: GOOGLE_DEFAULTS,
  // The events the runners read, shared by Calendar, Home and Cron.
  [CALENDAR]: CALENDAR_DEFAULTS,
  // What the runners read for Projects (GitHub, npm), Monitoring (Bing) and Money (exchange rates).
  [GITHUB]: GITHUB_DEFAULTS,
  [NPM]: NPM_DEFAULTS,
  [WEBSTATS]: WEBSTATS_DEFAULTS,
  // The X, LinkedIn, GitHub and Instagram accounts and their follower counts (Settings, Monitoring → Socials).
  [SOCIALS]: SOCIALS_DEFAULTS,
  // LinkedIn's posts, comments and sign-in (Settings → LinkedIn, Projects, Inbox, Monitoring → Socials).
  [LINKEDIN]: LINKEDIN_DEFAULTS,
  // People tied to projects, matched by email in Inbox and Calendar.
  [CONTACTS]: CONTACTS_DEFAULTS,
  [FX]: FX_DEFAULTS,
});
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// The URL is #/<section>?<view params>. The params restore each section's view after a refresh.
function readRoute() {
  const [path = '', query = ''] = location.hash.replace(/^#\//, '').split('?');
  return { id: path || startSection(), params: Object.fromEntries(new URLSearchParams(query)) };
}
const currentModule = () => modules.find((m) => m.id === readRoute().id) ?? modules[0];

// Writes the section's view into the URL without adding history entries.
/** @param {Module} mod */
function syncUrl(mod) {
  const params = mod.serialize?.() ?? {};
  const kept = Object.entries(params).filter(([, v]) => v !== '' && v !== null && v !== undefined && v !== false);
  // URLSearchParams turns each value into text.
  const query = new URLSearchParams(/** @type {[string, string][]} */ (kept)).toString();
  const hash = `#/${mod.id}${query ? `?${query}` : ''}`;
  if (location.hash !== hash) history.replaceState(null, '', hash);
}

// `user` is false for a render no click or key asked for, which must not move the focus.
/** @param {{ user?: boolean }} [options] */
function render({ user = true } = {}) {
  if (!store) return renderConnect();
  const mod = currentModule();
  // An address that names no section opens Home. Say so once; syncUrl below then corrects the address.
  const asked = readRoute().id;
  if (asked !== mod.id) toast(`There is no page at “${asked}”. Showing ${mod.title}.`);
  held = false;
  lastRender = performance.now();
  const before = app.querySelector('main.view');
  // Unsubmitted fields are carried over within a section; a new section starts clean.
  const kept = before && mod.id === lastSection ? snapshot(before) : [];
  const main = h('main', { class: 'view', 'data-section': mod.id });
  // What this render reads (and the section's own redraws until the next one) decides which disk changes redraw it.
  store.forget();
  // Only a change of section plays the entrance animation; edits within a section re-render silently.
  const entered = mod.id !== lastSection;
  if (entered) {
    main.classList.add('enter');
    lastSection = mod.id;
  }
  mod.render(main, store);
  syncUrl(mod);
  // Null parts (the sample bar) are filtered out.
  const parts = /** @type {HTMLElement[]} */ ([
    h('header', { class: entered ? 'topbar enter' : 'topbar' },
      h('nav', { class: 'tabs' },
        modules.filter((m) => !m.hidden && (m.id === mod.id || !hiddenSections().has(m.id))).map((m) =>
          h('a', { href: `#/${m.id}`, class: m.id === mod.id ? 'tab active' : 'tab', title: m.title, 'data-id': m.id, 'aria-current': m.id === mod.id ? 'page' : null },
            icon(m.icon), h('span', { class: 'tab-label' }, m.short ?? m.title),
            // What waits on the user there (Slack mentions, Dev terminals); js/attention.js updates it in place.
            h('span', { class: 'tab-pill', title: attentionTitle(m.id), hidden: !attentionOf(m.id) }, attentionOf(m.id) > 99 ? '99+' : String(attentionOf(m.id)))))),
      h('div', { class: 'topbar-end' },
        h('button', { type: 'button', class: 'search-btn', title: 'Search or jump', onclick: () => openPalette(/** @type {Store} */ (store), modules) },
          icon('search'), h('span', { class: 'grow' }, 'Search or jump…'), h('kbd', null, isMac ? '⌘K' : 'Ctrl K')),
        h('a', { id: 'runners-offline', class: 'pill tone-high runner-offline', href: '#/settings?section=runners', title: 'The runners are not running, so mail, calendars, wallets and site checks are not refreshed. Start the board with bun start.', hidden: runnersBadgeHidden() },
          icon('alert'), 'Runners offline'),
        h('span', { id: 'save-status', class: statusClass(store.status), role: 'status', title: statusText(store.status), 'aria-label': statusText(store.status), hidden: statusHidden(store.status) }, icon('save')),
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
  // A section that opts in has its redraws patched into the page on screen, which keeps hover, scroll, focus,
  // images and animations; the others, and any change of section, swap the new page in.
  const shown = before && !entered && mod.patch ? before : main;
  if (shown === before) patch(app, h('div', null, parts));
  else {
    if (before && !entered) keepImages(before, main);
    app.replaceChildren(...parts);
  }
  markDrawn(shown);
  steadyAnimations(app);
  // Within a section the page keeps its place: focusing a field near the top would scroll back up to it.
  if (user) /** @type {HTMLElement | null} */ (shown.querySelector('[data-autofocus]'))?.focus({ preventScroll: !entered });
  restore(shown, kept);
}

// The user's own saves render at once. Saves from timers and loads (a pools search reports every block range it
// reads) render at most once per gap: rebuilding the page every frame kept the main thread busy and swallowed
// clicks whose press and release landed on two different pages. They also wait while the user is typing in a
// changed field or holding a button down, and while the tab is hidden.
const BACKGROUND_GAP_MS = 1000;
let lastRender = 0;
let gapTimer = 0;

/** @param {{ user: boolean, changed: Set<string> | null }} info */
function onData({ user, changed }) {
  if (user) return render({ user });
  // Another tab or the runners saved collections this page never read (the inbox while Dev is open): nothing to redraw.
  if (changed && !/** @type {Store} */ (store).readAny(changed)) return;
  held = true;
  settle();
}

function settle() {
  if (!held || !store || document.hidden || holding(app.querySelector('main.view'))) return;
  const wait = lastRender + BACKGROUND_GAP_MS - performance.now();
  if (wait > 0) {
    gapTimer ||= setTimeout(() => {
      gapTimer = 0;
      settle();
    }, wait);
    return;
  }
  render({ user: false });
}

// With sample data there are no runners to miss.
const runnersBadgeHidden = () => sample || !runnersKnown() || runnersOnline();

// A section with readsRunners redraws when a job's outcome changes; 'all' also when only run times did.
/** @param {{ outcome: boolean }} change */
function onRunners({ outcome }) {
  const badge = document.getElementById('runners-offline');
  if (badge) badge.hidden = runnersBadgeHidden();
  const reads = currentModule().readsRunners;
  // The runners are watched once a store is open.
  if (reads === 'all' || (reads && outcome)) /** @type {Store} */ (store).refresh();
}

/** @param {keyof typeof STATUS_LABELS} status */
function updateStatus(status) {
  const el = document.getElementById('save-status');
  if (!el) return;
  el.title = statusText(status);
  el.setAttribute('aria-label', statusText(status));
  el.className = statusClass(status);
  el.hidden = statusHidden(status);
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

/** @param {FileSystemDirectoryHandle} handle */
async function open(handle) {
  const next = createStore(handle, collectionDefaults());
  try {
    await next.load();
  } catch (err) {
    connectError = `Could not read data: ${/** @type {Error} */ (err).message}`;
    return renderConnect();
  }
  store = next;
  useGoogleStore(store);
  useGithubStore(store);
  useNpmStore(store);
  useFxStore(store);
  configure(store.get('settings').github);
  migrateLegacyProjects(store);
  migrateProjectShape(store);
  ensureTasks(store);
  store.subscribe(onData);
  store.onStatus(updateStatus);
  connectError = '';
  currentModule().restore?.(readRoute().params);
  render();
  restoreCarried();
  if (!sample) {
    // The runners report the folderId they read, so Settings can tell when they write to another folder.
    if (!store.get('settings').folderId) store.update('settings', (d) => { d.folderId = uid(); });
    watchRunners(store, onRunners);
    watchAttention(store);
  }
  // Another tab or browser may save to the same folder: bring its changes in while this one is in view.
  setInterval(() => document.hidden || /** @type {Store} */ (store).sync(), SYNC_MS);
}

const SYNC_MS = 3000;

// After a reload for a new version: the fields typed in this section, and the scroll position. The page may still
// grow as the section draws what it loads, so the scroll is tried again a little later.
function restoreCarried() {
  const carry = takeCarried();
  const main = app.querySelector('main.view');
  if (!carry || !main) return;
  restore(main, /** @type {ReturnType<typeof snapshot>} */ (carry.fields));
  const scroll = () => window.scrollY < carry.scrollY && window.scrollTo(0, carry.scrollY);
  requestAnimationFrame(scroll);
  setTimeout(scroll, 400);
}

// Something a reload would cut short: a field being typed in, a dialog or a picker, a save not on disk yet.
const busy = () => Boolean(store?.pending) || holding(app.querySelector('main.view'))
  || Boolean(document.querySelector('.modal-overlay, .palette-overlay, .drawer-overlay'));

const CHORD_MS = 1500;
let chordAt = 0; // when "g" was pressed, waiting for the letter of a section

// Cmd/Ctrl+K anywhere opens the search palette. The single keys only work outside a field and with nothing open
// over the page: "/" and "n" open the palette, "?" lists the shortcuts, and "g" then a letter jumps to a section.
/** @param {KeyboardEvent} e */
function onShortcut(e) {
  if (!store) return;
  // Dev's terminal output takes keys too: they go to the running program, or to the command line under it.
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(/** @type {HTMLElement} */ (e.target).tagName) || /** @type {HTMLElement} */ (e.target).isContentEditable
    || Boolean(/** @type {HTMLElement} */ (e.target).closest?.('.term-out'));
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
    if (/** @type {Error} */ (err).name !== 'AbortError') connectError = `Could not open folder: ${/** @type {Error} */ (err).message}`;
    renderConnect();
  }
}

async function reconnect() {
  try {
    // The Reconnect button is only shown with a remembered folder.
    if (await hasPermission(/** @type {FileSystemDirectoryHandle} */ (pendingHandle), true)) return open(/** @type {FileSystemDirectoryHandle} */ (pendingHandle));
    connectError = 'Permission was not granted.';
  } catch (err) {
    connectError = `Could not reconnect: ${/** @type {Error} */ (err).message}`;
  }
  renderConnect();
}

async function boot() {
  applyAppearance();
  // Appearance can open links to other sites in this tab instead of a new one.
  document.addEventListener('click', (e) => {
    // In the installed app a new tab is the normal browser, which keeps other sites out of the app's window.
    if (linksInNewTab() || matchMedia('(display-mode: standalone)').matches || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = /** @type {Element} */ (e.target).closest?.('a[target="_blank"]');
    const href = a?.getAttribute('href') ?? '';
    if (!/^https?:/i.test(href)) return;
    e.preventDefault();
    location.href = href;
  });
  watchKeepAwake();
  // The installed app focuses its open window instead of opening another (the manifest's launch_handler), so a Dock
  // shortcut's section only arrives here, as the launch's target URL.
  window.launchQueue?.setConsumer(({ targetURL }) => {
    const hash = targetURL ? new URL(targetURL).hash : '';
    if (hash && hash !== location.hash) location.hash = hash;
  });
  // A link or the back button changed the route: load that section's view from the URL, then render.
  window.addEventListener('hashchange', () => {
    if (!store) return;
    currentModule().restore?.(readRoute().params);
    render();
  });
  // A reload right after adding a task used to drop it while the save was still waiting: save now, and have the
  // browser ask before leaving while it is not on disk yet.
  window.addEventListener('beforeunload', (e) => {
    if (!store?.pending) return;
    store.flush();
    e.preventDefault();
    e.returnValue = '';
  });
  window.addEventListener('pagehide', () => store?.flush());
  window.addEventListener('focus', () => store?.sync());
  document.addEventListener('keydown', onShortcut);
  watchCommits(app, settle);
  watchAppVersion({
    busy,
    memoryOnly: () => sample,
    beforeReload: async () => store?.flush(),
    fields: () => {
      const main = app.querySelector('main.view');
      return store && main ? snapshot(main) : [];
    },
  });
  // Background renders skipped while the tab was hidden are drawn once it shows again.
  document.addEventListener('visibilitychange', settle);
  document.addEventListener('visibilitychange', () => (document.hidden ? store?.flush() : store?.sync()));
  // Settings › Data folder asks for another folder.
  // The page reloads on the new folder, so timers and caches that belong to the old one are dropped with it.
  window.addEventListener('board:pick-folder', async () => {
    try {
      await store?.flush();
      await pickFolder();
      location.reload();
    } catch (err) {
      if (/** @type {Error} */ (err).name !== 'AbortError') console.error('Could not open folder', err);
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
