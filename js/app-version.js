// A tab keeps running the modules it loaded. After an edit or a pull it runs older code than the folder on disk, and
// may save data in a shape the new code no longer expects. This asks GET /version (tools/serve.js) now and then and:
// - offers a reload in a banner when the files changed;
// - reloads quietly a tab that comes back after a long time away with nothing in progress;
// - makes the tab reload, behind a full-screen notice, when the new code bumped APP_EPOCH or the tab has been old for
//   a day.
// What was typed in the section and the scroll position come back after any of these reloads.
// Another static server (python3 -m http.server) has no /version, and the check then stays off.
import { h, icon } from './ui.js';
import { APP_EPOCH, SNOOZE_MS, isVersionInfo, mayAutoReload, silentReloadOk, snoozed, updateState } from './app-version-core.js';

/** @import { UpdateState, VersionInfo } from './app-version-core.js' */

const POLL_MS = 60 * 1000;
// A tab shown again, focused or back online checks at once, but at most this often.
const THROTTLE_MS = 15 * 1000;
const FORCE_DELAY_MS = 3000;
// A required reload waits this long at most for the user to finish (close a dialog, leave a field).
const BUSY_WAIT_MS = 2 * 60 * 1000;
const BUSY_POLL_MS = 2000;
// What a reload carries over is ignored when the page took longer than this to come back.
const CARRY_MS = 60 * 1000;

const CARRY_KEY = 'board:update-carry';
const AUTO_KEY = 'board:update-auto-at';
const SNOOZE_KEY = 'board:update-snoozed-until';

/**
 * @typedef {object} Hooks
 * @property {() => boolean} busy something is in progress that a reload would cut short (typing, a dialog, a save)
 * @property {() => boolean} memoryOnly the data lives only in this tab (sample data), so a reload must be the user's choice
 * @property {() => Promise<unknown>} beforeReload saves what is not on disk yet
 * @property {() => unknown[]} fields the section's unsubmitted fields (keep-fields snapshot)
 */
/** @typedef {{ at: number, section: string, scrollY: number, fields: unknown[] }} Carry */

/** @param {string} key */
const readNumber = (key) => {
  try {
    const value = Number(sessionStorage.getItem(key));
    return value > 0 ? value : null;
  } catch {
    return null;
  }
};
/** @param {string} key @param {string | null} value */
const writeStorage = (key, value) => {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, value);
  } catch {
    /* storage blocked: the snooze or the carried fields last for this page only */
  }
};

const section = () => location.hash.replace(/^#\//, '').split('?')[0] || 'home';

// What the last reload carried for this section, read once. Null when there is none, it is old, or the page opened
// on another section.
export function takeCarried() {
  /** @type {Carry | null} */
  let carry = null;
  try {
    carry = JSON.parse(sessionStorage.getItem(CARRY_KEY) ?? 'null');
  } catch {
    /* unreadable: nothing carried */
  }
  writeStorage(CARRY_KEY, null);
  if (!carry || Date.now() - carry.at > CARRY_MS || carry.section !== section()) return null;
  return carry;
}

/** @type {Hooks} */
let hooks = { busy: () => false, memoryOnly: () => false, beforeReload: async () => {}, fields: () => [] };
/** @type {{ version: string, epoch: number } | null} */
let client = null;
/** @type {number | null} */
let staleSince = null;
/** @type {UpdateState} */
let state = { kind: 'current' };
let off = false;
let checking = false;
let lastCheck = 0;
/** @type {number | null} */
let hiddenAt = null;
/** @type {HTMLElement | null} */
let banner = null;
/** @type {HTMLElement | null} */
let screen = null;
let busySince = 0;
let busyTimer = 0;

/** @returns {Promise<VersionInfo | null>} */
async function fetchVersion() {
  try {
    const res = await fetch('/version', { cache: 'no-store' });
    // No such route: another server serves the board. Stop asking.
    if (res.status === 404) off = true;
    if (!res.ok) return null;
    const body = await res.json();
    return isVersionInfo(body) ? body : null;
  } catch {
    // Offline, or the server is restarting: never a reason to reload.
    return null;
  }
}

/** @param {{ force?: boolean }} [options] force skips the throttle */
async function check({ force = false } = {}) {
  if (off || checking || (!force && Date.now() - lastCheck < THROTTLE_MS)) return;
  checking = true;
  lastCheck = Date.now();
  const server = await fetchVersion();
  checking = false;
  if (!server) return;
  // The first answer is the version this tab loaded: the modules were read a moment before.
  client ??= { version: server.version, epoch: APP_EPOCH };
  if (server.version !== client.version) staleSince ??= Date.now();
  apply(updateState(client, server, { now: Date.now(), staleSince }));
}

/** @param {UpdateState} next */
function apply(next) {
  // With sample data a reload loses every change, so it is only ever offered.
  state = next.kind === 'required' && hooks.memoryOnly() ? { kind: 'available' } : next;
  if (state.kind === 'current') return hideBanner();
  if (state.kind === 'available') return snoozed(readNumber(SNOOZE_KEY), Date.now()) ? hideBanner() : showBanner();
  if (screen) return;
  if (hooks.busy()) {
    showBanner();
    waitUntilFree();
  } else showScreen();
}

// A required reload lets the user finish what they are doing first, for a while.
function waitUntilFree() {
  busySince ||= Date.now();
  if (busyTimer) return;
  busyTimer = window.setInterval(() => {
    if (hooks.busy() && Date.now() - busySince < BUSY_WAIT_MS) return;
    clearInterval(busyTimer);
    busyTimer = 0;
    showScreen();
  }, BUSY_POLL_MS);
}

/** @param {{ auto: boolean }} options auto: the board reloads by itself, so the loop guard applies */
async function reload({ auto }) {
  try {
    await hooks.beforeReload();
  } catch (err) {
    console.error('Could not save before reloading', err);
  }
  /** @type {Carry} */
  const carry = { at: Date.now(), section: section(), scrollY: Math.round(window.scrollY), fields: hooks.fields() };
  writeStorage(CARRY_KEY, JSON.stringify(carry));
  if (auto) writeStorage(AUTO_KEY, String(Date.now()));
  location.reload();
}

const REASONS = {
  epoch: 'This version changes how the board saves its data, so tabs still running the older one reload before they save again.',
  age: 'This tab has been running an older version of the board for over a day.',
};

function hideBanner() {
  banner?.remove();
  banner = null;
}

function showBanner() {
  const required = state.kind === 'required';
  const title = required ? 'This tab needs to reload' : 'A new version of the board is ready';
  const body = required
    ? `${REASONS[/** @type {{ reason: keyof typeof REASONS }} */ (state).reason]} It reloads once you are done here.`
    : hooks.memoryOnly()
      ? 'Reload to run it. The sample data starts over.'
      : 'Reload to run it. What you typed and where you were come back.';
  const next = h('div', { class: required ? 'update-banner required' : 'update-banner', role: 'status', 'aria-live': 'polite' },
    icon('refresh'),
    h('div', { class: 'update-banner-text' }, h('strong', null, title), h('span', null, body)),
    h('div', { class: 'update-banner-actions' },
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => reload({ auto: false }) }, 'Reload'),
      required ? null : h('button', { type: 'button', class: 'btn-small', onclick: snooze }, 'Later')));
  // Redrawn only when it changes, so a check never resets a hover or a focused button.
  if (banner?.className === next.className && banner.textContent === next.textContent) return;
  if (banner) banner.replaceWith(next);
  else document.body.append(next);
  banner = next;
}

function snooze() {
  writeStorage(SNOOZE_KEY, String(Date.now() + SNOOZE_MS));
  hideBanner();
}

function showScreen() {
  hideBanner();
  if (screen) return;
  const reason = /** @type {{ reason: keyof typeof REASONS }} */ (state).reason;
  // The last reload the board made by itself did not bring the new version: wait for a click instead of looping.
  const stuck = !mayAutoReload(readNumber(AUTO_KEY), Date.now());
  const heading = h('h2', { id: 'update-title', tabindex: '-1' }, stuck ? 'Almost there' : 'Updating the board');
  const status = h('p', { class: 'muted small' }, stuck
    ? 'The last reload did not pick up the new version. Reload when you are ready.'
    : 'Reloading in a few seconds…');
  screen = h('div', { class: 'update-screen', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'update-title' },
    h('div', { class: 'update-screen-card' },
      h('span', { class: stuck ? 'update-screen-icon' : 'update-screen-icon spin-icon' }, icon('refresh')),
      heading,
      h('p', null, REASONS[reason]),
      h('p', { class: 'muted' }, 'What you typed in this section and where you were come back after the reload.'),
      status,
      h('button', { type: 'button', class: 'primary', onclick: () => reload({ auto: false }) }, 'Reload now')));
  const app = document.getElementById('app');
  if (app) app.inert = true;
  document.body.append(screen);
  heading.focus();
  if (!stuck) setTimeout(() => reload({ auto: true }), FORCE_DELAY_MS);
}

/** @param {Hooks} next */
export function watchAppVersion(next) {
  hooks = next;
  if (typeof fetch === 'undefined') return;
  check({ force: true });
  setInterval(() => document.hidden || check({ force: true }), POLL_MS);
  window.addEventListener('focus', () => check());
  window.addEventListener('online', () => check());
  hiddenAt = document.hidden ? Date.now() : null;
  document.addEventListener('visibilitychange', async () => {
    if (document.hidden) {
      hiddenAt = Date.now();
      return;
    }
    const hiddenFor = hiddenAt === null ? 0 : Date.now() - hiddenAt;
    hiddenAt = null;
    await check();
    // Back after a long time away with nothing in progress: reload before the user starts on the old version.
    if (state.kind === 'available' && !hooks.memoryOnly() && silentReloadOk({ hiddenFor, busy: hooks.busy() }) && mayAutoReload(readNumber(AUTO_KEY), Date.now())) {
      reload({ auto: true });
    }
  });
}
