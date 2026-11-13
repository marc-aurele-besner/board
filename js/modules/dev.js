// Dev: a small IDE for this machine, Cursor style. A workspace folder (the board, the home folder, or a project's
// local folder) is shown as a file tree; files open read-only with syntax colours; terminals sit below. The side
// panel switches to Search, which finds text in the folder's files, and to Source Control, which shows and commits
// the folder's git changes.
// Commands run in a real pseudo-terminal through the runner `bun start` starts, so interactive programs such as
// the Claude CLI work: keys typed in the terminal go to the program, and vt.js draws what it prints.
// The runner owns the sessions: a command keeps running through a reload, and the page attaches to each terminal
// again, getting its whole output back. The runner also keeps the list of open terminals, so the list does not
// depend on this browser: another browser, or one whose site data was cleared, opens the same terminals.
import { h, icon, notice, uid } from '../ui.js';
import { toast } from '../toast.js';
import { openDialog } from '../modal.js';
import { TERMINAL_RUNNER, runnerInfo, listSessions, saveSessionList, listSession, moveSession, attachSession, runCommand, stopCommand, clearSession, closeSession as closeOnRunner, sendInput, saveImage } from '../terminal.js';
import { imageFiles, dragsFiles } from '../images.js';
import { createTerminal, styleOf, colorOf } from '../vt.js';
import { readTheme, themedColors } from '../term-colors.js';
import { explorer, editor, setRoot, hasOpenFiles, baseName, panelHead, panelAction } from './dev-files.js';
import { sourceControl, refreshGit, decorOf, changeCount } from './dev-git.js';
import { searchPanel } from './dev-search.js';
import { worktreesPanel, refreshWorktrees } from './dev-worktrees.js';
import { skillsPanel, refreshSkills } from './dev-skills.js';
import { pickChip } from '../inline.js';
import { projectIcon } from './projects.js';
import { linkWatcher, moveToReview } from '../task-links.js';
import { watchDevSessions } from './todos.js';
import { recordOfSession, sumUsage, usageLine, usageTitle } from '../dev-usage.js';
import { runnerOf, devPresets, shellQuote, DEFAULT_DEV_COMMAND, devCommandOf, claudeCommand } from '../dev-core.js';
import { cronRunOf, cronRunHref } from '../cron.js';
/** @import { Store, DevSessionList, IconName } from '../../types/data' */
/** @import { RunnerInfo, RunnerEvent } from '../../types/terminal' */
/** @import { DevContext } from '../../types/dev' */
/** @import { Child } from '../../types/ui' */
/** @import { Terminal, Line } from '../vt.js' */

/**
 * How a command ended: stopped, lost when the runner stopped, or its exit code or signal.
 * @typedef {{ stopped?: boolean, lost?: boolean, code?: number | null, signal?: string | null, ms?: number }} Exit
 * @typedef {{ history: HTMLElement, screen: HTMLElement, from: number, theme?: string }} LinesEl
 * @typedef {LinesEl & { out: HTMLElement, top: number, holding?: boolean }} TermEl
 * @typedef {{ id: string, n: number, cwd: string, tasks: string[], prompt: string, running: boolean, attach: AbortController | null,
 *   replaying: boolean, pid: number, exit: Exit | null, command: string, browse: number, stick: boolean, el: TermEl | null,
 *   term: Terminal, watch?: (text: string) => void, observer?: ResizeObserver, listed: boolean, listedAt: number }} Session
 */

export { runnerOf, devPresets, DEFAULT_DEV_COMMAND, devCommandOf };

const COLLECTION = 'dev';
// presets: commands named in Settings → Dev environment ({ id, name, command }), which projects pick instead of
// typing the same command each time.
const DEFAULTS = { history: [], runner: '', presets: [] };
const HISTORY_MAX = 100;
const RECENT_SHOWN = 8;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// Where this browser kept the open terminals before the runner did; read once, then removed.
const OLD_SESSIONS_KEY = 'board:dev-sessions';
// The terminal this browser shows. Each browser keeps its own, so two screens can show two terminals.
const ACTIVE_KEY = 'board:dev-active';
// How often an open Dev page reads the runner's list again, to show terminals opened or closed in another browser.
const SYNC_MS = 2000;
// The side panel shown: 'files', 'search', 'git', 'worktrees', 'skills' or 'terminals'.
const SIDE_KEY = 'board:dev-side';

// View state: the workspace, the sessions, the one shown, and what the runner said about itself.
/**
 * @type {{ side: string, workspace: string, sessions: Session[], active: string, wanted: number, info: RunnerInfo | null,
 *   infoError: string, checking: boolean, pending: string | null,
 *   queued: { id: string, prompt: string, projectId: string, taskIds: string[], command: string } | null,
 *   opening: { id: string, cwd: string, taskIds: string[] } | null, restored: boolean, back: string, filesOnly: boolean }}
 */
const view = { side: readSide(), workspace: 'board', sessions: [], active: '', wanted: 0, info: null, infoError: '', checking: false, pending: null, queued: null, opening: null, restored: false, back: '', filesOnly: false };
// Set by draw(), before any terminal is made or used.
/** @type {Store | null} */
let currentStore = null;

function readSide() {
  try {
    // A missing key (null) is in no list.
    const side = /** @type {string} */ (localStorage.getItem(SIDE_KEY));
    return ['git', 'search', 'worktrees', 'skills', 'terminals'].includes(side) ? side : 'files';
  } catch {
    return 'files';
  }
}

const maxSessions = () => view.info?.max ?? 12;
const activeSession = () => view.sessions.find((s) => s.id === view.active) ?? view.sessions[0];
const projectsWithFolder = (/** @type {Store} */ store) => store.get('projects').projects.filter((p) => p.localPath);

// Where a workspace is: 'board', 'home', or 'p:<project id>'.
/** @param {Store} store @param {string} root */
function rootPath(store, root) {
  if (root === 'home') return view.info?.home ?? '~';
  if (root.startsWith('p:')) return store.get('projects').projects.find((p) => p.id === root.slice(2))?.localPath ?? '';
  return view.info?.root ?? '';
}
/** @param {Store} store @param {string} root */
function rootLabel(store, root) {
  if (root === 'home') return 'Home';
  if (root.startsWith('p:')) return store.get('projects').projects.find((p) => p.id === root.slice(2))?.name ?? 'Project';
  return 'Board';
}

// What the file explorer needs from this module.
/** @type {(store: Store) => DevContext} */
const filesCtx = (store) => ({
  base: () => runnerOf(store),
  ready: () => !!view.info,
  refresh: () => store.refresh(),
  decor: decorOf,
  store,
  sessions: () => view.sessions,
  openTerminal: (path) => {
    const s = newSession(store, path);
    if (s) store.refresh();
  },
  cronLink: (which, label) => cronLink(store, which, label),
  // A session the runner still runs but Dev's list lost (closed here, or saved over by another page) is listed again.
  showTerminal: (id, cwd = '') => {
    if (!view.sessions.some((s) => s.id === id)) {
      if (view.sessions.length >= maxSessions()) return toast(`${maxSessions()} terminals are open. Close one first.`);
      const s = makeSession({ id, cwd });
      listOnRunner(store, s);
      if (view.info) attach(store, s);
    }
    view.active = id;
    saveActive();
    store.refresh();
  },
  // A skill picked in the Skills panel: typed into the running program of the terminal shown, or, when nothing
  // runs there, put in its command line as a claude command to finish and run.
  typeInTerminal: (text) => {
    const s = activeSession();
    if (!s) return toast('No terminal open.');
    if (s.running && s.pid) {
      s.stick = true;
      sendInput(runnerOf(store), s.pid, { data: text });
      requestAnimationFrame(() => s.el?.out.focus({ preventScroll: true }));
      return;
    }
    const input = /** @type {HTMLInputElement | null} */ (document.querySelector('.term-input'));
    if (!input) return;
    input.value = `claude "${text}"`;
    input.focus();
    // The cursor waits before the closing quote, where the skill's arguments go.
    input.setSelectionRange(input.value.length - 1, input.value.length - 1);
  },
});

// The terminal answers questions programs ask (cursor position, colours) as the theme shows it.
/** @param {'fg' | 'bg'} which */
function themeColor(which) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(which === 'fg' ? '--text' : '--surface-2').trim();
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  return m ? `rgb:${m[1]}${m[1]}/${m[2]}${m[2]}/${m[3]}${m[3]}` : '';
}

// The open terminals (id, number, folder, the tasks handed to claude in it) are the runner's: a reload, or another
// browser, shows the same ones. The page asks the runner to list a terminal it opens and takes the number the runner
// gives it, so a number names the same terminal in every browser; it never sends its whole list, which would drop
// the terminals another browser opened since. Changes wait until the runner's list was read.
/** @param {Store} store @param {Session} s */
async function listOnRunner(store, s) {
  if (!view.restored || s.listed) return;
  try {
    const entry = await listSession(runnerOf(store), { session: s.id, cwd: s.cwd, ...(s.tasks.length ? { tasks: s.tasks, prompt: s.prompt } : {}) });
    Object.assign(s, { n: Number(entry.n) || s.n, listed: true, listedAt: Date.now() });
    sortSessions();
    store.refresh();
  } catch {}
}

// A terminal's new folder, for the list other browsers read.
/** @param {Session} s */
function moveOnRunner(s) {
  if (view.restored && s.listed && currentStore) moveSession(runnerOf(currentStore), s.id, s.cwd).catch(() => {});
}

// The terminal shown is this browser's own.
function saveActive() {
  try {
    localStorage.setItem(ACTIVE_KEY, view.active);
  } catch {}
}

// Terminals in the order of their numbers, so the tabs read the same in every browser; one waiting for its number last.
const sortSessions = () => view.sessions.sort((a, b) => (a.n || Infinity) - (b.n || Infinity));

// A terminal's number, or an ellipsis while the runner has not given it one yet.
const numberOf = (/** @type {Session} */ s) => (s.n ? String(s.n) : '…');

/** @param {{ id?: string, n?: number, cwd?: string, tasks?: string[], prompt?: string, listed?: boolean }} options @returns {Session} */
function makeSession({ id = uid(), n = 0, cwd = '', tasks = [], prompt = '', listed = false }) {
  // term is added next.
  const s = /** @type {Session} */ ({ id, n, cwd, tasks, prompt, running: false, attach: null, replaying: false, pid: 0, exit: null, command: '', browse: -1, stick: true, el: null, listed, listedAt: 0 });
  s.term = createTerminal({
    // Questions in replayed output were answered long ago; only a live program gets an answer.
    reply: (data) => !s.replaying && s.running && s.pid && sendInput(runnerOf(/** @type {Store} */ (currentStore)), s.pid, { data }),
    background: themeColor,
  });
  // Issue and PR links the session prints are added to its tasks. Tasks moves them on to review once claude waits,
  // and watches for that even when it was not shown.
  if (tasks.length) {
    s.watch = linkWatcher(/** @type {Store} */ (currentStore), tasks, prompt);
    if (currentStore) watchDevSessions(currentStore);
  }
  view.sessions.push(s);
  return s;
}

// The terminals the runner lists, read once it answers. A list this browser kept before the runner did is moved
// to the runner. Blank terminals drawn while the runner could not be reached give way to the listed ones.
/** @param {Store} store */
async function restoreSessions(store) {
  // A runner started before it kept the list has none to give, and the old list stays until one does.
  /** @type {{ active?: string, sessions: DevSessionList['sessions'] | null } | null} */
  let saved = await listSessions(runnerOf(store)).catch(() => null);
  /** @type {typeof saved} */
  let old = null;
  try {
    old = JSON.parse(localStorage.getItem(OLD_SESSIONS_KEY) ?? 'null');
    if (saved) localStorage.removeItem(OLD_SESSIONS_KEY);
  } catch {}
  if (!saved) saved = { sessions: null };
  if (!saved.sessions) {
    // The list this browser kept is moved to the runner once, numbered as it was.
    if (old?.sessions?.length) {
      const sessions = old.sessions.filter((x) => typeof x?.id === 'string').map((x, i) => ({ id: x.id, n: Number(x.n) || i + 1, cwd: String(x.cwd ?? ''), ...(x.tasks?.length ? { tasks: x.tasks, prompt: x.prompt ?? '' } : {}) }));
      saved = { active: old.active, sessions };
      await saveSessionList(runnerOf(store), { active: String(old.active ?? ''), sessions }).catch(() => {});
    } else saved = { sessions: [] };
  }
  view.restored = true;
  const listed = saved.sessions ?? [];
  if (listed.length) {
    for (const s of view.sessions) {
      s.attach?.abort();
      s.observer?.disconnect();
    }
    view.sessions = [];
  }
  for (const x of listed) {
    if (typeof x?.id === 'string' && !view.sessions.some((s) => s.id === x.id)) makeSession({
      id: x.id,
      n: Number(x.n) || 0,
      cwd: String(x.cwd ?? ''),
      tasks: Array.isArray(x.tasks) ? x.tasks.filter((t) => typeof t === 'string') : [],
      prompt: String(x.prompt ?? ''),
      listed: true,
    });
  }
  // Blank terminals drawn while the runner could not be reached are listed now that it answers.
  for (const s of view.sessions) listOnRunner(store, s);
  sortSessions();
  let mine = '';
  try {
    mine = localStorage.getItem(ACTIVE_KEY) ?? '';
  } catch {}
  const active = [mine, saved.active].find((id) => id && view.sessions.some((s) => s.id === id));
  if (active) view.active = active;
}

// Reads the runner's list again: terminals another browser opened are shown here, those closed there are dropped,
// and numbers follow the runner's. A terminal this page listed after the read was asked for is kept.
let syncing = false;
/** @param {Store} store */
async function syncSessions(store) {
  if (syncing || !view.restored || !view.info) return;
  syncing = true;
  const asked = Date.now();
  try {
    const saved = await listSessions(runnerOf(store));
    if (!saved.sessions) return;
    const listed = new Map(saved.sessions.map((x) => [x.id, x]));
    let changed = false;
    for (const s of [...view.sessions]) {
      const x = listed.get(s.id);
      if (x) {
        const n = Number(x.n) || s.n;
        if (n !== s.n) changed = true;
        Object.assign(s, { n, listed: true });
      } else if (s.listed && s.listedAt < asked) {
        forget(s);
        changed = true;
      }
    }
    for (const x of saved.sessions) {
      if (typeof x?.id !== 'string' || view.sessions.some((s) => s.id === x.id)) continue;
      const s = makeSession({
        id: x.id,
        n: Number(x.n) || 0,
        cwd: String(x.cwd ?? ''),
        tasks: Array.isArray(x.tasks) ? x.tasks.filter((t) => typeof t === 'string') : [],
        prompt: String(x.prompt ?? ''),
        listed: true,
      });
      attach(store, s);
      changed = true;
    }
    if (changed) {
      sortSessions();
      store.refresh();
    }
  } catch {
  } finally {
    syncing = false;
  }
}
setInterval(() => {
  if (currentStore && location.hash.startsWith('#/dev') && document.visibilityState === 'visible') syncSessions(currentStore);
}, SYNC_MS);
// Back on this screen: the other one may have changed the list.
addEventListener('focus', () => {
  if (currentStore && location.hash.startsWith('#/dev')) syncSessions(currentStore);
});

// The terminal the URL names (#/dev?term=<number>) is shown, over the one saved last.
function showWanted() {
  const s = view.sessions.find((x) => x.n === view.wanted);
  view.wanted = 0;
  if (!s || s.id === view.active) return;
  view.active = s.id;
  saveActive();
}

/**
 * @param {Store} store
 * @param {string} [cwd]
 * @param {{ id?: string, tasks?: string[], prompt?: string }} [options]
 */
function newSession(store, cwd = rootPath(store, view.workspace), { id, tasks = [], prompt = '' } = {}) {
  if (view.sessions.length >= maxSessions()) {
    toast(`${maxSessions()} terminals are open. Close one first.`);
    return null;
  }
  const s = makeSession({ id, cwd, tasks, prompt });
  view.active = s.id;
  saveActive();
  listOnRunner(store, s);
  if (view.info) attach(store, s);
  return s;
}

// Drops a terminal from this page: closed here, or in another browser.
/** @param {Session} s */
function forget(s) {
  s.attach?.abort();
  s.observer?.disconnect();
  view.sessions = view.sessions.filter((x) => x !== s);
  if (view.active === s.id) {
    view.active = view.sessions.at(-1)?.id ?? '';
    saveActive();
  }
}

/** @param {Session} s */
function closeSession(s) {
  forget(s);
  closeOnRunner(runnerOf(/** @type {Store} */ (currentStore)), s.id).catch(() => {});
}

// Reads the session's events: first everything so far (drawn without toasts or answers), then live ones.
/** @param {Store} store @param {Session} s */
async function attach(store, s) {
  if (s.attach) return;
  const ctl = new AbortController();
  s.attach = ctl;
  let closed = false;
  try {
    closed = await attachSession(runnerOf(store), { session: s.id, signal: ctl.signal, onEvent: (e) => onSessionEvent(store, s, e) });
  } catch {}
  if (s.attach === ctl) s.attach = null;
  if (ctl.signal.aborted || !view.sessions.includes(s)) return;
  // Closed in another browser: this page drops it too.
  if (closed) {
    forget(s);
    store.refresh();
    return;
  }
  // The stream ended by itself: the runner stopped. What ran is marked; the page asks again in a moment.
  s.replaying = false;
  if (s.running) finish(store, s, { lost: true });
  view.info = null;
  setTimeout(() => checkRunner(store), 1500);
}

/** @param {Store} store @param {Session} s @param {RunnerEvent} e */
function onSessionEvent(store, s, e) {
  if (e.t === 'session') {
    s.replaying = true;
    // The runner has the whole terminal: it is drawn again from the start. A runner that lost it (its state folder
    // was removed) has nothing, so what is shown stays.
    if (e.known) {
      // Output kept before the runner noted sizes is replayed at the size it is shown; newer output says its own.
      fit(s);
      s.term.reset();
      s.term.clear();
      Object.assign(s, { running: false, pid: 0, exit: null, command: '' });
    }
  } else if (e.t === 'live') {
    s.replaying = false;
    // Replayed at the program's last size; now the terminal fits the page again, and a running program is told.
    fit(s);
    store.refresh();
  } else if (e.t === 'size') {
    // The program drew what follows at this size; replayed at another one, its cursor moves land in the wrong place.
    if (s.replaying) s.term.resize(e.cols, e.rows);
  } else if (e.t === 'start') {
    const moved = e.cwd !== s.cwd;
    Object.assign(s, { running: true, pid: e.pid, cwd: e.cwd, command: e.command, exit: null });
    if (s.replaying && e.cols) s.term.resize(e.cols, e.rows);
    s.term.note(`${e.cwd || 'board'} $ ${oneLine(e.command)}`, 't-cmd');
    if (!s.replaying) {
      if (moved) moveOnRunner(s);
      store.refresh();
    }
  } else if (e.t === 'out' || e.t === 'err') {
    s.term.write(e.d);
    if (!s.replaying) s.watch?.(e.d);
  } else if (e.t === 'cwd') {
    const moved = e.d !== s.cwd;
    s.cwd = e.d;
    if (!s.replaying && moved) moveOnRunner(s);
  } else if (e.t === 'exit') finish(store, s, e);
  schedulePaint();
}

/** @param {Store} store @param {Session} s @param {Exit} e */
function finish(store, s, e) {
  s.exit = e.stopped ? { stopped: true, ms: e.ms } : e.lost ? { lost: true } : { code: e.code, signal: e.signal, ms: e.ms };
  Object.assign(s, { running: false, pid: 0 });
  s.term.reset();
  s.term.note(exitText(s.exit), s.exit.code === 0 ? 't-meta t-ok' : 't-meta');
  schedulePaint();
  if (s.replaying || !view.sessions.includes(s)) return;
  const command = s.command;
  // A command may have changed the repository (a commit, a checkout, edited files).
  refreshGit(filesCtx(store), rootPath(store, view.workspace), { force: true });
  // claude quit on its own: the work handed to it is done, so its tasks wait for review.
  if (s.exit.code === 0 && s.tasks.length) moveToReview(store, s.tasks);
  if (!location.hash.startsWith('#/dev')) toast(`${command.length > 40 ? `${command.slice(0, 40)}…` : command}: ${exitText(s.exit).toLowerCase()}`);
  store.refresh();
}

// Drawing. A terminal's elements are made once and moved into each new page, so its output, scroll and focus
// survive the page being rebuilt. Lines are drawn again only when what they show changed: a program that rewrites a
// line with the same text (the Claude CLI redraws its whole screen) keeps its element, so a selection in it survives.
/** @typedef {WeakMap<Line, { v: number, cx: number, theme: string, sig: string, el: HTMLElement }>} LineCache */
/** @type {LineCache} */
const drawn = new WeakMap();

// The theme the terminal is drawn in; lines drawn in another one are drawn again.
/** @type {ReturnType<typeof readTheme> | null} */
let theme = null;
const currentTheme = () => (theme ??= readTheme());

/** @param {string} key */
function spanStyle(key) {
  const s = styleOf(key);
  const cls = [s.cls, s.bold && 'b', s.dim && 'd', s.italic && 'i', s.under && 'u', s.strike && 's'].filter(Boolean).join(' ');
  /** @type {{ color?: string, background?: string }} */
  const style = {};
  if (s.fg !== undefined || s.bg !== undefined || s.inverse) {
    // 256-colour indices above the 16 ANSI ones become RGB, which themedColors adapts like any other.
    const norm = (/** @type {number | string | undefined} */ v) => (typeof v === 'number' && v >= 16 ? colorOf(v) : v);
    const { fg, bg } = themedColors(norm(s.fg), norm(s.bg), s.inverse, currentTheme());
    if (fg) style.color = fg;
    if (bg) style.background = bg;
  }
  return { class: cls || null, style };
}

// The web addresses printed in a line, by column: plain text, so a program that prints a URL without OSC 8 links too.
const URL_RE = /https?:\/\/[^\s<>"'`]+/g;
/** @param {Line} line */
function lineLinks(line) {
  // One character per column, so a match's index is its column; a wide or combined character ends a URL.
  const text = Array.from({ length: line.cells.length }, (_, i) => {
    const c = line.cells[i]?.c ?? ' ';
    return c.length === 1 ? c : ' ';
  }).join('');
  /** @type {string[]} */
  const hrefs = [];
  for (const m of text.matchAll(URL_RE)) {
    // Punctuation that ends a sentence, or a bracket the URL was wrapped in, is not part of it.
    let url = m[0].replace(/[.,;:!?]+$/, '');
    while (/[)\]}]$/.test(url) && (url.match(/[([{]/g)?.length ?? 0) < (url.match(/[)\]}]/g)?.length ?? 0)) url = url.slice(0, -1);
    for (let i = 0; i < url.length; i++) hrefs[m.index + i] = url;
  }
  return hrefs;
}

/** @param {Line} line @param {number} [cursorX] @param {LineCache} [cache] */
function lineNode(line, cursorX = -1, cache = drawn) {
  const was = cache.get(line);
  if (was && was.v === line.v && was.cx === cursorX && was.theme === currentTheme().key) return was.el;
  /** @type {{ key: string, href: string | undefined, text: string, cursor: boolean }[]} */
  const runs = [];
  const end = Math.max(line.cells.length, cursorX + 1);
  const hrefs = lineLinks(line);
  const hrefAt = (/** @type {number} */ x) => styleOf(line.cells[x]?.k ?? '').link ?? hrefs[x];
  let x = 0;
  while (x < end) {
    const cursor = x === cursorX;
    const key = line.cells[x]?.k ?? '';
    const href = hrefAt(x);
    let text = line.cells[x]?.c ?? ' ';
    x++;
    // Cells of one style and link make one span; the cursor's cell gets its own.
    while (!cursor && x < end && x !== cursorX && (line.cells[x]?.k ?? '') === key && hrefAt(x) === href) {
      text += line.cells[x]?.c ?? ' ';
      x++;
    }
    runs.push({ key, href, text, cursor });
  }
  const sig = JSON.stringify(runs);
  if (was && was.sig === sig && was.theme === currentTheme().key) {
    Object.assign(was, { v: line.v, cx: cursorX });
    return was.el;
  }
  const el = was?.el ?? h('div', { class: 'term-line' });
  /** @type {(Node | string)[]} */
  const spans = [];
  for (const { key, href, text, cursor } of runs) {
    const attrs = spanStyle(key);
    const node = key || cursor ? h('span', { ...attrs, class: [attrs.class, cursor && 'term-cursor'].filter(Boolean).join(' ') || null }, text) : text;
    // A link opens in a new tab.
    spans.push(href ? h('a', { class: 'term-link', href, target: '_blank', rel: 'noopener noreferrer', title: href }, node) : node);
  }
  el.replaceChildren(...spans);
  cache.set(line, { v: line.v, cx: cursorX, theme: currentTheme().key, sig, el });
  return el;
}

// Draws a terminal into a view's elements ({ history, screen, from, theme }). `cache` keeps each line's element for
// that view: one line can be shown by Dev and by another view at once.
/** @param {LinesEl} el @param {Terminal} term @param {number} cursorY @param {LineCache} [cache] */
function drawLines(el, term, cursorY, cache = drawn) {
  const { history, screen } = el;
  // The theme changed: every line is drawn again in the new colours.
  if (el.theme !== currentTheme().key) {
    el.theme = currentTheme().key;
    history.replaceChildren(...term.history.map((l) => lineNode(l, -1, cache)));
    el.from = term.trimmed;
  }
  // History lines never change once scrolled off; only new ones are added, and old ones dropped.
  const drop = Math.min(history.childElementCount, term.trimmed - el.from);
  // drop is at most the number of lines shown.
  for (let i = 0; i < drop; i++) /** @type {ChildNode} */ (history.firstChild).remove();
  if (term.trimmed > el.from) el.from = term.trimmed;
  for (let i = el.from + history.childElementCount - term.trimmed; i < term.history.length; i++) history.append(lineNode(term.history[i], -1, cache));
  // The screen's lines are put in place one by one, not all replaced: a line left where it was keeps a selection.
  const lines = term.screen.slice(0, term.used());
  lines.forEach((l, y) => {
    const node = lineNode(l, y === cursorY ? Math.min(term.x, term.cols - 1) : -1, cache);
    const at = screen.children[y];
    if (at !== node) screen.insertBefore(node, at ?? null);
  });
  while (screen.childElementCount > lines.length) /** @type {ChildNode} */ (screen.lastChild).remove();
}

/** @param {Session} s */
function paint(s) {
  // While the mouse is pressed in the output (selecting text, clicking a link), nothing moves under it.
  if (!s.el || s.el.holding) return;
  const { term } = s;
  drawLines(s.el, term, s.running && term.cursor ? term.y : -1);
  const { out } = s.el;
  if (s.stick) out.scrollTop = out.scrollHeight;
  s.el.top = out.scrollTop;
}

// A read-only terminal for other sections (Cron), drawn as Dev draws its own: colours, styles and links. paint(term)
// draws it again and keeps it at the end when it was there.
/** @param {string} [label] */
export function terminalView(label = 'Terminal output') {
  const history = h('div', { class: 'term-history' });
  const screen = h('div', { class: 'term-screen' });
  const out = h('div', { class: 'term-out term-view', tabindex: '0', role: 'log', 'aria-label': label }, history, screen);
  const el = { history, screen, from: 0, theme: '' };
  /** @type {LineCache} */
  const cache = new WeakMap();
  return {
    el: out,
    /** @param {Terminal} term */
    paint(term) {
      const atEnd = out.scrollHeight - out.scrollTop - out.clientHeight < 24;
      // The theme may have been switched since Dev last drew.
      theme = null;
      drawLines(el, term, -1, cache);
      if (atEnd) out.scrollTop = out.scrollHeight;
    },
  };
}

// The colours programs are told the page uses, for terminals drawn outside Dev.
export const terminalBackground = (/** @type {'fg' | 'bg'} */ which) => themeColor(which);

let frame = 0;
const schedulePaint = () => (frame ||= requestAnimationFrame(() => {
  frame = 0;
  view.sessions.forEach(paint);
  painted.forEach((fn) => fn());
}));

// A page reads a session through one stream, so a second reader would cut Dev's off. Elsewhere (Cron) a view of a
// terminal Dev already reads shows Dev's copy, told of each change.
/** @type {Set<() => void>} */
const painted = new Set();
/** @param {string} id */
export function liveSession(id) {
  const s = view.sessions.find((x) => x.id === id && x.attach);
  return s ? { term: s.term, running: s.running, exit: s.exit } : null;
}
/** @param {() => void} fn */
export function onSessionPaint(fn) {
  painted.add(fn);
  return () => painted.delete(fn);
}

// Columns and rows that fit the terminal, from the size of one character.
/** @param {Session} s */
function fit(s) {
  const out = s.el?.out;
  if (!out?.isConnected || !out.clientWidth) return;
  const probe = h('span', { class: 'term-probe' }, 'M'.repeat(20));
  out.append(probe);
  const box = probe.getBoundingClientRect();
  probe.remove();
  const css = getComputedStyle(out);
  const width = out.clientWidth - parseFloat(css.paddingLeft) - parseFloat(css.paddingRight);
  const height = out.clientHeight - parseFloat(css.paddingTop) - parseFloat(css.paddingBottom);
  const cols = Math.max(20, Math.floor(width / (box.width / 20)));
  const rows = Math.max(5, Math.floor(height / box.height));
  if (cols === s.term.cols && rows === s.term.rows) return;
  s.term.resize(cols, rows);
  if (s.running && s.pid) sendInput(runnerOf(/** @type {Store} */ (currentStore)), s.pid, { cols, rows });
  schedulePaint();
}

// Keys for the program, as a terminal sends them.
/** @param {KeyboardEvent} e @param {boolean} appCursor @returns {string | null} */
function keyData(e, appCursor) {
  if (e.isComposing || e.metaKey) return null;
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  /** @type {Record<string, string>} */
  const arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  if (arrows[e.key]) return mod > 1 ? `\x1b[1;${mod}${arrows[e.key]}` : `${appCursor ? '\x1bO' : '\x1b['}${arrows[e.key]}`;
  /** @type {Record<string, string>} */
  const named = {
    Enter: e.shiftKey || e.altKey ? '\x1b\r' : '\r',
    Backspace: e.altKey ? '\x1b\x7f' : e.ctrlKey ? '\x08' : '\x7f',
    Tab: e.shiftKey ? '\x1b[Z' : '\t',
    Escape: '\x1b',
    Delete: '\x1b[3~',
    Insert: '\x1b[2~',
    PageUp: '\x1b[5~',
    PageDown: '\x1b[6~',
    F1: '\x1bOP', F2: '\x1bOQ', F3: '\x1bOR', F4: '\x1bOS', F5: '\x1b[15~', F6: '\x1b[17~', F7: '\x1b[18~', F8: '\x1b[19~', F9: '\x1b[20~', F10: '\x1b[21~', F11: '\x1b[23~', F12: '\x1b[24~',
  };
  if (named[e.key]) return named[e.key];
  if (e.ctrlKey && !e.altKey) {
    const k = e.key.length === 1 ? e.key.toLowerCase() : '';
    if (k >= 'a' && k <= 'z') return String.fromCharCode(k.charCodeAt(0) - 96);
    if (k === ' ' || k === '@' || k === '2') return '\x00';
    /** @type {Record<string, string>} */
    const ctrl = { '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '/': '\x1f' };
    return ctrl[k] ?? null;
  }
  if ([...e.key].length !== 1) return null;
  // On a Mac, Option types characters (é, ∫); elsewhere Alt+key is ESC then the key, as terminals send it.
  return e.altKey && !isMac ? `\x1b${e.key}` : e.key;
}

/** @param {Store} store @param {Session} s @param {KeyboardEvent} e */
function onTerminalKey(store, s, e) {
  if (!s.running || !s.pid) {
    // Typing in the output of an idle terminal goes to its command line.
    if ([...e.key].length === 1 && !e.metaKey && !e.ctrlKey) /** @type {HTMLInputElement | null} */ (document.querySelector('.term-input'))?.focus();
    return;
  }
  // Copy keeps working: Cmd+C on a Mac, and Ctrl+C elsewhere while text is selected.
  if (e.ctrlKey && e.key === 'c' && !isMac && String(getSelection())) return;
  const data = keyData(e, s.term.appCursor);
  if (data === null) return;
  e.preventDefault();
  s.stick = true;
  sendInput(runnerOf(store), s.pid, { data });
}

/** @param {Store} store @param {Session} s @param {ClipboardEvent} e */
function onTerminalPaste(store, s, e) {
  if (!s.running || !s.pid) return;
  e.preventDefault();
  const images = imageFiles(e.clipboardData);
  if (images.length) return typeImages(store, s, images);
  const text = (e.clipboardData?.getData('text') ?? '').replace(/\r?\n/g, '\r');
  if (text) sendInput(runnerOf(store), s.pid, { data: s.term.paste ? `\x1b[200~${text}\x1b[201~` : text });
}

// Types the paths of images into the running program, as dragging a file onto a terminal does: claude attaches them.
// The browser does not say where a file lives, so the runner saves a copy and answers its path.
/** @param {Store} store @param {Session} s @param {File[]} images */
async function typeImages(store, s, images) {
  const pid = s.pid;
  let paths;
  try {
    paths = await Promise.all(images.map(async (blob) => (await saveImage(runnerOf(store), blob)).path));
  } catch (err) {
    return toast(/** @type {Error} */ (err).message);
  }
  if (!s.running || s.pid !== pid) return;
  const text = `${paths.join(' ')} `;
  s.stick = true;
  sendInput(runnerOf(store), pid, { data: s.term.paste ? `\x1b[200~${text}\x1b[201~` : text });
  s.el?.out.focus({ preventScroll: true });
}

/** @param {Store} store @param {Session} s @param {DragEvent} e */
function onTerminalDrop(store, s, e) {
  if (!dragsFiles(e)) return;
  e.preventDefault();
  // Dropped on the terminal's own element.
  /** @type {TermEl} */ (s.el).out.classList.remove('dropping');
  const images = imageFiles(e.dataTransfer);
  if (!images.length) return toast('Only PNG, JPEG, GIF and WebP images can be dropped here');
  if (!s.running || !s.pid) return toast('Start claude in this terminal first, then drop the image');
  typeImages(store, s, images);
}

// Scrolling up to read stops following new output; scrolling back to the end follows it again. The direction
// decides, not only the distance: a smooth wheel scroll starts a few pixels from the end, and following output
// there would pull it straight back down.
/** @param {Session} s */
function onTerminalScroll(s) {
  // Scrolled: its elements exist.
  const { out } = /** @type {TermEl} */ (s.el);
  const top = out.scrollTop;
  if (top < /** @type {TermEl} */ (s.el).top - 1) s.stick = false;
  else if (out.scrollHeight - top - out.clientHeight < 24) s.stick = true;
  /** @type {TermEl} */ (s.el).top = top;
}

// A full-screen program (the Claude CLI, less, vim) keeps no scrollback here, so the wheel goes to it, as a
// terminal sends it: mouse reports when it asked for them, otherwise arrow keys on the alternate screen.
/** @param {Store} store @param {Session} s @param {WheelEvent} e */
function onTerminalWheel(store, s, e) {
  if (e.deltaY < 0) s.stick = false;
  const { term } = s;
  if (!s.running || !s.pid || !e.deltaY || (!term.mouse && !term.main)) return;
  e.preventDefault();
  const up = e.deltaY < 0;
  const lines = Math.min(10, Math.max(1, Math.round(Math.abs(e.deltaMode ? e.deltaY : e.deltaY / 40))));
  let data;
  if (term.mouse) {
    const box = /** @type {TermEl} */ (s.el).screen.getBoundingClientRect();
    const x = Math.min(term.cols, Math.max(1, Math.ceil(((e.clientX - box.left) / box.width) * term.cols) || 1));
    const y = Math.min(term.rows, Math.max(1, Math.ceil(((e.clientY - box.top) / box.height) * term.rows) || 1));
    const b = up ? 64 : 65;
    const one = term.mouseSgr ? `\x1b[<${b};${x};${y}M` : `\x1b[M${String.fromCharCode(32 + b, 32 + Math.min(x, 223), 32 + Math.min(y, 223))}`;
    data = one.repeat(Math.min(lines, 3));
  } else {
    data = `${term.appCursor ? '\x1bO' : '\x1b['}${up ? 'A' : 'B'}`.repeat(lines);
  }
  sendInput(runnerOf(store), s.pid, { data });
}

/** @param {Store} store @param {Session} s @returns {TermEl} */
function elementsOf(store, s) {
  if (s.el) return s.el;
  const history = h('div', { class: 'term-history' });
  const screen = h('div', { class: 'term-screen' });
  const out = h('div', {
    class: 'term-out',
    tabindex: '0',
    role: 'log',
    'aria-label': `Terminal ${numberOf(s)} output`,
    onscroll: () => onTerminalScroll(s),
    onwheel: (/** @type {WheelEvent} */ e) => onTerminalWheel(store, s, e),
    onkeydown: (/** @type {KeyboardEvent} */ e) => onTerminalKey(store, s, e),
    onpaste: (/** @type {ClipboardEvent} */ e) => onTerminalPaste(store, s, e),
    ondragover: (/** @type {DragEvent} */ e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      out.classList.add('dropping');
    },
    ondragleave: (/** @type {DragEvent} */ e) => !out.contains(/** @type {Node | null} */ (e.relatedTarget)) && out.classList.remove('dropping'),
    ondrop: (/** @type {DragEvent} */ e) => onTerminalDrop(store, s, e),
    onmousedown: (/** @type {MouseEvent} */ e) => {
      if (e.button !== 0) return;
      /** @type {TermEl} */ (s.el).holding = true;
      addEventListener('mouseup', () => {
        if (s.el) s.el.holding = false;
        schedulePaint();
      }, { once: true, capture: true });
    },
  }, history, screen);
  s.el = { out, history, screen, from: 0, top: 0 };
  s.observer = new ResizeObserver(() => fit(s));
  s.observer.observe(out);
  return s.el;
}

// A command on one line, for the places that show it: a prompt can span several.
const oneLine = (/** @type {string} */ text) => text.replace(/\s*\n\s*/g, ' ↵ ');

const duration = (/** @type {number} */ ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
/** @param {Exit | null | undefined} exit */
export function exitText(exit) {
  if (!exit) return '';
  // Only a lost command has no time.
  if (exit.stopped) return `Stopped after ${duration(/** @type {number} */ (exit.ms))}`;
  if (exit.lost) return 'Ended when the runner stopped';
  if (exit.signal) return `Ended by ${exit.signal} after ${duration(/** @type {number} */ (exit.ms))}`;
  return `Exit ${exit.code} · ${duration(/** @type {number} */ (exit.ms))}`;
}

/** @param {Store} store */
async function checkRunner(store) {
  view.checking = true;
  try {
    view.info = await runnerInfo(runnerOf(store));
    if (!view.restored) await restoreSessions(store);
    view.infoError = '';
    // Terminals opened before the runner answered learn their folder now, and every terminal gets its output.
    for (const s of view.sessions) if (!s.cwd && !s.command) s.cwd = rootPath(store, view.workspace);
    setRoot(filesCtx(store), rootPath(store, view.workspace));
    for (const s of view.sessions) attach(store, s);
  } catch (err) {
    view.info = null;
    view.infoError = /** @type {Error} */ (err).message;
  } finally {
    view.checking = false;
    // The terminals the runner listed are known now: the one the URL or a task names can be shown.
    if (view.restored && view.wanted) showWanted();
    store.refresh();
  }
}

// What claude used in a task's terminal so far, read from its transcript (dev-usage.js).
/** @param {Store} store @param {Session} s */
function sessionUsage(store, s) {
  const record = recordOfSession(store, s.id);
  if (!record) return null;
  const sum = sumUsage([record]);
  return h('span', { class: 'muted small term-usage', title: usageTitle(sum) }, icon('cpu'), usageLine(sum));
}

// Opens Dev with a new terminal that runs claude on a prompt, in the project's folder when it has one.
// The command waits for the runner to answer, so it also works when Dev was not open yet.
// Issue and PR links the session prints are added to the tasks in `taskIds`.
// Returns the terminal's session id, so the tasks can find it again (openSession), and the worktree claude makes
// ({ name, cwd }: its name and the folder of its repo), so the tasks can remove it once done; null when the command
// makes none, or names its own.
/** @param {{ store: Store, prompt: string, projectId?: string, taskIds?: string[], title?: string }} options */
export function startClaudeSession({ store, prompt, projectId = '', taskIds = [], title = '' }) {
  const id = uid();
  const { command, worktree } = claudeCommand(store, projectId, title, id, rootPath(store, view.workspace));
  view.queued = { id, prompt, projectId, taskIds, command };
  showDev();
  return { id, worktree };
}

// Starts a command in a new Dev terminal and stays on the page shown, for work the board starts by itself (Cron).
// With `claude`, `prompt` goes to claude as a task's Dev button sends it; otherwise `command` runs as typed. The
// terminal opens in the project's folder, or the board's when there is none. Resolves to { id, n, worktree } once
// the runner started it; fails when the runner cannot be reached or refuses. `devCommand` replaces the project's Dev
// command for this one start (a preset or a command typed in Cron).
/**
 * @param {{ store: Store, claude?: boolean, prompt?: string, command?: string, devCommand?: string, projectId?: string,
 *   taskIds?: string[], title?: string }} options
 */
export async function startDevSession({ store, claude = false, prompt = '', command = '', devCommand = '', projectId = '', taskIds = [], title = '' }) {
  const base = runnerOf(store);
  const info = view.info ?? await runnerInfo(base);
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  const cwd = project?.localPath || info.root || '';
  const id = uid();
  let worktree = null;
  if (claude) {
    ({ command, worktree } = claudeCommand(store, projectId, title, id, cwd, devCommand));
    command = `${command} -- ${shellQuote(prompt)}`;
  }
  // The terminal is not on the page yet: it starts at a usual size and is fitted once shown.
  await runCommand(base, { session: id, command, cwd, cols: 120, rows: 32, theme: currentTheme().dark ? 'dark' : 'light' });
  const tasks = taskIds;
  if (!claude) prompt = '';
  let n;
  if (view.restored) {
    // Dev has its list: the terminal joins it, and its output streams in like any other's.
    currentStore ??= store;
    const s = makeSession({ id, cwd, tasks, prompt });
    if (view.info) attach(store, s);
    await listOnRunner(store, s);
    n = s.n;
    store.refresh();
  } else {
    // Dev was not opened on this page: the runner's list gets the terminal, and Dev reads it from there.
    n = (await listSession(base, { session: id, cwd, ...(tasks.length ? { tasks, prompt } : {}) }).catch(() => null))?.n ?? 0;
  }
  return { id, n, worktree };
}

// Opens Dev on a terminal session a task started. One this page does not list (closed here, or started in another
// browser) is listed again while the runner still has it.
/** @param {{ id: string, cwd?: string, taskIds?: string[] }} options */
export function openSession({ id, cwd = '', taskIds = [] }) {
  view.opening = { id, cwd, taskIds };
  showDev();
}

// A task's Dev button remembers the page it was on, so Dev offers a way back to it.
function showDev() {
  if (location.hash.startsWith('#/dev')) return currentStore?.refresh();
  view.back = location.hash;
  location.hash = '#/dev';
}

// Leaving Dev any other way forgets the page to go back to.
window.addEventListener('hashchange', () => {
  if (!location.hash.startsWith('#/dev')) view.back = '';
});

function backButton() {
  if (!view.back) return null;
  return h('button', {
    type: 'button',
    class: 'icon-btn',
    title: 'Back to the page you came from',
    'aria-label': 'Back to the page you came from',
    onclick: () => {
      location.hash = view.back;
    },
  }, icon('arrow-left'));
}

/** @param {Store} store */
function showOpening(store) {
  // Called once view.opening is set.
  const { id, cwd, taskIds } = /** @type {NonNullable<typeof view.opening>} */ (view.opening);
  view.opening = null;
  let s = view.sessions.find((x) => x.id === id);
  if (!s) {
    s = makeSession({ id, cwd, tasks: taskIds });
    listOnRunner(store, s);
    if (view.info) attach(store, s);
  }
  view.active = s.id;
  saveActive();
}

/** @param {Store} store */
function startQueued(store) {
  // Called once view.queued is set.
  const { id, prompt, projectId, taskIds, command } = /** @type {NonNullable<typeof view.queued>} */ (view.queued);
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  if (project?.localPath) {
    view.workspace = `p:${project.id}`;
    setRoot(filesCtx(store), rootPath(store, view.workspace));
  }
  view.queued = null;
  const s = newSession(store, undefined, { id, tasks: taskIds, prompt });
  if (!s) return;
  // Runs once the terminal is on the page, so it starts at the size it is shown.
  // `--` ends the options, so a flag with an optional value (--worktree [name]) cannot take the prompt.
  requestAnimationFrame(() => run(store, s, `${command} -- ${shellQuote(prompt)}`, { remember: false }));
}

/** @param {Store} store @param {string} command */
function remember(store, command) {
  store.update(COLLECTION, (d) => {
    d.history = [command, ...d.history.filter((c) => c !== command)].slice(0, HISTORY_MAX);
  });
}

/** @param {Session} s */
function clearTerminal(s) {
  s.term.clear();
  schedulePaint();
  clearSession(runnerOf(/** @type {Store} */ (currentStore)), s.id).catch(() => {});
}

// The runner starts the command; what it prints, and how it ends, arrive through the session's stream.
/** @param {Store} store @param {Session} s @param {string} command @param {{ remember?: boolean }} [options] */
async function run(store, s, command, { remember: keep = true } = {}) {
  if (command === 'clear') {
    clearTerminal(s);
    return store.refresh();
  }
  fit(s);
  Object.assign(s, { stick: true, browse: -1 });
  // A task's prompt is long and one-off; it would crowd the recent commands.
  if (keep) remember(store, command);
  // Keys now go to the program.
  requestAnimationFrame(() => s.el?.out.focus({ preventScroll: true }));
  try {
    await runCommand(runnerOf(store), { session: s.id, command, cwd: s.cwd, cols: s.term.cols, rows: s.term.rows, theme: currentTheme().dark ? 'dark' : 'light' });
  } catch (err) {
    s.term.note(/** @type {Error} */ (err).message, 't-err');
    schedulePaint();
    // The runner may have gone away; ask again so the page says so.
    if (/reach the terminal runner/.test(/** @type {Error} */ (err).message)) checkRunner(store);
  }
}

// A searchable list, since a board with many projects makes a plain dropdown long; projects show their icon.
/** @param {Store} store */
function workspacePicker(store) {
  const projects = [...projectsWithFolder(store)].sort((a, b) => a.name.localeCompare(b.name));
  const options = [
    { value: 'board', label: 'This board', plainIcon: () => icon('folder') },
    { value: 'home', label: 'Home folder', plainIcon: () => icon('home') },
    ...projects.map((p) => ({ value: `p:${p.id}`, label: p.name, plainIcon: () => projectIcon(p) })),
  ];
  if (!options.some((o) => o.value === view.workspace)) options.push({ value: view.workspace, label: rootLabel(store, view.workspace), plainIcon: () => icon('folder') });
  const chip = pickChip({
    value: view.workspace,
    options,
    className: 'field-pick ide-workspace',
    onPick: (v) => {
      if (!v || v === view.workspace) return;
      view.workspace = v;
      setRoot(filesCtx(store), rootPath(store, view.workspace));
      store.refresh();
    },
  });
  chip.setAttribute('aria-label', 'Workspace folder');
  chip.title = 'The folder the files and new terminals open in. Projects show here once they have a local folder.';
  return chip;
}

// Files, Search or Source Control, as icons along the top like Cursor's activity bar. Source Control shows how many files
// changed as a badge on its icon.
/** @param {Store} store */
function sideSwitcher(store) {
  /** @type {(side: string, name: IconName, label: string, badge?: Child) => HTMLButtonElement} */
  const tab = (side, name, label, badge) => h('button', {
    type: 'button',
    role: 'tab',
    class: view.side === side ? 'ide-side-tab active' : 'ide-side-tab',
    'aria-selected': String(view.side === side),
    'aria-label': label,
    title: label,
    onclick: () => {
      view.side = side;
      try {
        localStorage.setItem(SIDE_KEY, side);
      } catch {}
      store.refresh();
    },
  }, icon(name), badge);
  const count = changeCount();
  const running = view.sessions.filter((x) => x.running).length;
  return h('nav', { class: 'ide-side-tabs', role: 'tablist', 'aria-label': 'Side panel' },
    tab('files', 'files', 'Explorer'),
    tab('search', 'search', 'Search'),
    tab('git', 'git-branch', count ? `Source control · ${count} changed ${count === 1 ? 'file' : 'files'}` : 'Source control',
      count ? h('span', { class: 'ide-side-badge' }, count > 99 ? '99+' : count) : null),
    tab('worktrees', 'worktree', 'Worktrees'),
    tab('skills', 'zap', 'Skills'),
    tab('terminals', 'terminal', running ? `Terminals · ${running} running` : 'Terminals',
      running ? h('span', { class: 'ide-side-badge' }, running) : null));
}

// Shows a terminal and gives it the keys.
/** @param {Store} store @param {Session} s */
function jumpTo(store, s) {
  view.active = s.id;
  saveActive();
  store.refresh();
  requestAnimationFrame(() => s.el?.out.focus({ preventScroll: true }));
}

// Every open terminal, running ones first, with what runs in it or the task handed to it: a click jumps in.
// On a terminal or worktree a Cron run started: a button that opens the run.
/** @param {Store} store @param {{ session?: string, worktree?: string, runId?: string }} which @param {string} label */
function cronLink(store, which, label) {
  const run = cronRunOf(store, which);
  if (!run) return null;
  const flow = store.get('cron')?.flows?.find((f) => f.id === run.flowId);
  return h('a', {
    class: 'tree-action cron-link',
    href: cronRunHref(run),
    title: `Started by ${flow ? `“${flow.name}”` : 'a Cron flow'}. Open the run.`,
    'aria-label': `Open the Cron run: ${label}`,
  }, icon('repeat'));
}

// Asks before closing several terminals at once: a running one has its command stopped.
/** @param {Store} store @param {Session[]} list @param {string} title */
function confirmClose(store, list, title) {
  const running = list.filter((s) => s.running).length;
  const dialog = openDialog({
    title,
    body: h('div', { class: 'stack' },
      h('p', null, `Close ${list.length} ${list.length === 1 ? 'terminal' : 'terminals'}?`),
      running ? h('p', { class: 'muted small' }, `${running} running: ${running === 1 ? 'its command is' : 'their commands are'} stopped.`) : null,
      h('div', { class: 'row end' },
        h('button', { type: 'button', class: 'btn-small', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'btn-small danger',
          onclick: () => {
            dialog.close();
            for (const s of list) if (view.sessions.includes(s)) closeSession(s);
            store.refresh();
          },
        }, 'Close'))),
  });
}

/** @param {Store} store @param {Child} picker @param {Child} switcher */
function terminalsPanel(store, picker, switcher) {
  const tasks = store.get('todos').items;
  const shown = activeSession()?.id;
  // @ts-expect-error booleans subtract as 1 and 0: running terminals first.
  const list = [...view.sessions].sort((a, b) => (b.running - a.running) || a.n - b.n);
  const running = list.filter((s) => s.running).length;
  const idle = list.filter((s) => !s.running);
  const row = (/** @type {Session} */ s) => {
    const titles = s.tasks.map((id) => tasks.find((t) => t.id === id)?.text).filter(Boolean);
    const what = s.running ? oneLine(s.command) : exitText(s.exit) || 'Ready';
    const state = s.running ? 'Running' : 'Idle';
    return h('div', { class: s.id === shown ? 'tree-row scm-row term-list-row active' : 'tree-row scm-row term-list-row' },
      h('button', {
        type: 'button',
        class: 'tree-item',
        title: [`Terminal ${numberOf(s)} · ${s.cwd || 'board'}`, s.running ? s.command : '', ...titles].filter(Boolean).join('\n'),
        'aria-current': s.id === shown ? 'true' : null,
        onclick: () => jumpTo(store, s),
      },
        h('span', { class: `wt-dot ${s.running ? 'running' : 'idle'}`, role: 'img', 'aria-label': state, title: state }),
        h('span', { class: 'term-list-text' },
          h('span', { class: 'tree-name' }, `${numberOf(s)} · ${s.cwd ? baseName(s.cwd) : 'board'}`),
          h('span', { class: 'term-list-sub muted' }, titles[0] ? `${titles[0]}${titles.length > 1 ? ` +${titles.length - 1}` : ''}` : what))),
      cronLink(store, { session: s.id, runId: s.tasks.map((id) => tasks.find((t) => t.id === id)?.cronRun).find(Boolean) }, `terminal ${numberOf(s)}`),
      h('button', {
        type: 'button',
        class: 'tree-action',
        title: s.running ? 'Stop and close this terminal' : 'Close this terminal',
        'aria-label': `Close terminal ${numberOf(s)}`,
        onclick: () => {
          closeSession(s);
          store.refresh();
        },
      }, icon('x')));
  };
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Terminals' },
    switcher,
    panelHead('Terminals', panelAction('plus', 'Open a new terminal in the workspace folder', () => {
      if (newSession(store)) store.refresh();
    }, view.sessions.length >= maxSessions())),
    h('div', { class: 'ide-explorer-head' }, picker),
    list.length ? h('div', { class: 'tree-root muted small' }, `${list.length} OPEN · ${running} RUNNING`) : null,
    list.length
      ? h('div', { class: 'stack wt' },
        h('div', { class: 'row wt-actions' },
          h('button', { type: 'button', class: 'btn-small', disabled: !idle.length, title: 'Close the terminals where nothing runs', onclick: () => confirmClose(store, idle, 'Close idle terminals') }, icon('trash'), `Close idle${idle.length ? ` (${idle.length})` : ''}`),
          h('button', { type: 'button', class: 'btn-small danger', title: 'Stop every running command and close every terminal', onclick: () => confirmClose(store, list, 'Close all terminals') }, icon('trash'), 'Close all')),
        h('div', { class: 'tree scm-list', role: 'list' }, list.map(row)))
      : h('p', { class: 'muted small' }, 'No terminals open.'));
}

/** @param {Store} store */
function sessionTabs(store) {
  const full = view.sessions.length >= maxSessions();
  return h('nav', { class: 'term-tabs', role: 'tablist', 'aria-label': 'Terminals' },
    view.sessions.map((s) => {
      const active = s.id === activeSession()?.id;
      return h('div', { class: active ? 'term-tab active' : 'term-tab' },
        h('button', {
          type: 'button',
          role: 'tab',
          'aria-selected': String(active),
          title: s.cwd,
          onclick: () => {
            view.active = s.id;
            saveActive();
            store.refresh();
          },
        }, s.running ? h('span', { class: 'term-dot', title: 'Running' }) : icon('terminal'), `${numberOf(s)} · ${s.cwd ? baseName(s.cwd) : 'board'}`),
        h('button', {
          type: 'button',
          class: 'term-close',
          title: s.running ? 'Stop and close this terminal' : 'Close this terminal',
          'aria-label': `Close terminal ${numberOf(s)}`,
          onclick: () => {
            closeSession(s);
            store.refresh();
          },
        }, icon('x')));
    }),
    h('button', {
      type: 'button',
      class: 'term-new',
      disabled: full,
      title: full ? `Up to ${maxSessions()} terminals. Start the board with TERMINAL_MAX set higher for more.` : 'Open a new terminal in the workspace folder',
      'aria-label': 'New terminal',
      onclick: () => {
        newSession(store);
        store.refresh();
      },
    }, icon('plus')));
}

/** @param {Store} store @param {Session} s */
function terminal(store, s) {
  const history = store.get(COLLECTION).history;
  const { out } = elementsOf(store, s);
  out.toggleAttribute('data-autofocus', s.running);
  const input = h('input', {
    name: 'command',
    class: 'term-input',
    placeholder: s.running ? 'Running: type in the terminal above. Stop ends it.' : 'Type a command and press Enter',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    disabled: s.running,
    'aria-label': 'Command',
    'data-autofocus': !s.running,
    // Up and Down walk the saved commands, newest first, as in a shell.
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        clearTerminal(s);
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length) {
        e.preventDefault();
        s.browse = Math.max(-1, Math.min(history.length - 1, s.browse + (e.key === 'ArrowUp' ? 1 : -1)));
        input.value = s.browse < 0 ? '' : history[s.browse];
      }
    },
  });

  return h('section', { class: 'card term' },
    h('div', { class: 'term-head' },
      backButton(),
      sessionTabs(store),
      h('code', { class: 'term-cwd', title: s.cwd }, s.cwd || '…'),
      sessionUsage(store, s),
      h('div', { class: 'row term-actions' },
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Copy the output',
          'aria-label': 'Copy the output',
          onclick: () => {
            const text = [...s.term.history, ...s.term.screen.slice(0, s.term.used())].map((l) => Array.from({ length: l.cells.length }, (_, i) => l.cells[i]?.c ?? ' ').join('').trimEnd()).join('\n');
            navigator.clipboard.writeText(text.trim()).then(() => toast('Output copied'), () => toast('Could not copy'));
          },
        }, icon('copy')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Clear the output (Ctrl+L)', 'aria-label': 'Clear the output', onclick: () => clearTerminal(s) }, icon('trash')))),
    out,
    h('form', {
      class: 'term-form',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        if (s.running) return stopCommand(runnerOf(store), s.id).catch((err) => toast(err.message));
        const command = input.value.trim();
        if (!command) return;
        input.value = '';
        run(store, s, command);
      },
    },
      h('span', { class: 'term-prompt', 'aria-hidden': 'true' }, '$'),
      input,
      s.running
        ? h('button', { type: 'submit', class: 'btn-small danger', title: 'Stop the command and anything it started' }, icon('stop'), 'Stop')
        : h('button', { type: 'submit', class: 'btn-small primary', disabled: !view.info }, icon('play'), 'Run')),
    h('div', { class: 'row between term-status' },
      h('span', { class: 'muted small term-state', title: s.running ? s.command : null }, s.running ? `Running ${oneLine(s.command)}` : exitText(s.exit) || 'Ready'),
      history.length && !s.running
        ? h('div', { class: 'term-recent', 'aria-label': 'Recent commands' },
            history.slice(0, RECENT_SHOWN).map((c) =>
              h('button', {
                type: 'button',
                class: 'chip term-chip',
                title: `Put “${c}” in the command line`,
                onclick: () => {
                  input.value = c;
                  input.focus();
                },
              }, c)))
        : null));
}

/** @param {Store} store */
function runnerNotice(store) {
  return h('div', { class: 'stack' },
    notice({
      text: view.infoError,
      actions: [h('button', { type: 'button', class: 'btn-small', disabled: view.checking, onclick: () => checkRunner(store) }, view.checking ? 'Checking…' : 'Try again')],
    }),
    h('form', {
      class: 'row term-runner',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        const runner = String(new FormData(/** @type {HTMLFormElement} */ (e.currentTarget)).get('runner') ?? '').trim().replace(/\/+$/, '');
        store.update(COLLECTION, (d) => {
          d.runner = runner;
        });
        checkRunner(store);
      },
    },
      h('input', { name: 'runner', type: 'url', value: store.get(COLLECTION).runner, placeholder: TERMINAL_RUNNER, autocomplete: 'off', spellcheck: false, 'aria-label': 'Runner address' }),
      h('button', { type: 'submit', class: 'btn-small' }, 'Save')),
    h('p', { class: 'muted small' }, `Leave the address empty to use ${TERMINAL_RUNNER}. Change it only if you started the board with TERMINAL_PORT.`));
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  // A render follows a theme switch, so the theme is read again.
  theme = null;
  currentStore = store;
  // Until the runner said which terminals are open, the address's terminal and a task's wait.
  if (view.restored && view.wanted) showWanted();
  if (view.restored && view.opening) showOpening(store);
  if (!view.info && !view.infoError && !view.checking) checkRunner(store);
  if (view.pending) {
    view.workspace = view.pending;
    view.pending = null;
    setRoot(filesCtx(store), rootPath(store, view.workspace));
    const open = view.sessions.find((x) => x.cwd === rootPath(store, view.workspace));
    if (open) view.active = open.id;
    // The Explorer link shows the folder's files; it starts a terminal only when there is none at all (below).
    else if (!view.filesOnly) newSession(store);
    view.filesOnly = false;
  }
  if (view.queued && view.info && view.restored) startQueued(store);
  if (!view.sessions.length && (view.restored || view.infoError)) newSession(store);
  const s = activeSession();
  // The page is rebuilt around the terminal; it keeps the keys if it had them.
  const focused = !!s && document.activeElement === s.el?.out;
  const ctx = filesCtx(store);
  // The tree's change colours and the panel's count come from git, read again when stale.
  if (view.info) refreshGit(ctx, rootPath(store, view.workspace));
  if (view.info && view.side === 'worktrees') refreshWorktrees(ctx, rootPath(store, view.workspace));
  // Skills are read before their panel is opened, so it shows them at once; a re-read redraws only on a change.
  if (view.info) refreshSkills(ctx, rootPath(store, view.workspace));

  root.replaceChildren(
    h('div', { class: 'stack-lg dev' },
      view.infoError ? runnerNotice(store) : null,
      h('div', { class: 'ide' },
        view.side === 'git'
          ? sourceControl(ctx, workspacePicker(store), sideSwitcher(store), rootPath(store, view.workspace))
          : view.side === 'search'
            ? searchPanel(ctx, workspacePicker(store), sideSwitcher(store), rootPath(store, view.workspace))
            : view.side === 'worktrees'
              ? worktreesPanel(ctx, workspacePicker(store), sideSwitcher(store), rootPath(store, view.workspace))
              : view.side === 'skills'
                ? skillsPanel(ctx, workspacePicker(store), sideSwitcher(store), rootPath(store, view.workspace))
                : view.side === 'terminals'
                  ? terminalsPanel(store, workspacePicker(store), sideSwitcher(store))
                  : explorer(ctx, workspacePicker(store), sideSwitcher(store)),
        h('div', { class: hasOpenFiles() ? 'ide-main has-file' : 'ide-main' },
          editor(ctx),
          s ? terminal(store, s) : h('section', { class: 'card term' }, h('p', { class: 'muted small' }, 'Asking the runner for the open terminals…'))))));
  requestAnimationFrame(fillWindow);
  if (!s) return;
  requestAnimationFrame(() => {
    if (focused) /** @type {TermEl} */ (s.el).out.focus({ preventScroll: true });
    fit(s);
    paint(s);
  });
}

// The page fills the window below where it starts, which moves with the top bar's wrapping and the banners above it.
function fillWindow() {
  const dev = /** @type {HTMLElement | null} */ (document.querySelector('.dev'));
  if (!dev) return;
  // offsetTop, not the bounding box: the entrance animation moves the page while it plays.
  let top = 0;
  for (let el = /** @type {HTMLElement | null} */ (dev); el; el = /** @type {HTMLElement | null} */ (el.offsetParent)) top += el.offsetTop;
  const below = parseFloat(getComputedStyle(/** @type {HTMLElement} */ (dev.parentElement)).paddingBottom) || 0;
  dev.style.setProperty('--dev-top', `${Math.round(top + below)}px`);
}
addEventListener('resize', fillWindow);

// The system theme changed (with the board following it): draw the terminals in the new colours.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  theme = null;
  schedulePaint();
});

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'dev',
  title: 'Dev',
  icon: 'terminal',
  collection: COLLECTION,
  defaults: DEFAULTS,
  render: draw,
  // The terminal shown is in the URL, so a refresh or a shared link opens it.
  serialize: () => ({ term: view.sessions.length > 1 ? activeSession()?.n || '' : '' }),
  // #/dev?project=<id> (from a project page) opens that project's folder, with a terminal in it.
  // With &side=files (a task list's Explorer button) it shows the folder's files instead of a new terminal.
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    if (p.project) view.pending = `p:${p.project}`;
    if (p.project && p.side === 'files') {
      view.side = 'files';
      view.filesOnly = true;
    }
    const n = Number(p.term);
    if (Number.isInteger(n) && n > 0) {
      view.wanted = n;
      // A link or the back button while Dev is open picks the terminal now.
      if (view.restored) showWanted();
    }
  },
});
