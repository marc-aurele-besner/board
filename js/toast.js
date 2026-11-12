// Short messages at the bottom of the screen. One with `undo` offers to take the action back for a few seconds.
import { h } from './ui.js';

let box = null;

export function toast(text, { undo = null } = {}) {
  // The runners load shared modules that toast (a PR link added to a task by a Cron step); there is no page there.
  if (typeof document === 'undefined') return;
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
