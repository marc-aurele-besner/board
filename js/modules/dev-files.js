// @ts-check
// Dev's file explorer and file reader, Cursor style: a folder tree on the left, open files as tabs, each shown
// with line numbers and syntax colours. Read only; files come through the runner on this machine.
// A tab can also show a diff (a changed file, or a commit) from Source Control.
import { h, icon } from '../ui.js';
import { toast } from '../toast.js';
import { listFolder, readFile } from '../terminal.js';
import { highlight, languageOf, languageLabel } from '../highlight.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerFolder, GitDiff } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @import { IconName } from '../../types/data' */

/**
 * @typedef {{ loading?: boolean, full?: string, entries?: RunnerFolder['entries'], error?: string }} Folder
 * @typedef {{ path: string, name: string, title?: string, file?: string, load?: () => Promise<GitDiff> }} TabInfo
 * @typedef {TabInfo & { loading: boolean, scroll: number, goto: number, error?: string, el?: HTMLElement | null, size?: number, text?: string, binary?: boolean,
 *   tooLarge?: boolean, diff?: string, commit?: GitDiff['commit'], lines?: number, files?: number }} FileTab
 */

// Folders nobody reads in an explorer, and that can hold many thousands of files.
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '.next', '.turbo', '.cache', '__pycache__', '.venv']);

// View state: listed folders by path, the expanded ones, and the open files.
/** @type {{ root: string, folders: Map<string, Folder>, expanded: Set<string>, tabs: FileTab[], active: string }} */
const state = { root: '', folders: new Map(), expanded: new Set(), tabs: [], active: '' };

const sepOf = (/** @type {string} */ path) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
export const joinPath = (/** @type {string} */ dir, /** @type {string} */ name) => (/[\\/]$/.test(dir) ? dir + name : dir + sepOf(dir) + name);
export const baseName = (/** @type {string} */ path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

/** @param {number} bytes */
function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** @param {DevContext} ctx @param {string} path */
async function load(ctx, path) {
  const folder = state.folders.get(path) ?? {};
  if (folder.loading) return;
  state.folders.set(path, { ...folder, loading: true });
  try {
    const { path: full, entries } = await listFolder(ctx.base(), path);
    // claude's worktrees (.claude/worktrees) are whole other checkouts of the repository, not its files.
    const worktrees = baseName(full) === '.claude';
    state.folders.set(path, { full, entries: entries.filter((e) => !HIDDEN.has(e.name) && !(worktrees && e.dir && e.name === 'worktrees')) });
  } catch (err) {
    state.folders.set(path, { error: /** @type {Error} */ (err).message });
  }
  ctx.refresh();
}

// The folder the explorer shows. A new root starts with the tree folded.
/** @param {DevContext} ctx @param {string} path */
export function setRoot(ctx, path) {
  if (path === state.root && state.folders.has(path)) return;
  state.root = path;
  state.expanded = new Set();
  if (path || ctx.ready()) load(ctx, path);
}

/** @param {DevContext} ctx @param {string} path */
function toggle(ctx, path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else {
    state.expanded.add(path);
    if (!state.folders.get(path)?.entries) load(ctx, path);
  }
  ctx.refresh();
}

/** @param {DevContext} ctx */
function reloadAll(ctx) {
  for (const path of [state.root, ...state.expanded]) load(ctx, path);
  for (const file of state.tabs) openFile(ctx, file.path, { reload: true });
}

// `line` scrolls to that line and marks it (a search match).
/** @type {(ctx: DevContext, path: string, options?: { reload?: boolean, line?: number }) => Promise<void>} */
export const openFile = (ctx, path, { reload = false, line = 0 } = {}) => openTab(ctx, { path, name: baseName(path) }, { reload, line });

// A diff in a tab. `key` names the tab (opening it again reads it again); `load` answers { diff, commit? }; `file`
// is the changed file's full path, for the button that opens it.
/** @type {(ctx: DevContext, tab: { key: string, name: string, title: string, file?: string, load: () => Promise<GitDiff> }) => Promise<void>} */
export const openDiff = (ctx, { key, name, title, file = '', load }) => openTab(ctx, { path: key, name, title, file, load }, { reload: true });

/** @param {DevContext} ctx @param {TabInfo} tab @param {{ reload: boolean, line?: number }} options */
async function openTab(ctx, tab, { reload, line = 0 }) {
  let file = state.tabs.find((f) => f.path === tab.path);
  if (file && line) file.goto = line;
  if (file && !reload) {
    state.active = tab.path;
    return ctx.refresh();
  }
  if (!file) {
    file = { ...tab, loading: true, scroll: 0, goto: line };
    state.tabs.push(file);
  }
  state.active = file.path;
  file.loading = true;
  ctx.refresh();
  try {
    if (file.load) Object.assign(file, await file.load(), { error: '', el: null });
    else {
      const read = await readFile(ctx.base(), file.path);
      Object.assign(file, { size: read.size, text: read.text, binary: read.binary, tooLarge: read.tooLarge, error: '', el: null });
    }
  } catch (err) {
    file.error = /** @type {Error} */ (err).message;
  }
  file.loading = false;
  ctx.refresh();
}

/** @param {DevContext} ctx @param {FileTab} file */
function closeFile(ctx, file) {
  const i = state.tabs.indexOf(file);
  state.tabs.splice(i, 1);
  if (state.active === file.path) state.active = (state.tabs[i] ?? state.tabs[i - 1])?.path ?? '';
  ctx.refresh();
}

/** @param {DevContext} ctx @param {string} path @param {number} depth @returns {HTMLElement[]} */
function treeRows(ctx, path, depth) {
  const folder = state.folders.get(path);
  if (!folder || folder.loading && !folder.entries) return [h('div', { class: 'tree-note muted small', style: { '--depth': depth } }, 'Loading…')];
  if (folder.error) return [h('div', { class: 'tree-note small tree-error', style: { '--depth': depth } }, folder.error)];
  // Neither loading nor failed: the folder was read.
  if (!/** @type {RunnerFolder['entries']} */ (folder.entries).length) return [h('div', { class: 'tree-note muted small', style: { '--depth': depth } }, 'Empty folder')];
  return /** @type {RunnerFolder['entries']} */ (folder.entries).flatMap((entry) => {
    const full = joinPath(/** @type {string} */ (folder.full), entry.name);
    if (entry.dir) {
      const open = state.expanded.has(full);
      return [
        h('div', { class: 'tree-row', style: { '--depth': depth } },
          h('button', { type: 'button', class: ['tree-item', ctx.decor?.(full)?.tone].filter(Boolean).join(' '), 'aria-expanded': String(open), title: full, onclick: () => toggle(ctx, full) },
            h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')),
            icon('folder'),
            h('span', { class: 'tree-name' }, entry.name),
            ctx.decor?.(full) ? h('span', { class: 'tree-dot', title: 'Has changes' }) : null),
          h('button', { type: 'button', class: 'tree-action', title: `Open a terminal in ${entry.name}`, 'aria-label': `Open a terminal in ${entry.name}`, onclick: () => ctx.openTerminal(full) }, icon('terminal'))),
        ...(open ? treeRows(ctx, full, depth + 1) : []),
      ];
    }
    const active = state.active === full;
    // Git's letter for a changed file, as editors show it (M modified, U untracked, A added, D deleted, ! conflict).
    const decor = ctx.decor?.(full);
    return [h('div', { class: active ? 'tree-row active' : 'tree-row', style: { '--depth': depth } },
      h('button', { type: 'button', class: ['tree-item', decor?.tone].filter(Boolean).join(' '), title: decor ? `${full} · ${decor.label}` : full, onclick: () => openFile(ctx, full) },
        h('span', { class: 'tree-chevron' }),
        icon('file'),
        h('span', { class: 'tree-name' }, entry.name),
        decor ? h('span', { class: 'tree-letter', 'aria-hidden': 'true' }, decor.letter) : null))];
  });
}

// A side panel's title, Cursor style (small capitals), with its actions as icons on the right.
export const panelHead = (/** @type {string} */ title, /** @type {Child[]} */ ...actions) => h('div', { class: 'ide-panel-head' }, h('h2', { class: 'ide-panel-title' }, title), h('div', { class: 'ide-panel-actions' }, actions));
export const panelAction = (/** @type {IconName} */ name, /** @type {string} */ label, /** @type {() => void} */ onclick, disabled = false) => h('button', { type: 'button', class: 'ide-panel-action', title: label, 'aria-label': label, disabled, onclick }, icon(name));

// `switcher` picks the side panel; `picker` chooses the workspace and sits under the panel's title.
/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher */
export function explorer(ctx, picker, switcher) {
  const root = state.folders.get(state.root);
  return h('aside', { class: 'card ide-explorer', 'aria-label': 'Files' },
    switcher,
    panelHead('Explorer',
      panelAction('refresh', 'Read the folders and open files again', () => reloadAll(ctx), !ctx.ready()),
      panelAction('collapse-all', 'Collapse folders', () => {
        state.expanded.clear();
        ctx.refresh();
      }, !state.expanded.size)),
    h('div', { class: 'ide-explorer-head' }, picker),
    root?.full ? h('div', { class: 'tree-root muted small', title: root.full }, baseName(root.full).toUpperCase()) : null,
    h('div', { class: 'tree', role: 'tree' }, ctx.ready() ? treeRows(ctx, state.root, 0) : h('p', { class: 'muted small' }, 'Files show once the runner answers.')));
}

// The code is drawn once per read and kept, so switching tabs or a page refresh does not draw it again.
/** @param {FileTab} file */
function codeView(file) {
  if (file.el) return file.el;
  // Only a text file gets here (fileBody).
  const lines = highlight(/** @type {string} */ (file.text), languageOf(file.name));
  const code = h('div', { class: 'code', style: { '--gutter': `${String(lines.length).length + 1}ch` } },
    lines.map((runs, i) =>
      h('div', { class: 'code-line' },
        h('span', { class: 'ln', 'aria-hidden': 'true' }, i + 1),
        h('span', { class: 'lc' }, runs.map(([cls, text]) => (cls ? h('span', { class: `tok-${cls}` }, text) : text))))));
  file.lines = lines.length;
  file.el = h('div', { class: 'code-view', tabindex: '0', onscroll: (/** @type {Event} */ e) => (file.scroll = /** @type {HTMLElement} */ (e.currentTarget).scrollTop) }, code);
  return file.el;
}

// A unified diff as rows: each file's name (in a commit), its hunks, and lines with their old and new numbers.
const DIFF_MAX_LINES = 20000;
const DIFF_HEADER = /^(index |--- |\+\+\+ |old mode|new mode|similarity index|dissimilarity index|copy from|copy to)/;
/** @param {FileTab & { diff: string }} file */
function diffView(file) {
  if (file.el) return file.el;
  /** @type {HTMLElement[]} */
  const rows = [];
  const lines = file.diff.split('\n');
  if (lines.at(-1) === '') lines.pop();
  let oldN = 0;
  let newN = 0;
  let lang = languageOf(file.name);
  let files = 0;
  /** @type {(cls: string, a: number | string, b: number | string, sign: string, content: Child) => HTMLElement} */
  const row = (cls, a, b, sign, content) => h('div', { class: `code-line ${cls}` },
    h('span', { class: 'ln', 'aria-hidden': 'true' }, a),
    h('span', { class: 'ln', 'aria-hidden': 'true' }, b),
    h('span', { class: 'lc' }, h('span', { class: 'diff-sign', 'aria-hidden': 'true' }, sign), content));
  // Each line is coloured on its own: a hunk starts anywhere, so a comment opened above it is not seen.
  const coloured = (/** @type {string} */ text) => (highlight(text, lang)[0] ?? []).map(([cls, t]) => (cls ? h('span', { class: `tok-${cls}` }, t) : t));
  for (const line of lines.slice(0, DIFF_MAX_LINES)) {
    if (line.startsWith('diff --')) {
      files++;
      const name = / b\/(.*)$/.exec(line)?.[1] ?? line;
      lang = languageOf(baseName(name));
      if (file.commit) rows.push(h('div', { class: 'code-line diff-file' }, h('span', { class: 'ln' }), h('span', { class: 'ln' }), h('span', { class: 'lc' }, name)));
    } else if (line.startsWith('@@')) {
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
      if (m) [oldN, newN] = [Number(m[1]), Number(m[2])];
      rows.push(row('diff-hunk', '', '', '', line));
    } else if (DIFF_HEADER.test(line)) {
      continue;
    } else if (line.startsWith('+')) rows.push(row('diff-add', '', newN++, '+', coloured(line.slice(1))));
    else if (line.startsWith('-')) rows.push(row('diff-del', oldN++, '', '-', coloured(line.slice(1))));
    else if (line.startsWith(' ')) rows.push(row('diff-ctx', oldN++, newN++, ' ', coloured(line.slice(1))));
    else if (line) rows.push(row('diff-meta', '', '', '', line));
  }
  if (lines.length > DIFF_MAX_LINES) rows.push(row('diff-meta', '', '', '', `${lines.length - DIFF_MAX_LINES} more lines not shown.`));
  file.lines = lines.length;
  file.files = files;
  const head = file.commit
    ? h('div', { class: 'diff-commit' },
        h('p', { class: 'diff-commit-message' }, file.commit.message),
        h('p', { class: 'muted small' }, `${file.commit.author} · ${new Date(file.commit.at).toLocaleString()} · `, h('code', null, file.commit.hash.slice(0, 10))))
    : null;
  const body = rows.length
    ? h('div', { class: 'code diff', style: { '--gutter': `${String(Math.max(oldN, newN)).length + 1}ch` } }, rows)
    : h('p', { class: 'muted small ide-msg' }, 'No changes to show.');
  file.el = h('div', { class: 'code-view', tabindex: '0', onscroll: (/** @type {Event} */ e) => (file.scroll = /** @type {HTMLElement} */ (e.currentTarget).scrollTop) }, head, body);
  return file.el;
}

/** @param {FileTab} file */
function fileBody(file) {
  if (file.loading && !file.el) return h('p', { class: 'muted small ide-msg' }, 'Reading…');
  if (file.error) return h('p', { class: 'small ide-msg tree-error' }, file.error);
  if (file.diff !== undefined) {
    const el = diffView(/** @type {FileTab & { diff: string }} */ (file));
    requestAnimationFrame(() => (el.scrollTop = file.scroll));
    return el;
  }
  if (file.binary) return h('p', { class: 'muted small ide-msg' }, `A binary file (${sizeText(/** @type {number} */ (file.size))}). The reader shows text files.`);
  if (file.tooLarge) return h('p', { class: 'muted small ide-msg' }, `${sizeText(/** @type {number} */ (file.size))} is over the 1 MB the reader shows.`);
  const el = codeView(file);
  requestAnimationFrame(() => {
    const row = file.goto && el.querySelector('.code')?.children[file.goto - 1];
    file.goto = 0;
    if (row) {
      el.querySelector('.code-line.hit')?.classList.remove('hit');
      row.classList.add('hit');
      // A table row's offsetTop is not measured from the view, so the two boxes are compared.
      file.scroll = Math.max(0, el.scrollTop + row.getBoundingClientRect().top - el.getBoundingClientRect().top - el.clientHeight / 3);
    }
    el.scrollTop = file.scroll;
  });
  return el;
}

export const hasOpenFiles = () => state.tabs.length > 0;

/** @param {DevContext} ctx */
export function editor(ctx) {
  if (!state.tabs.length) return null;
  const file = state.tabs.find((f) => f.path === state.active) ?? state.tabs[0];
  const root = state.folders.get(state.root)?.full ?? '';
  const shown = root && file.path.startsWith(root) ? file.path.slice(root.length).replace(/^[\\/]/, '') : file.path;
  const lang = languageOf(file.name);
  const diffBar = file.load
    ? h('div', { class: 'file-bar' },
        h('code', { class: 'file-path', title: file.title }, file.title),
        h('span', { class: 'muted small file-meta' }, file.commit ? `${file.files ?? 0} ${file.files === 1 ? 'file' : 'files'}` : ''),
        file.file ? h('button', { type: 'button', class: 'icon-btn', title: 'Open the file', 'aria-label': 'Open the file', onclick: () => openFile(ctx, /** @type {string} */ (file.file)) }, icon('file')) : null,
        h('button', { type: 'button', class: 'icon-btn', title: 'Read the changes again', 'aria-label': 'Reload the changes', onclick: () => openTab(ctx, file, { reload: true }) }, icon('refresh')))
    : null;
  return h('section', { class: 'card ide-editor' },
    h('nav', { class: 'file-tabs', role: 'tablist', 'aria-label': 'Open files' },
      state.tabs.map((f) =>
        h('div', { class: f === file ? 'file-tab active' : 'file-tab' },
          h('button', {
            type: 'button',
            role: 'tab',
            'aria-selected': String(f === file),
            title: f.path,
            onclick: () => {
              state.active = f.path;
              ctx.refresh();
            },
          }, icon(f.load ? 'diff' : 'file'), f.name),
          h('button', { type: 'button', class: 'term-close', title: `Close ${f.name}`, 'aria-label': `Close ${f.name}`, onclick: () => closeFile(ctx, f) }, icon('x'))))),
    diffBar ?? h('div', { class: 'file-bar' },
      h('code', { class: 'file-path', title: file.path }, shown.split(/[\\/]/).join(' › ')),
      h('span', { class: 'muted small file-meta' },
        [languageLabel(lang, file.name), file.lines ? `${file.lines} lines` : '', file.size !== undefined ? sizeText(file.size) : ''].filter(Boolean).join(' · ')),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Copy the path',
        'aria-label': 'Copy the path',
        onclick: () => navigator.clipboard.writeText(file.path).then(() => toast('Path copied'), () => toast('Could not copy')),
      }, icon('copy')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Read the file again', 'aria-label': 'Reload the file', onclick: () => openFile(ctx, file.path, { reload: true }) }, icon('refresh'))),
    fileBody(file));
}
