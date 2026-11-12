// Dev's Search, as in VS Code or Cursor: the lines holding a text in the workspace's files, grouped by file, with
// match case, whole word and regular expression toggles, and files to include or exclude. A match opens the file
// at its line. git grep runs through the runner on this machine; ignored files and claude's worktrees are left out.
import { h, icon } from '../ui.js';
import { searchFiles } from '../terminal.js';
import { openFile, baseName, panelHead, panelAction } from './dev-files.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerSearch, SearchMatch } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */

// Typing waits this long before searching.
const DEBOUNCE_MS = 300;

// View state: the fields and toggles, the folder searched, the answer, and the files folded in it.
/**
 * @type {{ q: string, match: boolean, word: boolean, regex: boolean, include: string, exclude: string, details: boolean, path: string,
 *   result: RunnerSearch | null, error: string, loading: boolean, seq: number, folded: Set<string> }}
 */
const state = { q: '', match: false, word: false, regex: false, include: '', exclude: '', details: false, path: '', result: null, error: '', loading: false, seq: 0, folded: new Set() };
let timer = 0;
// The results list drawn last, filled in place when an answer comes so the field being typed in keeps its focus.
/** @type {HTMLElement | null} */
let list = null;

/** @param {DevContext} ctx @param {string} path */
function schedule(ctx, path) {
  clearTimeout(timer);
  timer = setTimeout(() => run(ctx, path), DEBOUNCE_MS);
}

/** @param {DevContext} ctx @param {string} path */
async function run(ctx, path) {
  clearTimeout(timer);
  const seq = ++state.seq;
  if (!state.q || !ctx.ready()) {
    Object.assign(state, { result: null, error: '', loading: false });
    return redraw(ctx);
  }
  state.loading = true;
  redraw(ctx);
  try {
    const result = await searchFiles(ctx.base(), {
      path,
      q: state.q,
      case: state.match ? '1' : '',
      word: state.word ? '1' : '',
      regex: state.regex ? '1' : '',
      include: state.include,
      exclude: state.exclude,
    });
    if (seq !== state.seq) return;
    Object.assign(state, { result, error: '', path, folded: new Set() });
  } catch (err) {
    if (seq !== state.seq) return;
    Object.assign(state, { result: null, error: /** @type {Error} */ (err).message });
  }
  state.loading = false;
  redraw(ctx);
}

/** @param {DevContext} ctx */
function redraw(ctx) {
  if (list?.isConnected) list.replaceChildren(...results(ctx));
  else ctx.refresh();
}

// The parts of a line to mark: every match of the search in it, or the one git found when the pattern does not
// read the same way in JavaScript.
/** @param {string} text @param {number} col @returns {number[][]} */
function marks(text, col) {
  try {
    const source = state.regex ? state.q : state.q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(state.word ? `\\b(?:${source})\\b` : source, state.match ? 'g' : 'gi');
    const out = [];
    for (const m of text.matchAll(re)) {
      if (!m[0]) break;
      out.push([m.index, m.index + m[0].length]);
    }
    if (out.length) return out;
  } catch {}
  return [[col, col + (state.regex ? 0 : state.q.length)]];
}

// Indentation is dropped, and a match far into the line keeps only a little of what comes before it.
/** @param {string} line @param {number} start */
function lineText(line, start) {
  const indent = line.length - line.trimStart().length;
  let text = line.slice(indent);
  let col = Math.max(0, start - indent);
  if (col > 40) {
    text = `…${text.slice(col - 20)}`;
    col = 21;
  }
  /** @type {Child[]} */
  const parts = [];
  let at = 0;
  for (const [from, to] of marks(text, col)) {
    if (from > at) parts.push(text.slice(at, from));
    if (to > from) parts.push(h('mark', { class: 'search-hit' }, text.slice(from, to)));
    at = Math.max(at, to);
  }
  parts.push(text.slice(at));
  return parts;
}

/** @param {DevContext} ctx @returns {HTMLElement[]} */
function results(ctx) {
  if (!ctx.ready()) return [h('p', { class: 'muted small search-note' }, 'Search works once the runner answers.')];
  if (state.error) return [h('p', { class: 'small tree-error search-note' }, state.error)];
  if (state.loading && !state.result) return [h('p', { class: 'muted small search-note' }, 'Searching…')];
  const r = state.result;
  if (!r) return [];
  if (!r.matches.length) return [h('p', { class: 'muted small search-note' }, 'No results found. Check the include and exclude fields, and the files git ignores.')];
  /** @type {Map<string, SearchMatch[]>} */
  const files = new Map();
  for (const m of r.matches) {
    if (!files.has(m.path)) files.set(m.path, []);
    /** @type {SearchMatch[]} */ (files.get(m.path)).push(m);
  }
  // An answer to a search names its folder; only an empty search has none, and it is never sent.
  const root = /** @type {string} */ (r.path).replace(/[\\/]$/, '');
  const summary = `${r.matches.length}${r.more ? '+' : ''} ${r.matches.length === 1 ? 'result' : 'results'} in ${files.size} ${files.size === 1 ? 'file' : 'files'}`;
  return [
    h('p', { class: 'muted small search-note' }, summary, r.more ? ' (only the first shown; narrow the search)' : ''),
    h('div', { class: 'tree search-tree', role: 'tree' },
      [...files].flatMap(([path, matches]) => {
        const open = !state.folded.has(path);
        const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : path;
        const dir = rel.split('/').slice(0, -1).join('/');
        return [
          h('div', { class: 'tree-row' },
            h('button', {
              type: 'button',
              class: 'tree-item',
              'aria-expanded': String(open),
              title: path,
              onclick: () => {
                if (open) state.folded.add(path);
                else state.folded.delete(path);
                redraw(ctx);
              },
            },
            h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')),
            icon('file'),
            h('span', { class: 'tree-name' }, baseName(path)),
            dir ? h('span', { class: 'search-dir muted' }, dir) : null,
            h('span', { class: 'scm-count' }, matches.length))),
          ...(open ? matches.map((m) => h('div', { class: 'tree-row' },
            h('button', { type: 'button', class: 'tree-item search-line', style: { '--depth': 1 }, title: `${rel}:${m.line}`, onclick: () => openFile(ctx, path, { line: m.line }) },
              h('span', { class: 'search-text' }, lineText(m.text, m.col))))) : []),
        ];
      })),
  ];
}

// A toggle inside the search field, as the editors draw them: Aa, ab and .*
/** @param {DevContext} ctx @param {string} path @param {'match' | 'word' | 'regex'} key @param {string} label @param {Child} text */
function toggle(ctx, path, key, label, text) {
  return h('button', {
    type: 'button',
    class: state[key] ? 'search-toggle on' : 'search-toggle',
    title: label,
    'aria-label': label,
    'aria-pressed': String(state[key]),
    onclick: () => {
      state[key] = !state[key];
      ctx.refresh();
      run(ctx, path);
    },
  }, text);
}

/** @type {(ctx: DevContext, path: string, key: 'q' | 'include' | 'exclude', label: string, extra?: Child) => HTMLLabelElement} */
const field = (ctx, path, key, label, extra) => h('label', { class: 'search-field' },
  h('input', {
    type: 'text',
    value: state[key],
    placeholder: label,
    'aria-label': label,
    spellcheck: false,
    autocomplete: 'off',
    oninput: (/** @type {Event} */ e) => {
      state[key] = /** @type {HTMLInputElement} */ (e.target).value;
      schedule(ctx, path);
    },
    onkeydown: (/** @type {KeyboardEvent} */ e) => {
      if (e.key === 'Enter') run(ctx, path);
    },
  }),
  extra);

/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher @param {string} path */
export function searchPanel(ctx, picker, switcher, path) {
  // Another workspace: the answer was for the old folder.
  if (state.result && state.path !== path) {
    state.result = null;
    if (state.q) run(ctx, path);
  }
  list = h('div', { class: 'search-results' }, results(ctx));
  return h('aside', { class: 'card ide-explorer search-panel', 'aria-label': 'Search' },
    switcher,
    panelHead('Search',
      panelAction('refresh', 'Search again', () => run(ctx, path), !state.q || !ctx.ready()),
      panelAction('clear-all', 'Clear the search', () => {
        Object.assign(state, { q: '', result: null, error: '' });
        state.seq++;
        ctx.refresh();
      }, !state.q && !state.result),
      panelAction('collapse-all', 'Collapse the results', () => {
        state.folded = new Set(state.result?.matches.map((m) => m.path));
        redraw(ctx);
      }, !state.result?.matches.length)),
    h('div', { class: 'ide-explorer-head' }, picker),
    field(ctx, path, 'q', 'Search',
      h('span', { class: 'search-toggles' },
        toggle(ctx, path, 'match', 'Match case', 'Aa'),
        toggle(ctx, path, 'word', 'Match whole word', h('span', { class: 'search-word' }, 'ab')),
        toggle(ctx, path, 'regex', 'Use regular expression', '.*'))),
    h('div', { class: 'search-more' },
      h('button', {
        type: 'button',
        class: 'ide-panel-action',
        title: state.details ? 'Hide the files to include and exclude' : 'Files to include and exclude',
        'aria-label': 'Toggle search details',
        'aria-expanded': String(state.details),
        onclick: () => {
          state.details = !state.details;
          ctx.refresh();
        },
      }, icon('more'))),
    state.details
      ? h('div', { class: 'stack search-details' },
          h('div', { class: 'search-label muted small' }, 'files to include'),
          field(ctx, path, 'include', 'e.g. *.js, src/'),
          h('div', { class: 'search-label muted small' }, 'files to exclude'),
          field(ctx, path, 'exclude', 'e.g. *.min.js, dist'))
      : null,
    list);
}
