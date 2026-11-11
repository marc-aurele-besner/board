// Dev's file explorer and file reader, Cursor style: a folder tree on the left, open files as tabs, each shown
// with line numbers and syntax colours. Read only; files come through the runner on this machine.
import { h, icon } from '../ui.js';
import { toast } from '../toast.js';
import { listFolder, readFile } from '../terminal.js';
import { highlight, languageOf, languageLabel } from '../highlight.js';

// Folders nobody reads in an explorer, and that can hold many thousands of files.
const HIDDEN = new Set(['.git', 'node_modules', '.DS_Store', '.next', '.turbo', '.cache', '__pycache__', '.venv']);

// View state: listed folders by path, the expanded ones, and the open files.
const state = { root: '', folders: new Map(), expanded: new Set(), tabs: [], active: '' };

const sepOf = (path) => (path.includes('\\') && !path.includes('/') ? '\\' : '/');
export const joinPath = (dir, name) => (/[\\/]$/.test(dir) ? dir + name : dir + sepOf(dir) + name);
export const baseName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

function sizeText(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function load(ctx, path) {
  const folder = state.folders.get(path) ?? {};
  if (folder.loading) return;
  state.folders.set(path, { ...folder, loading: true });
  try {
    const { path: full, entries } = await listFolder(ctx.base(), path);
    state.folders.set(path, { full, entries: entries.filter((e) => !HIDDEN.has(e.name)) });
  } catch (err) {
    state.folders.set(path, { error: err.message });
  }
  ctx.refresh();
}

// The folder the explorer shows. A new root starts with the tree folded.
export function setRoot(ctx, path) {
  if (path === state.root && state.folders.has(path)) return;
  state.root = path;
  state.expanded = new Set();
  if (path || ctx.ready()) load(ctx, path);
}

function toggle(ctx, path) {
  if (state.expanded.has(path)) state.expanded.delete(path);
  else {
    state.expanded.add(path);
    if (!state.folders.get(path)?.entries) load(ctx, path);
  }
  ctx.refresh();
}

function reloadAll(ctx) {
  for (const path of [state.root, ...state.expanded]) load(ctx, path);
  for (const file of state.tabs) openFile(ctx, file.path, { reload: true });
}

export async function openFile(ctx, path, { reload = false } = {}) {
  let file = state.tabs.find((f) => f.path === path);
  if (file && !reload) {
    state.active = path;
    return ctx.refresh();
  }
  if (!file) {
    file = { path, name: baseName(path), loading: true, scroll: 0 };
    state.tabs.push(file);
  }
  state.active = path;
  file.loading = true;
  ctx.refresh();
  try {
    const read = await readFile(ctx.base(), path);
    Object.assign(file, { size: read.size, text: read.text, binary: read.binary, tooLarge: read.tooLarge, error: '', el: null });
  } catch (err) {
    file.error = err.message;
  }
  file.loading = false;
  ctx.refresh();
}

function closeFile(ctx, file) {
  const i = state.tabs.indexOf(file);
  state.tabs.splice(i, 1);
  if (state.active === file.path) state.active = (state.tabs[i] ?? state.tabs[i - 1])?.path ?? '';
  ctx.refresh();
}

function treeRows(ctx, path, depth) {
  const folder = state.folders.get(path);
  if (!folder || folder.loading && !folder.entries) return [h('div', { class: 'tree-note muted small', style: { '--depth': depth } }, 'Loading…')];
  if (folder.error) return [h('div', { class: 'tree-note small tree-error', style: { '--depth': depth } }, folder.error)];
  if (!folder.entries.length) return [h('div', { class: 'tree-note muted small', style: { '--depth': depth } }, 'Empty folder')];
  return folder.entries.flatMap((entry) => {
    const full = joinPath(folder.full, entry.name);
    if (entry.dir) {
      const open = state.expanded.has(full);
      return [
        h('div', { class: 'tree-row', style: { '--depth': depth } },
          h('button', { type: 'button', class: 'tree-item', 'aria-expanded': String(open), title: full, onclick: () => toggle(ctx, full) },
            h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')),
            icon('folder'),
            h('span', { class: 'tree-name' }, entry.name)),
          h('button', { type: 'button', class: 'tree-action', title: `Open a terminal in ${entry.name}`, 'aria-label': `Open a terminal in ${entry.name}`, onclick: () => ctx.openTerminal(full) }, icon('terminal'))),
        ...(open ? treeRows(ctx, full, depth + 1) : []),
      ];
    }
    const active = state.active === full;
    return [h('div', { class: active ? 'tree-row active' : 'tree-row', style: { '--depth': depth } },
      h('button', { type: 'button', class: 'tree-item', title: full, onclick: () => openFile(ctx, full) },
        h('span', { class: 'tree-chevron' }),
        icon('file'),
        h('span', { class: 'tree-name' }, entry.name)))];
  });
}

// `picker` chooses the workspace; it sits above the tree.
export function explorer(ctx, picker) {
  const root = state.folders.get(state.root);
  return h('aside', { class: 'card ide-explorer', 'aria-label': 'Files' },
    h('div', { class: 'ide-explorer-head' },
      picker,
      h('button', { type: 'button', class: 'icon-btn', title: 'Read the folders and open files again', 'aria-label': 'Refresh files', disabled: !ctx.ready(), onclick: () => reloadAll(ctx) }, icon('refresh'))),
    root?.full ? h('div', { class: 'tree-root muted small', title: root.full }, baseName(root.full).toUpperCase()) : null,
    h('div', { class: 'tree', role: 'tree' }, ctx.ready() ? treeRows(ctx, state.root, 0) : h('p', { class: 'muted small' }, 'Files show once the runner answers.')));
}

// The code is drawn once per read and kept, so switching tabs or a page refresh does not draw it again.
function codeView(file) {
  if (file.el) return file.el;
  const lines = highlight(file.text, languageOf(file.name));
  const code = h('div', { class: 'code', style: { '--gutter': `${String(lines.length).length + 1}ch` } },
    lines.map((runs, i) =>
      h('div', { class: 'code-line' },
        h('span', { class: 'ln', 'aria-hidden': 'true' }, i + 1),
        h('span', { class: 'lc' }, runs.map(([cls, text]) => (cls ? h('span', { class: `tok-${cls}` }, text) : text))))));
  file.lines = lines.length;
  file.el = h('div', { class: 'code-view', tabindex: '0', onscroll: (e) => (file.scroll = e.currentTarget.scrollTop) }, code);
  return file.el;
}

function fileBody(file) {
  if (file.loading && !file.el) return h('p', { class: 'muted small ide-msg' }, 'Reading…');
  if (file.error) return h('p', { class: 'small ide-msg tree-error' }, file.error);
  if (file.binary) return h('p', { class: 'muted small ide-msg' }, `A binary file (${sizeText(file.size)}). The reader shows text files.`);
  if (file.tooLarge) return h('p', { class: 'muted small ide-msg' }, `${sizeText(file.size)} is over the 1 MB the reader shows.`);
  const el = codeView(file);
  requestAnimationFrame(() => (el.scrollTop = file.scroll));
  return el;
}

export const hasOpenFiles = () => state.tabs.length > 0;

export function editor(ctx) {
  if (!state.tabs.length) return null;
  const file = state.tabs.find((f) => f.path === state.active) ?? state.tabs[0];
  const root = state.folders.get(state.root)?.full ?? '';
  const shown = root && file.path.startsWith(root) ? file.path.slice(root.length).replace(/^[\\/]/, '') : file.path;
  const lang = languageOf(file.name);
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
          }, icon('file'), f.name),
          h('button', { type: 'button', class: 'term-close', title: `Close ${f.name}`, 'aria-label': `Close ${f.name}`, onclick: () => closeFile(ctx, f) }, icon('x'))))),
    h('div', { class: 'file-bar' },
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
