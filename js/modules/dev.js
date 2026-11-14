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
import { onContextMenu, copyItem, openMenu, closeMenu } from '../menu.js';
import { TERMINAL_RUNNER, runnerInfo, listFolder, listSessions, sessionStatus, saveSessionList, listSession, moveSession, attachSession, runCommand, stopCommand, clearSession, closeSession as closeOnRunner, sendInput, saveImage, sessionTurns } from '../terminal.js';
import { imageFiles, dragsFiles } from '../images.js';
import { createTerminal, styleOf, colorOf } from '../vt.js';
import { readTheme, themedColors } from '../term-colors.js';
import { explorer, editor, setRoot, hasOpenFiles, baseName, panelHead, panelAction } from './dev-files.js';
import { sourceControl, refreshGit, decorOf, changeCount } from './dev-git.js';
import { searchPanel } from './dev-search.js';
import { worktreesPanel, refreshWorktrees } from './dev-worktrees.js';
import { skillsPanel, refreshSkills, knownSkills } from './dev-skills.js';
import { drawSkills, drawMcp, skillsOf, mcpOf, skillsTitle, mcpTitle } from './dev-uses.js';
import { pickChip } from '../inline.js';
import { resizableSide } from '../side-resize.js';
import { projectIcon } from './projects.js';
import { linkWatcher, moveToReview } from '../task-links.js';
import { watchDevSessions } from './todos.js';
import { recordOfSession, sumUsage, usageLine, usageTitle, mcpTool } from '../dev-usage.js';
import { runnerOf, devAgents, shellQuote, DEFAULT_DEV_COMMAND, devCommandOf, claudeCommand, claudeState, devHarnesses, withPrompt, withTaskPointer } from '../dev-core.js';
import { sessionTools, toolGroup, fmtSpan, pct } from '../dev-turns.js';
import { cronRunOf, cronRunHref } from '../cron.js';
/** @import { Store, DevSessionList, IconName } from '../../types/data' */
/** @import { RunnerInfo, RunnerEvent, RunnerTurns, RunnerStatus, SessionTurn, SessionAgent, ToolFailure } from '../../types/terminal' */
/** @import { DevContext } from '../../types/dev' */
/** @import { Child } from '../../types/ui' */
/** @import { Terminal, Line } from '../vt.js' */
/** @import { MenuEntry } from '../menu.js' */

/**
 * How a command ended: stopped, lost when the runner stopped, or its exit code or signal.
 * @typedef {{ stopped?: boolean, lost?: boolean, code?: number | null, signal?: string | null, ms?: number }} Exit
 * @typedef {{ history: HTMLElement, screen: HTMLElement, from: number, theme?: string }} LinesEl
 * @typedef {LinesEl & { out: HTMLElement, top: number, holding?: boolean }} TermEl
 * @typedef {{ id: string, n: number, cwd: string, tasks: string[], prompt: string, running: boolean, attach: AbortController | null,
 *   replaying: boolean, pid: number, exit: Exit | null, command: string, browse: number, stick: boolean, el: TermEl | null,
 *   term: Terminal, watch?: (text: string) => void, observer?: ResizeObserver, listed: boolean, listedAt: number,
 *   pickup?: { key: string, ok: boolean | null } }} Session
 */

export { runnerOf, devAgents, DEFAULT_DEV_COMMAND, devCommandOf };

const COLLECTION = 'dev';
// presets: commands named in Settings → Dev environment ({ id, name, command }), which projects pick instead of
// typing the same command each time.
const DEFAULTS = { history: [], favorites: [], runner: '', presets: [] };
const HISTORY_MAX = 100;
const RECENT_SHOWN = 8;
const FAVORITES_MAX = 40;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// Where this browser kept the open terminals before the runner did; read once, then removed.
const OLD_SESSIONS_KEY = 'board:dev-sessions';
// The terminal this browser shows. Each browser keeps its own, so two screens can show two terminals.
const ACTIVE_KEY = 'board:dev-active';
// How often an open Dev page reads the runner's list again, to show terminals opened or closed in another browser.
const SYNC_MS = 2000;
// The side panel shown: 'files', 'search', 'git', 'worktrees', 'skills' or 'terminals'.
const SIDE_KEY = 'board:dev-side';
// The side panel's width, dragged on its right edge and remembered in this browser.
const SIDE_RANGE = { def: 260, min: 200, max: 560 };

// View state: the workspace, the sessions, the one shown, and what the runner said about itself.
/**
 * @type {{ side: string, workspace: string, sessions: Session[], active: string, wanted: number, info: RunnerInfo | null,
 *   infoError: string, checking: boolean, pending: string | null,
 *   opening: { id: string, cwd: string, taskIds: string[] } | null, restored: boolean, back: string, filesOnly: boolean }}
 */
const view = { side: readSide(), workspace: 'board', sessions: [], active: '', wanted: 0, info: null, infoError: '', checking: false, pending: null, opening: null, restored: false, back: '', filesOnly: false };
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

const maxSessions = () => view.info?.max ?? 50;
// Past this many open terminals, Dev suggests closing the ones done with.
const SOFT_SESSIONS = 25;
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
  if (!currentStore || !location.hash.startsWith('#/dev') || document.visibilityState !== 'visible') return;
  syncSessions(currentStore);
  readDots(currentStore);
}, SYNC_MS);

// What each terminal is doing, for its dot in the Terminals panel and on the bar: asked of the runner every few
// seconds while Dev shows, and the dots are coloured where they stand, with no page render.
const DOTS_MS = 4000;
/** @type {{ status: Record<string, RunnerStatus>, at: number, busy: boolean }} */
const dots = { status: {}, at: 0, busy: false };
const RUNS_CLAUDE = /(?:^|[\s/])claude(?:\s|$)/;

/** @param {Store} store */
async function readDots(store) {
  if (dots.busy || !view.info || !view.sessions.length || Date.now() - dots.at < DOTS_MS) return;
  dots.busy = true;
  try {
    dots.status = await sessionStatus(runnerOf(store), view.sessions.map((s) => s.id));
    for (const el of document.querySelectorAll('.dev [data-dot]')) {
      const s = view.sessions.find((x) => x.id === /** @type {HTMLElement} */ (el).dataset.dot);
      if (!s) continue;
      const { key, label } = dotOf(s);
      el.className = el.className.replace(/ is-\w+/, '') + ` is-${key}`;
      el.setAttribute('title', label);
      el.setAttribute('aria-label', label);
    }
  } catch {
    // An unreachable runner says nothing: the dots keep what they showed.
  } finally {
    dots.at = Date.now();
    dots.busy = false;
  }
}

// Where a terminal stands, as the class of its dot and the words for it: a command running, claude working, asking
// (a question, a plan, a permission), waiting after its turn, done, ended with an error, not responding, or idle.
/** @param {Session} s @returns {{ key: string, label: string }} */
function dotOf(s) {
  const st = dots.status[s.id];
  const live = st?.state === 'working' || st?.state === 'waiting';
  // The status is a few seconds old: a command started or ended since is told by the terminal itself.
  if (!st || s.running !== live) {
    if (s.running) return { key: 'running', label: 'Running' };
    if (st?.state === 'done' || s.exit?.code === 0) return { key: 'done', label: 'Finished' };
    if (s.exit?.stopped) return { key: 'stopped', label: 'Stopped' };
    return s.exit ? { key: 'failed', label: exitText(s.exit) } : { key: 'idle', label: 'Idle' };
  }
  if (live && st.agents === undefined && !st.ask && !RUNS_CLAUDE.test(s.command.split(/\s--\s/)[0])) return { key: 'running', label: 'Running' };
  if (st.state === 'failed' && s.exit) return { key: 'failed', label: exitText(s.exit) };
  return claudeState(st);
}

// A terminal's dot, coloured again in place as its state is read.
/** @param {Session} s @param {string} base */
function dot(s, base) {
  const { key, label } = dotOf(s);
  return h('span', { class: `${base} is-${key}`, 'data-dot': s.id, role: 'img', 'aria-label': label, title: label });
}
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
  if (view.sessions.length === SOFT_SESSIONS + 1) toast(`${view.sessions.length} terminals are open. Close the idle and finished ones, and those of tasks in review, from the Terminals panel.`);
  return s;
}

// The terminals worth closing: nothing runs in them, claude is done, or every task they ran is done or in review.
/** @param {Store} store */
function staleSessions(store) {
  const items = store.get('todos').items;
  return view.sessions.filter((s) => {
    if (!s.running || dotOf(s).key === 'done') return true;
    const statuses = s.tasks.map((id) => items.find((t) => t.id === id)?.status).filter(Boolean);
    return statuses.length > 0 && statuses.every((st) => st === 'done' || st === 'review');
  });
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

// Starts a command in a new Dev terminal and stays on the page shown: a task's Dev button, and work the board
// starts by itself (Cron). With `claude`, `prompt` goes to claude with the project's Dev command; otherwise `command` runs as typed. The
// terminal opens in the project's folder, or the board's when there is none. Resolves to { id, n, worktree } once
// the runner started it; fails when the runner cannot be reached or refuses. `devCommand` replaces the project's Dev
// command for this one start (a preset or a command typed in Cron); `model` and `effort` are added to a claude command.
/**
 * @param {{ store: Store, claude?: boolean, prompt?: string, command?: string, devCommand?: string, projectId?: string,
 *   taskIds?: string[], title?: string, model?: string, effort?: string }} options
 */
export async function startDevSession({ store, claude = false, prompt = '', command = '', devCommand = '', projectId = '', taskIds = [], title = '', model = '', effort = '' }) {
  const base = runnerOf(store);
  const info = view.info ?? await runnerInfo(base);
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  const cwd = project?.localPath || info.root || '';
  const id = uid();
  let worktree = null;
  if (claude) {
    ({ command, worktree } = claudeCommand(store, projectId, title, id, cwd, devCommand, { model, effort }));
    const pointed = withTaskPointer(devHarnesses(store), command, prompt, taskIds);
    command = withPrompt(devHarnesses(store), pointed.command, pointed.prompt);
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

/** @param {Store} store @param {string} command */
function remember(store, command) {
  store.update(COLLECTION, (d) => {
    d.history = [command, ...d.history.filter((c) => c !== command)].slice(0, HISTORY_MAX);
  });
}

/** @param {Store} store @param {string} command */
function addFavorite(store, command) {
  const favorites = store.get(COLLECTION).favorites ?? [];
  if (favorites.includes(command)) return;
  if (favorites.length >= FAVORITES_MAX) return toast(`${FAVORITES_MAX} favorites already. Remove one first.`);
  store.update(COLLECTION, (d) => {
    d.favorites = [...(d.favorites ?? []), command];
  });
  toast('Added to favorites');
}

/** @param {Store} store @param {string} command */
function removeFavorite(store, command) {
  store.update(COLLECTION, (d) => {
    d.favorites = (d.favorites ?? []).filter((c) => c !== command);
  });
}

// The favorites menu: a favorite runs at once; the command typed, or a recent one, can be added, and any removed.
/** @param {Store} store @param {Session} s @param {HTMLInputElement} input @returns {MenuEntry[]} */
function favoritesMenu(store, s, input) {
  const { history, favorites = [] } = store.get(COLLECTION);
  const typed = input.value.trim();
  const recent = history.filter((c) => !favorites.includes(c));
  return [
    ...favorites.map((c) => ({ label: oneLine(c), icon: () => icon('play'), hint: 'Run', onSelect: () => run(store, s, c) })),
    favorites.length ? '-' : null,
    typed && !favorites.includes(typed) ? { label: `Add “${oneLine(typed)}”`, icon: () => icon('plus'), onSelect: () => addFavorite(store, typed) } : null,
    recent.length
      ? { label: 'Add a recent command', icon: () => icon('clock'), search: 'Find a command', items: recent.map((c) => ({ label: oneLine(c), onSelect: () => addFavorite(store, c) })) }
      : null,
    favorites.length
      ? { label: 'Remove a favorite', icon: () => icon('trash'), items: favorites.map((c) => ({ label: oneLine(c), danger: true, onSelect: () => removeFavorite(store, c) })) }
      : null,
    !favorites.length && !typed && !recent.length ? { label: 'Type a command, then add it here', icon: () => icon('info'), onSelect: () => input.focus() } : null,
  ];
}

// claude started again with the options it had, each kept as the shell word it was written as (a quoted
// --append-system-prompt or --model stays whole): the prompt (after `--`, or the first word that is no option's
// value) is not sent again, the worktree it named is returned apart, and --continue picks up its last conversation.
// null for a command that is not claude. A command the suggestion made (`cd <worktree> && claude …`) keeps its `cd`,
// so the conversation is continued in that folder again.
const SHELL_WORD = /(?:'[^']*'|"(?:\\.|[^"\\])*"|\\.|[^\s'"\\])+/gs;
const unquote = (/** @type {string} */ raw) =>
  raw.replace(/'([^']*)'|"((?:\\.|[^"\\])*)"|\\(.)/gs, (_, single, double, escaped) => single ?? (double !== undefined ? double.replace(/\\(.)/gs, '$1') : escaped));
const WORKTREE_NAME = /^[\w.-]{1,64}$/;
// claude's options that take no value; any other option takes the word after it.
const CLAUDE_SWITCHES = new Set([
  '--dangerously-skip-permissions', '--allow-dangerously-skip-permissions', '--verbose', '--debug', '-d', '--print', '-p', '--ide',
  '--strict-mcp-config', '--fork-session', '--include-partial-messages', '--replay-user-messages', '--chrome', '--no-chrome',
  '--disable-slash-commands',
]);
/** @param {string} command @returns {{ worktree: string, cd: string, command: string } | null} */
function claudeAgain(command) {
  const words = command.match(SHELL_WORD) ?? [];
  let cd = '';
  if (words[0] === 'cd' && words[1] && words[2] === '&&') cd = `cd ${words.splice(0, 3)[1]} && `;
  if (words[0] !== 'claude') return null;
  const kept = ['claude'];
  let worktree = '';
  for (let i = 1; i < words.length; i++) {
    const raw = words[i];
    if (raw === '--' || !raw.startsWith('-')) break;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const next = eq > 0 ? undefined : words[i + 1];
    const value = next !== undefined && next !== '--' && !next.startsWith('-');
    if (flag === '--worktree' || flag === '-w') {
      if (eq > 0) worktree = unquote(raw.slice(eq + 1));
      else if (value && WORKTREE_NAME.test(unquote(next))) worktree = unquote(words[++i]);
    } else if (flag === '--resume' || flag === '-r' || flag === '--session-id') {
      if (value) i++;
    } else if (flag !== '--continue' && flag !== '-c') {
      kept.push(raw);
      if (value && !CLAUDE_SWITCHES.has(flag)) kept.push(words[++i]);
    }
  }
  return { worktree: WORKTREE_NAME.test(worktree) ? worktree : '', cd, command: `${kept.join(' ')} --continue` };
}

// What the bar suggests once a command ended. claude that ran in a worktree (`claude --worktree <name>`) and quit:
// pick its conversation up in the same worktree, while the worktree is still there. claude anywhere else: continue it.
/** @param {Store} store @param {Session} s @returns {{ label: string, command: string } | null} */
function suggestion(store, s) {
  if (s.running || !s.exit || !s.command) return null;
  const again = claudeAgain(s.command);
  if (!again) return null;
  if (!again.worktree) return { label: 'Continue claude here', command: `${again.cd}${again.command}` };
  const path = `${s.cwd.replace(/\/+$/, '')}/.claude/worktrees/${again.worktree}`;
  // Whether the worktree is still there is asked of the runner once per command that ended.
  const key = `${path}\n${s.command}`;
  if (s.pickup?.key !== key && view.info) {
    const pickup = { key, ok: /** @type {boolean | null} */ (null) };
    s.pickup = pickup;
    listFolder(runnerOf(store), path).then(() => true, () => false).then((ok) => {
      pickup.ok = ok;
      if (s.pickup === pickup) store.refresh();
    });
  }
  return s.pickup?.key === key && s.pickup.ok
    ? { label: `Pick up claude in ${again.worktree}`, command: `cd ${shellQuote(path)} && ${again.command}` }
    : null;
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

// Shows a side panel, and remembers it for this browser.
/** @param {Store} store @param {string} side */
function showSide(store, side) {
  view.side = side;
  try {
    localStorage.setItem(SIDE_KEY, side);
  } catch {}
  store.refresh();
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
    onclick: () => showSide(store, side),
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

// A terminal's right-click menu, in the Terminals panel and on its tab.
/** @param {Store} store @param {Session} s @returns {MenuEntry[]} */
function sessionMenu(store, s) {
  const task = s.tasks.map((id) => store.get('todos').items.find((t) => t.id === id)).find(Boolean);
  const others = view.sessions.filter((x) => x !== s);
  return [
    { label: 'Show', icon: () => icon('terminal'), onSelect: () => jumpTo(store, s) },
    s.running ? { label: 'Stop the command', icon: () => icon('stop'), onSelect: () => { stopCommand(runnerOf(store), s.id).catch((err) => toast(err.message)); } } : null,
    { label: 'Clear the output', icon: () => icon('clear-all'), onSelect: () => clearTerminal(s) },
    view.sessions.length < maxSessions() ? {
      label: 'Open a new terminal in its folder',
      icon: () => icon('plus'),
      onSelect: () => {
        if (newSession(store, s.cwd || undefined)) store.refresh();
      },
    } : null,
    task ? {
      label: 'Open its task',
      icon: () => icon('check-square'),
      onSelect: () => { location.hash = `#/todos?${new URLSearchParams({ filter: task.projectId || 'personal', status: 'all', task: task.id })}`; },
    } : null,
    '-',
    s.cwd ? copyItem('Copy folder path', s.cwd) : null,
    s.command ? copyItem('Copy command', s.command) : null,
    '-',
    others.length ? { label: 'Close the others', icon: () => icon('x'), onSelect: () => confirmClose(store, others, 'Close the other terminals') } : null,
    {
      label: s.running ? 'Stop and close' : 'Close',
      icon: () => icon('trash'),
      danger: s.running,
      onSelect: () => {
        closeSession(s);
        store.refresh();
      },
    },
  ];
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
    return onContextMenu(h('div', { class: s.id === shown ? 'tree-row scm-row term-list-row active' : 'tree-row scm-row term-list-row' },
      h('button', {
        type: 'button',
        class: 'tree-item',
        title: [`Terminal ${numberOf(s)} · ${s.cwd || 'board'}`, s.running ? s.command : '', ...titles].filter(Boolean).join('\n'),
        'aria-current': s.id === shown ? 'true' : null,
        onclick: () => jumpTo(store, s),
      },
        dot(s, 'wt-dot'),
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
      }, icon('x'))), () => sessionMenu(store, s));
  };
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Terminals' },
    switcher,
    panelHead('Terminals', panelAction('plus', 'Open a new terminal in the workspace folder', () => {
      if (newSession(store)) store.refresh();
    }, view.sessions.length >= maxSessions())),
    h('div', { class: 'ide-explorer-head' }, picker),
    list.length ? h('div', { class: 'tree-root muted small' }, `${list.length} OPEN · ${running} RUNNING`) : null,
    list.length > SOFT_SESSIONS ? crowdedNotice(store) : null,
    list.length
      ? h('div', { class: 'stack wt' },
        h('div', { class: 'row wt-actions' },
          h('button', { type: 'button', class: 'btn-small', disabled: !idle.length, title: 'Close the terminals where nothing runs', onclick: () => confirmClose(store, idle, 'Close idle terminals') }, icon('trash'), `Close idle${idle.length ? ` (${idle.length})` : ''}`),
          h('button', { type: 'button', class: 'btn-small danger', title: 'Stop every running command and close every terminal', onclick: () => confirmClose(store, list, 'Close all terminals') }, icon('trash'), 'Close all')),
        h('div', { class: 'tree scm-list', role: 'list' }, list.map(row)))
      : h('p', { class: 'muted small' }, 'No terminals open.'));
}

// Past SOFT_SESSIONS open terminals: a nudge to close the idle and finished ones and those of tasks in review.
/** @param {Store} store */
function crowdedNotice(store) {
  const stale = staleSessions(store);
  return notice({
    tone: 'info',
    text: `${view.sessions.length} of ${maxSessions()} terminals are open. ${stale.length ? `${stale.length} ${stale.length === 1 ? 'is' : 'are'} idle, finished or for a task done or in review.` : 'Close the ones you are done with.'}`,
    actions: stale.length ? [h('button', { type: 'button', class: 'btn-small', onclick: () => confirmClose(store, stale, 'Clean up terminals') }, icon('trash'), `Clean up (${stale.length})`)] : [],
  });
}

// The bar names the terminal shown; the Terminals panel lists them all, so a click on the name opens it.
/** @param {Store} store @param {Session} s */
function sessionTitle(store, s) {
  const full = view.sessions.length >= maxSessions();
  return h('div', { class: 'term-title' },
    onContextMenu(h('button', {
      type: 'button',
      class: 'term-name',
      title: `${s.cwd || 'board'}\nShow every terminal in the side panel`,
      onclick: () => {
        view.side = 'terminals';
        try {
          localStorage.setItem(SIDE_KEY, view.side);
        } catch {}
        store.refresh();
      },
    }, s.running || dots.status[s.id] ? dot(s, 'term-dot') : icon('terminal'), h('span', null, `${numberOf(s)} · ${s.cwd ? baseName(s.cwd) : 'board'}`)), () => sessionMenu(store, s)),
    h('span', { class: 'term-claude' }, claudeButtons(store, s)),
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

// What the bar shows of the claude the shown terminal runs: its turns, its subagents, its tools, its skills and
// MCP tools.
/** @param {Store} store @param {Session} s */
function claudeButtons(store, s) {
  refreshTurns(store, s);
  return [turnsButton(store, s), agentsButton(store, s), toolsButton(store, s), toolButtons(store, s)];
}

// Draws those buttons again where they stand, without the page: the shell holds a page render back while a panel
// is open (the subagents panel too), a field has unsent text or the tab is hidden, and the counts went stale.
// Only when they read differently, and not under a press, whose click a new button would drop: the next read
// draws them then.
/** @param {Store} store @param {Session} s */
function drawClaudeButtons(store, s) {
  const slot = document.querySelector('.dev .term-claude');
  if (!slot || activeSession() !== s || slot.querySelector(':active')) return;
  const next = h('span', null, turnsButton(store, s), agentsButton(store, s), toolsButton(store, s), toolButtons(store, s));
  if (next.innerHTML === slot.innerHTML) return;
  const focused = [...slot.children].findIndex((el) => el === document.activeElement);
  const kind = focused < 0 ? '' : slot.children[focused].className.split(' ').slice(0, 2).join('.');
  slot.replaceChildren(...next.childNodes);
  if (kind) /** @type {HTMLElement | null} */ (slot.querySelector(`.${kind}`))?.focus({ preventScroll: true });
}

// The turns of the claude the shown terminal runs, read from its transcript through the runner: again every few
// seconds while it runs (sooner while it or a subagent works), and once after it ended. The loop runs on its own
// timer, for whichever terminal is shown when it fires, and a read that never answers is given up.
const TURNS_MS = 4000;
const TURNS_WORKING_MS = 2000;
const TURNS_TIMEOUT_MS = 15000;
/** @type {{ id: string, at: number, busy: boolean, data: RunnerTurns | null, timer: number }} */
const turnsView = { id: '', at: 0, busy: false, data: null, timer: 0 };
/** @param {Store} store */
function nextTurns(store) {
  const s = activeSession();
  if (s && document.querySelector('.dev')) refreshTurns(store, s);
}
/** @param {Store} store @param {Session} s */
function refreshTurns(store, s) {
  if (turnsView.id !== s.id) Object.assign(turnsView, { id: s.id, at: 0, data: null });
  clearTimeout(turnsView.timer);
  if (turnsView.busy || !view.info) return;
  const data = turnsView.data;
  // An ended claude no longer changes: read once more, then wait for the next command.
  if (data && !s.running && data.state === 'done') return;
  const working = data?.state === 'working' || data?.agents?.some((a) => a.state === 'working');
  const due = turnsView.at + (working ? TURNS_WORKING_MS : TURNS_MS) - Date.now();
  if (due > 0) {
    turnsView.timer = window.setTimeout(() => nextTurns(store), due);
    return;
  }
  turnsView.busy = true;
  sessionTurns(runnerOf(store), s.id, AbortSignal.timeout(TURNS_TIMEOUT_MS)).then((read) => {
    if (turnsView.id !== s.id) return;
    turnsView.data = read;
    drawClaudeButtons(store, s);
    drawTurns();
  }, () => {}).finally(() => {
    turnsView.busy = false;
    if (turnsView.id === s.id) turnsView.at = Date.now();
    // Another terminal may be shown by now: its read waited for this one.
    nextTurns(store);
  });
}

const TURN_STATES = /** @type {Record<string, string>} */ ({ working: 'Working', waiting: 'Waiting for you', done: 'Done' });
// A prompt on one line, short enough for a menu row.
const turnLine = (/** @type {string} */ text) => {
  const line = oneLine(text);
  return line.length > 70 ? `${line.slice(0, 69)}…` : line;
};
const clock = (/** @type {number} */ at) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const took = (/** @type {number} */ ms) => {
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  const min = Math.round(ms / 60000);
  return min < 60 ? `${min} min` : `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ''}`;
};
const WAIT_KINDS = /** @type {Record<string, string>} */ ({ question: 'a question', plan: 'the plan', permission: 'a permission' });

// A turn's stretches, in order: claude working, and waiting on its user between them. The last turn still going
// runs to now, and so does a wait not answered yet.
/** @param {SessionTurn} t @param {boolean} live @param {number} now */
function phasesOf(t, live, now) {
  const end = live ? Math.max(now, t.end) : t.end;
  /** @type {{ kind: string, at: number, end: number }[]} */
  const phases = [];
  let at = t.at;
  for (const w of t.waits ?? []) {
    const wEnd = w.end || end;
    if (w.at > at) phases.push({ kind: 'work', at, end: w.at });
    phases.push({ kind: w.kind, at: Math.max(w.at, at), end: wEnd });
    at = Math.max(at, wEnd);
  }
  if (end > at) phases.push({ kind: 'work', at, end });
  const waited = phases.reduce((n, p) => n + (p.kind === 'work' ? 0 : p.end - p.at), 0);
  return { phases, total: end - t.at, waited, worked: end - t.at - waited };
}

// The turns panel, open under the turns button: each turn with its prompt, a bar of its working and waiting
// stretches, and their times. It follows the data while open, and the clock for the turn still going. The
// subagents panel opens in its place, under the subagents button (kind 'agents'), and so do the tools, skills and
// MCP panels under theirs.
/** @typedef {'turns' | 'agents' | 'tools' | 'skills' | 'mcp'} PopKind */
/** @type {{ el: HTMLElement, s: Session, timer: number, kind: PopKind, store: Store } | null} */
let turnsPop = null;

function closeTurns() {
  if (!turnsPop) return;
  clearInterval(turnsPop.timer);
  turnsPop.el.remove();
  turnsPop = null;
  document.removeEventListener('pointerdown', onTurnsOutside, true);
  document.removeEventListener('keydown', onTurnsKey, true);
  window.removeEventListener('hashchange', closeTurns);
  window.removeEventListener('resize', closeTurns);
}
/** @param {PointerEvent} e */
function onTurnsOutside(e) {
  const target = /** @type {Element} */ (e.target);
  if (turnsPop?.el.contains(target) || target.closest?.('.term-turns, .term-tool')) return;
  closeTurns();
}
/** @param {KeyboardEvent} e */
function onTurnsKey(e) {
  if (e.key !== 'Escape') return;
  e.stopPropagation();
  closeTurns();
}

const POP_LABELS = { turns: 'Claude turns', agents: 'Claude subagents', tools: 'Claude tools', skills: 'Claude skills', mcp: 'Claude MCP calls' };
/** @param {Store} store @param {HTMLElement} anchor @param {Session} s @param {PopKind} [kind] */
function openTurns(store, anchor, s, kind = 'turns') {
  closeMenu();
  closeTurns();
  const el = h('div', { class: `popover turns-pop ${kind}-pop`, role: 'dialog', 'aria-label': POP_LABELS[kind] });
  document.body.append(el);
  turnsPop = { el, s, kind, store, timer: window.setInterval(() => drawTurns(), 1000) };
  drawTurns();
  const r = anchor.getBoundingClientRect();
  const x = Math.max(8, Math.min(r.left, window.innerWidth - el.offsetWidth - 8));
  Object.assign(el.style, { left: `${x}px`, top: `${r.bottom + 4}px`, maxHeight: `${window.innerHeight - r.bottom - 12}px` });
  document.addEventListener('pointerdown', onTurnsOutside, true);
  document.addEventListener('keydown', onTurnsKey, true);
  window.addEventListener('hashchange', closeTurns);
  window.addEventListener('resize', closeTurns);
}

function drawTurns() {
  if (!turnsPop) return;
  const { el, s } = turnsPop;
  const data = turnsView.id === s.id ? turnsView.data : null;
  if (!data || activeSession() !== s || !el.isConnected) return closeTurns();
  if (turnsPop.kind === 'agents') return drawAgents(el, data.agents ?? []);
  if (turnsPop.kind === 'tools') return drawTools(el, data);
  if (turnsPop.kind === 'mcp') return drawMcp(el, data);
  if (turnsPop.kind === 'skills') {
    const { store } = turnsPop;
    return drawSkills(el, data, { ctx: filesCtx(store), known: knownSkills(rootPath(store, view.workspace)), close: closeTurns, browse: () => showSide(store, 'skills') });
  }
  const { turns, state } = data;
  const now = Date.now();
  const idle = idleOf(data, now);
  const rows = turns.map((t, i) => {
    const live = i === turns.length - 1 && state !== 'done' && !idle.now;
    return { t, n: i + 1, live, ...phasesOf(t, live, now) };
  }).reverse();
  const worked = rows.reduce((n, r) => n + r.worked, 0);
  const waited = rows.reduce((n, r) => n + r.waited, 0);
  const idled = idle.gaps.reduce((n, g) => n + g.end - g.at, 0);
  // Each wait for the next prompt sits after the turn it follows, newest first like the turns.
  const gapAfter = new Map(idle.gaps.map((g) => [g.after, g]));
  const label = TURN_STATES[state] ?? state;
  const ask = state === 'waiting' && data.ask?.text ? data.ask.text : '';
  const signalled = state === 'done' && !!turns.at(-1)?.done;
  const scroll = el.querySelector('.turns-list')?.scrollTop ?? 0;
  el.replaceChildren(
    h('div', { class: 'turns-head' },
      h('div', { class: 'turns-title' },
        signalled
          ? h('span', { class: 'term-turns-check', role: 'img', 'aria-label': label }, icon('check'))
          : h('span', { class: `term-turns-state ${state}`, role: 'img', 'aria-label': label }),
        h('strong', null, label),
        h('span', { class: 'muted' }, `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'}`)),
      turns.length ? h('div', { class: 'muted small turns-sum' },
        h('span', { class: 'turns-key work' }), `${took(worked)} working`,
        waited ? [h('span', { class: 'turns-key wait' }), `${took(waited)} waiting on you`] : null,
        idled ? [h('span', { class: 'turns-key idle' }), `${took(idled)} waiting for your next prompt`] : null) : null,
      ask ? h('div', { class: 'small turns-ask' }, icon('alert'), h('span', null, ask)) : null,
      signalled ? h('div', { class: 'small turns-signal' }, icon('check'), h('span', null, 'claude said the work is done')) : null),
    rows.length
      ? h('div', { class: 'turns-list', role: 'list' }, rows.flatMap((r) => {
        const gap = gapAfter.get(r.n);
        return [gap ? idleRow(gap) : null, turnRow(r)];
      }))
      : h('p', { class: 'muted small' }, 'No prompt yet.'));
  const list = el.querySelector('.turns-list');
  if (list) list.scrollTop = scroll;

  /** @param {typeof rows[number]} r */
  function turnRow(r) {
    const status = r.live ? state : r.t.interrupted ? 'interrupted' : 'done';
    const now = r.live ? r.phases.at(-1) : undefined;
    const waits = r.t.waits?.length ?? 0;
    const signal = !r.live && !!r.t.done;
    return h('button', {
      type: 'button',
      class: `turns-row ${status}${signal ? ' signal' : ''}`,
      role: 'listitem',
      title: `${r.t.text}\n\nClick to copy the prompt`,
      onclick: () => { navigator.clipboard.writeText(r.t.text).then(() => toast('Prompt copied'), () => toast('Could not copy')); },
    },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-icon' }, status === 'working' ? h('span', { class: 'term-dot' }) : icon(status === 'waiting' ? 'alert' : status === 'interrupted' ? 'stop' : 'check')),
      h('span', { class: 'turns-text' }, `${r.n}. ${turnLine(r.t.text)}`),
      signal ? h('span', { class: 'turns-done', title: 'claude ended this turn with the done signal' }, 'Done') : null,
      h('span', { class: 'turns-took' }, r.total > 0 ? took(r.total) : '')),
    r.total > 0 ? h('div', { class: 'turns-bar', 'aria-hidden': 'true' }, r.phases.map((p) => h('span', {
      class: `turns-seg ${p.kind === 'work' ? 'work' : 'wait'}`,
      style: { flexGrow: String(Math.max(p.end - p.at, 1)) },
      title: `${p.kind === 'work' ? 'Working' : `Waiting on ${WAIT_KINDS[p.kind] ?? 'you'}`} · ${clock(p.at)} · ${took(p.end - p.at)}`,
    }))) : null,
    h('div', { class: 'muted small turns-meta' },
      h('span', null, `Started ${clock(r.t.at)}`),
      now ? h('span', null, h('span', { class: `turns-key ${now.kind === 'work' ? 'work' : 'wait'}` }),
        `Now ${now.kind === 'work' ? 'working' : `waiting on ${WAIT_KINDS[now.kind] ?? 'you'}`} for ${took(now.end - now.at)}`) : null,
      r.total > 0 ? h('span', null, h('span', { class: 'turns-key work' }), `${took(r.worked)} working`) : null,
      r.waited ? h('span', null, h('span', { class: 'turns-key wait' }), `${took(r.waited)} waiting on you${waits > 1 ? ` (${waits} times)` : ''}`) : null,
      status === 'interrupted' ? h('span', null, 'Interrupted') : null));
  }
}

// The times claude waited for its user's next prompt: between two turns, and after the last one while claude sits
// at its prompt with nothing asked. A pause of a moment is left out.
const IDLE_MIN_MS = 1000;
/** @param {RunnerTurns} data @param {number} now */
function idleOf(data, now) {
  const { turns, state } = data;
  /** @type {{ after: number, at: number, end: number, live: boolean }[]} */
  const gaps = [];
  turns.slice(1).forEach((t, i) => {
    if (t.at - turns[i].end >= IDLE_MIN_MS) gaps.push({ after: i + 1, at: turns[i].end, end: t.at, live: false });
  });
  const last = turns.at(-1);
  const idleNow = !!last && state === 'waiting' && !data.ask && !last.waits.some((w) => !w.end);
  if (idleNow && last) gaps.push({ after: turns.length, at: last.end, end: Math.max(now, last.end), live: true });
  return { gaps, now: idleNow };
}

/** @param {{ at: number, end: number, live: boolean }} g */
function idleRow(g) {
  return h('div', { class: `turns-row idle${g.live ? ' live' : ''}`, role: 'listitem' },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-icon' }, icon('clock')),
      h('span', { class: 'turns-text' }, 'Waiting for you'),
      h('span', { class: 'turns-took' }, took(g.end - g.at))),
    h('div', { class: 'turns-bar', 'aria-hidden': 'true' }, h('span', { class: 'turns-seg idle', style: { flexGrow: '1' } })),
    h('div', { class: 'muted small turns-meta' },
      h('span', null, g.live ? `Since ${clock(g.at)}` : `From ${clock(g.at)} to ${clock(g.end)}`)));
}

// How many turns the shown claude took, and where the last one stands; a click opens the turns panel.
/** @param {Store} store @param {Session} s */
function turnsButton(store, s) {
  const data = turnsView.id === s.id ? turnsView.data : null;
  if (!data?.claude) return null;
  const { turns, state } = data;
  const label = TURN_STATES[state] ?? state;
  // claude's done signal shows as a check where the state's dot would be.
  const signalled = state === 'done' && !!turns.at(-1)?.done;
  const ask = state === 'waiting' && data.ask ? `: ${data.ask.text}` : signalled ? ' (claude gave the done signal)' : '';
  return h('button', {
    type: 'button',
    class: `term-turns ${state}${signalled ? ' signal' : ''}`,
    title: `${turns.length} ${turns.length === 1 ? 'turn' : 'turns'} in this claude session · ${label}${ask}\nShow each turn, with its working and waiting times`,
    'aria-label': `Turns: ${turns.length}, ${label}`,
    'aria-haspopup': 'dialog',
    'aria-expanded': String(turnsPop?.s === s && turnsPop.kind === 'turns'),
    onclick: (/** @type {MouseEvent} */ e) => {
      e.stopPropagation();
      if (turnsPop?.s === s && turnsPop.kind === 'turns') return closeTurns();
      openTurns(store, /** @type {HTMLElement} */ (e.currentTarget), s);
    },
  }, icon('message'), h('span', null, String(turns.length)), signalled
    ? h('span', { class: 'term-turns-check', role: 'img', 'aria-label': label }, icon('check'))
    : h('span', { class: 'term-turns-state', role: 'img', 'aria-label': label }));
}

// The subagents the shown claude started, read with its turns: how many still work (or how many it ran, once all
// are done). A click opens the subagents panel.
/** @param {Store} store @param {Session} s */
function agentsButton(store, s) {
  const data = turnsView.id === s.id ? turnsView.data : null;
  if (!data?.claude) return null;
  const agents = data.agents ?? [];
  const working = agents.filter((a) => a.state === 'working').length;
  const isOpen = () => turnsPop?.s === s && turnsPop.kind === 'agents';
  const title = `${agents.length} ${agents.length === 1 ? 'subagent' : 'subagents'} in this claude session${working ? ` · ${working} working` : ''}\nShow what each one is doing`;
  return h('button', {
    type: 'button',
    class: `term-tool agents${working ? ' working' : agents.length ? '' : ' none'}`,
    title,
    'aria-label': title.split('\n')[0],
    'aria-haspopup': 'dialog',
    'aria-expanded': String(isOpen()),
    onclick: (/** @type {MouseEvent} */ e) => {
      e.stopPropagation();
      if (isOpen()) return closeTurns();
      openTurns(store, /** @type {HTMLElement} */ (e.currentTarget), s, 'agents');
    },
  }, icon('users'), h('span', null, working ? `${working}/${agents.length}` : String(agents.length)), working ? h('span', { class: 'term-dot' }) : null);
}

const AGENT_STATES = /** @type {Record<string, string>} */ ({ working: 'Working', done: 'Done', stopped: 'Stopped' });
// The subagents whose rows are unfolded to show their task and last text, by id.
const agentsOpen = new Set();

// The subagents panel: each subagent, newest first, with its task, how long it ran, and what it does now (its last
// tool call) or what it answered once done. A click unfolds its full task and last text.
/** @param {HTMLElement} el @param {SessionAgent[]} agents */
function drawAgents(el, agents) {
  const now = Date.now();
  const working = agents.filter((a) => a.state === 'working').length;
  const scroll = el.querySelector('.turns-list')?.scrollTop ?? 0;
  el.replaceChildren(
    h('div', { class: 'turns-head' },
      h('div', { class: 'turns-title' },
        icon('users'),
        h('strong', null, 'Subagents'),
        h('span', { class: 'muted' }, working ? `${working} working · ${agents.length} in all` : `${agents.length} in all`))),
    agents.length
      ? h('div', { class: 'turns-list', role: 'list' }, agents.map(agentRow))
      : h('p', { class: 'muted small agents-empty' }, 'No subagent started yet.'));
  const list = el.querySelector('.turns-list');
  if (list) list.scrollTop = scroll;

  /** @param {SessionAgent} a */
  function agentRow(a) {
    const live = a.state === 'working';
    const unfolded = agentsOpen.has(a.id);
    const ran = (live ? now : a.end) - a.start;
    const kind = [a.type, a.background ? 'background' : ''].filter(Boolean).join(' · ');
    const answer = a.said.replace(/\s+/g, ' ');
    return h('button', {
      type: 'button',
      class: `turns-row agent-row ${a.state}`,
      role: 'listitem',
      'aria-expanded': String(unfolded),
      title: unfolded ? 'Click to fold' : 'Click to show its task and last text',
      onclick: () => {
        if (unfolded) agentsOpen.delete(a.id);
        else agentsOpen.add(a.id);
        drawTurns();
      },
    },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-icon' }, live ? h('span', { class: 'term-dot' }) : icon(a.state === 'stopped' ? 'stop' : 'check')),
      h('span', { class: 'turns-text' }, a.description || turnLine(a.task) || a.id),
      h('span', { class: 'turns-took' }, a.start && ran > 0 ? took(ran) : '')),
    h('div', { class: 'muted small turns-meta' },
      h('span', null, [AGENT_STATES[a.state] ?? a.state, kind, a.start ? `started ${clock(a.start)}` : '', `${a.tools} tool ${a.tools === 1 ? 'call' : 'calls'}`].filter(Boolean).join(' · ')),
      live && a.tool ? h('span', { class: 'agent-now' }, icon('terminal'), h('span', null, `${a.tool.name}${a.tool.detail ? `: ${a.tool.detail}` : ''}`)) : null,
      !live && answer && !unfolded ? h('span', { class: 'agent-now' }, icon('message'), h('span', null, answer)) : null),
    unfolded ? h('div', { class: 'small agent-more' },
      a.task ? [h('div', { class: 'muted' }, 'Task'), h('p', null, a.task)] : null,
      a.said ? [h('div', { class: 'muted' }, live ? 'Last said' : 'Answer'), h('p', null, a.said)] : null) : null);
  }
}

// The tools the shown claude called, read with its turns: how many calls its session and its subagents made so
// far. A click opens the tools panel.
/** @param {Store} store @param {Session} s */
function toolsButton(store, s) {
  const data = turnsView.id === s.id ? turnsView.data : null;
  if (!data?.claude) return null;
  const { rows, calls, errors, agents } = sessionTools(data.turns, data.agentTools);
  const isOpen = () => turnsPop?.s === s && turnsPop.kind === 'tools';
  const more = [`${rows.length} ${rows.length === 1 ? 'tool' : 'tools'}`, agents ? `${agents} by subagents` : '', errors ? `${errors} failed` : ''].filter(Boolean).join(', ');
  const title = `${calls} tool ${calls === 1 ? 'call' : 'calls'} in this claude session${rows.length ? ` (${more})` : ''}\nShow a summary of the tools it used`;
  return h('button', {
    type: 'button',
    class: `term-tool tools${calls ? '' : ' none'}`,
    title,
    'aria-label': title.split('\n')[0],
    'aria-haspopup': 'dialog',
    'aria-expanded': String(isOpen()),
    onclick: (/** @type {MouseEvent} */ e) => {
      e.stopPropagation();
      if (isOpen()) return closeTurns();
      openTurns(store, /** @type {HTMLElement} */ (e.currentTarget), s, 'tools');
    },
  }, icon('wrench'), h('span', null, String(calls)));
}

// The tools panel, a summary of the tools the session used: the calls it and its subagents made, how many failed
// and the time they took, the tools called most, then every tool, the most called first, with a bar of its share
// of the calls (the failed ones in red), its failures and its time per call. A row naming several tools (an MCP
// server's, the subagents') lists them in its tooltip. A click on a tool with failures unfolds them, newest first:
// when each was called, what it was given and the error it got back.
// The tools whose failures are unfolded, by row key.
const toolsOpen = new Set();
/** @param {HTMLElement} el @param {RunnerTurns} data */
function drawTools(el, data) {
  const { rows, calls, errors, ms, agents } = sessionTools(data.turns, data.agentTools);
  /** @type {Map<string, ToolFailure[]>} */
  const failed = new Map();
  for (const f of data.failures ?? []) {
    const { key } = toolGroup(f.name);
    failed.set(key, [f, ...(failed.get(key) ?? [])]);
  }
  const most = rows[0]?.calls ?? 0;
  // Most calls answer in well under a second.
  const perCall = (/** @type {number} */ t) => (t < 1000 ? `${Math.max(1, Math.round(t))} ms` : fmtSpan(t));
  const started = data.agents?.length ?? 0;
  const top = rows.slice(0, 3).map((r) => `${r.label} ${pct(r.calls, calls)}`).join(', ');
  const slowest = [...rows].sort((a, b) => b.ms - a.ms)[0];
  const failing = [...rows].sort((a, b) => b.errors - a.errors)[0];
  const facts = /** @type {[string, string][]} */ ([
    ['By', started || agents ? `claude ${calls - agents} · its ${started === 1 ? 'subagent' : `${started || ''} subagents`.trim()} ${agents}` : ''],
    ['Most used', rows.length > 1 ? top : ''],
    ['Most time', rows.length > 1 && slowest?.ms >= 1000 ? `${slowest.label}, ${fmtSpan(slowest.ms)} (${pct(slowest.ms, ms)} of the time in calls)` : ''],
    ['Most failures', rows.length > 1 && failing?.errors ? `${failing.label}, ${failing.errors} of its ${failing.calls} calls` : ''],
  ]).filter(([, text]) => text);
  const scroll = el.querySelector('.turns-list')?.scrollTop ?? 0;
  el.replaceChildren(
    h('div', { class: 'turns-head' },
      h('div', { class: 'turns-title' },
        icon('wrench'),
        h('strong', null, 'Tools'),
        h('span', { class: 'muted' }, `${calls} ${calls === 1 ? 'call' : 'calls'} · ${rows.length} ${rows.length === 1 ? 'tool' : 'tools'}`)),
      calls ? h('div', { class: 'muted small turns-sum' },
        h('span', { class: 'turns-key work' }), `${calls - errors} succeeded`,
        errors ? [h('span', { class: 'turns-key fail' }), `${errors} failed (${pct(errors, calls)})`] : null,
        ms ? h('span', { class: 'tools-time' }, `${fmtSpan(ms)} in calls`) : null) : null,
      facts.length ? h('dl', { class: 'small tools-facts' }, facts.map(([name, text]) => [h('dt', { class: 'muted' }, name), h('dd', null, text)])) : null,
      started && !data.agentTools ? h('div', { class: 'muted small' }, 'Restart the command runner to count the subagents’ calls.') : null),
    rows.length
      ? h('div', { class: 'turns-list', role: 'list' }, rows.map(toolRow))
      : h('p', { class: 'muted small agents-empty' }, 'No tool called yet.'));
  const list = el.querySelector('.turns-list');
  if (list) list.scrollTop = scroll;

  /** @param {typeof rows[number]} r */
  function toolRow(r) {
    const names = r.names.map((n) => (n.startsWith('mcp__') ? mcpTool(n).tool || n : n));
    const unfolded = r.errors > 0 && toolsOpen.has(r.key);
    const head = [
      h('div', { class: 'turns-line' },
        h('span', { class: 'turns-icon' }, icon(r.key.startsWith('mcp:') ? 'plug' : r.key === 'Agent' ? 'users' : r.key === 'Skill' ? 'zap' : 'wrench')),
        h('span', { class: 'turns-text' }, r.label),
        h('span', { class: 'turns-took' }, `${r.calls}×`)),
      h('div', { class: 'turns-bar', 'aria-hidden': 'true' },
        h('span', { class: 'turns-seg work', style: { flexGrow: String(r.calls - r.errors) } }),
        r.errors ? h('span', { class: 'turns-seg fail', style: { flexGrow: String(r.errors) } }) : null,
        h('span', { class: 'turns-seg rest', style: { flexGrow: String(most - r.calls) } })),
      h('div', { class: 'muted small turns-meta' },
        h('span', null, [
          `${pct(r.calls, calls)} of the calls`,
          r.errors ? `${r.errors} failed (${pct(r.errors, r.calls)})` : '',
          r.agents ? `${r.agents} by subagents` : '',
          r.ms ? `${perCall(r.ms / r.calls)} a call` : '',
          r.ms >= 1000 && r.calls > 1 ? `${fmtSpan(r.ms)} in all` : '',
        ].filter(Boolean).join(' · '))),
    ];
    const several = names.length > 1 || names[0] !== r.label ? names.join('\n') : '';
    // Only a tool with failures has something to unfold. Its details stay out of the button, so their text can be selected.
    const row = h('div', { class: `turns-row tool-row${r.errors ? ' failed' : ''}`, role: 'listitem' },
      r.errors
        ? h('button', {
          type: 'button',
          class: 'tool-head',
          'aria-expanded': String(unfolded),
          title: [several, unfolded ? 'Click to fold' : `Click to show ${r.errors === 1 ? 'the failed call' : 'the failed calls'}`].filter(Boolean).join('\n'),
          onclick: () => {
            if (unfolded) toolsOpen.delete(r.key);
            else toolsOpen.add(r.key);
            drawTurns();
          },
        }, head)
        : head,
      unfolded ? failuresOf(r, names.length > 1) : null);
    if (!r.errors && several) row.title = several;
    return row;
  }

  /** @param {typeof rows[number]} r @param {boolean} named whether the row adds up several tools */
  function failuresOf(r, named) {
    const list = failed.get(r.key) ?? [];
    const missing = r.errors - list.length;
    const today = new Date().toDateString();
    const when = (/** @type {number} */ at) => (!at ? '' : new Date(at).toDateString() === today ? clock(at) : `${new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric' })} ${clock(at)}`);
    return h('div', { class: 'small tool-fails' },
      list.map((f) => h('div', { class: 'tool-fail' },
        h('div', { class: 'muted' }, [when(f.at), named ? (f.name.startsWith('mcp__') ? mcpTool(f.name).tool || f.name : f.name) : '', f.agent ? `by subagent ${f.agent}` : ''].filter(Boolean).join(' · ')),
        f.detail ? h(f.command ? 'div' : 'code', { class: 'tool-fail-call' }, f.detail) : null,
        f.command ? h('pre', { class: 'tool-fail-error' }, f.command) : null,
        h('pre', { class: 'tool-fail-error' }, f.error || 'It gave no error text.'))),
      !data.failures ? h('div', { class: 'muted' }, 'Restart the command runner to read what failed.')
        : missing > 0 ? h('div', { class: 'muted' }, list.length ? `${missing} older ${missing === 1 ? 'failure is' : 'failures are'} not kept.` : 'These failures are too old to be kept.') : null);
  }
}

// The skills and the MCP tools the shown claude used, read with its turns: a button each, with its own count, and
// the MCP one with its failed calls in red. A click opens its panel (dev-uses.js).
/** @param {Store} store @param {Session} s */
function toolButtons(store, s) {
  const data = turnsView.id === s.id ? turnsView.data : null;
  if (!data?.claude) return null;
  const mcp = mcpOf(data);
  /** @param {'skills' | 'mcp'} kind @param {IconName} name @param {number} count @param {string} title @param {number} [failed] */
  const button = (kind, name, count, title, failed = 0) => {
    const isOpen = () => turnsPop?.s === s && turnsPop.kind === kind;
    return h('button', {
      type: 'button',
      class: `term-tool ${kind}${count ? '' : ' none'}`,
      title,
      'aria-label': title.split('\n')[0],
      'aria-haspopup': 'dialog',
      'aria-expanded': String(isOpen()),
      onclick: (/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        if (isOpen()) return closeTurns();
        openTurns(store, /** @type {HTMLElement} */ (e.currentTarget), s, kind);
      },
    }, icon(name), h('span', null, String(count)), failed ? h('span', { class: 'term-fail' }, `${failed} failed`) : null);
  };
  return [
    button('skills', 'zap', skillsOf(data).uses, skillsTitle(data)),
    button('mcp', 'plug', mcp.calls, mcpTitle(data), mcp.errors),
  ];
}

/** @param {Store} store @param {Session} s */
function terminal(store, s) {
  const history = store.get(COLLECTION).history;
  const { out } = elementsOf(store, s);
  out.toggleAttribute('data-autofocus', s.running);
  const input = h('input', {
    name: 'command',
    class: 'term-input',
    placeholder: 'Type a command and press Enter',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
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

  const keys = (/** @type {string} */ label, /** @type {string} */ data, /** @type {string} */ title) =>
    h('button', {
      type: 'button',
      class: 'term-key',
      title,
      onclick: () => {
        if (s.pid) sendInput(runnerOf(store), s.pid, { data });
        /** @type {TermEl} */ (s.el).out.focus({ preventScroll: true });
      },
    }, label);
  const recent = history.length && !s.running
    ? h('button', {
      type: 'button',
      class: 'icon-btn term-history',
      title: 'Recent commands (Up and Down in the command line walk them too)',
      'aria-label': 'Recent commands',
      'aria-haspopup': 'menu',
      onclick: (/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        openMenu(history.slice(0, RECENT_SHOWN).map((c) => ({
          label: oneLine(c),
          icon: () => icon('terminal'),
          onSelect: () => {
            input.value = c;
            input.focus();
          },
        })), /** @type {HTMLElement} */ (e.currentTarget));
      },
    }, icon('clock'))
    : null;
  const state = s.running ? '' : exitText(s.exit);
  const next = suggestion(store, s);
  const favorites = s.running
    ? null
    : h('button', {
      type: 'button',
      class: 'icon-btn term-favorites',
      title: 'Favorite commands: run one, or add the command typed',
      'aria-label': 'Favorite commands',
      'aria-haspopup': 'menu',
      onclick: (/** @type {MouseEvent} */ e) => {
        e.stopPropagation();
        openMenu(favoritesMenu(store, s, input), /** @type {HTMLElement} */ (e.currentTarget));
      },
    }, icon('star'));

  return h('section', { class: 'card term' },
    h('div', { class: 'term-head' },
      backButton(),
      sessionTitle(store, s),
      sessionUsage(store, s),
      s.cwd
        ? h('button', {
          type: 'button',
          class: 'term-cwd',
          title: `${s.cwd}\nClick to copy the folder path`,
          onclick: () => navigator.clipboard.writeText(s.cwd).then(() => toast('Folder path copied'), () => toast('Could not copy')),
        }, h('span', { dir: 'ltr' }, shortPath(s.cwd)))
        : null,
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
      class: s.running ? 'term-form running' : 'term-form',
      onsubmit: (/** @type {SubmitEvent} */ e) => {
        e.preventDefault();
        if (s.running) return stopCommand(runnerOf(store), s.id).catch((err) => toast(err.message));
        const command = input.value.trim();
        if (!command) return;
        input.value = '';
        run(store, s, command);
      },
    },
      s.running
        ? h('span', { class: 'term-prompt term-dot', 'aria-hidden': 'true' })
        : h('span', { class: 'term-prompt', 'aria-hidden': 'true' }, '$'),
      // While a command runs, keys go to the terminal itself: the bar says what runs and offers the keys a mouse needs.
      s.running
        ? h('span', { class: 'term-state', title: s.command }, oneLine(s.command || ''))
        : input,
      s.running ? keys('Esc', '\x1b', 'Send Escape (interrupts claude)') : null,
      s.running ? keys('Ctrl+C', '\x03', 'Send Ctrl+C') : null,
      next
        ? h('button', {
          type: 'button',
          class: 'term-suggest',
          title: `${next.label}: runs\n${next.command}`,
          onclick: () => run(store, s, next.command, { remember: false }),
        }, icon('lightbulb'), h('span', {}, next.label))
        : null,
      state ? h('span', { class: s.exit && !s.exit.stopped && !s.exit.lost && !s.exit.signal && s.exit.code === 0 ? 'term-exit ok' : 'term-exit', title: state }, state) : null,
      favorites,
      recent,
      s.running
        ? h('button', { type: 'submit', class: 'term-run stop', title: 'Stop the command and anything it started' }, icon('stop'), 'Stop')
        : h('button', { type: 'submit', class: 'term-run', disabled: !view.info }, icon('play'), 'Run')));
}

// A folder path with the home folder as ~, as a shell shows it.
const shortPath = (/** @type {string} */ path) => {
  const home = view.info?.home;
  return home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path;
};

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
      resizableSide(h('div', { class: 'ide' },
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
          s ? terminal(store, s) : h('section', { class: 'card term' }, h('p', { class: 'muted small' }, 'Asking the runner for the open terminals…')))), 'dev', SIDE_RANGE)));
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
