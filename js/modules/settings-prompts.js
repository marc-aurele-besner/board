// Settings → Prompts: read and replace the system prompt of every AI feature, plus one prompt added to every call.
// Each text has Edit and Preview tabs (as Cron's fields), and its variables as chips that go in at the cursor.
import { h, icon } from '../ui.js';
import { PROMPTS, GLOBAL_PROMPT, GENERAL_VARS, FEATURE_VARS, overrides } from '../prompts.js';
import { modelForTask } from './settings.js';

/** @import { Store } from '../../types/data' */

// Text being edited, kept across re-renders (a background save re-renders the page), and which prompts are open.
/** @type {Record<string, string>} */
const drafts = {};
/** @type {Set<string>} */
const open = new Set();
// The prompts showing their Preview tab, and the words the list is filtered by.
/** @type {Set<string>} */
const previewing = new Set();
const promptsView = { q: '' };

// The text as a call sends it: each variable filled with its example and marked; one the board does not know is
// left as written and marked as missing.
/** @param {string} text @param {Record<string, string>} examples */
function previewOf(text, examples) {
  /** @type {(string | HTMLElement)[]} */
  const out = [];
  /** @type {Set<string>} */
  const missing = new Set();
  let last = 0;
  for (const m of text.matchAll(/\{\{\s*(\w+)\s*\}\}/g)) {
    out.push(text.slice(last, m.index));
    const value = examples[m[1]];
    if (value === undefined) missing.add(m[0]);
    out.push(value === undefined
      ? h('span', { class: 'cron-fill missing', title: 'No such variable: sent as written' }, m[0])
      : h('span', { class: 'cron-fill', title: `{{${m[1]}}}` }, value));
    last = (m.index ?? 0) + m[0].length;
  }
  out.push(text.slice(last));
  return [
    h('pre', { class: 'cron-preview prompt-preview' }, text.trim() ? out : h('span', { class: 'muted' }, 'Nothing: this text is empty.')),
    h('p', { class: 'muted small' }, 'Each variable filled with an example; a call fills in its own.'),
    missing.size ? h('p', { class: 'small error' }, `No value for ${[...missing].join(', ')}: sent as written.`) : null,
  ];
}

/** @param {Store} store @param {string} id @param {string} text @param {string} fallback */
function save(store, id, text, fallback) {
  delete drafts[id];
  store.update('settings', (d) => {
    d.prompts ??= {};
    // Saving the default text, or nothing, goes back to following the default.
    if (!text.trim() || text.trim() === fallback.trim()) delete d.prompts[id];
    else d.prompts[id] = text;
  });
}

/** @param {Store} store @param {{ id: string, fallback: string, rows: number, label: string, vars?: string[] }} options */
function editor(store, { id, fallback, rows, label, vars = [] }) {
  const saved = overrides(store)[id] ?? '';
  const current = saved || fallback;
  const value = drafts[id] ?? current;
  const dirty = id in drafts && drafts[id] !== current;
  /** @type {Record<string, string>} */
  const examples = Object.fromEntries([...GENERAL_VARS.map(([name, , example]) => [name, example]), ...vars.map((v) => [v, FEATURE_VARS[v]?.[1] ?? v])]);
  const saveButton = /** @type {HTMLButtonElement} */ (h('button', { type: 'button', class: 'primary', disabled: !dirty, onclick: () => save(store, id, area.value, fallback) }, 'Save'));
  const area = /** @type {HTMLTextAreaElement} */ (h('textarea', {
    rows,
    class: 'mono-text prompt-text',
    'aria-label': label,
    placeholder: id === GLOBAL_PROMPT ? 'For example: Answer in French. Keep replies short.' : '',
    // Shows Save without a re-render, which would drop focus.
    oninput: () => {
      drafts[id] = area.value;
      saveButton.disabled = area.value === current;
    },
  }, value));
  const box = h('div', { class: 'cron-preview-wrap stack' });
  const tabs = [['edit', 'Edit'], ['preview', 'Preview']].map(([tab, text]) =>
    h('button', { type: 'button', role: 'tab', class: 'sub-tab', 'data-tab': tab, onclick: () => show(tab === 'preview', true) }, text));
  // Switched in place, as a re-render would lose the cursor. `focus` is false while drawing.
  /** @param {boolean} on @param {boolean} focus */
  function show(on, focus) {
    if (on) previewing.add(id);
    else previewing.delete(id);
    area.hidden = on;
    box.hidden = !on;
    for (const b of tabs) {
      const active = (b.dataset.tab === 'preview') === on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    }
    if (on) box.replaceChildren(...previewOf(area.value, examples).filter((x) => x !== null));
    else if (focus) area.focus();
  }
  /** @param {string} name @param {string} title */
  const chip = (name, title) => h('button', {
    type: 'button',
    class: 'cron-var',
    title,
    // Keeps the field's focus and cursor, so the variable goes in where the cursor is.
    onmousedown: (/** @type {Event} */ e) => e.preventDefault(),
    onclick: () => {
      if (area.hidden) show(false, true);
      const focused = document.activeElement === area;
      const start = focused ? area.selectionStart : area.value.length;
      const end = focused ? area.selectionEnd : area.value.length;
      area.focus();
      area.setRangeText(`{{${name}}}`, start, end, 'end');
      area.dispatchEvent(new Event('input'));
    },
  }, `{{${name}}}`);
  const out = h('div', { class: 'stack' },
    h('div', { class: 'sub-tabs cron-field-tabs', role: 'tablist', 'aria-label': `${label} view` }, tabs),
    area,
    box,
    vars.length
      ? h('div', { class: 'cron-vars prompt-vars', role: 'group', 'aria-label': 'This feature’s variables' },
          h('span', { class: 'muted small' }, 'This feature'),
          vars.map((v) => chip(v, `${FEATURE_VARS[v]?.[0] ?? v}. Example: ${FEATURE_VARS[v]?.[1] ?? ''}`)))
      : null,
    h('div', { class: 'cron-vars prompt-vars', role: 'group', 'aria-label': 'Variables for any prompt' },
      h('span', { class: 'muted small' }, vars.length ? 'Any prompt' : 'Insert'),
      GENERAL_VARS.map(([name, about, example]) => chip(name, `${about}. Example: ${example}`))),
    h('div', { class: 'row prompt-actions' },
      saveButton,
      saved || dirty
        ? h('button', {
            type: 'button',
            onclick: () => {
              delete drafts[id];
              save(store, id, '', fallback);
            },
          }, id === GLOBAL_PROMPT ? 'Clear' : 'Restore default')
        : null));
  show(previewing.has(id), false);
  return out;
}

/** @param {string} text */
const matches = (text) => promptsView.q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => text.includes(w));

/** @param {HTMLElement | null} panel */
function filterPrompts(panel) {
  for (const li of /** @type {NodeListOf<HTMLElement>} */ (panel?.querySelectorAll('.prompt-list > li[data-find]') ?? [])) li.hidden = !matches(li.dataset.find ?? '');
}

/** @param {Store} store */
export function promptsCard(store) {
  const saved = overrides(store);
  const tasks = new Map((store.get('settings').models?.tasks ?? []).map((t) => [t.id, t.name]));
  const edited = PROMPTS.filter((p) => saved[p.id]).length;

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Prompts'),
        h('p', { class: 'muted' }, 'The system prompts the board sends with each AI feature. Edit one to change how that feature answers; restore the default at any time.'))),

    h('div', { class: 'card-inset stack' },
      h('div', null,
        h('strong', null, 'Every call'),
        h('p', { class: 'muted small' }, 'Added ahead of the feature’s own prompt on every AI call, Cron flow steps included. Leave empty to add nothing.')),
      editor(store, { id: GLOBAL_PROMPT, fallback: '', rows: 3, label: 'Prompt added to every call' })),

    h('div', { class: 'row between prompt-list-head' },
      h('p', { class: 'muted small' }, `${PROMPTS.length} features · ${edited ? `${edited} edited` : 'all on their defaults'}. Cron flow steps keep their own system instructions in Cron.`),
      h('input', {
        type: 'search',
        class: 'prompt-find',
        placeholder: 'Find a prompt',
        'aria-label': 'Find a prompt',
        value: promptsView.q,
        // Filtered in place, as a re-render would drop the field's focus.
        oninput: (/** @type {{ target: HTMLInputElement }} */ e) => {
          promptsView.q = e.target.value;
          filterPrompts(/** @type {HTMLElement} */ (e.target.closest('.panel')));
        },
      })),

    h('ul', { class: 'prompt-list' }, PROMPTS.map((p) =>
      h('li', { 'data-find': `${p.name} ${p.where} ${p.text}`.toLowerCase(), hidden: !matches(`${p.name} ${p.where} ${p.text}`.toLowerCase()) },
        h('details', {
          class: 'prompt-item',
          open: open.has(p.id),
          /** @param {{ target: HTMLDetailsElement }} e */
          ontoggle: (e) => (e.target.open ? open.add(p.id) : open.delete(p.id)),
        },
          h('summary', null,
            h('span', { class: 'grow' },
              h('strong', null, p.name),
              h('span', { class: 'muted small' }, ` · ${p.where}`)),
            saved[p.id] ? h('span', { class: 'pill tone-custom' }, 'Edited') : null,
            h('span', { class: 'muted small', title: 'Model used' }, icon('cpu'), ` ${modelForTask(store, p.task) || 'no model'}`)),
          h('p', { class: 'muted small' }, `Task: ${tasks.get(p.task) ?? p.task}`),
          editor(store, { id: p.id, fallback: p.text, rows: Math.min(16, p.text.split('\n').length + 5), label: `${p.name} prompt`, vars: p.vars }))))));
}
