// Dev: terminals on this machine. Each session runs commands in its own folder (the board, the home folder, or a
// project's local folder) through the runner that `bun start` starts, and shows their output as it comes.
// Sessions live in this tab only: a reload closes the streams, and the runner stops what they were running.
import { h, icon, notice, uid } from '../ui.js';
import { toast } from '../toast.js';
import { TERMINAL_RUNNER, runnerInfo, runCommand } from '../terminal.js';

const COLLECTION = 'dev';
const DEFAULTS = { history: [], runner: '' };
const HISTORY_MAX = 100;
const LINES_MAX = 5000;
const RECENT_SHOWN = 8;
// Escape sequences for colours, cursor moves and window titles: the output is shown as plain text.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

// View state: the sessions, the one shown, and what the runner said about itself.
const view = { sessions: [], active: '', info: null, infoError: '', checking: false, count: 0, pending: '' };

const runnerOf = (store) => store.get(COLLECTION).runner || TERMINAL_RUNNER;
const maxSessions = () => view.info?.max ?? 12;
const activeSession = () => view.sessions.find((s) => s.id === view.active) ?? view.sessions[0];
const projectsWithFolder = (store) => store.get('projects').projects.filter((p) => p.localPath);

// Where a session starts: 'board', 'home', or 'p:<project id>'.
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

function newSession(store, root = 'board') {
  if (view.sessions.length >= maxSessions()) {
    toast(`${maxSessions()} terminals are open. Close one first.`);
    return null;
  }
  const s = { id: uid(), n: ++view.count, root, cwd: rootPath(store, root), lines: [], open: null, cr: false, running: false, abort: null, exit: null, command: '', started: 0, browse: -1, stick: true };
  view.sessions.push(s);
  view.active = s.id;
  return s;
}

function closeSession(s) {
  s.abort?.abort();
  view.sessions = view.sessions.filter((x) => x !== s);
  if (view.active === s.id) view.active = view.sessions.at(-1)?.id ?? '';
}

// Adds output to a session. A carriage return starts the line over, as progress bars expect.
function write(s, text, cls = '') {
  for (const part of text.replace(ANSI, '').split(/(\r\n|\n|\r)/)) {
    if (part === '\n' || part === '\r\n') {
      s.open = null;
      s.cr = false;
    } else if (part === '\r') {
      s.cr = true;
    } else if (part) {
      if (s.cr && s.open) s.open.text = '';
      s.cr = false;
      if (!s.open) {
        s.open = { text: '', cls };
        s.lines.push(s.open);
      }
      s.open.text += part;
    }
  }
  if (s.lines.length > LINES_MAX) s.lines.splice(0, s.lines.length - LINES_MAX);
}
const note = (s, text, cls) => {
  s.open = null;
  s.lines.push({ text, cls });
};

// Output arrives many times a second, so it is drawn into the open terminal directly, once per frame,
// instead of rebuilding the page.
const nodes = new WeakMap();
function lineNode(line) {
  let el = nodes.get(line);
  if (!el) {
    el = h('div', { class: line.cls ? `term-line ${line.cls}` : 'term-line' });
    nodes.set(line, el);
  }
  if (el.textContent !== line.text) el.textContent = line.text || '​';
  return el;
}
let frame = 0;
function paint() {
  frame = 0;
  for (const s of view.sessions) {
    const out = document.querySelector(`.term-out[data-session="${s.id}"]`);
    if (!out) continue;
    out.replaceChildren(...s.lines.map(lineNode));
    if (s.stick) out.scrollTop = out.scrollHeight;
  }
}
const schedulePaint = () => (frame ||= requestAnimationFrame(paint));

const duration = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);
const exitText = (exit) => {
  if (!exit) return '';
  if (exit.stopped) return `Stopped after ${duration(exit.ms)}`;
  if (exit.failed) return 'Could not run';
  if (exit.signal) return `Ended by ${exit.signal} after ${duration(exit.ms)}`;
  return `Exit ${exit.code} · ${duration(exit.ms)}`;
};

async function checkRunner(store) {
  view.checking = true;
  try {
    view.info = await runnerInfo(runnerOf(store));
    view.infoError = '';
    // Sessions opened before the runner answered learn their folder now.
    for (const s of view.sessions) if (!s.cwd && !s.lines.length) s.cwd = rootPath(store, s.root);
  } catch (err) {
    view.info = null;
    view.infoError = err.message;
  } finally {
    view.checking = false;
    store.refresh();
  }
}

function remember(store, command) {
  store.update(COLLECTION, (d) => {
    d.history = [command, ...d.history.filter((c) => c !== command)].slice(0, HISTORY_MAX);
  });
}

async function run(store, s, command) {
  if (command === 'clear') {
    s.lines = [];
    s.open = null;
    return store.refresh();
  }
  note(s, `${s.cwd || rootLabel(store, s.root)} $ ${command}`, 't-cmd');
  const ctl = new AbortController();
  Object.assign(s, { running: true, abort: ctl, exit: null, command, started: performance.now(), stick: true, browse: -1 });
  remember(store, command);
  try {
    await runCommand(runnerOf(store), {
      command,
      cwd: s.cwd,
      signal: ctl.signal,
      onEvent: (e) => {
        if (e.t === 'start' || e.t === 'cwd') s.cwd = e.cwd ?? e.d;
        else if (e.t === 'out') write(s, e.d);
        else if (e.t === 'err') write(s, e.d, 't-err');
        else if (e.t === 'exit') s.exit = { code: e.code, signal: e.signal, ms: e.ms };
        schedulePaint();
      },
    });
    s.exit ??= { stopped: true, ms: performance.now() - s.started };
  } catch (err) {
    if (err.name === 'AbortError') s.exit = { stopped: true, ms: performance.now() - s.started };
    else {
      note(s, err.message, 't-err');
      s.exit = { failed: true };
      // The runner may have gone away; ask again so the page says so.
      if (/reach the terminal runner/.test(err.message)) checkRunner(store);
    }
  } finally {
    Object.assign(s, { running: false, abort: null });
    note(s, exitText(s.exit), s.exit?.code === 0 ? 't-meta t-ok' : 't-meta');
    if (!view.sessions.includes(s)) return;
    if (!location.hash.startsWith('#/dev')) toast(`${command.length > 40 ? `${command.slice(0, 40)}…` : command}: ${exitText(s.exit).toLowerCase()}`);
    store.refresh();
  }
}

function sessionTabs(store) {
  const full = view.sessions.length >= maxSessions();
  return h('nav', { class: 'sub-tabs term-tabs', role: 'tablist', 'aria-label': 'Terminals' },
    view.sessions.map((s) => {
      const active = s.id === activeSession()?.id;
      return h('div', { class: active ? 'term-tab active' : 'term-tab' },
        h('button', {
          type: 'button',
          role: 'tab',
          class: active ? 'sub-tab active' : 'sub-tab',
          'aria-selected': String(active),
          title: s.cwd,
          onclick: () => {
            view.active = s.id;
            store.refresh();
          },
        }, s.running ? h('span', { class: 'term-dot', title: 'Running' }) : icon('terminal'), `${s.n} · ${rootLabel(store, s.root)}`),
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
      class: 'sub-tab term-new',
      disabled: full,
      title: full ? `Up to ${maxSessions()} terminals. Start the board with TERMINAL_MAX set higher for more.` : 'Open a new terminal in the same starting folder',
      onclick: () => {
        newSession(store, activeSession()?.root ?? 'board');
        store.refresh();
      },
    }, icon('plus'), 'New'));
}

function folderPicker(store, s) {
  const roots = [['board', 'This board'], ['home', 'Home folder'], ...projectsWithFolder(store).map((p) => [`p:${p.id}`, p.name])];
  // A project whose folder was removed keeps its sessions, listed under its name.
  if (!roots.some(([v]) => v === s.root)) roots.push([s.root, rootLabel(store, s.root)]);
  return h('label', { class: 'inline' }, 'Folder',
    h('select', {
      value: s.root,
      'aria-label': 'Terminal folder',
      disabled: s.running,
      onchange: (e) => {
        s.root = e.target.value;
        s.cwd = rootPath(store, s.root);
        note(s, `Folder: ${s.cwd || rootLabel(store, s.root)}`, 't-meta');
        store.refresh();
      },
    }, roots.map(([v, label]) => h('option', { value: v }, label))));
}

function terminal(store, s) {
  const history = store.get(COLLECTION).history;
  const input = h('input', {
    name: 'command',
    class: 'term-input',
    placeholder: s.running ? 'Running… Ctrl+C stops it' : 'Type a command and press Enter',
    autocomplete: 'off',
    autocapitalize: 'off',
    spellcheck: false,
    'aria-label': 'Command',
    'data-autofocus': true,
    // Up and Down walk the saved commands, newest first, as in a shell.
    onkeydown: (e) => {
      if (e.key === 'c' && e.ctrlKey && s.running) {
        e.preventDefault();
        s.abort?.abort();
      } else if (e.key === 'l' && e.ctrlKey) {
        e.preventDefault();
        s.lines = [];
        s.open = null;
        schedulePaint();
      } else if ((e.key === 'ArrowUp' || e.key === 'ArrowDown') && history.length) {
        e.preventDefault();
        s.browse = Math.max(-1, Math.min(history.length - 1, s.browse + (e.key === 'ArrowUp' ? 1 : -1)));
        input.value = s.browse < 0 ? '' : history[s.browse];
      }
    },
  });
  const out = h('div', {
    class: 'term-out',
    'data-session': s.id,
    role: 'log',
    'aria-live': 'off',
    tabindex: '0',
    // Scrolling up to read stops following new output; scrolling back to the end follows it again.
    onscroll: (e) => {
      const el = e.currentTarget;
      s.stick = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    },
  }, s.lines.map(lineNode));
  if (!s.lines.length) out.append(h('div', { class: 'term-line t-meta' }, `Commands run in ${s.cwd || 'the board folder'}. cd moves this terminal; clear empties it.`));

  return h('section', { class: 'card term' },
    h('div', { class: 'term-head' },
      folderPicker(store, s),
      h('code', { class: 'term-cwd', title: s.cwd }, s.cwd || '…'),
      h('div', { class: 'row term-actions' },
        h('button', {
          type: 'button',
          class: 'btn-small',
          disabled: !s.lines.length,
          onclick: () => navigator.clipboard.writeText(s.lines.map((l) => l.text).join('\n')).then(() => toast('Output copied'), () => toast('Could not copy')),
        }, icon('copy'), 'Copy'),
        h('button', {
          type: 'button',
          class: 'btn-small',
          disabled: !s.lines.length,
          onclick: () => {
            s.lines = [];
            s.open = null;
            store.refresh();
          },
        }, icon('trash'), 'Clear'))),
    out,
    h('form', {
      class: 'term-form',
      onsubmit: (e) => {
        e.preventDefault();
        if (s.running) return s.abort?.abort();
        const command = input.value.trim();
        if (!command) return;
        input.value = '';
        run(store, s, command);
      },
    },
      h('span', { class: 'term-prompt', 'aria-hidden': 'true' }, '$'),
      input,
      s.running
        ? h('button', { type: 'submit', class: 'btn-small danger' }, icon('stop'), 'Stop')
        : h('button', { type: 'submit', class: 'btn-small primary', disabled: !view.info }, icon('play'), 'Run')),
    h('div', { class: 'row between term-status' },
      h('span', { class: 'muted small' }, s.running ? `Running ${s.command}` : exitText(s.exit) || 'Ready'),
      history.length
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
  if (!view.info && !view.infoError && !view.checking) checkRunner(store);
  if (view.pending) newSession(store, view.pending);
  view.pending = '';
  if (!view.sessions.length) newSession(store);
  const s = activeSession();
  const busy = view.sessions.filter((x) => x.running).length;

  root.replaceChildren(
    h('div', { class: 'stack-lg dev' },
      h('header', null,
        h('h2', null, 'Dev'),
        h('p', { class: 'muted small' },
          view.info
            ? `Commands run on this machine in ${view.info.shell.split(/[\\/]/).pop()}, with their output shown as it comes. ${busy} of ${view.info.max} running. Closing or reloading the page stops them.`
            : 'Commands run on this machine, with their output shown as it comes.')),
      view.infoError ? runnerNotice(store) : null,
      sessionTabs(store),
      terminal(store, s)));
  // The page was rebuilt: put each terminal back at the end of its output.
  requestAnimationFrame(() => {
    for (const x of view.sessions) {
      const out = document.querySelector(`.term-out[data-session="${x.id}"]`);
      if (out && x.stick) out.scrollTop = out.scrollHeight;
    }
  });
}

// A reload ends every stream, which stops the commands; ask first while any are running.
window.addEventListener('beforeunload', (e) => {
  if (view.sessions.some((s) => s.running)) e.preventDefault();
});

export default {
  id: 'dev',
  title: 'Dev',
  icon: 'terminal',
  collection: COLLECTION,
  defaults: DEFAULTS,
  render: draw,
  serialize: () => ({}),
  // #/dev?project=<id> (from a project page) opens a terminal in that project's folder, or shows the one already open.
  restore: (p = {}) => {
    if (!p.project) return;
    const root = `p:${p.project}`;
    const open = view.sessions.find((s) => s.root === root);
    if (open) view.active = open.id;
    else view.pending = root;
  },
};
