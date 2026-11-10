// Notion-style inline editing: click a value to edit it where it is shown, no form.
// Each control calls onSave/onPick with the new value; the store then re-renders the page.
import { h, icon } from './ui.js';

// Click-to-edit text. Enter saves (Ctrl/Cmd+Enter for multiline), Escape cancels, blur saves.
export function editText({ value = '', placeholder = 'Empty', multiline = false, className = '', allowEmpty = false, onSave }) {
  const current = value ?? '';
  const view = h('span', {
    class: `editable ${className}${current ? '' : ' is-placeholder'}`.trim(),
    role: 'button',
    tabindex: '0',
    title: 'Click to edit',
    onclick: (e) => {
      e.stopPropagation();
      start();
    },
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        start();
      }
    },
  }, current || placeholder);

  function start() {
    let done = false;
    const field = multiline
      ? h('textarea', { class: 'editable-field', rows: Math.min(10, Math.max(2, current.split('\n').length + 1)), placeholder, value: current })
      : h('input', { class: 'editable-field', type: 'text', placeholder, value: current, autocomplete: 'off' });

    const finish = (save) => {
      if (done) return;
      done = true;
      const next = multiline ? field.value.trim() : field.value.trim();
      const changed = next !== current.trim();
      if (save && changed && (next || allowEmpty)) onSave(next);
      else field.replaceWith(view);
    };

    field.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        finish(false);
      } else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        finish(true);
      }
    });
    field.addEventListener('blur', () => finish(true));
    field.addEventListener('click', (e) => e.stopPropagation());

    view.replaceWith(field);
    field.focus();
    if (!multiline) field.select();
  }

  return view;
}

// A popover is one open picker at a time. It closes on outside click or Escape.
let openPicker = null;

function closePicker() {
  if (!openPicker) return;
  openPicker.el.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  openPicker = null;
}

function onOutside(e) {
  if (!openPicker) return;
  if (openPicker.el.contains(e.target) || openPicker.anchor.contains(e.target)) return;
  closePicker();
}

function onKey(e) {
  if (e.key === 'Escape') closePicker();
}

function positionPopover(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 16);
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 4;
  const fitsBelow = below + 300 < window.innerHeight;
  el.style.top = fitsBelow ? `${below}px` : `${Math.max(8, rect.top - 4 - el.offsetHeight)}px`;
}

// Opens a searchable list anchored to `anchor`. `options` are { value, label, tone? }.
function showPicker(anchor, { options, value, nullable, nullLabel, allowCreate, onPick, onCreate }) {
  closePicker();
  const search = h('input', { class: 'pop-search', placeholder: 'Search or create…', autocomplete: 'off', 'aria-label': 'Search options' });
  const list = h('div', { class: 'pop-list', role: 'listbox' });

  const choose = (v) => {
    closePicker();
    onPick(v);
  };
  const create = (name) => {
    closePicker();
    onCreate(name);
  };

  const row = (v, label, tone, selected) =>
    h('button', {
      type: 'button',
      class: `pop-item${selected ? ' selected' : ''}`,
      role: 'option',
      'aria-selected': String(selected),
      onclick: () => choose(v),
    },
      h('span', { class: `pill tone-${tone ?? 'plain'}` }, label),
      selected ? icon('check') : null);

  const renderList = () => {
    const q = search.value.trim();
    const lower = q.toLowerCase();
    const shown = options.filter((o) => !q || o.label.toLowerCase().includes(lower));
    const exact = options.some((o) => o.label.toLowerCase() === lower);
    list.replaceChildren(
      nullable && !q ? row(null, nullLabel ?? 'None', 'plain', !value) : null,
      ...shown.map((o) => row(o.value, o.label, o.tone, o.value === value)),
      allowCreate && q && !exact
        ? h('button', { type: 'button', class: 'pop-item create', onclick: () => create(q) }, icon('plus'), `Create “${q}”`)
        : null,
      !shown.length && !(allowCreate && q) ? h('p', { class: 'pop-empty' }, 'Nothing to pick') : null);
  };

  search.addEventListener('input', renderList);
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const q = search.value.trim();
    const lower = q.toLowerCase();
    const exact = options.find((o) => o.label.toLowerCase() === lower);
    if (exact) choose(exact.value);
    else if (allowCreate && q) create(q);
  });

  const el = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Choose an option' }, search, list);
  document.body.append(el);
  openPicker = { el, anchor };
  renderList();
  positionPopover(el, anchor);
  search.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

// A colored chip that opens a picker when clicked.
// options: [{ value, label, tone? }]. A null or '' value means none.
export function pickChip({ value = null, options, placeholder = 'Set', nullable = false, nullLabel = 'None', allowCreate = false, tone, className = '', onPick, onCreate }) {
  const found = options.find((o) => o.value === value);
  const isEmpty = value === null || value === undefined || value === '';
  const label = found ? found.label : isEmpty ? (nullable ? nullLabel : placeholder) : String(value);
  const chip = h('button', {
    type: 'button',
    class: `chip-pick ${className}${isEmpty ? ' is-empty' : ''}`.trim(),
    'aria-haspopup': 'listbox',
    onclick: (e) => {
      e.stopPropagation();
      if (openPicker && openPicker.anchor === chip) return closePicker();
      showPicker(chip, {
        options,
        value,
        nullable,
        nullLabel,
        allowCreate,
        onPick: (v) => onPick(v),
        onCreate: (name) => onCreate?.(name),
      });
    },
  }, found ? h('span', { class: `pill tone-${found.tone ?? 'plain'}` }, label) : h('span', { class: 'muted' }, label));
  return chip;
}

// Keeps a row's own click (for example, opening its details) from firing when a control inside it is used.
export const stop = (e) => e.stopPropagation();
