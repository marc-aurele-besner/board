// Dev: a small IDE for this machine, Cursor style. A workspace folder (the board, the home folder, or a project's
// local folder) is shown as a file tree; files open read-only with syntax colours; terminals sit below. The side
// panel switches to Source Control, which shows and commits the folder's git changes.
// Commands run in a real pseudo-terminal through the runner `bun start` starts, so interactive programs such as
// the Claude CLI work: keys typed in the terminal go to the program, and vt.js draws what it prints.
// The runner owns the sessions: a command keeps running through a reload, and the page attaches to each terminal
// again (listed in localStorage), getting its whole output back.
import { h, icon, notice, uid } from '../ui.js';
import { toast } from '../toast.js';
import { TERMINAL_RUNNER, runnerInfo, attachSession, runCommand, stopCommand, clearSession, closeSession as closeOnRunner, sendInput } from '../terminal.js';
import { createTerminal, styleOf, colorOf } from '../vt.js';
import { readTheme, themedColors } from '../term-colors.js';
import { explorer, editor, setRoot, hasOpenFiles, baseName } from './dev-files.js';
import { sourceControl, refreshGit, decorOf, changeCount } from './dev-git.js';
import { pickChip } from '../inline.js';
import { projectIcon } from './projects.js';
import { linkWatcher, moveToReview } from '../task-links.js';

const COLLECTION = 'dev';
const DEFAULTS = { history: [], runner: '' };
const HISTORY_MAX = 100;
const RECENT_SHOWN = 8;
const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
// The open terminals (id, number, folder, the tasks handed to claude in it) and the one shown, so a reload attaches to them again.
const SESSIONS_KEY = 'board:dev-sessions';
// The side panel shown: 'files' or 'git'.
const SIDE_KEY = 'board:dev-side';

// View state: the workspace, the sessions, the one shown, and what the runner said about itself.
const view = { side: readSide(), workspace: 'board', sessions: [], active: '', wanted: 0, info: null, infoError: '', checking: false, count: 0, pending: null, queued: null, opening: null, restored: false };
let currentStore = null;

function readSide() {
  try {
    return localStorage.getItem(SIDE_KEY) === 'git' ? 'git' : 'files';
  } catch {
    return 'files';
  }
}

export const runnerOf = (store) => store.get(COLLECTION).runner || TERMINAL_RUNNER;
const maxSessions = () => view.info?.max ?? 12;
const activeSession = () => view.sessions.find((s) => s.id === view.active) ?? view.sessions[0];
const projectsWithFolder = (store) => store.get('projects').projects.filter((p) => p.localPath);

// Where a workspace is: 'board', 'home', or 'p:<project id>'.
function rootPath(store, root) {
  if (root === 'home') return view.info?.home ?? '~';
  if (root.startsWith('p:')) return store.get('projects').projects.find((p) => p.id === root.slice(2))?.localPath ?? '';
  return view.info?.root ?? '';
}
function rootLabel(store, root) {
  if (root === 'home') return 'Home';
  if (root.startsWith('p:')) return store.get('projects').projects.find((p) => p.id === root.slice(2))?.name ?? 'Project';
  return 'Board';
}

// What the file explorer needs from this module.
const filesCtx = (store) => ({
  base: () => runnerOf(store),
  ready: () => !!view.info,
  refresh: () => store.refresh(),
  decor: decorOf,
  openTerminal: (path) => {
    const s = newSession(store, path);
    if (s) store.refresh();
  },
});

// The terminal answers questions programs ask (cursor position, colours) as the theme shows it.
function themeColor(which) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(which === 'fg' ? '--text' : '--surface-2').trim();
  const m = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(value);
  return m ? `rgb:${m[1]}${m[1]}/${m[2]}${m[2]}/${m[3]}${m[3]}` : '';
}

function saveSessions() {
  try {
    localStorage.setItem(SESSIONS_KEY, JSON.stringify({ active: view.active, sessions: view.sessions.map(({ id, n, cwd, tasks, prompt }) => ({ id, n, cwd, ...(tasks.length ? { tasks, prompt } : {}) })) }));
  } catch {}
}

function makeSession({ id = uid(), n = ++view.count, cwd = '', tasks = [], prompt = '' }) {
  const s = { id, n, cwd, tasks, prompt, running: false, attach: null, replaying: false, pid: 0, exit: null, command: '', browse: -1, stick: true, el: null };
  s.term = createTerminal({
    // Questions in replayed output were answered long ago; only a live program gets an answer.
    reply: (data) => !s.replaying && s.running && s.pid && sendInput(runnerOf(currentStore), s.pid, { data }),
    background: themeColor,
  });
  // Issue and PR links the session prints are added to its tasks.
  if (tasks.length) s.watch = linkWatcher(currentStore, tasks, prompt);
  view.sessions.push(s);
  return s;
}

// The terminals open before the reload, attached again once the runner answers.
function restoreSessions() {
  view.restored = true;
  let saved = null;
  try {
    saved = JSON.parse(localStorage.getItem(SESSIONS_KEY) ?? 'null');
  } catch {}
  for (const x of saved?.sessions ?? []) {
    if (typeof x?.id === 'string' && !view.sessions.some((s) => s.id === x.id)) makeSession({
      id: x.id,
      n: Number(x.n) || ++view.count,
      cwd: String(x.cwd ?? ''),
      tasks: Array.isArray(x.tasks) ? x.tasks.filter((t) => typeof t === 'string') : [],
      prompt: String(x.prompt ?? ''),
    });
  }
  view.count = Math.max(view.count, ...view.sessions.map((s) => s.n));
  if (view.sessions.some((s) => s.id === saved?.active)) view.active = saved.active;
}

// The terminal the URL names (#/dev?term=<number>) is shown, over the one saved last.
function showWanted() {
  const s = view.sessions.find((x) => x.n === view.wanted);
  view.wanted = 0;
  if (!s || s.id === view.active) return;
  view.active = s.id;
  saveSessions();
}

function newSession(store, cwd = rootPath(store, view.workspace), { id, tasks = [], prompt = '' } = {}) {
  if (view.sessions.length >= maxSessions()) {
    toast(`${maxSessions()} terminals are open. Close one first.`);
    return null;
  }
  const s = makeSession({ id, cwd, tasks, prompt });
  view.active = s.id;
  saveSessions();
  if (view.info) attach(store, s);
  return s;
}

function closeSession(s) {
  s.attach?.abort();
  s.observer?.disconnect();
  closeOnRunner(runnerOf(currentStore), s.id).catch(() => {});
  view.sessions = view.sessions.filter((x) => x !== s);
  if (view.active === s.id) view.active = view.sessions.at(-1)?.id ?? '';
  saveSessions();
}

// Reads the session's events: first everything so far (drawn without toasts or answers), then live ones.
async function attach(store, s) {
  if (s.attach) return;
  const ctl = new AbortController();
  s.attach = ctl;
  try {
    await attachSession(runnerOf(store), { session: s.id, signal: ctl.signal, onEvent: (e) => onSessionEvent(store, s, e) });
  } catch {}
  if (s.attach === ctl) s.attach = null;
  if (ctl.signal.aborted || !view.sessions.includes(s)) return;
  // The stream ended by itself: the runner stopped. What ran is marked; the page asks again in a moment.
  s.replaying = false;
  if (s.running) finish(store, s, { lost: true });
  view.info = null;
  setTimeout(() => checkRunner(store), 1500);
}

function onSessionEvent(store, s, e) {
  if (e.t === 'session') {
    s.replaying = true;
    // The runner has the whole terminal: it is drawn again from the start. A runner that lost it (its state folder
    // was removed) has nothing, so what is shown stays.
    if (e.known) {
      // Replayed at the size it is shown, so lines wrap as they did.
      fit(s);
      s.term.reset();
      s.term.clear();
      Object.assign(s, { running: false, pid: 0, exit: null, command: '' });
    }
  } else if (e.t === 'live') {
    s.replaying = false;
    store.refresh();
  } else if (e.t === 'start') {
    Object.assign(s, { running: true, pid: e.pid, cwd: e.cwd, command: e.command, exit: null });
    s.term.note(`${e.cwd || 'board'} $ ${oneLine(e.command)}`, 't-cmd');
    if (!s.replaying) {
      saveSessions();
      store.refresh();
    }
  } else if (e.t === 'out' || e.t === 'err') {
    s.term.write(e.d);
    if (!s.replaying) s.watch?.(e.d);
  } else if (e.t === 'cwd') {
    s.cwd = e.d;
    if (!s.replaying) saveSessions();
  } else if (e.t === 'exit') finish(store, s, e);
  schedulePaint();
}

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
// survive the page being rebuilt. Lines are drawn again only when they changed.
const drawn = new WeakMap();

// The theme the terminal is drawn in; lines drawn in another one are drawn again.
let theme = null;
const currentTheme = () => (theme ??= readTheme());

function spanStyle(key) {
  const s = styleOf(key);
  const cls = [s.cls, s.bold && 'b', s.dim && 'd', s.italic && 'i', s.under && 'u', s.strike && 's'].filter(Boolean).join(' ');
  const style = {};
  if (s.fg !== undefined || s.bg !== undefined || s.inverse) {
    // 256-colour indices above the 16 ANSI ones become RGB, which themedColors adapts like any other.
    const norm = (v) => (typeof v === 'number' && v >= 16 ? colorOf(v) : v);
    const { fg, bg } = themedColors(norm(s.fg), norm(s.bg), s.inverse, currentTheme());
    if (fg) style.color = fg;
    if (bg) style.background = bg;
  }
  return { class: cls || null, style };
}

function lineNode(line, cursorX = -1) {
  const was = drawn.get(line);
  if (was && was.v === line.v && was.cx === cursorX && was.theme === currentTheme().key) return was.el;
  const el = was?.el ?? h('div', { class: 'term-line' });
  const spans = [];
  const end = Math.max(line.cells.length, cursorX + 1);
  let x = 0;
  while (x < end) {
    const cursor = x === cursorX;
    const key = line.cells[x]?.k ?? '';
    let text = line.cells[x]?.c ?? ' ';
    x++;
    // Cells of one style make one span; the cursor's cell gets its own.
    while (!cursor && x < end && x !== cursorX && (line.cells[x]?.k ?? '') === key) {
      text += line.cells[x]?.c ?? ' ';
      x++;
    }
    const attrs = spanStyle(key);
    spans.push(key || cursor ? h('span', { ...attrs, class: [attrs.class, cursor && 'term-cursor'].filter(Boolean).join(' ') || null }, text) : text);
  }
  el.replaceChildren(...spans);
  drawn.set(line, { v: line.v, cx: cursorX, theme: currentTheme().key, el });
  return el;
}

function paint(s) {
  if (!s.el) return;
  const { term } = s;
  const { history, screen, out } = s.el;
  // The theme changed: every line is drawn again in the new colours.
  if (s.el.theme !== currentTheme().key) {
    s.el.theme = currentTheme().key;
    history.replaceChildren(...term.history.map((l) => lineNode(l)));
    s.el.from = term.trimmed;
  }
  // History lines never change once scrolled off; only new ones are added, and old ones dropped.
  const drop = Math.min(history.childElementCount, term.trimmed - s.el.from);
  for (let i = 0; i < drop; i++) history.firstChild.remove();
  if (term.trimmed > s.el.from) s.el.from = term.trimmed;
  for (let i = s.el.from + history.childElementCount - term.trimmed; i < term.history.length; i++) history.append(lineNode(term.history[i]));
  const cursorY = s.running && term.cursor ? term.y : -1;
  screen.replaceChildren(...term.screen.slice(0, term.used()).map((l, y) => lineNode(l, y === cursorY ? Math.min(term.x, term.cols - 1) : -1)));
  if (s.stick) out.scrollTop = out.scrollHeight;
  s.el.top = out.scrollTop;
}

let frame = 0;
const schedulePaint = () => (frame ||= requestAnimationFrame(() => {
  frame = 0;
  view.sessions.forEach(paint);
}));

// Columns and rows that fit the terminal, from the size of one character.
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
  if (s.running && s.pid) sendInput(runnerOf(currentStore), s.pid, { cols, rows });
  schedulePaint();
}

// Keys for the program, as a terminal sends them.
function keyData(e, appCursor) {
  if (e.isComposing || e.metaKey) return null;
  const mod = 1 + (e.shiftKey ? 1 : 0) + (e.altKey ? 2 : 0) + (e.ctrlKey ? 4 : 0);
  const arrows = { ArrowUp: 'A', ArrowDown: 'B', ArrowRight: 'C', ArrowLeft: 'D', Home: 'H', End: 'F' };
  if (arrows[e.key]) return mod > 1 ? `\x1b[1;${mod}${arrows[e.key]}` : `${appCursor ? '\x1bO' : '\x1b['}${arrows[e.key]}`;
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
    const ctrl = { '[': '\x1b', '\\': '\x1c', ']': '\x1d', '^': '\x1e', '6': '\x1e', '_': '\x1f', '-': '\x1f', '/': '\x1f' };
    return ctrl[k] ?? null;
  }
  if ([...e.key].length !== 1) return null;
  // On a Mac, Option types characters (é, ∫); elsewhere Alt+key is ESC then the key, as terminals send it.
  return e.altKey && !isMac ? `\x1b${e.key}` : e.key;
}

function onTerminalKey(store, s, e) {
  if (!s.running || !s.pid) {
    // Typing in the output of an idle terminal goes to its command line.
    if ([...e.key].length === 1 && !e.metaKey && !e.ctrlKey) document.querySelector('.term-input')?.focus();
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

function onTerminalPaste(store, s, e) {
  if (!s.running || !s.pid) return;
  e.preventDefault();
  const text = (e.clipboardData?.getData('text') ?? '').replace(/\r?\n/g, '\r');
  if (text) sendInput(runnerOf(store), s.pid, { data: s.term.paste ? `\x1b[200~${text}\x1b[201~` : text });
}

// Scrolling up to read stops following new output; scrolling back to the end follows it again. The direction
// decides, not only the distance: a smooth wheel scroll starts a few pixels from the end, and following output
// there would pull it straight back down.
function onTerminalScroll(s) {
  const { out } = s.el;
  const top = out.scrollTop;
  if (top < s.el.top - 1) s.stick = false;
  else if (out.scrollHeight - top - out.clientHeight < 24) s.stick = true;
  s.el.top = top;
}

// A full-screen program (the Claude CLI, less, vim) keeps no scrollback here, so the wheel goes to it, as a
// terminal sends it: mouse reports when it asked for them, otherwise arrow keys on the alternate screen.
function onTerminalWheel(store, s, e) {
  if (e.deltaY < 0) s.stick = false;
  const { term } = s;
  if (!s.running || !s.pid || !e.deltaY || (!term.mouse && !term.main)) return;
  e.preventDefault();
  const up = e.deltaY < 0;
  const lines = Math.min(10, Math.max(1, Math.round(Math.abs(e.deltaMode ? e.deltaY : e.deltaY / 40))));
  let data;
  if (term.mouse) {
    const box = s.el.screen.getBoundingClientRect();
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

function elementsOf(store, s) {
  if (s.el) return s.el;
  const history = h('div', { class: 'term-history' });
  const screen = h('div', { class: 'term-screen' });
  const out = h('div', {
    class: 'term-out',
    tabindex: '0',
    role: 'log',
    'aria-label': `Terminal ${s.n} output`,
    onscroll: () => onTerminalScroll(s),
    onwheel: (e) => onTerminalWheel(store, s, e),
    onkeydown: (e) => onTerminalKey(store, s, e),
    onpaste: (e) => onTerminalPaste(store, s, e),
  }, history, screen);
  s.el = { out, history, screen, from: 0, top: 0 };
  s.observer = new ResizeObserver(() => fit(s));
  s.observer.observe(out);
  return s.el;
}

// A command on one line, for the places that show it: a prompt can span several.
const oneLine = (text) => text.replace(/\s*\n\s*/g, ' ↵ ');

const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
function exitText(exit) {
  if (!exit) return '';
  if (exit.stopped) return `Stopped after ${duration(exit.ms)}`;
  if (exit.lost) return 'Ended when the runner stopped';
  if (exit.signal) return `Ended by ${exit.signal} after ${duration(exit.ms)}`;
  return `Exit ${exit.code} · ${duration(exit.ms)}`;
}

async function checkRunner(store) {
  view.checking = true;
  try {
    view.info = await runnerInfo(runnerOf(store));
    view.infoError = '';
    // Terminals opened before the runner answered learn their folder now, and every terminal gets its output.
    for (const s of view.sessions) if (!s.cwd && !s.command) s.cwd = rootPath(store, view.workspace);
    setRoot(filesCtx(store), rootPath(store, view.workspace));
    for (const s of view.sessions) attach(store, s);
  } catch (err) {
    view.info = null;
    view.infoError = err.message;
  } finally {
    view.checking = false;
    store.refresh();
  }
}

// A shell word: single quotes keep newlines, quotes and $ in the prompt as typed.
const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

// The command a task is handed to; a project can set its own in its Dev command field.
export const DEFAULT_DEV_COMMAND = 'claude --dangerously-skip-permissions --worktree';

// Opens Dev with a new terminal that runs claude on a prompt, in the project's folder when it has one.
// The command waits for the runner to answer, so it also works when Dev was not open yet.
// Issue and PR links the session prints are added to the tasks in `taskIds`.
// Returns the terminal's session id, so the tasks can find it again (openSession).
export function startClaudeSession({ prompt, projectId = '', taskIds = [] }) {
  const id = uid();
  view.queued = { id, prompt, projectId, taskIds };
  showDev();
  return id;
}

// Opens Dev on a terminal session a task started. One this page does not list (closed here, or started in another
// browser) is listed again while the runner still has it.
export function openSession({ id, cwd = '', taskIds = [] }) {
  view.opening = { id, cwd, taskIds };
  showDev();
}

function showDev() {
  if (location.hash.startsWith('#/dev')) currentStore?.refresh();
  else location.hash = '#/dev';
}

function showOpening(store) {
  const { id, cwd, taskIds } = view.opening;
  view.opening = null;
  let s = view.sessions.find((x) => x.id === id);
  if (!s) {
    s = makeSession({ id, cwd, tasks: taskIds });
    if (view.info) attach(store, s);
  }
  view.active = s.id;
  saveSessions();
}

function startQueued(store) {
  const { id, prompt, projectId, taskIds } = view.queued;
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
  const command = project?.devCommand?.trim() || DEFAULT_DEV_COMMAND;
  requestAnimationFrame(() => run(store, s, `${command} -- ${shellQuote(prompt)}`, { remember: false }));
}

function remember(store, command) {
  store.update(COLLECTION, (d) => {
    d.history = [command, ...d.history.filter((c) => c !== command)].slice(0, HISTORY_MAX);
  });
}

function clearTerminal(s) {
  s.term.clear();
  schedulePaint();
  clearSession(runnerOf(currentStore), s.id).catch(() => {});
}

// The runner starts the command; what it prints, and how it ends, arrive through the session's stream.
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
    s.term.note(err.message, 't-err');
    schedulePaint();
    // The runner may have gone away; ask again so the page says so.
    if (/reach the terminal runner/.test(err.message)) checkRunner(store);
  }
}

// A searchable list, since a board with many projects makes a plain dropdown long; projects show their icon.
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

// Files or Source Control, as the activity bar of VS Code picks them. Source Control shows how many files changed.
function sideSwitcher(store) {
  const tab = (side, name, label, extra) => h('button', {
    type: 'button',
    role: 'tab',
    class: view.side === side ? 'ide-side-tab active' : 'ide-side-tab',
    'aria-selected': String(view.side === side),
    onclick: () => {
      view.side = side;
      try {
        localStorage.setItem(SIDE_KEY, side);
      } catch {}
      store.refresh();
    },
  }, icon(name), label, extra);
  const count = changeCount();
  return h('nav', { class: 'ide-side-tabs', role: 'tablist', 'aria-label': 'Side panel' },
    tab('files', 'folder', 'Files'),
    tab('git', 'git-branch', 'Source control', count ? h('span', { class: 'scm-count', title: `${count} changed ${count === 1 ? 'file' : 'files'}` }, count > 999 ? '999+' : count) : null));
}

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
            saveSessions();
            store.refresh();
          },
        }, s.running ? h('span', { class: 'term-dot', title: 'Running' }) : icon('terminal'), `${s.n} · ${s.cwd ? baseName(s.cwd) : 'board'}`),
        h('button', {
          type: 'button',
          class: 'term-close',
          title: s.running ? 'Stop and close this terminal' : 'Close this terminal',
          'aria-label': `Close terminal ${s.n}`,
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
    onkeydown: (e) => {
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
      sessionTabs(store),
      h('code', { class: 'term-cwd', title: s.cwd }, s.cwd || '…'),
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
      onsubmit: (e) => {
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

function runnerNotice(store) {
  return h('div', { class: 'stack' },
    notice({
      text: view.infoError,
      actions: [h('button', { type: 'button', class: 'btn-small', disabled: view.checking, onclick: () => checkRunner(store) }, view.checking ? 'Checking…' : 'Try again')],
    }),
    h('form', {
      class: 'row term-runner',
      onsubmit: (e) => {
        e.preventDefault();
        const runner = String(new FormData(e.currentTarget).get('runner') ?? '').trim().replace(/\/+$/, '');
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

function draw(root, store) {
  // A render follows a theme switch, so the theme is read again.
  theme = null;
  currentStore = store;
  if (!view.restored) restoreSessions();
  if (view.wanted) showWanted();
  if (view.opening) showOpening(store);
  if (!view.info && !view.infoError && !view.checking) checkRunner(store);
  if (view.pending) {
    view.workspace = view.pending;
    view.pending = null;
    setRoot(filesCtx(store), rootPath(store, view.workspace));
    const open = view.sessions.find((x) => x.cwd === rootPath(store, view.workspace));
    if (open) view.active = open.id;
    else newSession(store);
  }
  if (view.queued && view.info) startQueued(store);
  if (!view.sessions.length) newSession(store);
  const s = activeSession();
  // The page is rebuilt around the terminal; it keeps the keys if it had them.
  const focused = document.activeElement === s.el?.out;
  const ctx = filesCtx(store);
  // The tree's change colours and the panel's count come from git, read again when stale.
  if (view.info) refreshGit(ctx, rootPath(store, view.workspace));

  root.replaceChildren(
    h('div', { class: 'stack-lg dev' },
      view.infoError ? runnerNotice(store) : null,
      h('div', { class: 'ide' },
        view.side === 'git'
          ? sourceControl(ctx, workspacePicker(store), sideSwitcher(store), rootPath(store, view.workspace))
          : explorer(ctx, workspacePicker(store), sideSwitcher(store)),
        h('div', { class: hasOpenFiles() ? 'ide-main has-file' : 'ide-main' },
          editor(ctx),
          terminal(store, s)))));
  requestAnimationFrame(() => {
    if (focused) s.el.out.focus({ preventScroll: true });
    fit(s);
    paint(s);
  });
}

// The system theme changed (with the board following it): draw the terminals in the new colours.
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  theme = null;
  schedulePaint();
});

export default {
  id: 'dev',
  title: 'Dev',
  icon: 'terminal',
  collection: COLLECTION,
  defaults: DEFAULTS,
  render: draw,
  // The terminal shown is in the URL, so a refresh or a shared link opens it.
  serialize: () => ({ term: view.sessions.length > 1 ? activeSession()?.n : '' }),
  // #/dev?project=<id> (from a project page) opens that project's folder, with a terminal in it.
  restore: (p = {}) => {
    if (p.project) view.pending = `p:${p.project}`;
    const n = Number(p.term);
    if (Number.isInteger(n) && n > 0) {
      view.wanted = n;
      // A link or the back button while Dev is open picks the terminal now.
      if (view.restored) showWanted();
    }
  },
};
