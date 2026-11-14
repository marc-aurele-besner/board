// Slack: every workspace signed in with a browser session, in one sidebar, so there is no switching between them.
// Channels can be dragged into any order, gathered into groups, and tied to projects (one by one, by group, or a whole
// workspace). A muted channel stays where it is, dimmed and never counted as unread. Messages, threads and reactions
// are read live through the runners: the open conversation every few seconds, unread counts every 20 s.
import { h, icon, uid, notice, refreshIcon, codeBox, keepImages, steadyAnimations } from '../ui.js';
import { projectTree, projectIcon } from './projects.js';
import { pickButton, pickChip } from '../inline.js';
import { menuButton, onContextMenu, openMenu } from '../menu.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import { runnersOnline, runnersKnown } from '../runners.js';
import { markup } from '../slack-markup.js';
import { emojiChar } from '../emoji.js';
import { pickEmoji, frequentEmoji, rememberEmoji } from '../emoji-picker.js';
import { makeTask } from '../capture.js';
import { setAttention, slackMentions, mentionsOf } from '../attention.js';
import {
  SLACK, SLACK_DEFAULTS, keyOf, splitKey, addWorkspaces, listChannels, ensureUsers, readCounts, readHistory, readThread,
  postMessage, editMessage, deleteMessage, react, markRead, customEmoji, fileData, slackLink,
} from '../slack.js';
import { dateLocale } from '../locale.js';
import { removeWithUndo } from '../remove.js';
import { askBeforeRemoving } from '../appearance.js';
/** @import { Store, SlackData, SlackWorkspace, SlackChannel, SlackGroup, Project } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @import { MenuEntry } from '../menu.js' */
/** @import { Message, Count } from '../slack.js' */
/**
 * A sidebar section: a group, a workspace's channels outside groups, or a project's.
 * @typedef {{ id: string, kind: 'group' | 'team' | 'project', title: string, projectId: string | null, keys: string[],
 *   ws?: SlackWorkspace, group?: SlackGroup, project?: Project }} Section
 */

const HISTORY_MS = 5000;
const COUNTS_MS = 20000;
// Messages of one person within this many seconds share one header.
const SAME_AUTHOR_S = 5 * 60;

// View state. open: the conversation on screen ("<team>|<channel>"); thread: the ts of the thread beside it.
/** @type {{ open: string, thread: string, filter: string, unread: boolean, by: string }} */
const view = { open: '', thread: '', filter: '', unread: false, by: 'workspace' };
// The conversation last open in this browser, so coming back to Slack from another section (whose link carries no
// view) opens it again.
const OPEN_KEY = 'board:slack-open';
const KEY_RE = /^[A-Z0-9]+\|[A-Z0-9]+$/;
const TS_RE = /^\d+\.\d+$/;

function rememberOpen() {
  try {
    localStorage.setItem(OPEN_KEY, JSON.stringify({ c: view.open, t: view.thread }));
  } catch {}
}

/** @returns {{ c?: unknown, t?: unknown }} */
function lastOpen() {
  try {
    return JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}') ?? {};
  } catch {
    return {};
  }
}

// The sidebar's and the thread's widths, dragged by the dividers beside them and kept in this browser.
const WIDTHS_KEY = 'board:slack-widths';
const SIDE_W = { def: 240, min: 180, max: 480 };
const THREAD_W = { def: 380, min: 280, max: 900 };
// The conversation keeps at least this much room when the thread grows.
const MAIN_MIN = 320;
const widths = savedWidths();

/** @returns {{ side: number, thread: number }} */
function savedWidths() {
  /** @type {{ side?: unknown, thread?: unknown }} */
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(WIDTHS_KEY) ?? '{}') ?? {};
  } catch {}
  /** @param {unknown} v @param {{ def: number, min: number, max: number }} r */
  const pick = (v, r) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(r.max, Math.max(r.min, Math.round(v))) : r.def);
  return { side: pick(saved.side, SIDE_W), thread: pick(saved.thread, THREAD_W) };
}

function rememberWidths() {
  try {
    localStorage.setItem(WIDTHS_KEY, JSON.stringify(widths));
  } catch {}
}

/** @param {HTMLElement} layout */
function applyWidths(layout) {
  layout.style.setProperty('--slack-side-w', `${widths.side}px`);
  layout.style.setProperty('--slack-thread-w', `${widths.thread}px`);
}

/**
 * A divider that drags one pane's width; a double click puts it back to its default.
 * @param {'side' | 'thread'} which
 */
function resizer(which) {
  const range = which === 'side' ? SIDE_W : THREAD_W;
  const handle = h('div', {
    class: `slack-resize slack-resize-${which}`,
    role: 'separator',
    'aria-orientation': 'vertical',
    'aria-label': which === 'side' ? 'Resize the sidebar' : 'Resize the thread',
    title: 'Drag to resize, double-click to reset',
    ondblclick: () => {
      widths[which] = range.def;
      const layout = /** @type {HTMLElement | null} */ (handle.parentElement);
      if (layout) applyWidths(layout);
      rememberWidths();
    },
    onpointerdown: (/** @type {PointerEvent} */ e) => {
      if (e.button !== 0) return;
      const layout = /** @type {HTMLElement | null} */ (handle.parentElement);
      if (!layout) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      const startX = e.clientX;
      const start = widths[which];
      const total = layout.clientWidth;
      layout.classList.add('resizing');
      /** @param {PointerEvent} m */
      const move = (m) => {
        const dx = m.clientX - startX;
        // The thread sits on the right, so dragging its divider left widens it.
        const want = which === 'side' ? start + dx : start - dx;
        const other = which === 'side' ? (layout.classList.contains('with-thread') ? widths.thread : 0) : widths.side;
        const max = Math.min(range.max, total - other - MAIN_MIN);
        widths[which] = Math.round(Math.max(range.min, Math.min(max, want)));
        applyWidths(layout);
      };
      const up = () => {
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
        layout.classList.remove('resizing');
        rememberWidths();
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    },
  });
  return handle;
}

// What is read live. history and threads by "<team>|<channel>" and "<team>|<channel>|<ts>".
/**
 * @typedef {{ list: Message[], next: string, at: number, busy: boolean, error: string }} Feed
 */
const live = {
  /** @type {Map<string, Feed>} */
  history: new Map(),
  /** @type {Map<string, Feed>} */
  threads: new Map(),
  /** @type {Map<string, Map<string, Count>>} by team id */
  counts: new Map(),
  countsAt: 0,
  /** @type {Map<string, string>} by team id: what the last count or listing reported */
  errors: new Map(),
  /** @type {Set<string>} team ids whose channels were listed since the page loaded */
  listed: new Set(),
  /** @type {Map<string, Record<string, string>>} custom emoji by team id */
  emoji: new Map(),
  /** @type {Map<string, string>} session images by address, once read */
  images: new Map(),
  // Scroll of the message list per conversation: null when it sits at the bottom.
  /** @type {Map<string, number | null>} */
  scroll: new Map(),
  // Scroll of the sidebar's list, kept across redraws (unread counts redraw it every 20 s).
  sideScroll: 0,
  sending: false,
  /** @type {{ root: HTMLElement, store: Store } | null} */
  mounted: null,
  /** @type {ReturnType<typeof setInterval> | null} */
  timer: null,
  // Whether Escape (which drops the picked conversations) is listened for.
  keys: false,
};

const data = (/** @type {Store} */ store) => /** @type {SlackData} */ ({ ...SLACK_DEFAULTS, ...store.get(SLACK) });
/** @param {Store} store @param {string} team */
const workspaceOf = (store, team) => data(store).workspaces.find((w) => w.id === team) ?? null;
/** @param {Store} store @param {string} key */
function channelOf(store, key) {
  const [team, id] = splitKey(key);
  return (data(store).channels[team] ?? []).find((c) => c.id === id) ?? null;
}
/** @param {Store} store @param {string} team @param {string} id */
const userName = (store, team, id) => data(store).users[team]?.[id]?.name ?? id;

// The name a conversation goes by: #name, a person's name, or the people of a group message.
/** @param {Store} store @param {string} team @param {SlackChannel} c */
function nameOf(store, team, c) {
  if (c.kind === 'im') return c.user ? userName(store, team, c.user) : c.id;
  if (c.kind === 'mpim') return c.name.replace(/^mpdm-/, '').replace(/-\d+$/, '').split('--').join(', ');
  return c.name;
}

/** @param {SlackData} d @param {string} key */
const groupOf = (d, key) => d.groups.find((g) => g.items.includes(key)) ?? null;

// A channel's project: its own, else its group's, else its workspace's. '' saved on the channel means none.
/** @param {SlackData} d @param {string} key */
function projectOf(d, key) {
  if (key in d.projects) return d.projects[key] || null;
  const group = groupOf(d, key);
  if (group?.projectId) return group.projectId;
  return d.workspaces.find((w) => w.id === splitKey(key)[0])?.projectId ?? null;
}

const KIND_RANK = /** @type {Record<string, number>} */ ({ channel: 0, private: 0, mpim: 1, im: 2 });

// Dragged keys in their order first, then channels before direct messages, by name.
/** @param {Store} store @param {string[]} keys */
function sortKeys(store, keys) {
  const d = data(store);
  const at = new Map(d.order.map((k, i) => [k, i]));
  /** @param {string} k */
  const meta = (k) => {
    const c = channelOf(store, k);
    return { rank: KIND_RANK[c?.kind ?? 'channel'] ?? 0, name: c ? nameOf(store, splitKey(k)[0], c).toLowerCase() : k };
  };
  return [...keys].sort((a, b) => {
    const ia = at.get(a) ?? Infinity;
    const ib = at.get(b) ?? Infinity;
    if (ia !== ib) return ia - ib;
    const ma = meta(a);
    const mb = meta(b);
    return ma.rank - mb.rank || ma.name.localeCompare(mb.name);
  });
}

/** @param {Store} store */
const projectsOf = (store) => projectTree(store.get('projects').projects).map(({ project }) => project);

// The sidebar's sections, in order, each with its conversations sorted.
/** @param {Store} store @returns {Section[]} */
function sections(store) {
  const d = data(store);
  const all = d.workspaces.flatMap((w) => (d.channels[w.id] ?? []).map((c) => keyOf(w.id, c.id)));
  const exists = new Set(all);
  if (view.by === 'project') {
    const projects = projectsOf(store);
    /** @type {Map<string | null, string[]>} */
    const by = new Map();
    for (const k of all) {
      const p = projectOf(d, k);
      const id = p && projects.some((x) => x.id === p) ? p : null;
      by.set(id, [...(by.get(id) ?? []), k]);
    }
    /** @type {Section[]} */
    const out = projects.filter((p) => by.has(p.id)).map((p) => ({ id: `project:${p.id}`, kind: 'project', title: p.name, projectId: p.id, keys: sortKeys(store, by.get(p.id) ?? []), project: p }));
    if (by.has(null)) out.push({ id: 'project:', kind: 'project', title: 'No project', projectId: null, keys: sortKeys(store, by.get(null) ?? []) });
    return out;
  }
  const grouped = new Set(d.groups.flatMap((g) => g.items));
  return [
    ...d.groups.map((g) => /** @type {Section} */ ({ id: g.id, kind: 'group', title: g.name, projectId: g.projectId, keys: sortKeys(store, g.items.filter((k) => exists.has(k))), group: g })),
    ...d.workspaces.map((w) => /** @type {Section} */ ({ id: w.id, kind: 'team', title: w.name, projectId: w.projectId, keys: sortKeys(store, all.filter((k) => splitKey(k)[0] === w.id && !grouped.has(k))), ws: w })),
  ];
}

/** @param {string} key */
function countOf(key) {
  const [team, id] = splitKey(key);
  return live.counts.get(team)?.get(id) ?? null;
}
/** @param {Store} store @param {string} key */
const isMuted = (store, key) => data(store).muted.includes(key);
// Unread as the sidebar shows it: a muted conversation is never unread, though its mentions still count.
/** @param {Store} store @param {string} key */
function unreadOf(store, key) {
  const c = countOf(key);
  if (!c) return { unread: false, mentions: 0 };
  return { unread: c.unread && !isMuted(store, key), mentions: mentionsOf(splitKey(key)[1], c) };
}

// ---- reading ----------------------------------------------------------------------------------------------------

/** @param {Store} store */
async function refreshCounts(store) {
  live.countsAt = Date.now();
  await Promise.all(data(store).workspaces.filter((w) => !w.error).map(async (w) => {
    try {
      live.counts.set(w.id, await readCounts(w, store));
      live.errors.delete(w.id);
    } catch (err) {
      live.errors.set(w.id, /** @type {Error} */ (err).message);
    }
  }));
  paint('side');
}

/** @param {Store} store @param {SlackWorkspace} w @param {{ force?: boolean }} [options] */
async function relist(store, w, { force = false } = {}) {
  if (live.listed.has(w.id) && !force) return;
  live.listed.add(w.id);
  try {
    await listChannels(store, w);
  } catch (err) {
    live.errors.set(w.id, /** @type {Error} */ (err).message);
    paint('side');
  }
}

// Ids of the people a list of messages names: posters, repliers and <@mentions>.
/** @param {Message[]} list */
const peopleIn = (list) => list.flatMap((m) => [m.user, ...m.replyUsers, ...[...m.text.matchAll(/<@([UW][A-Z0-9]+)/g)].map((x) => x[1]), ...m.reactions.flatMap((r) => r.users.slice(0, 3))]);

// Newer pages replace what they cover; older messages already loaded stay.
/** @param {Message[]} old @param {Message[]} fresh @param {boolean} newest */
function mergeMessages(old, fresh, newest) {
  if (!old.length || !fresh.length) return fresh.length ? fresh : newest ? [] : old;
  const from = Number(fresh[0].ts);
  const to = Number(fresh[fresh.length - 1].ts);
  const kept = old.filter((m) => Number(m.ts) < from || (!newest && Number(m.ts) > to));
  return [...kept, ...fresh].sort((a, b) => Number(a.ts) - Number(b.ts));
}

/** @param {Store} store @param {string} key @param {{ older?: boolean }} [options] */
async function loadHistory(store, key, { older = false } = {}) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  if (!w || w.error) return;
  const feed = live.history.get(key) ?? { list: [], next: '', at: 0, busy: false, error: '' };
  if (feed.busy) return;
  feed.busy = true;
  live.history.set(key, feed);
  try {
    const page = await readHistory(w, channel, { cursor: older ? feed.next : '', limit: older ? 50 : 40 }, store);
    if (older) {
      feed.list = [...page.messages, ...feed.list];
      feed.next = page.next;
    } else {
      // The first read sets how far back "Load older" goes.
      if (!feed.at) feed.next = page.next;
      feed.list = mergeMessages(feed.list, page.messages, true);
    }
    feed.at = Date.now();
    feed.error = '';
    ensureUsers(store, w, peopleIn(page.messages)).catch(() => {});
    if (view.open === key && !document.hidden) markSeen(store, key);
  } catch (err) {
    feed.error = /** @type {Error} */ (err).message;
  } finally {
    feed.busy = false;
  }
  if (view.open === key) paint('main');
}

/** @param {Store} store @param {string} key @param {string} ts */
async function loadThread(store, key, ts) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  if (!w || w.error) return;
  const tkey = `${key}|${ts}`;
  const feed = live.threads.get(tkey) ?? { list: [], next: '', at: 0, busy: false, error: '' };
  if (feed.busy) return;
  feed.busy = true;
  live.threads.set(tkey, feed);
  try {
    feed.list = await readThread(w, channel, ts, store);
    feed.at = Date.now();
    feed.error = '';
    ensureUsers(store, w, peopleIn(feed.list)).catch(() => {});
  } catch (err) {
    feed.error = /** @type {Error} */ (err).message;
  } finally {
    feed.busy = false;
  }
  if (view.open === key && view.thread === ts) paint('thread');
}

// Marks the open conversation read in Slack once its newest message is on screen.
/** @param {Store} store @param {string} key */
function markSeen(store, key) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  const newest = live.history.get(key)?.list.at(-1)?.ts;
  const count = countOf(key);
  if (!w || !newest || (count && !count.unread && count.lastRead >= newest)) return;
  if (count) Object.assign(count, { unread: false, mentions: 0, lastRead: newest });
  else live.counts.get(team)?.set(channel, { unread: false, mentions: 0, latest: newest, lastRead: newest });
  markRead(w, channel, newest).catch(() => {});
  paint('side');
}

// The custom emoji of the workspaces on screen, once.
/** @param {SlackWorkspace} w */
function loadEmoji(w) {
  if (live.emoji.has(w.id)) return;
  live.emoji.set(w.id, {});
  customEmoji(w).then((map) => {
    live.emoji.set(w.id, map);
    paint('main');
    paint('thread');
  });
}

// One tick of the live reads, while the Slack tab is on screen and the page is visible.
function tick() {
  const m = live.mounted;
  if (!m || !m.root.isConnected) {
    if (live.timer) clearInterval(live.timer);
    live.timer = null;
    live.mounted = null;
    return;
  }
  if (document.hidden || !runnersOnline()) return;
  const { store } = m;
  if (Date.now() - live.countsAt >= COUNTS_MS) refreshCounts(store);
  if (view.open) {
    const feed = live.history.get(view.open);
    if (!feed || Date.now() - feed.at >= HISTORY_MS) loadHistory(store, view.open);
    if (view.thread) {
      const t = live.threads.get(`${view.open}|${view.thread}`);
      if (!t || Date.now() - t.at >= HISTORY_MS) loadThread(store, view.open, view.thread);
    }
  }
}

// ---- painting ---------------------------------------------------------------------------------------------------

// Redraws one part in place (the sidebar's list, the messages, the thread), so live reads keep the composer, its
// focus and the scroll. Falls back to nothing when the tab is not on screen.
/** @param {'side' | 'main' | 'thread'} part */
function paint(part) {
  const m = live.mounted;
  if (!m || !m.root.isConnected) return;
  if (part === 'side') {
    // The nav's Slack pill follows what this tab reads and marks read; before the first read it keeps its own.
    if (live.counts.size) setAttention('slack', slackMentions(m.store, live.counts));
    const old = m.root.querySelector('.slack-side-list');
    if (old) {
      const fresh = sideList(m.store);
      if (fresh.outerHTML === old.outerHTML) return;
      swap(old, fresh);
      fresh.scrollTop = live.sideScroll;
    }
    return;
  }
  const selector = part === 'main' ? '.slack-messages' : '.slack-thread-messages';
  const old = m.root.querySelector(selector);
  const fresh = part === 'main' ? messagesPane(m.store) : threadMessages(m.store);
  if (old && fresh) {
    // A live read that brought nothing new leaves the list as it is.
    if (fresh.outerHTML === old.outerHTML) return;
    swap(old, fresh);
    keepScroll(fresh, part === 'main' ? view.open : `${view.open}|${view.thread}`);
  } else if (!old !== !fresh) m.store.refresh();
}

// Replaces a part with its redrawn self, keeping the images already shown and the pulses in step.
/** @param {Element} old @param {Element} fresh */
function swap(old, fresh) {
  keepImages(old, fresh);
  old.replaceWith(fresh);
  steadyAnimations(fresh);
}

/** @param {Element} el @param {string} key */
function placeScroll(el, key) {
  const at = live.scroll.get(key);
  el.scrollTop = at === undefined || at === null ? el.scrollHeight : at;
}

// Puts a redrawn list back where it was: at the bottom when it was there, else at the same place.
/** @param {Element} el @param {string} key */
function keepScroll(el, key) {
  placeScroll(el, key);
  el.addEventListener('scroll', () => {
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    live.scroll.set(key, bottom ? null : el.scrollTop);
  });
}

/** @param {Store} store @param {string} key */
function openConversation(store, key) {
  view.open = key;
  view.thread = '';
  live.scroll.delete(key);
  store.refresh();
  loadHistory(store, key);
}

// ---- small parts ------------------------------------------------------------------------------------------------

/** @param {SlackWorkspace} w @param {string} [className] */
export function teamIcon(w, className = 'slack-team-icon') {
  return w.icon
    ? h('img', { class: className, src: w.icon, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: `${className} slack-initials` }, w.name.slice(0, 1).toUpperCase());
}

/** @param {string} name @param {string} avatar @param {string} [className] */
function avatar(name, avatar, className = 'slack-avatar') {
  return avatar
    ? h('img', { class: className, src: avatar, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: `${className} slack-initials` }, (name || '?').slice(0, 1).toUpperCase());
}

// A :name: as a character, a workspace's image, or as typed.
/** @param {string} team @param {string} name @returns {Child} */
function emojiNode(team, name) {
  const char = emojiChar(name);
  if (char) return h('span', { class: 'slack-emoji', title: `:${name}:` }, char);
  const map = live.emoji.get(team) ?? {};
  let src = map[name];
  // An alias names another emoji, standard or custom.
  for (let i = 0; i < 3 && src?.startsWith('alias:'); i++) {
    const target = src.slice(6);
    if (emojiChar(target)) return h('span', { class: 'slack-emoji', title: `:${name}:` }, emojiChar(target));
    src = map[target];
  }
  return src ? h('img', { class: 'slack-emoji-img', src, alt: `:${name}:`, title: `:${name}:`, loading: 'lazy' }) : `:${name}:`;
}

/** @param {string} ts */
const dateOf = (ts) => new Date(Number(ts) * 1000);
/** @param {string} ts */
const timeOf = (ts) => dateOf(ts).toLocaleTimeString(dateLocale(), { hour: '2-digit', minute: '2-digit' });
/** @param {string} ts */
function dayOf(ts) {
  const d = dateOf(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString(dateLocale(), { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
}

// A small dialog with one text field.
/** @param {{ title: string, label: string, value?: string, multiline?: boolean, action?: string, onSave: (value: string) => void | Promise<void> }} options */
function askText({ title, label, value = '', multiline = false, action = 'Save', onSave }) {
  const field = multiline
    ? h('textarea', { name: 'value', rows: 5, 'aria-label': label, value })
    : h('input', { name: 'value', type: 'text', 'aria-label': label, value });
  const form = h('form', {
    class: 'stack',
    onsubmit: async (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      const text = field.value.trim();
      if (!text) return;
      try {
        await onSave(text);
        dialog.close();
      } catch (err) {
        toast(/** @type {Error} */ (err).message);
      }
    },
  },
    h('label', { class: 'stack-sm' }, h('span', { class: 'small muted' }, label), field),
    h('div', { class: 'row end' }, h('button', { type: 'submit', class: 'primary' }, action)));
  const dialog = openDialog({ title, body: form });
  field.focus();
  if (!multiline) field.select();
}

// ---- layout changes ---------------------------------------------------------------------------------------------

// The store fills the top-level defaults when it reads slack.json, so every list is there.
/** @param {Store} store @param {(d: SlackData) => void} mutate */
const change = (store, mutate) => store.update(SLACK, mutate);

// Moves a conversation into a section, before another conversation or at its end.
/** @param {Store} store @param {string} key @param {Section} section @param {string | null} before */
function moveTo(store, key, section, before) {
  if (section.kind === 'team' && splitKey(key)[0] !== section.id) {
    toast('A conversation stays in its own workspace. Put it in a group to show it with another workspace’s.');
    return;
  }
  const keys = section.keys.filter((k) => k !== key);
  const at = before ? keys.indexOf(before) : -1;
  keys.splice(at < 0 ? keys.length : at, 0, key);
  change(store, (d) => {
    if (section.kind === 'group' || section.kind === 'team') {
      for (const g of d.groups) g.items = g.items.filter((k) => k !== key);
      if (section.kind === 'group') d.groups.find((g) => g.id === section.id)?.items.push(key);
    } else if (projectOf(d, key) !== section.projectId) {
      // Into a project's section: tied to it, or to none.
      d.projects[key] = section.projectId ?? '';
    }
    const inSection = new Set(keys);
    d.order = [...keys, ...d.order.filter((k) => !inSection.has(k))];
  });
}

/** @param {Store} store @param {string} key @param {Section} section @param {number} by */
function nudge(store, key, section, by) {
  const i = section.keys.indexOf(key);
  const j = i + by;
  if (i < 0 || j < 0 || j >= section.keys.length) return;
  const before = by < 0 ? section.keys[j] : section.keys[j + 1] ?? null;
  moveTo(store, key, section, before);
}

/** @param {Store} store @param {string} key */
function toggleMute(store, key) {
  const muted = isMuted(store, key);
  change(store, (d) => {
    d.muted = muted ? d.muted.filter((k) => k !== key) : [...d.muted, key];
  });
}

/** @param {Store} store @param {string[]} keys @param {string} [name] */
function newGroup(store, keys, name) {
  askText({
    title: 'New group',
    label: 'Name',
    value: name ?? '',
    action: 'Create',
    onSave: (text) => change(store, (d) => {
      for (const g of d.groups) g.items = g.items.filter((k) => !keys.includes(k));
      d.groups.push({ id: uid(), name: text, projectId: null, items: keys });
    }),
  });
}

/** @param {Store} store */
function projectOptions(store) {
  return projectsOf(store).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }));
}

// ---- sidebar ----------------------------------------------------------------------------------------------------

/** @param {string} text @param {string} what */
const copyText = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`), () => toast('Could not copy'));

// The Project submenu: every project with a tick on the one chosen, then none. `inherit` adds a row that drops the
// conversation's own choice, so it follows its group or workspace again.
/** @param {Store} store @param {string | null} current @param {(id: string) => void} set @param {{ checked: boolean, onSelect: () => void } | null} [inherit] */
function projectItems(store, current, set, inherit = null) {
  return /** @type {MenuEntry[]} */ ([
    ...projectsOf(store).map((p) => ({ label: p.name, icon: () => projectIcon(p), checked: current === p.id, onSelect: () => set(p.id) })),
    '-',
    { label: 'No project', checked: current === '', icon: () => icon('x'), onSelect: () => set('') },
    inherit ? { label: 'Follow group or workspace', checked: inherit.checked, icon: () => icon('undo'), onSelect: inherit.onSelect } : null,
  ]);
}

// Marks a conversation read up to its latest message, here and in Slack. The caller repaints.
/** @param {Store} store @param {string} key */
function markReadNow(store, key) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  const n = countOf(key);
  if (!w || !n?.latest) return;
  markRead(w, channel, n.latest).catch((err) => toast(err.message));
  Object.assign(n, { unread: false, mentions: 0, lastRead: n.latest });
}

// A conversation's menu, as Slack's: open and copy, read and mute, then where it sits (order, group, project).
/** @param {Store} store @param {string} key @param {Section} section @returns {MenuEntry[]} */
function itemMenu(store, key, section) {
  const d = data(store);
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  const c = channelOf(store, key);
  const name = c ? nameOf(store, team, c) : key;
  const group = groupOf(d, key);
  const muted = isMuted(store, key);
  const { unread, mentions } = unreadOf(store, key);
  const own = key in d.projects;
  const at = section.keys.indexOf(key);
  const link = w ? slackLink(w, channel) : '';
  return [
    { label: 'Open', icon: () => icon('message'), onSelect: () => openConversation(store, key) },
    w ? { label: 'Open in Slack', icon: () => icon('link'), onSelect: () => window.open(link, '_blank', 'noopener') } : null,
    { label: 'Copy', icon: () => icon('copy'), items: [
      { label: 'Copy name', onSelect: () => copyText(c?.kind === 'im' || c?.kind === 'mpim' ? name : `#${name}`, 'name') },
      w ? { label: 'Copy link', onSelect: () => copyText(link, 'link') } : null,
    ] },
    '-',
    { label: 'Mark as read', icon: () => icon('check'), onSelect: () => { if (unread || mentions) markReadNow(store, key); paint('side'); } },
    { label: muted ? 'Unmute conversation' : 'Mute conversation', icon: () => icon(muted ? 'bell' : 'bell-off'), onSelect: () => toggleMute(store, key) },
    '-',
    { label: 'Move', icon: () => icon('arrow-left-right'), items: [
      at > 0 ? { label: 'Up', icon: () => icon('arrow-up'), onSelect: () => nudge(store, key, section, -1) } : null,
      at >= 0 && at < section.keys.length - 1 ? { label: 'Down', icon: () => icon('arrow-down'), onSelect: () => nudge(store, key, section, 1) } : null,
      '-',
      ...d.groups.map((g) => ({
        label: g.name,
        icon: () => icon('folder'),
        checked: g === group,
        onSelect: () => {
          const target = sections(store).find((x) => x.id === g.id);
          if (target && g !== group) moveTo(store, key, target, null);
        },
      })),
      '-',
      { label: 'New group…', icon: () => icon('plus'), onSelect: () => newGroup(store, [key]) },
      group ? { label: `Take out of ${group.name}`, icon: () => icon('x'), onSelect: () => change(store, (dd) => { for (const g of dd.groups) g.items = g.items.filter((k) => k !== key); }) } : null,
    ] },
    { label: 'Project', icon: () => icon('folder'), search: 'Find a project', hint: own ? undefined : 'inherited', items: projectItems(
      store,
      own ? d.projects[key] : null,
      (id) => change(store, (dd) => { dd.projects[key] = id; }),
      { checked: !own, onSelect: () => change(store, (dd) => { delete dd.projects[key]; }) },
    ) },
  ];
}

// The menu of several conversations picked with Ctrl / Cmd or Shift: what itemMenu does, applied to each.
/** @param {Store} store @param {string[]} keys @returns {MenuEntry[]} */
function pickedMenu(store, keys) {
  const d = data(store);
  const allMuted = keys.every((k) => isMuted(store, k));
  const groups = keys.map((k) => groupOf(d, k));
  const owns = keys.map((k) => (k in d.projects ? d.projects[k] : null));
  // The project they all chose, null when none chose one, undefined when they differ.
  const same = owns.every((x) => x === owns[0]) ? owns[0] : undefined;
  /** @param {string} k */
  const label = (k) => {
    const c = channelOf(store, k);
    const name = c ? nameOf(store, splitKey(k)[0], c) : k;
    return c?.kind === 'im' || c?.kind === 'mpim' ? name : `#${name}`;
  };
  /** @param {string} k */
  const link = (k) => {
    const [team, channel] = splitKey(k);
    const w = workspaceOf(store, team);
    return w ? slackLink(w, channel) : '';
  };
  /** @param {(dd: SlackData) => void} mutate */
  const apply = (mutate) => { clearPicked(); change(store, mutate); };
  return [
    { label: `${keys.length} conversations`, hint: 'Esc clears', icon: () => icon('x'), onSelect: () => { clearPicked(); paint('side'); } },
    '-',
    { label: 'Copy', icon: () => icon('copy'), items: [
      { label: 'Copy names', onSelect: () => copyText(keys.map(label).join('\n'), 'names') },
      { label: 'Copy links', onSelect: () => copyText(keys.map(link).filter(Boolean).join('\n'), 'links') },
    ] },
    '-',
    { label: 'Mark as read', icon: () => icon('check'), onSelect: () => { for (const k of keys) markReadNow(store, k); clearPicked(); paint('side'); } },
    {
      label: allMuted ? 'Unmute conversations' : 'Mute conversations',
      icon: () => icon(allMuted ? 'bell' : 'bell-off'),
      onSelect: () => apply((dd) => {
        const rest = dd.muted.filter((k) => !keys.includes(k));
        dd.muted = allMuted ? rest : [...rest, ...keys];
      }),
    },
    '-',
    { label: 'Move', icon: () => icon('arrow-left-right'), items: [
      ...d.groups.map((g) => ({
        label: g.name,
        icon: () => icon('folder'),
        checked: groups.every((x) => x === g),
        onSelect: () => apply((dd) => {
          for (const x of dd.groups) x.items = x.items.filter((k) => !keys.includes(k));
          dd.groups.find((x) => x.id === g.id)?.items.push(...keys);
          // At the group's end, in the order they show.
          dd.order = [...dd.order.filter((k) => !keys.includes(k)), ...keys];
        }),
      })),
      '-',
      { label: 'New group…', icon: () => icon('plus'), onSelect: () => { clearPicked(); newGroup(store, keys); } },
      groups.some(Boolean) ? { label: 'Take out of groups', icon: () => icon('x'), onSelect: () => apply((dd) => { for (const g of dd.groups) g.items = g.items.filter((k) => !keys.includes(k)); }) } : null,
    ] },
    { label: 'Project', icon: () => icon('folder'), search: 'Find a project', hint: same === null ? 'inherited' : undefined, items: projectItems(
      store,
      same ?? null,
      (id) => apply((dd) => { for (const k of keys) dd.projects[k] = id; }),
      { checked: same === null, onSelect: () => apply((dd) => { for (const k of keys) delete dd.projects[k]; }) },
    ) },
  ];
}

/** @param {Store} store @param {Section} section */
const toggleFold = (store, section) => change(store, (d) => {
  d.collapsed = d.collapsed.includes(section.id) ? d.collapsed.filter((x) => x !== section.id) : [...d.collapsed, section.id];
});

// A section's menu: fold it, then a group's name, project, place and removal, or a workspace's project, listing and sign-in.
/** @param {Store} store @param {Section} section @returns {MenuEntry[]} */
function sectionMenu(store, section) {
  const folded = data(store).collapsed.includes(section.id);
  const fold = { label: folded ? 'Expand' : 'Collapse', icon: () => icon(folded ? 'chevron-down' : 'chevron-up'), onSelect: () => toggleFold(store, section) };
  if (section.kind === 'project') return [fold];
  if (section.kind === 'group') {
    const g = /** @type {SlackGroup} */ (section.group);
    const groups = data(store).groups;
    const i = groups.indexOf(g);
    /** @param {number} by */
    const swap = (by) => change(store, (d) => {
      const j = i + by;
      if (j < 0 || j >= d.groups.length) return;
      [d.groups[i], d.groups[j]] = [d.groups[j], d.groups[i]];
    });
    return [
      fold,
      { label: 'Rename…', icon: () => icon('pencil'), onSelect: () => askText({ title: 'Rename group', label: 'Name', value: g.name, onSave: (name) => change(store, (d) => { const x = d.groups.find((y) => y.id === g.id); if (x) x.name = name; }) }) },
      '-',
      { label: 'Move', icon: () => icon('arrow-left-right'), items: [
        i > 0 ? { label: 'Up', icon: () => icon('arrow-up'), onSelect: () => swap(-1) } : null,
        i < groups.length - 1 ? { label: 'Down', icon: () => icon('arrow-down'), onSelect: () => swap(1) } : null,
      ] },
      { label: 'Project', icon: () => icon('folder'), search: 'Find a project', items: projectItems(store, g.projectId ?? '', (id) => change(store, (d) => { const x = d.groups.find((y) => y.id === g.id); if (x) x.projectId = id || null; })) },
      '-',
      { label: 'Remove group', hint: 'keeps its channels', icon: () => icon('trash'), danger: true, onSelect: () => change(store, (d) => { d.groups = d.groups.filter((y) => y.id !== g.id); }) },
    ];
  }
  const w = /** @type {SlackWorkspace} */ (section.ws);
  return [
    fold,
    { label: 'Open in Slack', icon: () => icon('link'), onSelect: () => window.open(w.url || 'https://app.slack.com/', '_blank', 'noopener') },
    { label: 'Read its channels again', icon: () => icon('refresh'), onSelect: () => relist(store, w, { force: true }).then(() => toast(`${w.name}: channels read again.`)) },
    '-',
    { label: 'Project', icon: () => icon('folder'), search: 'Find a project', items: projectItems(store, w.projectId ?? '', (id) => change(store, (d) => { const x = d.workspaces.find((y) => y.id === w.id); if (x) x.projectId = id || null; })) },
    { label: 'Sign in again', icon: () => icon('key'), onSelect: () => openSignIn(store) },
    '-',
    { label: 'Remove workspace…', icon: () => icon('trash'), danger: true, onSelect: () => confirmRemove(store, w) },
  ];
}

/** @param {Store} store @param {SlackWorkspace} w */
export function confirmRemove(store, w) {
  const remove = () => {
    const prefix = `${w.id}|`;
    if (view.open.startsWith(prefix)) view.open = '';
    change(store, (d) => {
      d.workspaces = d.workspaces.filter((x) => x.id !== w.id);
      delete d.channels[w.id];
      delete d.users[w.id];
      d.muted = d.muted.filter((k) => !k.startsWith(prefix));
      d.order = d.order.filter((k) => !k.startsWith(prefix));
      d.collapsed = d.collapsed.filter((k) => k !== w.id);
      for (const k of Object.keys(d.projects)) if (k.startsWith(prefix)) delete d.projects[k];
      for (const g of d.groups) g.items = g.items.filter((k) => !k.startsWith(prefix));
    });
  };
  // With Appearance's "Ask before removing" off: at once, with Undo.
  if (!askBeforeRemoving()) {
    removeWithUndo(store, { ask: '', done: `Removed ${w.name}`, collections: ['slack'], run: remove });
    return;
  }
  const dialog = openDialog({
    title: `Remove ${w.name}?`,
    body: h('div', { class: 'stack' },
      h('p', null, 'Its session, channel list, mutes and order are removed from the board. Your Slack account is not changed.'),
      h('div', { class: 'row end' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: () => {
            dialog.close();
            remove();
          },
        }, 'Remove'))),
  });
}

// Where a drag is: the conversation being dragged.
let dragging = '';

// The conversations picked with Ctrl / Cmd (one at a time) or Shift (a range from the last one picked), whose menu
// acts on all of them. A plain click drops them.
/** @type {Set<string>} */
const picked = new Set();
let pickedFrom = '';
const clearPicked = () => { picked.clear(); pickedFrom = ''; };
// On a Mac, Ctrl + click is a right click: it comes as a contextmenu event with the main button.
const IS_MAC = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform);

// Picks or unpicks one conversation; with `range`, every conversation shown from the last one picked to it.
/** @param {string} key @param {boolean} range */
function pick(key, range) {
  // The open conversation is picked too when picking starts, as in Slack.
  if (!picked.size && view.open && view.open !== key) { picked.add(view.open); pickedFrom = view.open; }
  const shown = [...(live.mounted?.root.querySelectorAll('.slack-side-list .slack-item[data-key]') ?? [])]
    .map((el) => /** @type {HTMLElement} */ (el).dataset.key ?? '');
  const a = shown.indexOf(pickedFrom);
  const b = shown.indexOf(key);
  if (range && a >= 0 && b >= 0) {
    for (const k of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) picked.add(k);
  } else {
    if (picked.has(key)) picked.delete(key);
    else picked.add(key);
    pickedFrom = key;
  }
  paint('side');
}

// A row's menu: of every picked conversation when it is one of them, else its own (and the picks are dropped).
/** @param {Store} store @param {string} key @param {Section} section @returns {MenuEntry[]} */
function rowMenu(store, key, section) {
  const keys = [...picked].filter((k) => channelOf(store, k));
  if (picked.has(key) && keys.length > 1) return pickedMenu(store, keys);
  if (picked.size) { clearPicked(); paint('side'); }
  return itemMenu(store, key, section);
}

/** @param {Store} store @param {string} key @param {Section} section @param {boolean} multi */
function sideItem(store, key, section, multi) {
  const [team] = splitKey(key);
  const w = workspaceOf(store, team);
  const c = channelOf(store, key);
  if (!w || !c) return null;
  const name = nameOf(store, team, c);
  const { unread, mentions } = unreadOf(store, key);
  const muted = isMuted(store, key);
  const person = c.kind === 'im' && c.user ? data(store).users[team]?.[c.user] : null;
  const glyph = c.kind === 'im'
    ? avatar(name, person?.avatar ?? '', 'slack-item-avatar')
    : h('span', { class: 'slack-item-glyph' }, icon(c.kind === 'private' ? 'lock' : c.kind === 'mpim' ? 'users' : 'hash'));
  const cls = ['slack-item', view.open === key && 'active', picked.has(key) && 'picked', unread && 'unread', muted && 'muted'].filter(Boolean).join(' ');
  const row = h('div', {
    class: cls,
    draggable: 'true',
    'data-key': key,
    ondragstart: (/** @type {DragEvent} */ e) => {
      dragging = key;
      e.dataTransfer?.setData('text/plain', key);
      if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
    },
    ondragend: () => { dragging = ''; },
    ondragover: (/** @type {DragEvent} */ e) => {
      if (!dragging || dragging === key) return;
      e.preventDefault();
      /** @type {HTMLElement} */ (e.currentTarget).classList.add('drop-before');
    },
    ondragleave: (/** @type {DragEvent} */ e) => /** @type {HTMLElement} */ (e.currentTarget).classList.remove('drop-before'),
    ondrop: (/** @type {DragEvent} */ e) => {
      e.preventDefault();
      e.stopPropagation();
      const moved = dragging || e.dataTransfer?.getData('text/plain') || '';
      dragging = '';
      if (moved && moved !== key) moveTo(store, moved, section, key);
    },
  },
    h('button', {
      type: 'button',
      class: 'slack-item-open',
      title: `${name} · ${w.name}${muted ? ' · muted' : ''}`,
      onclick: (/** @type {MouseEvent} */ e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) {
          e.preventDefault();
          pick(key, e.shiftKey);
          return;
        }
        if (picked.size) { clearPicked(); paint('side'); }
        openConversation(store, key);
      },
    },
      // A workspace's own section says which workspace; groups and projects mix them.
      multi && section.kind !== 'team' ? teamIcon(w, 'slack-item-team') : null,
      glyph,
      h('span', { class: 'slack-item-name' }, name),
      muted ? h('span', { class: 'slack-item-muted', title: 'Muted' }, icon('bell-off')) : null,
      mentions ? h('span', { class: muted ? 'slack-badge muted' : 'slack-badge' }, String(mentions)) : null),
    menuButton({ title: 'More', className: 'icon-btn slack-item-menu', build: () => rowMenu(store, key, section) }));
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (IS_MAC && e.ctrlKey && e.button === 0) pick(key, false);
    else openMenu(rowMenu(store, key, section), { x: e.clientX, y: e.clientY });
  });
  return row;
}

/** @param {Store} store */
function sideList(store) {
  const d = data(store);
  const multi = d.workspaces.length > 1;
  const words = view.filter.trim().toLowerCase();
  /** @param {string} key */
  const shown = (key) => {
    if (key === view.open) return true;
    if (view.unread) {
      const u = unreadOf(store, key);
      if (!u.unread && !u.mentions) return false;
    }
    if (!words) return true;
    const c = channelOf(store, key);
    return c ? nameOf(store, splitKey(key)[0], c).toLowerCase().includes(words) : false;
  };
  const list = sections(store).map((s) => {
    const keys = s.keys.filter(shown);
    if ((words || view.unread) && !keys.length) return null;
    const folded = d.collapsed.includes(s.id) && !words && !view.unread;
    const unreadCount = s.keys.filter((k) => unreadOf(store, k).unread).length;
    const mentionCount = s.keys.reduce((n, k) => n + unreadOf(store, k).mentions, 0);
    const project = s.projectId ? projectsOf(store).find((p) => p.id === s.projectId) : null;
    const error = s.kind === 'team' ? (s.ws?.error || live.errors.get(s.id) || '') : '';
    return h('section', {
      class: 'slack-section',
      ondragover: (/** @type {DragEvent} */ e) => { if (dragging) e.preventDefault(); },
      ondrop: (/** @type {DragEvent} */ e) => {
        e.preventDefault();
        const moved = dragging || e.dataTransfer?.getData('text/plain') || '';
        dragging = '';
        if (moved) moveTo(store, moved, s, null);
      },
    },
      onContextMenu(h('div', { class: 'slack-section-head' },
        h('button', {
          type: 'button',
          class: 'slack-section-toggle',
          'aria-expanded': String(!folded),
          onclick: () => toggleFold(store, s),
        },
          icon(folded ? 'chevron-right' : 'chevron-down'),
          s.kind === 'team' && s.ws ? teamIcon(s.ws) : s.project ? projectIcon(s.project) : s.kind === 'group' ? icon('folder') : null,
          h('span', { class: 'slack-section-title' }, s.title),
          project && s.kind !== 'project' ? h('span', { class: 'slack-section-project', title: `Tied to ${project.name}` }, projectIcon(project), project.name) : null,
          mentionCount
            ? h('span', { class: 'slack-badge', title: `${mentionCount} ${mentionCount === 1 ? 'mention' : 'mentions'}` }, String(mentionCount))
            : folded && unreadCount ? h('span', { class: 'slack-badge soft' }, String(unreadCount)) : null),
        menuButton({ title: s.kind === 'group' ? 'Group' : s.kind === 'team' ? 'Workspace' : 'Section', className: 'icon-btn slack-item-menu', build: () => sectionMenu(store, s) })),
      () => sectionMenu(store, s)),
      error ? h('p', { class: 'slack-section-error small' }, icon('alert'), error) : null,
      folded ? null : h('div', { class: 'slack-section-items' },
        keys.length ? keys.map((k) => sideItem(store, k, s, multi)) : h('p', { class: 'muted small slack-drop-hint' }, s.kind === 'group' ? 'Drag channels here.' : live.listed.has(s.id) ? 'No conversations.' : 'Reading…')));
  }).filter(Boolean);
  return h('div', {
    class: 'slack-side-list',
    onscroll: (/** @type {Event} */ e) => { live.sideScroll = /** @type {HTMLElement} */ (e.target).scrollTop; },
  }, list.length ? list : h('p', { class: 'muted small' }, words || view.unread ? 'Nothing matches.' : 'No conversations yet.'));
}

/** @param {Store} store */
function sidebar(store) {
  return h('aside', { class: 'slack-side' },
    h('div', { class: 'slack-side-tools' },
      h('input', {
        type: 'search',
        class: 'slack-filter',
        placeholder: 'Find a conversation',
        'aria-label': 'Find a conversation',
        value: view.filter,
        oninput: (/** @type {Event} */ e) => {
          view.filter = /** @type {HTMLInputElement} */ (e.target).value;
          paint('side');
        },
      }),
      h('div', { class: 'row slack-side-row' },
        h('div', { class: 'segmented', role: 'group', 'aria-label': 'Group by' },
          [['workspace', 'Workspaces'], ['project', 'Projects']].map(([k, label]) => h('button', {
            type: 'button',
            class: view.by === k ? 'seg active' : 'seg',
            'aria-pressed': String(view.by === k),
            onclick: () => { view.by = k; store.refresh(); },
          }, label))),
        h('button', {
          type: 'button',
          class: view.unread ? 'btn-small active' : 'btn-small',
          'aria-pressed': String(view.unread),
          title: 'Only conversations with something unread',
          onclick: () => { view.unread = !view.unread; store.refresh(); },
        }, 'Unread'),
        pickButton({
          label: '',
          title: 'Add',
          className: 'icon-btn',
          options: [
            { value: 'workspace', label: 'Add workspaces', plainIcon: () => icon('plus') },
            { value: 'group', label: 'New group', plainIcon: () => icon('folder') },
            { value: 'counts', label: 'Read unread counts now', plainIcon: () => icon('refresh') },
          ],
          onPick: (/** @type {string} */ v) => {
            if (v === 'workspace') openSignIn(store);
            else if (v === 'group') newGroup(store, []);
            else refreshCounts(store);
          },
        }))),
    sideList(store));
}

// ---- messages ---------------------------------------------------------------------------------------------------

/** @param {Store} store @param {string} team */
const markupContext = (store, team) => ({
  user: (/** @type {string} */ id) => userName(store, team, id),
  me: workspaceOf(store, team)?.userId ?? '',
  emoji: (/** @type {string} */ name) => emojiNode(team, name),
});

// An image Slack keeps behind the session, read through the runners once and then shown.
/** @param {SlackWorkspace} w @param {string} url @param {string} alt */
function sessionImage(w, url, alt) {
  const ready = live.images.get(url);
  const img = h('img', { class: 'slack-file-image', alt, loading: 'lazy', src: ready || null });
  if (!ready) {
    fileData(w, url).then((src) => {
      if (!src) return void img.replaceWith(h('span', { class: 'muted small' }, alt));
      live.images.set(url, src);
      img.src = src;
    });
  }
  return img;
}

// The reaction picker, with the workspace's own emoji. Picking one already there as mine takes it off, as in Slack.
/** @param {Store} store @param {string} key @param {Message} m @param {SlackWorkspace} w */
function pickReaction(store, key, m, w) {
  pickEmoji({
    custom: Object.keys(live.emoji.get(w.id) ?? {}),
    render: (name) => emojiNode(w.id, name),
    onPick: (name) => toggleReaction(store, key, m, !m.reactions.find((r) => r.name === name)?.users.includes(w.userId), name),
  });
}

/** @param {Store} store @param {string} key @param {Message} m @param {boolean} on @param {string} name */
async function toggleReaction(store, key, m, on, name) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  if (!w) return;
  // Shown at once, then read again.
  const r = m.reactions.find((x) => x.name === name);
  if (on) {
    rememberEmoji(name);
    if (r) { r.users.push(w.userId); r.count++; } else m.reactions.push({ name, users: [w.userId], count: 1 });
  } else if (r) {
    r.users = r.users.filter((u) => u !== w.userId);
    r.count--;
    if (r.count <= 0) m.reactions = m.reactions.filter((x) => x !== r);
  }
  paint('main');
  paint('thread');
  try {
    await react(w, channel, m.ts, name, on);
  } catch (err) {
    toast(/** @type {Error} */ (err).message);
  }
  loadHistory(store, key);
  if (view.thread) loadThread(store, key, view.thread);
}

/** @param {Store} store @param {string} key @param {Message} m */
function editDialog(store, key, m) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  if (!w) return;
  askText({
    title: 'Edit message',
    label: 'Message',
    value: m.text.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&'),
    multiline: true,
    onSave: async (text) => {
      await editMessage(w, channel, m.ts, withMentions(store, team, text));
      loadHistory(store, key);
      if (view.thread) loadThread(store, key, view.thread);
    },
  });
}

/** @param {Store} store @param {string} key @param {Message} m */
function deleteDialog(store, key, m) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  if (!w) return;
  const dialog = openDialog({
    title: 'Delete message?',
    body: h('div', { class: 'stack' },
      h('p', null, 'It is deleted in Slack for everyone.'),
      h('div', { class: 'row end' },
        h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
        h('button', {
          type: 'button',
          class: 'danger',
          onclick: async () => {
            dialog.close();
            try {
              await deleteMessage(w, channel, m.ts);
              const feed = live.history.get(key);
              if (feed) feed.list = feed.list.filter((x) => x.ts !== m.ts);
              const t = live.threads.get(`${key}|${view.thread}`);
              if (t) t.list = t.list.filter((x) => x.ts !== m.ts);
              paint('main');
              paint('thread');
            } catch (err) {
              toast(/** @type {Error} */ (err).message);
            }
          },
        }, 'Delete'))),
  });
}

// A message's text as read: mentions as @names, links as their labels, Slack's escapes undone.
/** @param {Store} store @param {string} team @param {string} text */
function plainText(store, team, text) {
  return text
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_, id) => `@${userName(store, team, id)}`)
    .replace(/<!(here|channel|everyone)[^>]*>/g, '@$1')
    .replace(/<#[A-Z0-9]+\|([^>]*)>/g, '#$1')
    .replace(/<([^|>]+)\|([^>]+)>/g, '$2')
    .replace(/<([^>]+)>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

// A task from a message: its first line as the title, the whole text and its link below, in the conversation's project.
/** @param {Store} store @param {string} key @param {Message} m */
function messageTask(store, key, m) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  const text = plainText(store, team, m.text).trim();
  const first = text.split('\n').find((l) => l.trim())?.trim() ?? '';
  const title = first.length > 120 ? `${first.slice(0, 119)}…` : first || 'Slack message';
  const description = [text, w ? slackLink(w, channel, m.ts) : ''].filter(Boolean).join('\n\n');
  store.update('todos', (d) => d.items.push(makeTask({ text: title, description, projectId: projectOf(data(store), key) })));
  toast(`Task added: ${title}`);
}

// A message's menu on a right click, as Slack's: react, reply, a task, copy and open, then edit and delete.
/** @param {Store} store @param {string} key @param {Message} m @param {boolean} inThread @returns {MenuEntry[]} */
function messageMenu(store, key, m, inThread) {
  const [team, channel] = splitKey(key);
  const w = /** @type {SlackWorkspace} */ (workspaceOf(store, team));
  const mine = m.user === w.userId;
  const link = slackLink(w, channel, m.ts);
  const reacted = (/** @type {string} */ n) => Boolean(m.reactions.find((r) => r.name === n)?.users.includes(w.userId));
  return [
    { label: 'Add reaction', icon: () => icon('smile'), items: [
      ...frequentEmoji(5).map((n) => ({ label: `:${n}:`, icon: () => emojiNode(team, n), hint: reacted(n) ? 'added' : undefined, onSelect: () => toggleReaction(store, key, m, !reacted(n), n) })),
      '-',
      { label: 'More reactions…', icon: () => icon('smile'), onSelect: () => pickReaction(store, key, m, w) },
    ] },
    inThread ? null : { label: m.replyCount ? 'View thread' : 'Reply in thread', icon: () => icon('message'), onSelect: () => openThread(store, m.ts) },
    { label: 'Add to tasks', icon: () => icon('check-square'), onSelect: () => messageTask(store, key, m) },
    '-',
    m.text ? { label: 'Copy text', icon: () => icon('copy'), onSelect: () => copyText(plainText(store, team, m.text), 'text') } : null,
    { label: 'Copy link', icon: () => icon('copy'), onSelect: () => copyText(link, 'link') },
    { label: 'Open in Slack', icon: () => icon('link'), onSelect: () => window.open(link, '_blank', 'noopener') },
    mine ? '-' : null,
    mine ? { label: 'Edit message', icon: () => icon('pencil'), onSelect: () => editDialog(store, key, m) } : null,
    mine ? { label: 'Delete message…', icon: () => icon('trash'), danger: true, onSelect: () => deleteDialog(store, key, m) } : null,
  ];
}

const SYSTEM = /^(channel_join|channel_leave|group_join|group_leave|channel_topic|channel_purpose|channel_name|pinned_item|bot_add|bot_remove)$/;

/** @param {Store} store @param {string} key @param {Message} m @param {{ compact: boolean, inThread: boolean }} options */
function messageRow(store, key, m, { compact, inThread }) {
  const [team, channel] = splitKey(key);
  const w = /** @type {SlackWorkspace} */ (workspaceOf(store, team));
  const person = data(store).users[team]?.[m.user];
  const name = person?.name || m.username || (m.user ? m.user : 'Slack');
  const mine = m.user === w.userId;
  const ctx = markupContext(store, team);
  if (SYSTEM.test(m.subtype)) {
    return h('div', { class: 'slack-msg system', 'data-ts': m.ts },
      h('span', { class: 'slack-time', title: dateOf(m.ts).toLocaleString(dateLocale()) }, timeOf(m.ts)),
      h('span', { class: 'muted small' }, markup(m.text, ctx)));
  }
  const reactions = m.reactions.length
    ? h('div', { class: 'slack-reactions' },
        m.reactions.map((r) => {
          const on = r.users.includes(w.userId);
          return h('button', {
            type: 'button',
            class: on ? 'slack-reaction mine' : 'slack-reaction',
            title: `${r.users.map((u) => userName(store, team, u)).join(', ')} reacted with :${r.name}:`,
            'aria-pressed': String(on),
            onclick: () => toggleReaction(store, key, m, !on, r.name),
          }, emojiNode(team, r.name), h('span', null, String(r.count)));
        }),
        h('button', { type: 'button', class: 'slack-reaction add', title: 'Add a reaction', 'aria-label': 'Add a reaction', onclick: () => pickReaction(store, key, m, w) }, icon('smile')))
    : null;
  const thread = !inThread && m.replyCount
    ? h('button', { type: 'button', class: 'slack-thread-link', onclick: () => openThread(store, m.ts) },
        h('span', { class: 'slack-thread-faces' }, m.replyUsers.slice(0, 4).map((u) => avatar(userName(store, team, u), data(store).users[team]?.[u]?.avatar ?? '', 'slack-face'))),
        h('strong', null, `${m.replyCount} ${m.replyCount === 1 ? 'reply' : 'replies'}`),
        m.latestReply ? h('span', { class: 'muted' }, `Last reply ${dayOf(m.latestReply).toLowerCase() === 'today' ? timeOf(m.latestReply) : dayOf(m.latestReply)}`) : null)
    : null;
  const files = m.files.length
    ? h('div', { class: 'slack-files' }, m.files.map((f) => f.image
        ? h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer', class: 'slack-file-thumb', title: f.name }, sessionImage(w, f.thumb, f.name))
        : h('a', { href: f.link, target: '_blank', rel: 'noopener noreferrer', class: 'slack-file' }, icon('file'), f.name)))
    : null;
  const attachments = m.attachments.length
    ? m.attachments.map((a) => h('div', { class: 'slack-attachment', style: a.color ? { '--c': a.color } : null },
        a.title ? (a.link ? h('a', { href: a.link, target: '_blank', rel: 'noopener noreferrer', class: 'slack-attachment-title' }, a.title) : h('strong', null, a.title)) : null,
        a.text ? markup(a.text, ctx) : null,
        a.image && /^https:/.test(a.image) ? h('img', { class: 'slack-attachment-image', src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' }) : null))
    : null;
  const actions = h('div', { class: 'slack-msg-actions' },
    // Like Slack: the three emoji I react with most, then the picker.
    frequentEmoji(3).map((n) => h('button', { type: 'button', class: 'icon-btn', title: `React :${n}:`, 'aria-label': `React :${n}:`, onclick: () => toggleReaction(store, key, m, !m.reactions.find((r) => r.name === n)?.users.includes(w.userId), n) }, emojiNode(team, n))),
    h('button', { type: 'button', class: 'icon-btn', title: 'Add a reaction', 'aria-label': 'Add a reaction', onclick: () => pickReaction(store, key, m, w) }, icon('smile')),
    inThread ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Reply in thread', 'aria-label': 'Reply in thread', onclick: () => openThread(store, m.ts) }, icon('message')),
    mine ? h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', onclick: () => editDialog(store, key, m) }, icon('pencil')) : null,
    mine ? h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', onclick: () => deleteDialog(store, key, m) }, icon('trash')) : null,
    h('a', { class: 'icon-btn', href: slackLink(w, channel, m.ts), target: '_blank', rel: 'noopener noreferrer', title: 'Open in Slack', 'aria-label': 'Open in Slack' }, icon('link')));
  const row = h('div', { class: compact ? 'slack-msg compact' : 'slack-msg', 'data-ts': m.ts },
    compact
      ? h('span', { class: 'slack-time slack-gutter', title: dateOf(m.ts).toLocaleString(dateLocale()) }, timeOf(m.ts))
      : avatar(name, person?.avatar || m.avatar),
    h('div', { class: 'slack-msg-body' },
      compact ? null : h('div', { class: 'slack-msg-meta' },
        h('strong', null, name),
        person?.bot || (!m.user && m.username) ? h('span', { class: 'pill tone-plain' }, 'App') : null,
        h('span', { class: 'slack-time', title: dateOf(m.ts).toLocaleString(dateLocale()) }, timeOf(m.ts))),
      m.text ? markup(m.text, ctx) : null,
      m.edited ? h('span', { class: 'muted small' }, '(edited)') : null,
      files,
      attachments,
      reactions,
      thread),
    actions);
  // The browser's own menu stays on a link, an image or selected text, to open or copy them.
  row.addEventListener('contextmenu', (e) => {
    const target = /** @type {Element} */ (e.target);
    if (target.closest('a, img, .slack-msg-actions') || String(getSelection() ?? '').trim()) return;
    e.preventDefault();
    openMenu(messageMenu(store, key, m, inThread), { x: e.clientX, y: e.clientY });
  });
  return row;
}

// Messages with a day line between days and one header per run of the same person.
/** @param {Store} store @param {string} key @param {Message[]} list @param {boolean} inThread */
function messageRows(store, key, list, inThread) {
  /** @type {Child[]} */
  const out = [];
  /** @type {Message | null} */
  let prev = null;
  for (const m of list) {
    const day = dayOf(m.ts);
    if (!prev || dayOf(prev.ts) !== day) out.push(h('div', { class: 'slack-day' }, h('span', null, day)));
    const compact = Boolean(prev && dayOf(prev.ts) === day && prev.user === m.user && prev.user && !SYSTEM.test(prev.subtype) &&
      Number(m.ts) - Number(prev.ts) < SAME_AUTHOR_S && !(inThread && prev === list[0]));
    out.push(messageRow(store, key, m, { compact, inThread }));
    prev = m;
  }
  return out;
}

/** @param {Store} store */
function messagesPane(store) {
  if (!view.open) return null;
  const feed = live.history.get(view.open);
  return h('div', { class: 'slack-messages', role: 'log', 'aria-live': 'polite' },
    feed?.next ? h('div', { class: 'slack-older' }, h('button', { type: 'button', class: 'btn-small', disabled: feed.busy, onclick: () => loadHistory(store, view.open, { older: true }) }, 'Load older messages')) : null,
    feed?.error ? notice({ text: feed.error }) : null,
    !feed || (!feed.at && !feed.error)
      ? h('p', { class: 'muted small slack-loading' }, 'Reading messages…')
      : feed.list.length ? messageRows(store, view.open, feed.list, false) : h('p', { class: 'muted small slack-loading' }, 'No messages yet.'));
}

// @name of a person this workspace knows becomes a real mention; @here and @channel go as Slack's own.
/** @param {Store} store @param {string} team @param {string} text */
function withMentions(store, team, text) {
  const people = Object.entries(data(store).users[team] ?? {});
  return text
    .replace(/(^|\s)@(here|channel|everyone)\b/g, '$1<!$2>')
    .replace(/(^|\s)@([\w.-]+)/g, (all, space, word) => {
      const lower = word.toLowerCase();
      const hit = people.find(([, u]) => u.name.toLowerCase().replace(/\s+/g, '') === lower || u.name.toLowerCase().split(/\s+/)[0] === lower);
      return hit ? `${space}<@${hit[0]}>` : all;
    });
}

/** @param {Store} store @param {string} key @param {{ threadTs?: string, label: string }} options */
function composer(store, key, { threadTs = '', label }) {
  const [team, channel] = splitKey(key);
  const w = workspaceOf(store, team);
  const field = h('textarea', { class: 'slack-input', rows: 1, name: threadTs ? 'reply' : 'message', 'aria-label': label, placeholder: label });
  const broadcast = threadTs ? h('input', { type: 'checkbox', name: 'broadcast' }) : null;
  const send = async () => {
    const text = field.value.trim();
    if (!text || !w || live.sending) return;
    live.sending = true;
    try {
      await postMessage(w, channel, withMentions(store, team, text), { threadTs, broadcast: broadcast?.checked });
      field.value = '';
      field.style.height = '';
      field.dispatchEvent(new Event('change', { bubbles: true }));
      live.scroll.delete(threadTs ? `${key}|${threadTs}` : key);
      loadHistory(store, key);
      if (threadTs) loadThread(store, key, threadTs);
    } catch (err) {
      toast(/** @type {Error} */ (err).message);
    } finally {
      live.sending = false;
    }
  };
  field.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });
  // Grows with what is typed, up to a few lines.
  field.addEventListener('input', () => {
    field.style.height = '';
    field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
  });
  // One box, as Slack's: the field, then a thin row with the hint (or the broadcast tick) and the send button.
  return h('form', { class: 'slack-composer', onsubmit: (/** @type {SubmitEvent} */ e) => { e.preventDefault(); send(); } },
    h('div', { class: 'slack-composer-box' },
      field,
      h('div', { class: 'row between slack-composer-row' },
        broadcast ? h('label', { class: 'check row small' }, broadcast, `Also send to ${label.replace(/^Reply.*/, 'the channel')}`) : h('span', { class: 'muted small' }, 'Enter sends · Shift+Enter adds a line'),
        h('button', { type: 'submit', class: 'slack-send', title: 'Send', 'aria-label': 'Send' }, icon('send')))));
}

/** @param {Store} store @param {string} ts */
function openThread(store, ts) {
  view.thread = ts;
  live.scroll.delete(`${view.open}|${ts}`);
  store.refresh();
  loadThread(store, view.open, ts);
}

/** @param {Store} store */
function threadMessages(store) {
  if (!view.open || !view.thread) return null;
  const feed = live.threads.get(`${view.open}|${view.thread}`);
  return h('div', { class: 'slack-thread-messages' },
    feed?.error ? notice({ text: feed.error }) : null,
    !feed || (!feed.at && !feed.error)
      ? h('p', { class: 'muted small slack-loading' }, 'Reading the thread…')
      : messageRows(store, view.open, feed.list, true));
}

/** @param {Store} store */
function threadPane(store) {
  if (!view.open || !view.thread) return null;
  const c = channelOf(store, view.open);
  const name = c ? nameOf(store, splitKey(view.open)[0], c) : '';
  return h('aside', { class: 'slack-thread' },
    h('header', { class: 'row between slack-pane-head' },
      h('div', { class: 'row slack-title' }, h('strong', null, 'Thread'), h('span', { class: 'muted small slack-topic' }, c?.kind === 'im' ? name : `#${name}`)),
      h('button', { type: 'button', class: 'icon-btn', title: 'Close thread', 'aria-label': 'Close thread', onclick: () => { view.thread = ''; store.refresh(); } }, icon('x'))),
    threadMessages(store),
    composer(store, view.open, { threadTs: view.thread, label: `Reply… ${c?.kind === 'im' ? '' : `#${name}`}`.trim() }));
}

/** @param {Store} store */
function mainPane(store) {
  const d = data(store);
  if (!d.workspaces.length) return h('section', { class: 'slack-main slack-empty' }, signInForm(store));
  if (!view.open) {
    return h('section', { class: 'slack-main slack-empty' },
      h('div', { class: 'stack slack-empty-text' },
        icon('slack'),
        h('p', null, 'Pick a conversation on the left.'),
        h('p', { class: 'muted small' }, 'Every workspace in one list. Drag conversations to reorder them or drop them on a group; right-click one to mute it, move it or tie it to a project.')));
  }
  const [team, channel] = splitKey(view.open);
  const w = workspaceOf(store, team);
  const c = channelOf(store, view.open);
  if (!w || !c) return h('section', { class: 'slack-main slack-empty' }, h('p', { class: 'muted' }, 'This conversation is not in your list any more.'));
  loadEmoji(w);
  const name = nameOf(store, team, c);
  const muted = isMuted(store, view.open);
  const feed = live.history.get(view.open);
  const own = view.open in d.projects;
  const project = projectOf(d, view.open);
  const label = c.kind === 'im' ? `Message ${name}` : c.kind === 'mpim' ? `Message ${name}` : `Message #${name}`;
  return h('section', { class: 'slack-main' },
    h('header', { class: 'row between slack-pane-head' },
      h('div', { class: 'row slack-title' },
        teamIcon(w),
        h('strong', { class: 'slack-title-name' }, c.kind === 'im' || c.kind === 'mpim' ? name : `#${name}`),
        h('span', { class: 'muted small slack-topic', title: [w.name, c.topic].filter(Boolean).join(' · ') }, [w.name, c.topic].filter(Boolean).join(' · '))),
      h('div', { class: 'row slack-head-actions' },
        pickChip({
          value: project,
          options: projectOptions(store),
          nullable: true,
          nullLabel: 'No project',
          className: 'slack-project-pick',
          onPick: (/** @type {string | null} */ v) => change(store, (dd) => { dd.projects[view.open] = v ?? ''; }),
        }),
        own ? h('button', { type: 'button', class: 'icon-btn', title: 'Follow its group’s or workspace’s project', 'aria-label': 'Follow its group’s or workspace’s project', onclick: () => change(store, (dd) => { delete dd.projects[view.open]; }) }, icon('undo')) : null,
        h('button', {
          type: 'button',
          class: muted ? 'icon-btn active' : 'icon-btn',
          title: muted ? 'Muted: unmute' : 'Mute (it stays in the list)',
          'aria-label': muted ? 'Unmute' : 'Mute',
          'aria-pressed': String(muted),
          onclick: () => toggleMute(store, view.open),
        }, icon(muted ? 'bell-off' : 'bell')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Read again', 'aria-label': 'Read again', disabled: feed?.busy, onclick: () => loadHistory(store, view.open) }, refreshIcon(Boolean(feed?.busy))),
        h('a', { class: 'icon-btn', href: slackLink(w, channel), target: '_blank', rel: 'noopener noreferrer', title: 'Open in Slack', 'aria-label': 'Open in Slack' }, icon('link')))),
    messagesPane(store),
    composer(store, view.open, { label }));
}

// ---- signing in -------------------------------------------------------------------------------------------------

const CONSOLE = 'copy(JSON.parse(localStorage.localConfig_v2).teams)';

/** @param {Store} store @param {(said: string) => void} [done] called with what it says once a workspace is in */
export function signInForm(store, done) {
  const tokens = h('textarea', { name: 'tokens', rows: 4, placeholder: '{"T0123…": {"token": "xoxc-…", …}} or xoxc-…', 'aria-label': 'Tokens' });
  const cookie = h('input', { name: 'cookie', type: 'password', autocomplete: 'off', placeholder: 'xoxd-…', 'aria-label': 'd cookie', value: data(store).workspaces[0]?.cookie ?? '' });
  const status = h('p', { class: 'small muted', role: 'status' });
  const form = h('form', {
    class: 'stack slack-signin',
    onsubmit: async (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      const button = /** @type {HTMLButtonElement} */ (form.querySelector('button[type=submit]'));
      button.disabled = true;
      status.textContent = 'Signing in…';
      try {
        const { added, errors } = await addWorkspaces(store, tokens.value, cookie.value);
        tokens.value = '';
        for (const w of data(store).workspaces) if (added.includes(w.name)) { live.listed.delete(w.id); relist(store, w); }
        status.textContent = [added.length ? `Signed in to ${added.join(', ')}.` : '', ...errors].filter(Boolean).join(' ');
        if (added.length) {
          refreshCounts(store);
          done?.(status.textContent);
        }
      } catch (err) {
        status.textContent = /** @type {Error} */ (err).message;
      } finally {
        button.disabled = false;
      }
    },
  },
    h('h3', null, 'Sign in to your Slack workspaces'),
    h('p', { class: 'small muted' }, 'The board signs in as you, with the session of Slack’s web client, so it works in any workspace you can open in the browser, without installing an app. All your workspaces show side by side.'),
    h('ol', { class: 'small stack-sm' },
      h('li', null, 'Open ', h('a', { href: 'https://app.slack.com/client', target: '_blank', rel: 'noopener noreferrer' }, 'app.slack.com'), ' in Chrome and sign in to every workspace you want here.'),
      h('li', null, 'Open the developer tools (⌥⌘J on a Mac, Ctrl+Shift+J elsewhere). In the Console, paste this line and press Enter:',
        codeBox(CONSOLE, { label: 'the Console line' }),
        h('span', { class: 'muted' }, 'It copies every workspace’s token to the clipboard. Paste it under Tokens. If Chrome refuses the paste, type ', h('code', null, 'allow pasting'), ', press Enter and paste again.')),
      h('li', null, 'In the developer tools, open Application → Cookies → https://app.slack.com, and copy the value of the cookie named ', h('code', null, 'd'), ' (it starts with ', h('code', null, 'xoxd-'), '). Paste it under d cookie.')),
    h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'Tokens'), tokens),
    h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'd cookie'), cookie),
    h('p', { class: 'small muted' }, 'They are saved in slack.json in your data folder and sent only to Slack, through the runners. Anyone who can read that folder can read your Slack. Signing out of Slack in the browser ends the session here too.'),
    h('div', { class: 'row between' }, status, h('button', { type: 'submit', class: 'primary' }, 'Sign in')));
  return form;
}

/** @param {Store} store */
function openSignIn(store) {
  /** @type {{ close: () => void } | null} */
  let dialog = null;
  const form = signInForm(store, () => setTimeout(() => dialog?.close(), 800));
  dialog = openDialog({ title: 'Slack workspaces', wide: true, body: form });
}

// ---- the section ------------------------------------------------------------------------------------------------

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  const d = data(store);
  if (view.open && !channelOf(store, view.open)) {
    // A conversation no longer listed (left, or its workspace removed) closes, unless its list is still on its way.
    const team = splitKey(view.open)[0];
    if (!workspaceOf(store, team) || live.listed.has(team)) view.open = '';
  }
  rememberOpen();
  live.mounted = { root, store };
  if (!live.keys) {
    live.keys = true;
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape' || !picked.size || !live.mounted?.root.isConnected) return;
      clearPicked();
      paint('side');
    });
  }
  if (!live.timer) live.timer = setInterval(tick, 1000);
  for (const w of d.workspaces) if (!w.error) relist(store, w);
  if (view.open && !live.history.has(view.open)) queueMicrotask(() => loadHistory(store, view.open));

  const broken = d.workspaces.filter((w) => w.error);
  const banners = [
    runnersKnown() && !runnersOnline() ? notice({ tone: 'info', text: 'Slack is read through the runners, which are not running. Start the board with bun start.' }) : null,
    broken.length
      ? notice({ text: broken.map((w) => `${w.name}: ${w.error}`).join('\n'), actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => openSignIn(store) }, 'Sign in again')] })
      : null,
  ].filter(Boolean);

  root.replaceChildren(
    h('div', { class: 'stack slack' },
      ...banners,
      h('div', { class: !d.workspaces.length ? 'slack-layout alone' : view.thread && view.open ? 'slack-layout with-thread' : 'slack-layout' },
        d.workspaces.length ? sidebar(store) : null,
        mainPane(store),
        threadPane(store),
        d.workspaces.length ? resizer('side') : null,
        d.workspaces.length && view.thread && view.open ? resizer('thread') : null)));
  const layout = /** @type {HTMLElement | null} */ (root.querySelector('.slack-layout'));
  if (layout) applyWidths(layout);

  const side = root.querySelector('.slack-side-list');
  const list = root.querySelector('.slack-messages');
  if (list) keepScroll(list, view.open);
  const thread = root.querySelector('.slack-thread-messages');
  if (thread) keepScroll(thread, `${view.open}|${view.thread}`);
  // The section is drawn into a page not yet attached, where scrollTop is ignored: the lists go back to their
  // place once it is on screen, before it is painted.
  requestAnimationFrame(() => {
    fillWindow();
    if (side) side.scrollTop = live.sideScroll;
    if (list) placeScroll(list, view.open);
    if (thread) placeScroll(thread, `${view.open}|${view.thread}`);
  });
}

// The layout fills the window below where it starts, which moves with the top bar's wrapping and the banners above it.
function fillWindow() {
  const layout = /** @type {HTMLElement | null} */ (document.querySelector('.slack-layout'));
  if (!layout) return;
  // offsetTop, not the bounding box: the entrance animation moves the page while it plays.
  let top = 0;
  for (let el = /** @type {HTMLElement | null} */ (layout); el; el = /** @type {HTMLElement | null} */ (el.offsetParent)) top += el.offsetTop;
  layout.style.setProperty('--slack-top', `${Math.round(top)}px`);
}
addEventListener('resize', fillWindow);

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'slack',
  title: 'Slack',
  icon: 'slack',
  collection: SLACK,
  defaults: SLACK_DEFAULTS,
  render: draw,
  serialize: () => ({ c: view.open, t: view.thread, by: view.by === 'workspace' ? '' : view.by }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    // A link with no conversation (the section's tab) opens the one last open in this browser.
    /** @type {{ c?: unknown, t?: unknown }} */
    const from = 'c' in p ? p : lastOpen();
    view.open = typeof from.c === 'string' && KEY_RE.test(from.c) ? from.c : '';
    view.thread = view.open && typeof from.t === 'string' && TS_RE.test(from.t) ? from.t : '';
    view.by = p.by === 'project' ? 'project' : 'workspace';
  },
});
