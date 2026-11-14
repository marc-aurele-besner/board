// A shell command line coloured as an editor would (variables set before it, the program, flags, strings, $VARS,
// {{variables}}), and the field that edits one: the text typed over its own colours, the variables it takes as chips
// under it, and a Preview tab with each {{variable}} filled with an example. Settings → Coding Agents uses it.
import { h } from './ui.js';
import { shellQuote } from './dev-core.js';
/** @import { Child } from '../types/ui' */

/** @typedef {[string, string]} Run A class ('' for plain) and its text. */

// Tried in order at each position of a command line.
const VAR = /\{\{?\w+\}\}?/y;
const ASSIGN = /[A-Za-z_]\w*(?==)/y;
const STRING = /"(?:\\.|[^"\\])*"?|'[^']*'?/y;
const DOLLAR = /\$(?:\{[^}\s]*\}?|\w+)/y;
const FLAG = /--?[A-Za-z][\w.-]*/y;
const OPERATOR = /&&|\|\||[|;&<>]/y;
const SPACE = /\s+/y;
const NUMBER = /\d+(?:\.\d+)?(?![\w.-])/y;
const WORD = /[^\s'"${}|;&<>=]+|[\s\S]/y;

/** @param {RegExp} re @param {string} text @param {number} at */
const match = (re, text, at) => {
  re.lastIndex = at;
  return re.exec(text)?.[0] ?? '';
};

// The runs of one command line. Still in the program's place, a NAME= is a variable set for it; the first other
// word is the program, and after an operator (&&, |, ;) the next word is a program again.
/** @param {string} text @returns {Run[]} */
export function shellRuns(text) {
  /** @type {Run[]} */
  const runs = [];
  let at = 0;
  let program = true; // the next word is the program
  let wordStart = true;
  let inProgram = false; // within the program's word
  let inAssign = false; // within the value of a NAME=value
  /** @param {string} cls @param {string} value */
  const push = (cls, value) => {
    const last = runs.at(-1);
    if (last && last[0] === cls) last[1] += value;
    else runs.push([cls, value]);
    at += value.length;
  };
  while (at < text.length) {
    let m;
    if ((m = match(SPACE, text, at))) {
      push('', m);
      if (inProgram) { inProgram = false; program = false; }
      inAssign = false;
      wordStart = true;
      continue;
    }
    if ((m = match(VAR, text, at))) push('cmd-var', m);
    else if ((m = match(OPERATOR, text, at))) { push('keyword', m); program = true; inProgram = false; }
    else if (wordStart && program && (m = match(ASSIGN, text, at))) { push('property', m); push('', '='); wordStart = false; inAssign = true; continue; }
    else if ((m = match(STRING, text, at))) push('string', m);
    else if ((m = match(DOLLAR, text, at))) push('variable', m);
    else if (wordStart && !program && /^--(?:\s|$)/.test(text.slice(at, at + 3))) push('keyword', '--');
    else if (wordStart && !program && (m = match(FLAG, text, at))) push('meta', m);
    else if (wordStart && !program && (m = match(NUMBER, text, at))) push('number', m);
    else if ((m = match(WORD, text, at))) {
      if (inAssign) push('string', m);
      else if (program || inProgram) { push('function', m); inProgram = true; }
      else push('', m);
    }
    wordStart = false;
  }
  return runs;
}

/** @param {Run[]} runs */
const runNodes = (runs) => runs.map(([cls, text]) => (cls ? h('span', { class: cls === 'cmd-var' ? 'cmd-var' : `tok-${cls}` }, text) : text));

// A command shown read-only, in colour.
/** @param {string} text @param {string} [className] */
export const codeLine = (text, className = '') => h('code', { class: `cmd-code ${className}`.trim() }, runNodes(shellRuns(text)));

// The command with each {{variable}} filled by its example, quoted as it will run and marked; a variable with no
// example stays as written.
/** @param {string} template @param {Record<string, string>} values */
function previewNodes(template, values) {
  /** @type {Child[]} */
  const out = [];
  let last = 0;
  for (const m of template.matchAll(/\{\{?(\w+)\}\}?/g)) {
    out.push(...runNodes(shellRuns(template.slice(last, m.index))));
    const value = values[m[1]];
    out.push(value
      ? h('span', { class: 'cron-fill', title: `{{${m[1]}}}` }, shellQuote(value))
      : h('span', { class: 'cron-fill missing', title: `${m[1]}: no example` }, m[0]));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(...runNodes(shellRuns(template.slice(last))));
  return out;
}

// Which field had Preview on, by key, so a re-render keeps the tab.
const previewing = new Set();

/**
 * A command field. `vars` are the variables offered as chips, `preview` gives the template the Preview tab fills
 * with `examples` (no Preview tab without it). `runs` instead shows, always and as it is typed, the whole command a
 * task would run (`runsHint` under it). Saved on blur or Enter; Escape puts the saved text back.
 * @param {{ key: string, label?: string, value: string, placeholder?: string, vars?: [string, string][],
 *   preview?: (value: string) => string, examples?: Record<string, string>, previewHint?: string,
 *   runs?: (value: string) => string, runsHint?: string, onSave: (value: string) => void }} options
 */
export function commandField({ key, label = '', value, placeholder = '', vars = [], preview, examples = {}, previewHint = '', runs, runsHint = '', onSave }) {
  const code = h('pre', { class: 'cmd-code cmd-layer', 'aria-hidden': 'true' });
  const input = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    class: 'cmd-input',
    name: `cmd-${key}`,
    rows: 1,
    spellcheck: false,
    autocomplete: 'off',
    autocapitalize: 'off',
    placeholder,
    'aria-label': label || placeholder,
  }));
  input.value = value;
  const runsBox = runs ? h('pre', { class: 'cmd-code cmd-preview' }) : null;
  const paint = () => {
    code.replaceChildren(...runNodes(shellRuns(input.value)), '\u200b');
    runsBox?.replaceChildren(...runNodes(shellRuns(/** @type {(v: string) => string} */ (runs)(input.value.replace(/\s*\n\s*/g, ' ').trim() || placeholder))));
  };
  paint();
  let saved = value;
  const save = () => {
    const next = input.value.replace(/\s*\n\s*/g, ' ').trim();
    if (next === saved.trim()) return;
    saved = next;
    onSave(next);
  };
  input.addEventListener('input', paint);
  input.addEventListener('change', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      input.blur();
    } else if (e.key === 'Escape') {
      input.value = saved;
      paint();
      input.blur();
    }
  });
  const editor = h('div', { class: 'cmd-editor' }, code, input);
  // A chip pressed on the Preview tab goes back to Edit, so the variable is seen going in.
  let showEdit = () => {};

  const chips = vars.length
    ? h('div', { class: 'cron-vars', role: 'group', 'aria-label': `Variables for ${label || 'the command'}` },
        vars.map(([name, title]) => h('button', {
          type: 'button',
          class: 'cron-var',
          title,
          // Keeps the field's focus and cursor, so the variable goes in where the cursor is.
          onmousedown: (/** @type {Event} */ e) => e.preventDefault(),
          onclick: () => {
            if (editor.hidden) showEdit();
            const token = `{{${name}}}`;
            const focused = document.activeElement === input;
            const start = focused ? input.selectionStart : input.value.length;
            const end = focused ? input.selectionEnd : input.value.length;
            const before = input.value.slice(0, start);
            input.focus();
            input.setRangeText(`${before && !/\s$/.test(before) ? ' ' : ''}${token}`, start, end, 'end');
            paint();
            save();
          },
        }, `{{${name}}}`)))
    : null;

  if (!preview) {
    return h('div', { class: 'cmd-field' },
      label ? h('span', { class: 'dev-env-label small' }, label) : null,
      editor, chips,
      runsBox ? [h('span', { class: 'dev-env-label small' }, 'A task runs'), runsBox, runsHint ? h('p', { class: 'muted small' }, runsHint) : null] : null);
  }
  const fill = preview;
  const box = h('div', { class: 'cmd-preview-wrap' });
  const tabs = [['edit', 'Edit'], ['preview', 'Preview']].map(([tab, text]) =>
    h('button', { type: 'button', role: 'tab', class: 'sub-tab', 'data-tab': tab, onclick: () => show(tab === 'preview', true) }, text));
  // Switched in place: a re-render would save the field first and lose its cursor. `focus` is false when drawing.
  /** @param {boolean} on @param {boolean} focus */
  function show(on, focus) {
    if (on) previewing.add(key);
    else previewing.delete(key);
    editor.hidden = on;
    box.hidden = !on;
    for (const b of tabs) {
      const active = (b.dataset.tab === 'preview') === on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    if (on) {
      box.replaceChildren(h('pre', { class: 'cmd-code cmd-preview' }, previewNodes(fill(input.value.trim() || placeholder), examples)));
      if (previewHint) box.append(h('p', { class: 'muted small' }, previewHint));
    } else if (focus) input.focus();
  }
  const out = h('div', { class: 'cmd-field' },
    h('div', { class: 'cmd-field-head' },
      h('span', { class: 'dev-env-label small' }, label),
      h('div', { class: 'sub-tabs cron-field-tabs', role: 'tablist', 'aria-label': `${label} view` }, tabs)),
    editor, box, chips);
  showEdit = () => show(false, true);
  show(previewing.has(key), false);
  return out;
}
