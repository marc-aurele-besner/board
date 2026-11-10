// Short messages at the bottom of the screen. One with `undo` offers to take the action back for a few seconds.
import { h } from './ui.js';

let box = null;

export function toast(text, { undo = null } = {}) {
  if (!box) {
    box = h('div', { class: 'toasts', 'aria-live': 'polite' });
    document.body.append(box);
  }
  const el = h('div', { class: 'toast' }, h('span', null, text));
  const remove = () => el.remove();
  if (undo) {
    el.append(h('button', {
      type: 'button',
      onclick: () => {
        remove();
        undo();
      },
    }, 'Undo'));
  }
  box.append(el);
  setTimeout(remove, undo ? 6000 : 3200);
}
