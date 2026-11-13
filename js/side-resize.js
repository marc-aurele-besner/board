// A section's left panel with a width the user drags: a divider on its right edge, a double click puts the default
// back. Each section keeps its own width, remembered in this browser.
import { h } from './ui.js';

/** @typedef {{ def: number, min: number, max: number }} SideRange */

const KEY = 'board:side-widths';
// The center panel keeps at least this much room.
const MAIN_MIN = 360;

/** @type {Record<string, number> | null} */
let widths = null;

/** @returns {Record<string, number>} */
function all() {
  if (widths) return widths;
  widths = {};
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    if (saved && typeof saved === 'object') widths = saved;
  } catch {}
  return /** @type {Record<string, number>} */ (widths);
}

function remember() {
  try {
    localStorage.setItem(KEY, JSON.stringify(all()));
  } catch {}
}

/**
 * The section's width: saved, within its range, or the default.
 * @param {string} id
 * @param {SideRange} range
 */
function widthOf(id, range) {
  const v = all()[id];
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(range.max, Math.max(range.min, Math.round(v))) : range.def;
}

/** @param {HTMLElement} layout @param {number} w */
const apply = (layout, w) => layout.style.setProperty('--side-w', `${w}px`);

/**
 * Makes `layout`, a two-column grid whose first child is the side panel, resizable: sets its width and adds the divider.
 * A patched redraw keeps the elements on screen and hands them these handlers, so the handlers find the layout from
 * the event, never from this call.
 * @template {HTMLElement} T
 * @param {T} layout
 * @param {string} id what the width is saved under, one per section
 * @param {SideRange} range
 * @returns {T}
 */
export function resizableSide(layout, id, range) {
  layout.classList.add('side-resizable');
  apply(layout, widthOf(id, range));
  layout.append(h('div', {
    class: 'side-resize',
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': 'Resize the side panel',
    title: 'Drag to resize, double-click to reset',
    ondblclick: (/** @type {MouseEvent & { currentTarget: HTMLElement }} */ e) => {
      const parent = e.currentTarget.parentElement;
      if (parent) apply(parent, range.def);
      all()[id] = range.def;
      remember();
    },
    onpointerdown: (/** @type {PointerEvent & { currentTarget: HTMLElement }} */ e) => {
      const handle = e.currentTarget;
      const parent = handle.parentElement;
      if (e.button !== 0 || !parent) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = widthOf(id, range);
      const max = Math.max(range.min, Math.min(range.max, parent.clientWidth - MAIN_MIN));
      parent.classList.add('resizing');
      /** @param {PointerEvent} m */
      const move = (m) => {
        all()[id] = Math.round(Math.max(range.min, Math.min(max, start + m.clientX - startX)));
        apply(parent, all()[id]);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        parent.classList.remove('resizing');
        remember();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
  }));
  return layout;
}
