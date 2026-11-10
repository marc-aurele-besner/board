// Notifications: one list under the bell for deadlines, automated tasks, site checks, Telegram and pools.
// They are saved in notifications.json. Each kind can be switched off, or also sent to Telegram, in Settings.
import { h, icon, uid, now, todayISO, statusOf, empty } from './ui.js';
import { sendTelegram } from './telegram.js';

export const COLLECTION = 'notifications';
export const DEFAULTS = { items: [], prefs: {} };
const MAX_ITEMS = 200;

// [key, label in Settings, icon]
export const KINDS = [
  ['deadline', 'Task deadlines', 'clock'],
  ['auto', 'Automated tasks', 'zap'],
  ['health', 'Website health', 'globe'],
  ['ssl', 'SSL certificates and domains', 'shield'],
  ['telegram', 'Telegram messages', 'send'],
  ['pools', 'Liquidity Pools out of range', 'droplet'],
];

// A kind that was never changed shows in the board and is not sent to Telegram.
export const prefOf = (store, kind) => ({ app: true, telegram: false, ...(store.get(COLLECTION).prefs?.[kind] ?? {}) });

export function setPref(store, kind, patch) {
  store.update(COLLECTION, (d) => {
    d.prefs = { ...d.prefs, [kind]: { ...prefOf(store, kind), ...patch } };
  });
}

// Adds a notification. `key` names the event, so the same event is not announced twice.
export function notify(store, { kind, text, href = '', key = '' }) {
  const data = store.get(COLLECTION);
  if (key && data.items.some((n) => n.key === key)) return false;
  const pref = prefOf(store, kind);
  if (pref.app) {
    store.update(COLLECTION, (d) => {
      d.items.unshift({ id: uid(), kind, text, href, key, at: now(), read: false });
      d.items.length = Math.min(d.items.length, MAX_ITEMS);
    });
  }
  if (pref.telegram) sendTelegram(store, text).catch(() => {});
  return true;
}

export const unreadCount = (store) => store.get(COLLECTION).items.filter((n) => !n.read).length;

// Announces tasks whose deadline is today or has passed. Once per task and day.
export function checkDeadlines(store) {
  const today = todayISO();
  for (const t of store.get('todos').items) {
    if (!t.due || statusOf(t) === 'done' || t.due > today) continue;
    notify(store, {
      kind: 'deadline',
      text: t.due === today ? `“${t.text}” is due today.` : `“${t.text}” passed its deadline (${t.due}).`,
      href: '#/todos?filter=today',
      key: `deadline:${t.id}:${t.due === today ? today : 'late'}`,
    });
  }
}

function when(isoTime) {
  const mins = Math.round((Date.now() - Date.parse(isoTime)) / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} h ago`;
  return isoTime.slice(0, 10);
}

let drawer = null;

function closeDrawer() {
  drawer?.remove();
  drawer = null;
  document.removeEventListener('keydown', onKey);
}
function onKey(e) {
  if (e.key === 'Escape') closeDrawer();
}

// The panel that slides in from the right. It is redrawn in place when a notification is read.
export function openNotifications(store) {
  closeDrawer();
  const iconOf = (kind) => KINDS.find(([k]) => k === kind)?.[2] ?? 'bell';
  const paint = () => {
    const { items } = store.get(COLLECTION);
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
