// Settings → Prompts: read and replace the system prompt of every AI feature, plus one prompt added to every call.
import { h, icon } from '../ui.js';
import { PROMPTS, GLOBAL_PROMPT, overrides } from '../prompts.js';
import { modelForTask } from './settings.js';

// Text being edited, kept across re-renders (a background save re-renders the page), and which prompts are open.
const drafts = {};
const open = new Set();

function save(store, id, text, fallback) {
  delete drafts[id];
  store.update('settings', (d) => {
    d.prompts ??= {};
    // Saving the default text, or nothing, goes back to following the default.
    if (!text.trim() || text.trim() === fallback.trim()) delete d.prompts[id];
    else d.prompts[id] = text;
  });
}

function editor(store, { id, fallback, rows, label, vars = [] }) {
  const saved = overrides(store)[id] ?? '';
  const current = saved || fallback;
  const value = drafts[id] ?? current;
  const dirty = id in drafts && drafts[id] !== current;
  const area = h('textarea', {
    rows,
    class: 'mono-text prompt-text',
    'aria-label': label,
    placeholder: id === GLOBAL_PROMPT ? 'For example: Answer in French. Keep replies short.' : '',
    oninput: (e) => {
      drafts[id] = e.target.value;
      // Show the buttons without a re-render, which would drop focus.
      const actions = e.target.parentElement.querySelector('.prompt-actions');
      actions.querySelector('[data-save]').disabled = e.target.value === current;
    },
  }, value);
  return h('div', { class: 'stack' },
    area,
    vars.length
      ? h('p', { class: 'muted small' }, 'Filled in when the call is made: ', vars.map((v, i) => [i ? ', ' : '', h('code', null, `{{${v}}}`)]))
      : null,
    h('div', { class: 'row prompt-actions' },
      h('button', { type: 'button', class: 'primary', 'data-save': '', disabled: !dirty, onclick: () => save(store, id, area.value, fallback) }, 'Save'),
      saved || dirty
        ? h('button', {
            type: 'button',
            onclick: () => {
              delete drafts[id];
              save(store, id, '', fallback);
            },
          }, id === GLOBAL_PROMPT ? 'Clear' : 'Restore default')
        : null));
}

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

    h('p', { class: 'muted small' }, `${PROMPTS.length} features · ${edited ? `${edited} edited` : 'all on their defaults'}. Cron flow steps keep their own system instructions in Cron.`),

    h('ul', { class: 'prompt-list' }, PROMPTS.map((p) =>
      h('li', null,
        h('details', {
          class: 'prompt-item',
          open: open.has(p.id),
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
