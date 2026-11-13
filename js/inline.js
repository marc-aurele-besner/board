// Notion-style inline editing: click a value to edit it where it is shown, no form.
// Each control calls onSave/onPick with the new value; the store then re-renders the page.
import { h, icon } from './ui.js';
import { richText } from './rich.js';

/** @import { Child } from '../types/ui' */
/**
 * An option of a picker. `color` (a project's) or `tone` (a CSS palette name) colours its pill; `plainIcon` shows an
 * icon and the name instead of a pill.
 * @template V
 * @typedef {{ value: V, label: string, tone?: string, color?: string | null, plainIcon?: Child | (() => Child) }} PickOption
 */
/**
 * A row of pickTree(): `depth` indents it under its parent.
 * @template V
 * @typedef {{ value: V, label: string, depth: number, checked: boolean, mixed?: boolean, lead?: () => Child }} TreeOption
 */

// Click-to-edit text. Enter saves (Ctrl/Cmd+Enter for multiline), Escape cancels, blur saves.
// `display(text)` can draw the saved value as something other than plain text, such as a bullet list.
/**
 * @param {{ value?: string | null, placeholder?: string, multiline?: boolean, className?: string, allowEmpty?: boolean, rich?: boolean,
 *   display?: ((text: string) => Child) | null, onSave: (text: string) => void }} options
 */
export function editText({ value = '', placeholder = 'Empty', multiline = false, className = '', allowEmpty = false, rich = false, display = null, onSave }) {
  const current = value ?? '';
  const view = h(rich || display ? 'div' : 'span', {
    class: `editable ${className}${current ? '' : ' is-placeholder'}`.trim(),
    role: 'button',
    tabindex: '0',
    title: 'Click to edit',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      // Links and buttons inside a rich description work as usual; only the text opens the editor.
      if (/** @type {Element} */ (e.target).closest('a, button, input')) return;
      e.stopPropagation();
      start();
    },
    /** @param {KeyboardEvent} e */
    onkeydown: (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        start();
      }
    },
  }, display && current ? display(current) : rich && current ? richText(current) : current || placeholder);

  function start() {
    let done = false;
    const field = multiline
      ? h('textarea', { class: 'editable-field', rows: Math.min(10, Math.max(2, current.split('\n').length + 1)), placeholder, value: current })
      : h('input', { class: 'editable-field', type: 'text', placeholder, value: current, autocomplete: 'off' });

    /** @param {boolean} save */
    const finish = (save) => {
      if (done) return;
      done = true;
      const next = multiline ? field.value.trim() : field.value.trim();
      const changed = next !== current.trim();
      if (save && changed && (next || allowEmpty)) onSave(next);
      else field.replaceWith(view);
    };

    /** @type {HTMLElement} */ (field).addEventListener('keydown', (e) => {
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
/** @type {{ el: HTMLElement, anchor: HTMLElement, key: string | null } | null} */
let openPicker = null;

function closePicker() {
  if (!openPicker) return;
  openPicker.el.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  openPicker = null;
}

/** @param {PointerEvent} e */
function onOutside(e) {
  if (!openPicker) return;
  if (openPicker.el.contains(/** @type {Node} */ (e.target)) || openPicker.anchor.contains(/** @type {Node} */ (e.target))) return;
  // A multi-select re-renders its page on every tick, so its anchor is found again by key.
  if (openPicker.key && /** @type {Element} */ (e.target).closest?.(`[data-pick-key="${openPicker.key}"]`)) return;
  closePicker();
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.key === 'Escape') closePicker();
}

/** @param {HTMLElement} el @param {HTMLElement} anchor */
function positionPopover(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(280, window.innerWidth - 16);
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 4;
  const fitsBelow = below + 300 < window.innerHeight;
  el.style.top = fitsBelow ? `${below}px` : `${Math.max(8, rect.top - 4 - el.offsetHeight)}px`;
}

// Up and down arrows move a highlight through the list while the focus stays in the search field, so typing
// goes on; Enter then picks the highlighted row. The highlight keeps its place when the list is painted again.
/** @param {HTMLInputElement} search @param {HTMLElement} list */
function listCursor(search, list) {
  let at = -1;
  const items = () => /** @type {HTMLElement[]} */ ([...list.querySelectorAll('.pop-item')]);
  const mark = () => {
    const all = items();
    if (at >= all.length) at = all.length - 1;
    all.forEach((b, i) => b.classList.toggle('cursor', i === at));
    all[at]?.scrollIntoView({ block: 'nearest' });
  };
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const n = items().length;
    if (!n) return;
    at = e.key === 'ArrowDown' ? (at + 1) % n : (at <= 0 ? n : at) - 1;
    mark();
  });
  return {
    mark,
    reset: () => {
      at = -1;
    },
    current: () => items()[at] ?? null,
  };
}

// Opens a searchable list anchored to `anchor`. `options` are { value, label, tone? }.
// With `multi`, `value` is an array, a click ticks or unticks an option and the list stays open.
/**
 * The callbacks are methods so a caller's own option type is accepted.
 * @param {HTMLElement} anchor
 * @param {{ options: PickOption<unknown>[], value: unknown, nullable?: boolean, nullLabel?: string, allowCreate?: boolean, multi?: boolean,
 *   key?: string | null, onPick(value: unknown): void, onCreate?(name: string): void }} options
 */
function showPicker(anchor, { options, value, nullable, nullLabel, allowCreate, multi = false, key = null, onPick, onCreate }) {
  closePicker();
  // Options without a usable label are dropped, so no empty or "null" rows can appear.
  options = options.filter((o) => o && o.label !== null && o.label !== undefined && String(o.label) !== '');
  const search = h('input', { class: 'pop-search', placeholder: allowCreate ? 'Search or create…' : 'Search…', autocomplete: 'off', 'aria-label': 'Search options' });
  const list = h('div', { class: 'pop-list', role: 'listbox' });

  // Only read with `multi`.
  let picked = /** @type {Set<unknown>} */ (multi ? new Set(/** @type {unknown[]} */ (value)) : null);
  /** @param {unknown} v */
  const choose = (v) => {
    if (!multi) {
      closePicker();
      return onPick(v);
    }
    if (picked.has(v)) picked.delete(v);
    else picked.add(v);
    renderList();
    onPick([...picked]);
    // onPick re-renders the page on the next frame, and the shell then focuses its own field; take the focus back.
    requestAnimationFrame(() => {
      if (openPicker?.el === el) search.focus();
    });
  };
  /** @param {unknown} v */
  const isSelected = (v) => (multi ? picked.has(v) : v === value);
  /** @param {string} name */
  const create = (name) => {
    closePicker();
    // Only called with allowCreate, which comes with onCreate.
    /** @type {(name: string) => void} */ (onCreate)(name);
  };

  /** @param {unknown} v @param {string} label @param {Partial<PickOption<unknown>>} opt @param {boolean} selected */
  const row = (v, label, opt, selected) =>
    h('button', {
      type: 'button',
      class: `pop-item${selected ? ' selected' : ''}`,
      role: 'option',
      'aria-selected': String(selected),
      onclick: () => choose(v),
    },
      pill(label, opt),
      selected ? icon('check') : null);

  const cursor = listCursor(search, list);
  const renderList = () => {
    const q = search.value.trim();
    const lower = q.toLowerCase();
    const shown = options.filter((o) => !q || o.label.toLowerCase().includes(lower));
    const exact = options.some((o) => o.label.toLowerCase() === lower);
    // replaceChildren() turns null into the text "null", so empty slots are filtered out first.
    list.replaceChildren(.../** @type {HTMLElement[]} */ ([
      nullable && !q ? row(null, nullLabel ?? 'None', {}, !value) : null,
      multi && picked.size && !q
        ? h('button', { type: 'button', class: 'pop-item create', onclick: () => {
            picked = new Set();
            renderList();
            onPick([]);
          } }, icon('x'), 'Clear')
        : null,
      ...shown.map((o) => row(o.value, o.label, o, isSelected(o.value))),
      allowCreate && q && !exact
        ? h('button', { type: 'button', class: 'pop-item create', onclick: () => create(q) }, icon('plus'), `Create “${q}”`)
        : null,
      !shown.length && !(allowCreate && q) ? h('p', { class: 'pop-empty' }, 'Nothing to pick') : null,
    ].filter(Boolean)));
    cursor.mark();
  };

  search.addEventListener('input', () => {
    cursor.reset();
    renderList();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const highlighted = cursor.current();
    if (highlighted) return highlighted.click();
    const q = search.value.trim();
    const lower = q.toLowerCase();
    const exact = options.find((o) => o.label.toLowerCase() === lower);
    if (exact) choose(exact.value);
    else if (allowCreate && q) create(q);
    else if (multi && q) {
      const first = options.find((o) => o.label.toLowerCase().includes(lower));
      if (first) choose(first.value);
    }
  });

  if (multi) list.setAttribute('aria-multiselectable', 'true');
  const el = h('div', { class: 'popover', role: 'dialog', 'aria-label': multi ? 'Choose options' : 'Choose an option' }, search, list);
  document.body.append(el);
  openPicker = { el, anchor, key };
  renderList();
  positionPopover(el, anchor);
  search.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

// A colored chip that opens a picker when clicked.
// options: [{ value, label, tone? }]. A null or '' value means none.
/**
 * @template V
 * @param {{ value?: V | null, options: PickOption<V>[], placeholder?: string, nullable?: boolean, nullLabel?: string, allowCreate?: boolean,
 *   tone?: string, className?: string, onPick: (value: V) => void, onCreate?: ((name: string) => void) | null }} options
 */
export function pickChip({ value = null, options, placeholder = 'Set', nullable = false, nullLabel = 'None', allowCreate = false, tone, className = '', onPick, onCreate }) {
  const found = options.find((o) => o.value === value);
  const isEmpty = value === null || value === undefined || value === '';
  const label = found ? found.label : isEmpty ? (nullable ? nullLabel : placeholder) : String(value);
  const chip = h('button', {
    type: 'button',
    class: `chip-pick ${className}${isEmpty ? ' is-empty' : ''}`.trim(),
    'aria-haspopup': 'listbox',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      // The button on screen: after a patched redraw it runs the handler of a fresh, never shown `chip`.
      const anchor = /** @type {HTMLElement} */ (e.currentTarget);
      if (openPicker && openPicker.anchor === anchor) return closePicker();
      showPicker(anchor, {
        options,
        value,
        nullable,
        nullLabel,
        allowCreate,
        onPick: (/** @type {V} */ v) => onPick(v),
        onCreate: (/** @type {string} */ name) => onCreate?.(name),
      });
    },
  }, found ? pill(label, found) : h('span', { class: 'muted' }, label));
  return chip;
}

// A button that names an action and opens the same searchable picker, for setting a value on many things at once.
// options: [{ value, label, tone?, color? }].
/**
 * @template V
 * @param {{ label: string, options: PickOption<V>[], title?: string, className?: string, onPick: (value: V) => void }} options
 */
export function pickButton({ label, options, title, className = 'btn-small', onPick }) {
  const button = h('button', {
    type: 'button',
    class: `${className} pick-btn`.trim(),
    title: title ?? label,
    'aria-haspopup': 'listbox',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      const anchor = /** @type {HTMLElement} */ (e.currentTarget);
      if (openPicker && openPicker.anchor === anchor) return closePicker();
      showPicker(anchor, { options, value: undefined, onPick });
    },
  }, label, icon('chevron-down'));
  return button;
}

// A small "i" button that opens a short explanation, for places too tight for the text itself (a table header).
/** @param {{ title: string, text: string }} options */
export function infoButton({ title, text }) {
  const button = h('button', {
    type: 'button',
    class: 'info-btn',
    'aria-label': `About ${title}`,
    'aria-haspopup': 'dialog',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      const anchor = /** @type {HTMLElement} */ (e.currentTarget);
      if (openPicker && openPicker.anchor === anchor) return closePicker();
      closePicker();
      const el = h('div', { class: 'popover info-pop', role: 'dialog', 'aria-label': title }, h('strong', null, title), h('p', null, text));
      document.body.append(el);
      openPicker = { el, anchor, key: null };
      positionPopover(el, anchor);
      document.addEventListener('pointerdown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
      // A shortcut can change the page with no click; an open popover would hold its re-renders.
      window.addEventListener('hashchange', closePicker, { once: true });
    },
  }, icon('info'));
  return button;
}

// A colored pill. An option with `color` (a project's color) gets that color; otherwise `tone` picks one from the CSS palette.
/** @param {unknown} label @param {Partial<PickOption<unknown>>} [opt] */
export function pill(label, opt = {}) {
  const text = label === null || label === undefined ? '' : String(label);
  // An option with an icon (a project's) shows the icon and the name, without a pill.
  // A DOM node can sit in one place only, so an icon passed as a function is built again for each use.
  if (opt.plainIcon) return h('span', { class: 'opt-plain' }, typeof opt.plainIcon === 'function' ? opt.plainIcon() : opt.plainIcon, text);
  if (opt.color) return h('span', { class: 'pill tone-custom', style: { '--c': opt.color } }, text);
  return h('span', { class: `pill tone-${opt.tone ?? 'plain'}` }, text);
}

// Keeps a row's own click (for example, opening its details) from firing when a control inside it is used.
/** @param {Event} e */
export const stop = (e) => e.stopPropagation();

// A filter button that opens the searchable picker with several options ticked at once. An empty list means "any".
// options: [{ value, label, tone?, color? }]. `key` must be unique on the page: the button is drawn again on each tick.
/**
 * @template V
 * @param {{ key: string, values?: V[], options: PickOption<V>[], anyLabel?: string, ariaLabel?: string, onChange: (values: V[]) => void }} options
 */
export function pickMulti({ key, values = [], options, anyLabel = 'Any', ariaLabel, onChange }) {
  const chosen = options.filter((o) => values.includes(o.value));
  const text = !chosen.length ? anyLabel : chosen.length === 1 ? chosen[0].label : `${chosen[0].label} +${chosen.length - 1}`;
  const button = h('button', {
    type: 'button',
    class: `pick-multi${chosen.length ? ' active' : ''}`,
    title: chosen.map((o) => o.label).join(', ') || anyLabel,
    'aria-label': ariaLabel,
    'aria-haspopup': 'listbox',
    'data-pick-key': key,
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      if (openPicker && openPicker.key === key) return closePicker();
      showPicker(/** @type {HTMLElement} */ (e.currentTarget), { options, value: values, multi: true, key, onPick: onChange });
    },
  }, h('span', { class: 'pick-multi-text' }, text), icon('chevron-down'));
  return button;
}

// A filter button that opens a searchable list laid out as a tree, with a box to tick on each row: an account with its
// calendars, say. getOptions() is called on every paint, so ticks read the saved state after each change.
// options: [{ value, label, depth, checked, mixed?, lead?: () => Node }]. A search keeps the parents of what matches,
// and the children of a parent that matches.
/**
 * @template V
 * @param {{ key: string, label: string, title?: string, ariaLabel?: string, getOptions: () => TreeOption<V>[], onToggle: (value: V, on: boolean) => void }} options
 */
export function pickTree({ key, label, title, ariaLabel, getOptions, onToggle }) {
  const button = h('button', {
    type: 'button',
    class: 'pick-multi pick-tree-btn',
    title: title ?? label,
    'aria-label': ariaLabel,
    'aria-haspopup': 'listbox',
    'data-pick-key': key,
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      if (openPicker && openPicker.key === key) return closePicker();
      showTree(/** @type {HTMLElement} */ (e.currentTarget), { key, getOptions, onToggle });
    },
  }, h('span', { class: 'pick-multi-text' }, label), icon('chevron-down'));
  return button;
}

// The callbacks are methods so a caller's own option type is accepted.
/** @param {HTMLElement} anchor @param {{ key: string, getOptions(): TreeOption<unknown>[], onToggle(value: unknown, on: boolean): void }} options */
function showTree(anchor, { key, getOptions, onToggle }) {
  closePicker();
  const search = h('input', { class: 'pop-search', placeholder: 'Search…', autocomplete: 'off', 'aria-label': 'Search options' });
  const list = h('div', { class: 'pop-list pick-tree', role: 'listbox', 'aria-multiselectable': 'true' });
  const cursor = listCursor(search, list);
  const paint = () => {
    const q = search.value.trim().toLowerCase();
    const options = getOptions();
    /** @param {TreeOption<unknown>} o */
    const hit = (o) => o.label.toLowerCase().includes(q);
    const keep = new Set();
    /** @type {number[]} */
    const trail = []; // index of the current row's parents, by depth
    let under = Infinity; // depth of the nearest parent that matched
    options.forEach((o, i) => {
      trail.length = o.depth;
      trail[o.depth] = i;
      if (o.depth <= under) under = Infinity;
      if (!q || o.depth > under || hit(o)) {
        for (const j of trail) keep.add(j);
        if (q && hit(o)) under = Math.min(under, o.depth);
      }
    });
    const rows = options.filter((_, i) => keep.has(i)).map((o) =>
      h('button', {
        type: 'button',
        class: `pop-item pick-tree-item${o.checked ? ' selected' : ''}`,
        role: 'option',
        'aria-selected': String(o.checked),
        style: { '--depth': o.depth },
        onclick: () => {
          onToggle(o.value, !o.checked);
          // The page redraws on the next frame; paint again from the saved state and keep the focus here.
          requestAnimationFrame(() => {
            if (openPicker?.el !== el) return;
            paint();
            search.focus();
          });
        },
      },
        h('span', { class: `pick-tree-box${o.checked ? ' on' : o.mixed ? ' mixed' : ''}`, 'aria-hidden': 'true' }, o.checked ? icon('check') : null),
        o.lead ? o.lead() : null,
        h('span', { class: 'pick-tree-label' }, o.label)));
    list.replaceChildren(...(rows.length ? rows : [h('p', { class: 'pop-empty' }, 'Nothing to pick')]));
    cursor.mark();
  };
  search.addEventListener('input', () => {
    cursor.reset();
    paint();
  });
  search.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    cursor.current()?.click();
  });
  const el = h('div', { class: 'popover', role: 'dialog', 'aria-label': 'Choose options' }, search, list);
  document.body.append(el);
  openPicker = { el, anchor, key };
  paint();
  positionPopover(el, anchor);
  search.focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}
