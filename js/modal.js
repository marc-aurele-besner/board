// A simple modal dialog. Closes on Escape, on a click outside it, or with the close button.
import { h, icon } from './ui.js';

/** @import { Child } from '../types/ui' */

/** @param {{ title: string, body: Child, wide?: boolean }} options */
export function openDialog({ title, body, wide = false }) {
  const previous = /** @type {HTMLElement | null} */ (document.activeElement);
  /** @param {KeyboardEvent} e */
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey);
    previous?.focus?.();
  };
  const overlay = h('div', {
    class: 'modal-overlay',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      if (e.target === overlay) close();
    },
  },
    h('div', { class: wide ? 'modal wide' : 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('header', { class: 'modal-head' },
        h('h2', null, title),
        h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'modal-body' }, body)));

  document.body.append(overlay);
  document.addEventListener('keydown', onKey);
  /** @type {HTMLElement | null} */ (overlay.querySelector('input, select, button'))?.focus();
  return { close };
}
