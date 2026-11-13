// A context menu like a desktop app's: actions, separators and submenus that open to the side.
// Opened by a right click at the pointer, or by a ⋯ button under the button. One menu at a time.
import { h, icon } from './ui.js';

/** @import { Child } from '../types/ui' */
/**
 * A row of a menu: an action, a submenu (`items`), or '-' for a separator. `checked` shows a tick, `hint` a muted
 * word on the right. `search` puts a field with that placeholder atop the submenu, which keeps the rows whose label
 * holds what is typed.
 * @typedef {{ label: string, icon?: Child | (() => Child), hint?: string, checked?: boolean, danger?: boolean,
 *   onSelect?: () => void, items?: MenuEntry[], search?: string }} MenuItem
 * @typedef {MenuItem | '-' | null | false} MenuEntry
 */

/** @type {{ root: HTMLElement, panels: HTMLElement[], anchor: HTMLElement | null } | null} */
let open = null;
// The row each submenu opened from, to go back to it with the left arrow.
/** @type {WeakMap<HTMLElement, HTMLElement>} */
const openers = new WeakMap();
// One timer for every panel: reaching a submenu's row cancels a close its parent's row had planned.
/** @type {ReturnType<typeof setTimeout> | undefined} */
let hoverTimer;

export function closeMenu() {
  if (!open) return;
  for (const p of open.panels) p.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('blur', closeMenu);
  window.removeEventListener('resize', closeMenu);
  window.removeEventListener('hashchange', closeMenu);
  open = null;
}

/** @param {PointerEvent} e */
function onOutside(e) {
  const target = /** @type {Node} */ (e.target);
  if (open?.panels.some((p) => p.contains(target)) || open?.anchor?.contains(target)) return;
  closeMenu();
}

/** @param {HTMLElement} panel */
const rowsOf = (panel) => /** @type {HTMLElement[]} */ ([...panel.querySelectorAll(':scope > .menu-item:not([disabled]):not([hidden])')]);

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (!open) return;
  const panel = open.panels.find((p) => p.contains(document.activeElement)) ?? open.panels[open.panels.length - 1];
  const rows = rowsOf(panel);
  const at = rows.indexOf(/** @type {HTMLElement} */ (document.activeElement));
  // In a search field the side arrows move the caret.
  const typing = document.activeElement instanceof HTMLInputElement;
  if (e.key === 'Escape' || (e.key === 'ArrowLeft' && panel !== open.root && !typing)) {
    e.preventDefault();
    e.stopPropagation();
    if (panel === open.root) return closeMenu();
    closeFrom(panel);
    openers.get(panel)?.focus();
  } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    const by = e.key === 'ArrowDown' ? 1 : -1;
    rows[(at + by + rows.length) % rows.length]?.focus();
  } else if (e.key === 'ArrowRight' && at >= 0 && rows[at].classList.contains('has-sub')) {
    e.preventDefault();
    rows[at].click();
  } else if (e.key === 'Tab') {
    e.preventDefault();
  }
}

// Closes a panel and every submenu opened from it.
/** @param {HTMLElement} panel */
function closeFrom(panel) {
  if (!open) return;
  const i = open.panels.indexOf(panel);
  if (i < 0) return;
  for (const p of open.panels.splice(i)) p.remove();
}

/** @param {HTMLElement} panel */
function closeAfter(panel) {
  if (!open) return;
  const i = open.panels.indexOf(panel);
  for (const p of open.panels.splice(i + 1)) p.remove();
}

/** @param {MenuEntry[]} entries @param {number} depth @param {string} [search] */
function panelOf(entries, depth, search) {
  const panel = h('div', { class: 'popover menu', role: 'menu', 'data-depth': String(depth) });
  if (search) panel.append(searchField(panel, search));
  const list = entries.filter((e) => e);
  list.forEach((entry, i) => {
    if (entry === '-') {
      // No separator at the ends or twice in a row, so callers can add one around optional rows.
      const prev = list[i - 1];
      if (i > 0 && i < list.length - 1 && prev !== '-') panel.append(h('div', { class: 'menu-sep', role: 'separator' }));
      return;
    }
    const item = /** @type {MenuItem} */ (entry);
    const sub = item.items?.filter((x) => x);
    const lead = typeof item.icon === 'function' ? item.icon() : item.icon;
    const row = h('button', {
      type: 'button',
      class: ['menu-item', sub && 'has-sub', item.danger && 'danger'].filter(Boolean).join(' '),
      role: sub ? undefined : item.checked === undefined ? 'menuitem' : 'menuitemcheckbox',
      'aria-haspopup': sub ? 'menu' : undefined,
      'aria-checked': item.checked === undefined ? undefined : String(item.checked),
      disabled: sub && !sub.length ? true : undefined,
      onclick: () => {
        if (sub) return openSub(row, panel, sub, depth, item.search);
        closeMenu();
        item.onSelect?.();
      },
      onpointerenter: () => {
        // The search field keeps the focus, so typing still filters while the pointer is over the rows.
        if (document.activeElement?.parentElement !== panel || !document.activeElement.matches('.menu-search')) row.focus({ preventScroll: true });
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => (sub ? openSub(row, panel, sub, depth, item.search) : closeAfter(panel)), sub ? 120 : 200);
      },
    },
      h('span', { class: 'menu-lead' }, item.checked ? icon('check') : lead ?? null),
      h('span', { class: 'menu-label' }, item.label),
      item.hint ? h('span', { class: 'menu-hint' }, item.hint) : null,
      sub ? icon('chevron-right') : null);
    panel.append(row);
  });
  return panel;
}

// The field atop a searchable panel: hides the rows that do not match, and the separators while it filters. Enter
// picks the first row left.
/** @param {HTMLElement} panel @param {string} placeholder */
function searchField(panel, placeholder) {
  return h('input', {
    type: 'search',
    class: 'menu-search',
    placeholder,
    'aria-label': placeholder,
    /** @param {Event & { target: HTMLInputElement }} e */
    oninput: (e) => {
      const q = e.target.value.trim().toLowerCase();
      for (const row of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll(':scope > .menu-item'))) {
        row.hidden = !!q && !(row.querySelector('.menu-label')?.textContent ?? '').toLowerCase().includes(q);
      }
      for (const sep of /** @type {NodeListOf<HTMLElement>} */ (panel.querySelectorAll(':scope > .menu-sep'))) sep.hidden = !!q;
    },
    /** @param {KeyboardEvent} e */
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      rowsOf(panel)[0]?.click();
    },
  });
}

/** @param {HTMLElement} row @param {HTMLElement} parent @param {MenuEntry[]} entries @param {number} depth @param {string} [search] */
function openSub(row, parent, entries, depth, search) {
  if (!open) return;
  // Already open from this row: keep it.
  const next = open.panels[open.panels.indexOf(parent) + 1];
  if (next && openers.get(next) === row) return;
  closeAfter(parent);
  for (const r of parent.querySelectorAll('.menu-item.open')) r.classList.remove('open');
  row.classList.add('open');
  const panel = panelOf(entries, depth + 1, search);
  openers.set(panel, row);
  document.body.append(panel);
  open.panels.push(panel);
  const r = row.getBoundingClientRect();
  const p = parent.getBoundingClientRect();
  const w = panel.offsetWidth;
  const hgt = panel.offsetHeight;
  const right = p.right - 2;
  const x = right + w <= window.innerWidth - 8 ? right : Math.max(8, p.left - w + 2);
  const y = Math.max(8, Math.min(r.top - 5, window.innerHeight - hgt - 8));
  Object.assign(panel.style, { left: `${x}px`, top: `${y}px` });
  // Filtering shrinks the panel, so it keeps the top it opened at instead of being placed again.
  /** @type {HTMLElement | null} */ (panel.querySelector('.menu-search'))?.focus({ preventScroll: true });
}

// Opens a menu at a point (a right click) or under an element (a ⋯ button).
/** @param {MenuEntry[]} entries @param {{ x: number, y: number } | HTMLElement} at */
export function openMenu(entries, at) {
  closeMenu();
  const root = panelOf(entries, 0);
  document.body.append(root);
  open = { root, panels: [root], anchor: at instanceof HTMLElement ? at : null };
  const w = root.offsetWidth;
  const hgt = root.offsetHeight;
  let x;
  let y;
  if (at instanceof HTMLElement) {
    const r = at.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 4 + hgt > window.innerHeight ? r.top - 4 - hgt : r.bottom + 4;
  } else ({ x, y } = at);
  x = Math.max(8, Math.min(x, window.innerWidth - w - 8));
  y = Math.max(8, Math.min(y, window.innerHeight - hgt - 8));
  Object.assign(root.style, { left: `${x}px`, top: `${y}px` });
  rowsOf(root)[0]?.focus({ preventScroll: true });
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('blur', closeMenu);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('hashchange', closeMenu);
}

// A ⋯ button that opens the menu `build()` returns when it is pressed, so its rows read the state of that moment.
/** @param {{ title: string, className?: string, build: () => MenuEntry[] }} options */
export function menuButton({ title, className = 'icon-btn', build }) {
  const button = h('button', {
    type: 'button',
    class: className,
    title,
    'aria-label': title,
    'aria-haspopup': 'menu',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      // The button on screen: after a patched redraw it runs the handler of a fresh, never shown `button`.
      const anchor = /** @type {HTMLElement} */ (e.currentTarget);
      if (open?.anchor === anchor) return closeMenu();
      openMenu(build(), anchor);
    },
  }, icon('more'));
  return button;
}

// Opens `build()`'s menu on a right click of `el`, in place of the browser's.
/** @param {HTMLElement} el @param {() => MenuEntry[]} build */
export function onContextMenu(el, build) {
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openMenu(build(), { x: e.clientX, y: e.clientY });
  });
  return el;
}
