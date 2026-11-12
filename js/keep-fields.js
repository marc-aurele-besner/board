// Every save rebuilds the page, and background jobs save while the user is typing. This keeps what was typed but
// not submitted across a rebuild, and tells the shell when a rebuild should wait because a changed field has focus.

const FIELDS = 'input:not([type=button]):not([type=submit]):not([type=reset]):not([type=file]):not([type=hidden]), textarea, select';
const CHECKABLE = new Set(['checkbox', 'radio']);

// An input, textarea or select. Typed as an input: what the others lack (checked, placeholder, the selection) reads
// undefined on them.
/** @typedef {HTMLInputElement} Field */
/** @typedef {ReturnType<typeof snapshot>} Kept */

// The value each field was drawn with. A field whose value differs from it holds unsubmitted input.
/** @type {WeakMap<Element, string | boolean>} */
const drawn = new WeakMap();
// Fields whose value was just submitted (Enter, a form submit, a button beside them). Their old text is never put back.
/** @type {WeakSet<EventTarget>} */
const committed = new WeakSet();

/** @param {Field} el */
const read = (el) => (CHECKABLE.has(el.type) ? el.checked : el.value);
/** @param {Field} el @param {string | boolean} value */
const write = (el, value) => {
  if (CHECKABLE.has(el.type)) el.checked = /** @type {boolean} */ (value);
  else el.value = /** @type {string} */ (value);
};
/** @param {unknown} el @returns {el is Field} */
const isField = (el) => el instanceof Element && el.matches(FIELDS);
/** @param {Field} el */
const dirty = (el) => drawn.has(el) && read(el) !== drawn.get(el);

// Matches a field across two renders by what it is, its label, and its place among fields with the same label.
/** @param {ParentNode} root */
function keyed(root) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  /** @type {Map<string, Field>} */
  const out = new Map();
  for (const el of /** @type {NodeListOf<Field>} */ (root.querySelectorAll(FIELDS))) {
    const label = el.name || el.getAttribute('aria-label') || el.placeholder || el.id || el.className;
    const base = `${el.tagName}|${el.type}|${label}${el.type === 'radio' ? `|${el.value}` : ''}`;
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    out.set(`${base}#${n}`, el);
  }
  return out;
}

// Call after a render, so later typing can be told apart from what the section drew.
/** @param {ParentNode} root */
export function markDrawn(root) {
  for (const el of /** @type {NodeListOf<Field>} */ (root.querySelectorAll(FIELDS))) drawn.set(el, read(el));
}

/** @param {ParentNode} root */
export function snapshot(root) {
  const active = document.activeElement;
  const kept = [];
  for (const [key, el] of keyed(root)) {
    const focused = el === active;
    const changed = dirty(el) && !committed.has(el);
    if (!changed && !focused) continue;
    kept.push({ key, changed, drawn: drawn.get(el), value: read(el), focused, start: el.selectionStart, end: el.selectionEnd, direction: el.selectionDirection });
  }
  return kept;
}

/** @param {ParentNode} root @param {Kept} kept */
export function restore(root, kept) {
  if (!kept.length) return;
  const fields = keyed(root);
  for (const k of kept) {
    const el = fields.get(k.key);
    if (!el) continue;
    // A section that drew a different value meant to (it saved or reset the field), so only an unchanged one is refilled.
    if (k.changed && read(el) === k.drawn) write(el, k.value);
    if (k.focused) {
      el.focus({ preventScroll: true });
      try {
        if (k.start !== null) el.setSelectionRange(k.start, k.end, /** @type {'forward' | 'backward' | 'none'} */ (k.direction)); // null only where there is no caret
      } catch {
        /* this input type has no caret */
      }
    }
  }
}

// A pointer is down. A rebuild between press and release would drop the click, since they land on different elements.
let pressed = false;

// True while a rebuild would get in the way: a field the user changed has focus, a field drawn after the render
// (an inline editor) has focus, a picker is open, or a button is being pressed.
/** @param {Element | null | undefined} root */
export function holding(root) {
  if (pressed || document.querySelector('.popover')) return true;
  const el = document.activeElement;
  if (!root || !isField(el) || !root.contains(el) || committed.has(el)) return false;
  return !drawn.has(el) || dirty(el);
}

// Watches for submits, so the text of a sent form or a field where Enter was pressed is not brought back.
/** @param {HTMLElement} root @param {() => void} onSettle */
export function watchCommits(root, onSettle) {
  /** @param {NodeListOf<Element> | Element[]} els */
  const commit = (els) => els.forEach((el) => committed.add(el));
  root.addEventListener('submit', (e) => commit(/** @type {HTMLFormElement} */ (e.target).querySelectorAll(FIELDS)), true);
  root.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !isField(e.target)) return;
    if (e.target.tagName === 'TEXTAREA' && !(e.metaKey || e.ctrlKey)) return;
    commit([e.target]);
  }, true);
  root.addEventListener('click', (e) => {
    const button = /** @type {Element} */ (e.target).closest?.('button, [role=button]');
    // A button that opens a picker submits nothing; the text typed beside it is still unsent.
    if (button && !button.hasAttribute('aria-haspopup')) commit((button.closest('form') ?? button.parentElement ?? button).querySelectorAll(FIELDS));
  }, true);
  // Typing again after a submit that did not go through makes the field worth keeping again.
  root.addEventListener('input', (e) => committed.delete(/** @type {EventTarget} */ (e.target)), true);
  document.addEventListener('pointerdown', () => (pressed = true), true);
  const release = () => (pressed = false);
  for (const type of ['pointerup', 'pointercancel']) document.addEventListener(type, release, true);
  // A release outside the window never reaches the page; leaving the window ends the press instead.
  window.addEventListener('blur', release);
  // Focus leaving a field, a click or a key can end a hold; the check runs once the event is done.
  const settle = () => setTimeout(onSettle, 0);
  for (const type of ['focusout', 'pointerup', 'pointercancel', 'keyup']) document.addEventListener(type, settle, true);
  window.addEventListener('blur', settle);
}
