// Slack: every workspace signed in with a browser session, in one sidebar, so there is no switching between them.
// Channels can be dragged into any order, gathered into groups, and tied to projects (one by one, by group, or a whole
// workspace). A muted channel stays where it is, dimmed and never counted as unread. Messages, threads and reactions
// are read live through the runners: the open conversation every few seconds, unread counts every 20 s.
import { h, icon, uid, notice, refreshIcon } from '../ui.js';
import { projectTree, projectIcon } from './projects.js';
import { pickButton, pickChip } from '../inline.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import { runnersOnline, runnersKnown } from '../runners.js';
import { markup } from '../slack-markup.js';
import { emojiChar, EMOJI, QUICK_REACTIONS } from '../emoji.js';
import {
  SLACK, SLACK_DEFAULTS, keyOf, splitKey, addWorkspaces, listChannels, ensureUsers, readCounts, readHistory, readThread,
  postMessage, editMessage, deleteMessage, react, markRead, customEmoji, fileData, slackLink,
} from '../slack.js';
/** @import { Store, SlackData, SlackWorkspace, SlackChannel, SlackGroup, Project } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
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
  sending: false,
  /** @type {{ root: HTMLElement, store: Store } | null} */
  mounted: null,
  /** @type {ReturnType<typeof setInterval> | null} */
  timer: null,
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
  const dm = /^D/.test(splitKey(key)[1]);
  const mentions = dm && c.unread ? Math.max(c.mentions, 1) : c.mentions;
  return { unread: c.unread && !isMuted(store, key), mentions };
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
    const old = m.root.querySelector('.slack-side-list');
    if (old) old.replaceWith(sideList(m.store));
    return;
  }
  const selector = part === 'main' ? '.slack-messages' : '.slack-thread-messages';
  const old = m.root.querySelector(selector);
  const fresh = part === 'main' ? messagesPane(m.store) : threadMessages(m.store);
  if (old && fresh) {
    old.replaceWith(fresh);
    keepScroll(fresh, part === 'main' ? view.open : `${view.open}|${view.thread}`);
  } else if (!old !== !fresh) m.store.refresh();
}

// Puts a redrawn list back where it was: at the bottom when it was there, else at the same place.
/** @param {Element} el @param {string} key */
function keepScroll(el, key) {
  const at = live.scroll.get(key);
  el.scrollTop = at === undefined || at === null ? el.scrollHeight : at;
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
function teamIcon(w, className = 'slack-team-icon') {
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
const timeOf = (ts) => dateOf(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** @param {string} ts */
function dayOf(ts) {
  const d = dateOf(ts);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yesterday.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', ...(d.getFullYear() !== today.getFullYear() ? { year: 'numeric' } : {}) });
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

// The menu of a conversation: mute, read, group, project, order.
/** @param {Store} store @param {string} key @param {Section} section */
function itemMenu(store, key, section) {
  const d = data(store);
  const group = groupOf(d, key);
  const muted = isMuted(store, key);
  const projects = projectsOf(store);
  const own = key in d.projects;
  const options = [
    { value: 'mute', label: muted ? 'Unmute' : 'Mute', plainIcon: () => icon(muted ? 'bell' : 'bell-off') },
    { value: 'read', label: 'Mark as read', plainIcon: () => icon('check') },
    { value: 'up', label: 'Move up', plainIcon: () => icon('arrow-up') },
    { value: 'down', label: 'Move down', plainIcon: () => icon('arrow-down') },
    ...d.groups.filter((g) => g !== group).map((g) => ({ value: `group:${g.id}`, label: `Move to group ${g.name}`, plainIcon: () => icon('folder') })),
    { value: 'new-group', label: 'New group with this…', plainIcon: () => icon('plus') },
    ...(group ? [{ value: 'ungroup', label: `Take out of ${group.name}`, plainIcon: () => icon('x') }] : []),
    ...projects.map((p) => ({ value: `project:${p.id}`, label: `Tie to ${p.name}`, plainIcon: () => projectIcon(p) })),
    ...(projectOf(d, key) ? [{ value: 'project:', label: 'Tie to no project', plainIcon: () => icon('x') }] : []),
    ...(own ? [{ value: 'project-inherit', label: 'Follow its group’s or workspace’s project', plainIcon: () => icon('undo') }] : []),
    { value: 'slack', label: 'Open in Slack', plainIcon: () => icon('link') },
  ];
  return pickButton({
    label: '',
    title: 'More',
    className: 'icon-btn slack-item-menu',
    options,
    onPick: (/** @type {string} */ v) => {
      const [team, channel] = splitKey(key);
      const w = workspaceOf(store, team);
      if (v === 'mute') toggleMute(store, key);
      else if (v === 'read') {
        const c = countOf(key);
        if (w && c?.latest) {
          markRead(w, channel, c.latest).catch((err) => toast(err.message));
          Object.assign(c, { unread: false, mentions: 0, lastRead: c.latest });
          paint('side');
        }
      } else if (v === 'up' || v === 'down') nudge(store, key, section, v === 'up' ? -1 : 1);
      else if (v.startsWith('group:')) {
        const target = sections(store).find((s) => s.id === v.slice(6));
        if (target) moveTo(store, key, target, null);
      } else if (v === 'new-group') newGroup(store, [key]);
      else if (v === 'ungroup') change(store, (dd) => { for (const g of dd.groups) g.items = g.items.filter((k) => k !== key); });
      else if (v === 'project-inherit') change(store, (dd) => { delete dd.projects[key]; });
      else if (v.startsWith('project:')) change(store, (dd) => { dd.projects[key] = v.slice(8); });
      else if (v === 'slack' && w) window.open(slackLink(w, channel), '_blank', 'noopener');
    },
  });
}

// The menu of a section: a group's name, project, place and removal; a workspace's project, listing and sign-in.
/** @param {Store} store @param {Section} section */
function sectionMenu(store, section) {
  const projects = projectOptions(store);
  if (section.kind === 'project') return null;
  if (section.kind === 'group') {
    const g = /** @type {SlackGroup} */ (section.group);
    const i = data(store).groups.indexOf(g);
    return pickButton({
      label: '',
      title: 'Group',
      className: 'icon-btn slack-item-menu',
      options: [
        { value: 'rename', label: 'Rename', plainIcon: () => icon('pencil') },
        { value: 'up', label: 'Move group up', plainIcon: () => icon('arrow-up') },
        { value: 'down', label: 'Move group down', plainIcon: () => icon('arrow-down') },
        ...projects.map((p) => ({ ...p, value: `project:${p.value}`, label: `Tie to ${p.label}` })),
        ...(g.projectId ? [{ value: 'project:', label: 'Tie to no project', plainIcon: () => icon('x') }] : []),
        { value: 'delete', label: 'Remove group (keeps its channels)', plainIcon: () => icon('trash') },
      ],
      onPick: (/** @type {string} */ v) => {
        if (v === 'rename') askText({ title: 'Rename group', label: 'Name', value: g.name, onSave: (name) => change(store, (d) => { const x = d.groups.find((y) => y.id === g.id); if (x) x.name = name; }) });
        else if (v === 'up' || v === 'down') change(store, (d) => {
          const j = i + (v === 'up' ? -1 : 1);
          if (j < 0 || j >= d.groups.length) return;
          [d.groups[i], d.groups[j]] = [d.groups[j], d.groups[i]];
        });
        else if (v.startsWith('project:')) change(store, (d) => { const x = d.groups.find((y) => y.id === g.id); if (x) x.projectId = v.slice(8) || null; });
        else if (v === 'delete') change(store, (d) => { d.groups = d.groups.filter((y) => y.id !== g.id); });
      },
    });
  }
  const w = /** @type {SlackWorkspace} */ (section.ws);
  return pickButton({
    label: '',
    title: 'Workspace',
    className: 'icon-btn slack-item-menu',
    options: [
      { value: 'relist', label: 'Read its channels again', plainIcon: () => icon('refresh') },
      ...projects.map((p) => ({ ...p, value: `project:${p.value}`, label: `Tie workspace to ${p.label}` })),
      ...(w.projectId ? [{ value: 'project:', label: 'Tie to no project', plainIcon: () => icon('x') }] : []),
      { value: 'signin', label: 'Sign in again', plainIcon: () => icon('key') },
      { value: 'slack', label: 'Open in Slack', plainIcon: () => icon('link') },
      { value: 'remove', label: 'Remove workspace', plainIcon: () => icon('trash') },
    ],
    onPick: (/** @type {string} */ v) => {
      if (v === 'relist') relist(store, w, { force: true }).then(() => toast(`${w.name}: channels read again.`));
      else if (v.startsWith('project:')) change(store, (d) => { const x = d.workspaces.find((y) => y.id === w.id); if (x) x.projectId = v.slice(8) || null; });
      else if (v === 'signin') openSignIn(store);
      else if (v === 'slack') window.open(w.url || 'https://app.slack.com/', '_blank', 'noopener');
      else if (v === 'remove') confirmRemove(store, w);
    },
  });
}

/** @param {Store} store @param {SlackWorkspace} w */
function confirmRemove(store, w) {
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
          },
        }, 'Remove'))),
  });
}

// Where a drag is: the conversation being dragged.
let dragging = '';

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
  const cls = ['slack-item', view.open === key && 'active', unread && 'unread', muted && 'muted'].filter(Boolean).join(' ');
  return h('div', {
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
      onclick: () => openConversation(store, key),
    },
      // A workspace's own section says which workspace; groups and projects mix them.
      multi && section.kind !== 'team' ? teamIcon(w, 'slack-item-team') : null,
      glyph,
      h('span', { class: 'slack-item-name' }, name),
      muted ? h('span', { class: 'slack-item-muted', title: 'Muted' }, icon('bell-off')) : null,
      mentions ? h('span', { class: muted ? 'slack-badge muted' : 'slack-badge' }, String(mentions)) : null),
    itemMenu(store, key, section));
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
      h('div', { class: 'slack-section-head' },
        h('button', {
          type: 'button',
          class: 'slack-section-toggle',
          'aria-expanded': String(!folded),
          onclick: () => change(store, (dd) => {
            dd.collapsed = dd.collapsed.includes(s.id) ? dd.collapsed.filter((x) => x !== s.id) : [...dd.collapsed, s.id];
          }),
        },
          icon(folded ? 'chevron-right' : 'chevron-down'),
          s.kind === 'team' && s.ws ? teamIcon(s.ws) : s.project ? projectIcon(s.project) : s.kind === 'group' ? icon('folder') : null,
          h('span', { class: 'slack-section-title' }, s.title),
          project && s.kind !== 'project' ? h('span', { class: 'slack-section-project', title: `Tied to ${project.name}` }, projectIcon(project), project.name) : null,
          folded && unreadCount ? h('span', { class: 'slack-badge soft' }, String(unreadCount)) : null),
        sectionMenu(store, s)),
      error ? h('p', { class: 'slack-section-error small' }, icon('alert'), error) : null,
      folded ? null : h('div', { class: 'slack-section-items' },
        keys.length ? keys.map((k) => sideItem(store, k, s, multi)) : h('p', { class: 'muted small slack-drop-hint' }, s.kind === 'group' ? 'Drag channels here.' : live.listed.has(s.id) ? 'No conversations.' : 'Reading…')));
  }).filter(Boolean);
  return h('div', { class: 'slack-side-list' }, list.length ? list : h('p', { class: 'muted small' }, words || view.unread ? 'Nothing matches.' : 'No conversations yet.'));
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

// The reaction picker: Slack's usual ones, then any emoji by name, the workspace's own included.
/** @param {SlackWorkspace} w @param {(name: string) => void} onPick */
function pickEmoji(w, onPick) {
  const custom = Object.keys(live.emoji.get(w.id) ?? {});
  const names = [...new Set([...Object.keys(EMOJI), ...custom])];
  const results = h('div', { class: 'slack-emoji-grid' });
  /** @param {string} name */
  const choice = (name) => h('button', { type: 'button', class: 'slack-emoji-choice', title: `:${name}:`, onclick: () => { dialog.close(); onPick(name); } }, emojiNode(w.id, name));
  /** @param {string} q */
  const fill = (q) => {
    const words = q.trim().toLowerCase().replace(/:/g, '');
    const list = words ? names.filter((n) => n.includes(words)).slice(0, 80) : QUICK_REACTIONS;
    results.replaceChildren(...(list.length ? list.map(choice) : [h('p', { class: 'muted small' }, 'No emoji by that name.')]));
  };
  fill('');
  const dialog = openDialog({
    title: 'React',
    body: h('div', { class: 'stack' },
      h('input', { type: 'search', placeholder: 'Find an emoji by name', 'aria-label': 'Find an emoji', oninput: (/** @type {Event} */ e) => fill(/** @type {HTMLInputElement} */ (e.target).value) }),
      results),
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
      h('span', { class: 'slack-time', title: dateOf(m.ts).toLocaleString() }, timeOf(m.ts)),
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
        h('button', { type: 'button', class: 'slack-reaction add', title: 'Add a reaction', 'aria-label': 'Add a reaction', onclick: () => pickEmoji(w, (n) => toggleReaction(store, key, m, true, n)) }, icon('smile')))
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
    QUICK_REACTIONS.slice(0, 3).map((n) => h('button', { type: 'button', class: 'icon-btn', title: `React :${n}:`, 'aria-label': `React :${n}:`, onclick: () => toggleReaction(store, key, m, !m.reactions.find((r) => r.name === n)?.users.includes(w.userId), n) }, emojiNode(team, n))),
    h('button', { type: 'button', class: 'icon-btn', title: 'Add a reaction', 'aria-label': 'Add a reaction', onclick: () => pickEmoji(w, (n) => toggleReaction(store, key, m, true, n)) }, icon('smile')),
    inThread ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Reply in thread', 'aria-label': 'Reply in thread', onclick: () => openThread(store, m.ts) }, icon('message')),
    mine ? h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': 'Edit', onclick: () => editDialog(store, key, m) }, icon('pencil')) : null,
    mine ? h('button', { type: 'button', class: 'icon-btn', title: 'Delete', 'aria-label': 'Delete', onclick: () => deleteDialog(store, key, m) }, icon('trash')) : null,
    h('a', { class: 'icon-btn', href: slackLink(w, channel, m.ts), target: '_blank', rel: 'noopener noreferrer', title: 'Open in Slack', 'aria-label': 'Open in Slack' }, icon('link')));
  return h('div', { class: compact ? 'slack-msg compact' : 'slack-msg', 'data-ts': m.ts },
    compact
      ? h('span', { class: 'slack-time slack-gutter', title: dateOf(m.ts).toLocaleString() }, timeOf(m.ts))
      : avatar(name, person?.avatar || m.avatar),
    h('div', { class: 'slack-msg-body' },
      compact ? null : h('div', { class: 'slack-msg-meta' },
        h('strong', null, name),
        person?.bot || (!m.user && m.username) ? h('span', { class: 'pill tone-plain' }, 'App') : null,
        h('span', { class: 'slack-time', title: dateOf(m.ts).toLocaleString() }, timeOf(m.ts))),
      m.text ? markup(m.text, ctx) : null,
      m.edited ? h('span', { class: 'muted small' }, '(edited)') : null,
      files,
      attachments,
      reactions,
      thread),
    actions);
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
  return h('form', { class: 'slack-composer', onsubmit: (/** @type {SubmitEvent} */ e) => { e.preventDefault(); send(); } },
    field,
    h('div', { class: 'row between slack-composer-row' },
      broadcast ? h('label', { class: 'check row small' }, broadcast, `Also send to ${label.replace(/^Reply.*/, 'the channel')}`) : h('span', { class: 'muted small' }, 'Enter sends · Shift+Enter adds a line'),
      h('button', { type: 'submit', class: 'primary btn-small', title: 'Send' }, icon('send'), 'Send')));
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
      h('div', null, h('strong', null, 'Thread'), h('span', { class: 'muted small' }, ` ${c?.kind === 'im' ? name : `#${name}`}`)),
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
        icon('message'),
        h('p', null, 'Pick a conversation on the left.'),
        h('p', { class: 'muted small' }, 'Drag conversations to reorder them, drop them on a group, or use their ⋯ menu to mute, group or tie them to a project.')));
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
        h('div', { class: 'stack-xs' },
          h('strong', null, c.kind === 'im' || c.kind === 'mpim' ? name : `#${name}`),
          h('span', { class: 'muted small slack-topic' }, [w.name, c.topic].filter(Boolean).join(' · ')))),
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

/** @param {Store} store @param {() => void} [done] */
function signInForm(store, done) {
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
          done?.();
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
      h('li', null, 'Open the developer tools (⌥⌘J), paste ', h('code', null, CONSOLE), ' into the Console and press Enter. It copies every workspace’s token. Paste it under Tokens.'),
      h('li', null, 'In the developer tools, open Application → Cookies → https://app.slack.com, and copy the value of the cookie named ', h('code', null, 'd'), '. Paste it under d cookie.')),
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
  live.mounted = { root, store };
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
      h('header', { class: 'row between' },
        h('div', null,
          h('h2', null, 'Slack'),
          h('p', { class: 'muted small' }, 'Every workspace in one list. Reorder, group and tie conversations to projects; muted ones stay in place.'))),
      ...banners,
      h('div', { class: !d.workspaces.length ? 'slack-layout alone' : view.thread && view.open ? 'slack-layout with-thread' : 'slack-layout' },
        d.workspaces.length ? sidebar(store) : null,
        mainPane(store),
        threadPane(store))));

  const list = root.querySelector('.slack-messages');
  if (list) keepScroll(list, view.open);
  const thread = root.querySelector('.slack-thread-messages');
  if (thread) keepScroll(thread, `${view.open}|${view.thread}`);
  // Lists are drawn before they are laid out; the bottom is only known after.
  requestAnimationFrame(() => {
    if (list && live.scroll.get(view.open) == null) list.scrollTop = list.scrollHeight;
    if (thread && live.scroll.get(`${view.open}|${view.thread}`) == null) thread.scrollTop = thread.scrollHeight;
  });
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'slack',
  title: 'Slack',
  icon: 'message',
  collection: SLACK,
  defaults: SLACK_DEFAULTS,
  render: draw,
  serialize: () => ({ c: view.open, t: view.thread, by: view.by === 'workspace' ? '' : view.by }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.open = /^[A-Z0-9]+\|[A-Z0-9]+$/.test(p.c ?? '') ? p.c : '';
    view.thread = view.open && /^\d+\.\d+$/.test(p.t ?? '') ? p.t : '';
    view.by = p.by === 'project' ? 'project' : 'workspace';
  },
});
