// Notifications without the DOM: the kinds, each kind's preferences, notify() and the deadline check. The bell and its
// drawer are in notifications.js; the runners load this file to notify from their jobs.
import { uid, now, todayISO, statusOf } from './ui.js';
import { sendTelegram } from './telegram.js';

/** @import { DataStore, IconName, NotificationPref } from '../types/data' */

export const COLLECTION = 'notifications';
export const DEFAULTS = { items: [], prefs: {} };
const MAX_ITEMS = 200;

// [key, label in Settings, icon]
/** @type {[string, string, IconName][]} */
export const KINDS = [
  ['deadline', 'Task deadlines', 'clock'],
  ['auto', 'Automated tasks', 'zap'],
  ['health', 'Website health', 'globe'],
  ['ssl', 'SSL certificates and domains', 'shield'],
  ['status', 'Provider outages and recoveries', 'activity'],
  ['telegram', 'Telegram messages', 'send'],
  ['notion', 'Tasks from Notion', 'notion'],
  ['pools', 'Liquidity Pools out of range', 'droplet'],
  ['lending', 'Aave health factor low', 'landmark'],
  ['budget', 'Budgets gone over', 'wallet'],
  ['cron', 'Cron flows', 'repeat'],
];

// A kind that was never changed shows in the board and is not sent to Telegram.
/** @param {DataStore} store @param {string} kind @returns {NotificationPref} */
export const prefOf = (store, kind) => ({ app: true, telegram: false, ...(/** @type {Partial<NotificationPref> | undefined} */ (store.get(COLLECTION).prefs?.[kind]) ?? {}) });

/** @param {DataStore} store @param {string} kind @param {Partial<NotificationPref>} patch */
export function setPref(store, kind, patch) {
  store.update(COLLECTION, (d) => {
    d.prefs = { ...d.prefs, [kind]: { ...prefOf(store, kind), ...patch } };
  });
}

// Adds a notification. `key` names the event, so the same event is not announced twice.
/** @param {DataStore} store @param {{ kind: string, text: string, href?: string, key?: string }} notification */
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

/** @param {DataStore} store */
export const unreadCount = (store) => store.get(COLLECTION).items.filter((n) => !n.read).length;

// Announces tasks whose deadline is today or has passed. Once per task and day.
/** @param {DataStore} store */
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

