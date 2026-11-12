// Notifications: one list under the bell for deadlines, automated tasks, site checks, Telegram and pools.
// They are saved in notifications.json. Each kind can be switched off, or also sent to Telegram, in Settings.
import { h, icon, empty } from './ui.js';
import { COLLECTION, DEFAULTS, KINDS, prefOf, setPref, notify, unreadCount, checkDeadlines } from './notify-core.js';

export { COLLECTION, DEFAULTS, KINDS, prefOf, setPref, notify, unreadCount, checkDeadlines };

/** @import { Store, Notification, IconName } from '../types/data' */

/** @param {string} isoTime */
function when(isoTime) {
  const mins = Math.round((Date.now() - Date.parse(isoTime)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return isoTime.slice(0, 10);
}

/** @type {HTMLElement | null} */
let drawer = null;

function closeDrawer() {
  drawer?.remove();
  drawer = null;
  document.removeEventListener('keydown', onKey);
}
/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.key === 'Escape') closeDrawer();
}

// The panel that slides in from the right. It is redrawn in place when a notification is read.
/** @param {Store} store */
export function openNotifications(store) {
  closeDrawer();
  /** @param {string} kind @returns {IconName} */
  const iconOf = (kind) => KINDS.find(([k]) => k === kind)?.[2] ?? 'bell';
  const paint = () => {
    const { items } = store.get(COLLECTION);
    /** @param {Notification} n */
    const open = (n) => {
      store.update(COLLECTION, (d) => {
        const item = d.items.find((x) => x.id === n.id);
        if (item) item.read = true;
      });
      closeDrawer();
      if (n.href) location.hash = n.href;
    };
    panel.replaceChildren(
      h('header', { class: 'row between' },
        h('h2', null, 'Notifications'),
        h('div', { class: 'row' },
          h('button', {
            type: 'button',
            class: 'btn-small',
            disabled: !items.some((n) => !n.read),
            onclick: () => {
              store.update(COLLECTION, (d) => d.items.forEach((n) => (n.read = true)));
              paint();
            },
          }, 'Mark all read'),
          h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Close', onclick: closeDrawer }, icon('x')))),
      items.length
        ? h('ul', { class: 'notif-list' }, items.map((n) =>
            h('li', null,
              h('button', { type: 'button', class: n.read ? 'notif' : 'notif unread', onclick: () => open(n) },
                icon(iconOf(n.kind)),
                h('span', { class: 'grow' }, n.text, h('span', { class: 'muted small notif-when' }, when(n.at))),
                n.read ? null : h('span', { class: 'notif-dot', 'aria-label': 'Unread' })))))
        : empty('You are all caught up.'),
      h('div', { class: 'row between' },
        h('a', { href: '#/settings?section=notifications', class: 'btn-link', onclick: closeDrawer }, 'Choose what notifies you'),
        items.length
          ? h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                store.update(COLLECTION, (d) => {
                  d.items = [];
                });
                paint();
              },
            }, 'Clear all')
          : null));
  };
  const panel = h('aside', { class: 'drawer', role: 'dialog', 'aria-label': 'Notifications' });
  drawer = h('div', {
    class: 'drawer-overlay',
    /** @param {MouseEvent} e */
    onclick: (e) => {
      if (e.target === drawer) closeDrawer();
    },
  }, panel);
  paint();
  document.body.append(drawer);
  document.addEventListener('keydown', onKey);
  panel.querySelector('button')?.focus();
}

// The bell in the top bar, with the number of unread notifications.
/** @param {Store} store */
export function bell(store) {
  const n = unreadCount(store);
  return h('button', {
    type: 'button',
    class: 'icon-btn bell',
    title: 'Notifications',
    'aria-label': `Notifications, ${n} unread`,
    onclick: () => openNotifications(store),
  }, icon('bell'), n ? h('span', { class: 'bell-count' }, n > 99 ? '99+' : String(n)) : null);
}
