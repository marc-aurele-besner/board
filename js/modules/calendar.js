// Calendar: the events of every connected Google account, by day, week or month, with task deadlines on the same days.
// Events of the range on screen show from the browser's cache at once, then are read again when the cache is stale. Settings → Google Calendar lists the accounts.
import { h, icon, refreshIcon, notice, statusOf } from '../ui.js';
import { projectIcon, projectTree, labelsOf, labelColor, underLabel } from './projects.js';
import { setupBanner } from '../integrations.js';
import { calendarAccounts, calendarEvents, cachedCalendarEvents, calendarWindow, connectCalendar, isCalendarConnected, setCalendar, setCalendarAccount, eventDate, calendarProject, calendarLabel } from '../gcal.js';
import { accountAvatar } from '../google.js';
import { pickChip, pickTree } from '../inline.js';
import { makeTask } from '../capture.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import { runJob } from '../runners.js';
import { resizableSide } from '../side-resize.js';
import { eventGuests } from './project-contacts.js';
/** @import { Store, Task, CalendarAccount, CalendarEvent } from '../../types/data' */
/**
 * The part of a timed event on one day, in hours from midnight; placeSegments() adds its column and the column count.
 * @typedef {{ e: CalendarEvent, top: number, bottom: number, col?: number, cols?: number }} Segment
 */

const MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const AGENDA_DAYS = 7; // the days the side column lists

// View state. date: the day the view is anchored on, YYYY-MM-DD.
// mini: the month the small calendar shows when paged away from the main view. scroll: the time grid's position, kept
// across redraws.
/** @type {{ mode: string, date: string, project: string, tasks: boolean, mini: string, scroll: number | null }} */
const view = { mode: 'week', date: '', project: 'all', tasks: true, mini: '', scroll: null };
// Events come from calendar.json, which the runners keep read. key: the range and calendars last checked, so a range
// the file does not hold yet is asked of the runners once; errors: what that ask, or Refresh, reported.
/** @type {{ key: string, busy: boolean, errors: string[] }} */
const read = { key: '', busy: false, errors: [] };

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');
/** @param {Date} d */
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
/**
 * @param {Date} d
 * @param {number} n
 */
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const anchor = () => (view.date ? eventDate(view.date) : new Date(new Date().setHours(0, 0, 0, 0)));
// Weeks start on Monday.
/** @param {Date} d */
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));

// [first day, day after the last] of what is on screen. A month shows whole weeks.
/**
 * @param {string} mode
 * @param {Date} d
 */
function rangeOf(mode, d) {
  if (mode === 'day') return [d, addDays(d, 1)];
  if (mode === 'week') return [weekStart(d), addDays(weekStart(d), 7)];
  const first = weekStart(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const weeks = Math.ceil((last.getTime() - first.getTime()) / (7 * 86400000));
  return [first, addDays(first, weeks * 7)];
}

/** @param {number} dir */
function step(dir) {
  const d = anchor();
  if (view.mode === 'day') view.date = isoOf(addDays(d, dir));
  else if (view.mode === 'week') view.date = isoOf(addDays(d, 7 * dir));
  else view.date = isoOf(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

/**
 * @param {string} mode
 * @param {Date} d
 */
function titleOf(mode, d) {
  if (mode === 'day') return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (mode === 'month') return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const [from, to] = rangeOf('week', d);
  const end = addDays(to, -1);
  const short = (/** @type {Date} */ x) => x.toLocaleDateString([], { month: 'short', day: 'numeric' });
  // "Nov 9 – 15, 2026", or "Nov 30 – Dec 6, 2026" across months.
  return `${short(from)} – ${from.getMonth() === end.getMonth() ? end.getDate() : short(end)}, ${end.getFullYear()}`;
}

/** @param {number} t */
function ago(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 24 ? `${hours} h ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/** @param {Date} d */
const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
/** @param {CalendarEvent} e */
const timeLabel = (e) => (e.allDay ? 'All day' : clock(eventDate(e.start)));

// "Wed, Nov 11 · 10:00 – 11:00", or the days of an all-day event.
/** @param {CalendarEvent} e */
function whenOf(e) {
  const start = eventDate(e.start);
  const end = eventDate(e.end || e.start);
  const day = (/** @type {Date} */ d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (e.allDay) {
    const last = addDays(end, -1);
    return last > start ? `${day(start)} – ${day(last)}` : `${day(start)} · All day`;
  }
  return start.toDateString() === end.toDateString() ? `${day(start)} · ${clock(start)} – ${clock(end)}` : `${day(start)} ${clock(start)} – ${day(end)} ${clock(end)}`;
}

// True when an event takes up part of the day that starts at `d`.
/**
 * @param {CalendarEvent} e
 * @param {Date} d
 */
function onDay(e, d) {
  const next = addDays(d, 1);
  const start = eventDate(e.start);
  const end = e.end ? eventDate(e.end) : start;
  return start < next && (end > d || (end.getTime() === start.getTime() && start >= d));
}

// Google sends descriptions as light HTML. Parsed in an inert document, so nothing in it runs; only the text is kept.
/** @param {string} html */
function plainText(html) {
  if (!/[<&]/.test(html)) return html;
  const marked = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  return (new DOMParser().parseFromString(marked, 'text/html').body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

// A calendar event as a task in the calendar's project, due on the event's day. Home uses it too.
/**
 * @param {Store} store
 * @param {CalendarEvent} e
 */
export function eventAsTask(store, e) {
  const description = [whenOf(e), e.location, e.link].filter(Boolean).join('\n');
  store.update('todos', (d) =>
    d.items.push(makeTask({ text: e.title, description, due: isoOf(eventDate(e.start)), projectId: e.projectId ?? null })));
  toast(`Task added: ${e.title}`);
}

// --- Reading ---

// What a read depends on: the range, the shown calendars and which accounts are connected.
/**
 * @param {Store} store
 * @param {Date} from
 * @param {Date} to
 */
function keyOf(store, from, to) {
  const shown = calendarAccounts(store).map((a) => `${a.email}:${isCalendarConnected(a.email)}:${a.calendars.filter((c) => c.on).map((c) => `${c.id}=${calendarProject(a, c) ?? ''}/${calendarLabel(a, c) ?? ''}`).join(',')}`);
  return `${isoOf(from)}|${isoOf(to)}|${shown.join(';')}`;
}

// Asks the runners for a range calendar.json does not hold, or (`force`, from Refresh) to read it again now.
/**
 * @param {Store} store
 * @param {string} key
 * @param {Date} from
 * @param {Date} to
 * @param {{ force?: boolean }} [options]
 */
function load(store, key, from, to, { force = false } = {}) {
  read.key = key;
  read.busy = true;
  store.refresh();
  const [start, end] = calendarWindow();
  const inWindow = from >= start && to <= end;
  /** @type {Promise<{ errors: string[] }>} */
  const work = force
    ? runJob('calendar', inWindow ? {} : { from: from.toISOString(), to: to.toISOString() }).then(() => store.sync()).then(() => ({ errors: [] }))
    : calendarEvents(store, from, to);
  work
    .then(({ errors }) => {
      if (read.key === key) read.errors = errors;
    })
    .catch((err) => {
      if (read.key === key) read.errors = [/** @type {Error} */ (err).message];
    })
    .finally(() => {
      if (read.key === key) read.busy = false;
      store.refresh();
    });
}

/**
 * @param {Store} store
 * @param {string} clientId
 * @param {string} email
 */
function connectAccount(store, clientId, email) {
  connectCalendar(clientId, email)
    .then(() => store.refresh())
    .catch((/** @type {Error} */ err) => toast(err.message));
}

// --- Pieces ---

// The other copies of an event, by the one that stands for them.
/** @type {WeakMap<CalendarEvent, CalendarEvent[]>} */
const copiesOf = new WeakMap();

// One event per title and time: a holiday calendar added on every account, or a meeting on two of them, came back
// once per calendar and filled the day with the same chip. The first copy stands for the others.
/** @param {CalendarEvent[]} events */
function regroup(events) {
  /** @type {Map<string, CalendarEvent>} */
  const first = new Map();
  /** @type {CalendarEvent[]} */
  const out = [];
  for (const e of events) {
    const id = [e.title.trim().toLowerCase(), e.start, e.end, e.allDay].join('|');
    const head = first.get(id);
    if (!head) { first.set(id, e); copiesOf.delete(e); out.push(e); continue; }
    copiesOf.set(head, [...(copiesOf.get(head) ?? []), e]);
  }
  return out;
}

/** @param {CalendarEvent} e */
const copyCount = (e) => {
  const n = copiesOf.get(e)?.length ?? 0;
  return n ? h('span', { class: 'cal-group-count', title: `On ${n + 1} calendars` }, String(n + 1)) : null;
};

/**
 * @param {Store} store
 * @param {CalendarEvent} e
 */
function openEvent(store, e) {
  const projects = store.get('projects').projects;
  const project = projects.find((p) => p.id === e.projectId);
  const text = plainText(e.description);
  const dialog = openDialog({
    title: e.title,
    body: h('div', { class: 'stack cal-detail' },
      h('p', { class: 'row' }, icon('clock'), whenOf(e)),
      e.location ? h('p', { class: 'row' }, icon('globe'), e.location) : null,
      h('p', { class: 'row muted small' },
        h('span', { class: 'gcal-swatch', style: { '--c': e.color || 'var(--accent)' } }),
        `${e.calendar} · ${e.account}`,
        project ? h('span', { class: 'row' }, projectIcon(project), project.name) : null),
      (copiesOf.get(e) ?? []).map((c) => h('p', { class: 'row muted small' },
        h('span', { class: 'gcal-swatch', style: { '--c': c.color || 'var(--accent)' } }),
        `${c.calendar} · ${c.account}`)),
      eventGuests(store, e),
      text ? h('p', { class: 'cal-notes' }, text) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => { eventAsTask(store, e); dialog.close(); } }, icon('check-square'), 'Make a task'),
        e.meet ? h('a', { class: 'btn-small', href: e.meet, target: '_blank', rel: 'noopener' }, 'Join the call') : null,
        e.link ? h('a', { class: 'btn-small', href: e.link, target: '_blank', rel: 'noopener' }, 'Open in Google Calendar') : null)),
  });
}

/**
 * @param {Store} store
 * @param {CalendarEvent} e
 * @param {{ time?: boolean }} [options]
 */
const eventChip = (store, e, { time = true } = {}) =>
  h('button', {
    type: 'button',
    class: e.allDay ? 'cal-chip all-day' : 'cal-chip',
    style: { '--c': e.color || 'var(--accent)' },
    title: `${e.title} · ${whenOf(e)}`,
    onclick: () => openEvent(store, e),
  },
    h('span', { class: 'gcal-swatch' }),
    time && !e.allDay ? h('span', { class: 'cal-time' }, timeLabel(e)) : null,
    h('span', { class: 'cal-chip-text' }, e.title),
    copyCount(e));

/** @param {Task} t */
const taskChip = (t) =>
  h('a', { class: 'cal-chip cal-task', href: `#/todos?filter=${t.projectId ?? 'personal'}`, title: `Task due: ${t.text}` },
    icon('check-square'), h('span', { class: 'cal-chip-text' }, t.text));

// Subtask groups unfolded, by parent id and day; folded otherwise.
/** @type {Set<string>} */
const openGroups = new Set();

// One day's due tasks, with subtasks folded under their parent: a parent with many children due at once
// filled the day with near-identical chips. A lone subtask stays a chip, unless its parent is due too.
/**
 * @param {Store} store
 * @param {Task[]} tasks
 * @param {string} day
 * @returns {HTMLElement[]}
 */
function taskChips(store, tasks, day) {
  /** @type {Map<string, Task[]>} */
  const kids = new Map();
  for (const t of tasks) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t]);
  const ids = new Set(tasks.map((t) => t.id));
  /** @param {string} id */
  const grouped = (id) => (kids.get(id)?.length ?? 0) >= (ids.has(id) ? 1 : 2);
  /** @type {HTMLElement[]} */
  const out = [];
  const seen = new Set();
  for (const t of tasks) {
    const g = t.parentId && grouped(t.parentId) ? t.parentId : grouped(t.id) ? t.id : null;
    if (!g) { out.push(taskChip(t)); continue; }
    if (seen.has(g)) continue;
    seen.add(g);
    const parent = store.get('todos').items.find((x) => x.id === g);
    const children = /** @type {Task[]} */ (kids.get(g));
    const key = `${g}|${day}`;
    const open = openGroups.has(key);
    out.push(h('button', {
      type: 'button',
      class: open ? 'cal-chip cal-task cal-group open' : 'cal-chip cal-task cal-group',
      'aria-expanded': String(open),
      title: `${open ? 'Fold' : 'Show'} ${children.length} subtask${children.length === 1 ? '' : 's'} of ${parent?.text ?? 'a task'}`,
      onclick: () => {
        open ? openGroups.delete(key) : openGroups.add(key);
        store.refresh();
      },
    },
      icon('chevron-right'),
      h('span', { class: 'cal-chip-text' }, parent?.text ?? 'Subtasks'),
      h('span', { class: 'cal-group-count' }, String(children.length))));
    if (open) for (const c of children) out.push(Object.assign(taskChip(c), { className: 'cal-chip cal-task cal-sub' }));
  }
  return out;
}

/**
 * @param {Store} store
 * @param {Date} d
 */
const openDay =(store, d) => () => {
  view.mode = 'day';
  view.date = isoOf(d);
  store.refresh();
};

// --- Time grid (day and week), laid out as Google Calendar does ---

const HOUR = 48; // px per hour
const DAY_MS = 86400000;
// Whole-day events, and timed ones that last a day or more, go in the strip above the hours.
/** @param {CalendarEvent} e */
const isLong = (e) => e.allDay || eventDate(e.end || e.start).getTime() - eventDate(e.start).getTime() >= DAY_MS;
/** @param {Date} d */
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Days between two midnights; rounded, so a daylight-saving change does not shift a column.
/**
 * @param {Date} from
 * @param {Date} d
 */
const dayIndex = (from, d) => Math.round((midnight(d).getTime() - from.getTime()) / DAY_MS);
/** @param {number} hour */
const hourLabel = (hour) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
// "2 PM" or "2:30 PM": the minutes only when there are some, as Google's grid shows them.
/** @param {Date} d */
const shortClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', ...(d.getMinutes() ? { minute: '2-digit' } : {}) });

// The part of each timed event that falls on day `d`, in hours from midnight.
/**
 * @param {CalendarEvent[]} timed
 * @param {Date} d
 * @returns {Segment[]}
 */
function segmentsOf(timed, d) {
  const next = addDays(d, 1);
  /** @param {Date} x */
  const hoursOf = (x) => (x >= next ? 24 : x <= d ? 0 : x.getHours() + x.getMinutes() / 60);
  return timed.filter((e) => onDay(e, d)).map((e) => {
    const top = Math.min(hoursOf(eventDate(e.start)), 23.5);
    return { e, top, bottom: Math.max(hoursOf(eventDate(e.end || e.start)), top + 0.5) };
  });
}

// Events that overlap share the width: each takes the first free column of its cluster.
/**
 * @param {Segment[]} segs
 * @returns {Required<Segment>[]}
 */
function placeSegments(segs) {
  segs.sort((x, y) => x.top - y.top || y.bottom - x.bottom);
  /** @type {Segment[]} */
  let cluster = [];
  /** @type {number[]} */
  let ends = [];
  let clusterEnd = -1;
  const close = () => {
    for (const s of cluster) s.cols = ends.length;
    cluster = [];
    ends = [];
  };
  for (const s of segs) {
    if (s.top >= clusterEnd) close();
    let col = ends.findIndex((end) => end <= s.top);
    if (col === -1) col = ends.push(s.bottom) - 1;
    else ends[col] = s.bottom;
    s.col = col;
    cluster.push(s);
    clusterEnd = Math.max(clusterEnd, s.bottom);
  }
  close();
  return /** @type {Required<Segment>[]} */ (segs);
}

/**
 * @param {Store} store
 * @param {Required<Segment>} s
 */
function timedBlock(store, s) {
  const { e } = s;
  const short = s.bottom - s.top < 0.75;
  return h('button', {
    type: 'button',
    class: short ? 'cal-event short' : 'cal-event',
    style: {
      '--c': e.color || 'var(--accent)',
      top: `${s.top * HOUR}px`,
      height: `${(s.bottom - s.top) * HOUR - 2}px`,
      left: `${(s.col / s.cols) * 100}%`,
      width: `calc(${100 / s.cols}% - 3px)`,
    },
    title: `${e.title} · ${whenOf(e)}`,
    onclick: () => openEvent(store, e),
  },
    h('span', { class: 'cal-event-title' }, e.title, copyCount(e)),
    h('span', { class: 'cal-event-time' }, `${shortClock(eventDate(e.start))} – ${shortClock(eventDate(e.end || e.start))}`),
    e.location && !short ? h('span', { class: 'cal-event-place' }, e.location) : null);
}

/**
 * @param {Store} store
 * @param {Date} from
 * @param {number} days
 * @param {CalendarEvent[]} events
 * @param {Task[]} tasks
 */
function gridView(store, from, days, events, tasks) {
  const dates = Array.from({ length: days }, (_, i) => addDays(from, i));
  const today = new Date();
  const cols = { '--days': days };

  // The strip above the hours: multi-day bars span their columns; deadlines sit on their day.
  const bars = events.filter(isLong).map((e) => {
    const start = eventDate(e.start);
    const end = eventDate(e.end || e.start);
    const first = Math.max(0, dayIndex(from, start));
    const after = e.allDay || end.getTime() === midnight(end).getTime() ? dayIndex(from, end) : dayIndex(from, end) + 1;
    const last = Math.min(days, Math.max(first + 1, after));
    return h('button', {
      type: 'button',
      class: ['cal-bar', start < from ? 'cut-start' : '', after > days ? 'cut-end' : ''].filter(Boolean).join(' '),
      style: { '--c': e.color || 'var(--accent)', gridColumn: `${first + 1} / ${last + 1}` },
      title: `${e.title} · ${whenOf(e)}`,
      onclick: () => openEvent(store, e),
    }, h('span', { class: 'cal-chip-text' }, e.title), copyCount(e));
  });
  const due = dates.flatMap((d, i) => taskChips(store, tasks.filter((t) => t.due === isoOf(d)), isoOf(d)).map((chip) => {
    chip.style.gridColumn = String(i + 1);
    return chip;
  }));
  const timed = events.filter((e) => !isLong(e));
  const nowHours = today.getHours() + today.getMinutes() / 60;

  return h('section', { class: 'card cal-grid' },
    h('div', { class: 'cal-grid-row cal-grid-head', style: cols },
      h('span', { class: 'cal-gutter-head' }),
      dates.map((d) => h('button', {
        type: 'button',
        class: d.toDateString() === today.toDateString() ? 'cal-grid-day today' : 'cal-grid-day',
        onclick: openDay(store, d),
        title: 'Show this day',
      },
        h('span', { class: 'cal-weekday' }, d.toLocaleDateString([], { weekday: 'short' })),
        h('span', { class: 'cal-grid-date' }, d.getDate())))),
    bars.length || due.length
      ? h('div', { class: 'cal-grid-row cal-grid-strip', style: cols },
          h('span', { class: 'cal-gutter-head muted small' }, 'All day'),
          h('div', { class: 'cal-strip' }, bars, due))
      : null,
    h('div', { class: 'cal-grid-scroll', onscroll: (/** @type {Event} */ ev) => { view.scroll = /** @type {HTMLElement} */ (ev.currentTarget).scrollTop; } },
      h('div', { class: 'cal-grid-row cal-grid-body', style: { ...cols, '--hour': `${HOUR}px`, height: `${24 * HOUR}px` } },
        h('div', { class: 'cal-gutter' },
          Array.from({ length: 23 }, (_, i) => h('span', { class: 'cal-hour', style: { top: `${(i + 1) * HOUR}px` } }, hourLabel(i + 1)))),
        dates.map((d) => {
          const isToday = d.toDateString() === today.toDateString();
          return h('div', { class: isToday ? 'cal-day-col today' : 'cal-day-col' },
            placeSegments(segmentsOf(timed, d)).map((sg) => timedBlock(store, sg)),
            isToday ? h('div', { class: 'cal-now', style: { top: `${nowHours * HOUR}px` }, 'aria-hidden': 'true' }) : null);
        }))));
}

// Once the grid is on the page: back where it was, or two hours before now, or at 7 in the morning.
/**
 * @param {HTMLElement} root
 * @param {Date} from
 * @param {number} days
 */
function scrollGrid(root, from, days) {
  const el = root.querySelector('.cal-grid-scroll');
  if (!el) return;
  const now = new Date();
  const showsToday = now >= from && now < addDays(from, days);
  const top = view.scroll ?? Math.max(0, (showsToday ? now.getHours() - 2 : 7) * HOUR);
  // The page is drawn before the shell puts it on screen, and a detached element cannot scroll.
  requestAnimationFrame(() => {
    el.scrollTop = top;
  });
}

/**
 * @param {Store} store
 * @param {Date} from
 * @param {Date} to
 * @param {number} month
 * @param {CalendarEvent[]} events
 * @param {Task[]} tasks
 */
function monthView(store, from, to, month, events, tasks) {
  /** @type {Date[]} */
  const days = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  // The month fills the window below the toolbar, so its cells hold as many events as their height leaves room for
  // (a chip is about 24px, the date 30px), before "+N more".
  const cellHeight = (window.innerHeight - 190) / (days.length / 7);
  const perCell = Math.max(2, Math.floor((cellHeight - 30) / 24));
  return h('div', { class: 'card cal-month' },
    h('div', { class: 'cal-month-grid cal-month-head', 'aria-hidden': 'true' },
      days.slice(0, 7).map((d) => h('span', null, d.toLocaleDateString([], { weekday: 'short' })))),
    h('div', { class: 'cal-month-grid' },
      days.map((d) => {
        const list = events.filter((e) => onDay(e, d));
        const due = tasks.filter((t) => t.due === isoOf(d));
        const items = [...list.map((e) => eventChip(store, e, { time: false })), ...taskChips(store, due, isoOf(d))];
        const today = d.toDateString() === new Date().toDateString();
        return h('div', { class: ['cal-cell', d.getMonth() === month ? '' : 'outside', today ? 'today' : ''].filter(Boolean).join(' ') },
          h('button', { type: 'button', class: 'cal-cell-date', onclick: openDay(store, d), 'aria-label': d.toLocaleDateString([], { dateStyle: 'full' }) }, d.getDate()),
          items.length > perCell ? items.slice(0, perCell - 1) : items,
          items.length > perCell ? h('button', { type: 'button', class: 'cal-more', onclick: openDay(store, d) }, `+${items.length - perCell + 1} more`) : null);
      })));
}

// The calendars of every account as a searchable tree: each account (with its Google picture) and its calendars.
/**
 * @param {Store} store
 * @param {CalendarAccount[]} accounts
 */
function calendarFilter(store, accounts) {
  const all = accounts.flatMap((a) => a.calendars);
  if (!all.length) return null;
  const on = all.filter((c) => c.on).length;
  return pickTree({
    key: 'cal-calendars',
    label: on === all.length ? 'All calendars' : on ? `${on} of ${all.length} calendars` : 'No calendar',
    ariaLabel: 'Calendars shown',
    // Read again on each paint, so a tick shows at once.
    getOptions: () => calendarAccounts(store).flatMap((a) => {
      const shown = a.calendars.filter((c) => c.on).length;
      return [
        { value: { account: a.email }, label: a.email, depth: 0, checked: a.calendars.length > 0 && shown === a.calendars.length, mixed: shown > 0, lead: () => accountAvatar(a.email) },
        ...a.calendars.map((c) => ({
          value: { account: a.email, id: c.id },
          label: c.name,
          depth: 1,
          checked: c.on,
          lead: () => h('span', { class: 'gcal-swatch', style: { '--c': c.color || 'var(--accent)' } }),
        })),
      ];
    }),
    // Ticking an account shows or hides all of its calendars.
    onToggle: (/** @type {{ account: string, id?: string }} */ { account, id }, /** @type {boolean} */ next) => {
      if (id) return setCalendar(store, account, id, { on: next });
      const a = calendarAccounts(store).find((x) => x.email === account);
      if (a) setCalendarAccount(store, account, { calendars: a.calendars.map((c) => ({ ...c, on: next })) });
    },
  });
}

// A small month to jump to any day, as in Google's side column. Its arrows page through months on their own.
/**
 * @param {Store} store
 * @param {Date} d
 * @param {Date} from
 * @param {Date} to
 */
function miniMonth(store, d, from, to) {
  const month = view.mini ? eventDate(view.mini) : new Date(d.getFullYear(), d.getMonth(), 1);
  const [first, last] = rangeOf('month', month);
  /** @type {Date[]} */
  const days = [];
  for (let x = first; x < last; x = addDays(x, 1)) days.push(x);
  const today = new Date().toDateString();
  /** @param {number} n */
  const page = (n) => () => {
    view.mini = isoOf(new Date(month.getFullYear(), month.getMonth() + n, 1));
    store.refresh();
  };
  return h('div', { class: 'cal-mini' },
    h('div', { class: 'cal-mini-head' },
      h('strong', null, month.toLocaleDateString([], { month: 'long', year: 'numeric' })),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous month', onclick: page(-1) }, icon('chevron-left')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next month', onclick: page(1) }, icon('chevron-right'))),
    h('div', { class: 'cal-mini-grid', 'aria-hidden': 'true' },
      days.slice(0, 7).map((x) => h('span', { class: 'muted' }, x.toLocaleDateString([], { weekday: 'narrow' })))),
    h('div', { class: 'cal-mini-grid' },
      days.map((x) => h('button', {
        type: 'button',
        class: [
          'cal-mini-day',
          x.getMonth() === month.getMonth() ? '' : 'outside',
          x.toDateString() === today ? 'today' : '',
          x >= from && x < to ? 'in-range' : '',
        ].filter(Boolean).join(' '),
        'aria-label': x.toLocaleDateString([], { dateStyle: 'full' }),
        onclick: () => {
          view.date = isoOf(x);
          view.mini = '';
          store.refresh();
        },
      }, x.getDate()))));
}

// What is coming, under the small month: overdue tasks, then each of the next days with its events and deadlines,
// whatever the main view shows. A day's name opens it.
/**
 * @param {Store} store
 * @param {(x: { projectId: string | null, labelId?: string | null }) => boolean} byProject
 */
function agenda(store, byProject) {
  const today = midnight(new Date());
  const end = addDays(today, AGENDA_DAYS);
  const events = regroup(cachedCalendarEvents(store, today, end).events.filter(byProject));
  const tasks = view.tasks
    ? store.get('todos').items.filter((t) => t.due && statusOf(t) !== 'done' && t.due < isoOf(end)).filter(byProject)
    : [];
  const overdue = tasks.filter((t) => /** @type {string} */ (t.due) < isoOf(today));
  const days = Array.from({ length: AGENDA_DAYS }, (_, i) => addDays(today, i))
    .map((d) => ({ d, list: events.filter((e) => onDay(e, d)), due: tasks.filter((t) => t.due === isoOf(d)) }))
    .filter((x) => x.list.length || x.due.length);
  /** @param {Date} d */
  const dayName = (d) => {
    const n = dayIndex(today, d);
    return n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : d.toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'short' });
  };
  return h('section', { class: 'cal-agenda' },
    h('h3', null, `Next ${AGENDA_DAYS} days`),
    overdue.length
      ? h('div', { class: 'cal-agenda-day' },
          h('span', { class: 'cal-agenda-name overdue' }, 'Overdue'),
          taskChips(store, overdue, 'overdue'))
      : null,
    days.map(({ d, list, due }) => h('div', { class: 'cal-agenda-day' },
      h('button', { type: 'button', class: 'cal-agenda-name', title: 'Show this day', onclick: openDay(store, d) }, dayName(d)),
      list.map((e) => eventChip(store, e)),
      taskChips(store, due, isoOf(d)))),
    !overdue.length && !days.length ? h('p', { class: 'muted small' }, 'Nothing planned.') : null);
}

// The time grid and the month run to the bottom of the window, below where they start: that moves with the banners.
function fillWindow() {
  const layout = /** @type {HTMLElement | null} */ (document.querySelector('.cal-layout'));
  const fill = /** @type {HTMLElement | null} */ (layout?.querySelector('.cal-grid-scroll, .cal-month'));
  if (!layout || !fill) return;
  // offsetTop, not the bounding box: the entrance animation moves the page while it plays.
  let top = 0;
  for (let el = /** @type {HTMLElement | null} */ (fill); el; el = /** @type {HTMLElement | null} */ (el.offsetParent)) top += el.offsetTop;
  layout.style.setProperty('--cal-fill-top', `${Math.round(top)}px`);
}
addEventListener('resize', fillWindow);

// --- Page ---

/**
 * @param {HTMLElement} root
 * @param {Store} store
 */
function draw(root, store) {
  const settings = store.get('settings');
  const clientId = settings.google?.clientId ?? '';
  const accounts = calendarAccounts(store);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const labels = store.get('projects').categories ?? [];
  // The filter is a project id, or "label:<id>" for a project label.
  const labelFilter = view.project.startsWith('label:') ? view.project.slice(6) : null;
  if (view.project !== 'all' && !(labelFilter ? labels.some((c) => c.id === labelFilter) : projects.some((p) => p.id === view.project))) view.project = 'all';

  const d = anchor();
  const [from, to] = rangeOf(view.mode, d);
  const connected = accounts.filter((a) => isCalendarConnected(a.email));
  const key = keyOf(store, from, to);
  if (accounts.length && key !== read.key) queueMicrotask(() => load(store, key, from, to));
  const cached = cachedCalendarEvents(store, from, to);

  // Events carry their calendar's label; tasks only have their project's.
  /** @param {{ projectId: string | null, labelId?: string | null }} x */
  const byProject = (x) => view.project === 'all' ||
    (labelFilter ? underLabel(projects, x.projectId, x.labelId ?? null, labelFilter) : x.projectId === view.project);
  const events = regroup(cached.events.filter(byProject));
  const tasks = view.tasks
    ? store.get('todos').items.filter((t) => t.due && statusOf(t) !== 'done' && t.due >= isoOf(from) && t.due < isoOf(to)).filter(byProject)
    : [];
  // Projects that have a calendar, for the filter; tasks of any project still follow it.
  const linked = new Set(accounts.flatMap((a) => a.calendars.map((c) => calendarProject(a, c))).filter(Boolean));
  // Labels a calendar carries, or one of its projects does.
  const linkedLabels = new Set([
    ...accounts.flatMap((a) => a.calendars.map((c) => calendarLabel(a, c))).filter(Boolean),
    ...projects.filter((p) => linked.has(p.id)).flatMap(labelsOf),
  ]);

  // Moving the main view brings the small month back to it.
  /** @param {() => void} move */
  const go = (move) => () => {
    move();
    view.mini = '';
    store.refresh();
  };
  const toolbar = h('div', { class: 'row between cal-toolbar' },
    h('div', { class: 'row cal-nav' },
      h('button', { type: 'button', class: 'btn-small cal-today', onclick: go(() => { view.date = ''; }) }, 'Today'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous', title: 'Previous', onclick: go(() => step(-1)) }, icon('chevron-left')),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next', title: 'Next', onclick: go(() => step(1)) }, icon('chevron-right')),
      h('h3', { class: 'cal-title' }, titleOf(view.mode, d))),
    h('div', { class: 'row cal-actions' },
      cached.at ? h('span', { class: 'muted small', title: new Date(cached.at).toLocaleString() }, `Updated ${ago(cached.at)}`) : null,
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: read.busy ? 'Reading…' : 'Read again from Google (through the runners)',
        'aria-label': 'Refresh',
        disabled: read.busy || !connected.length,
        onclick: () => load(store, key, from, to, { force: true }),
      }, refreshIcon(read.busy)),
      h('div', { class: 'segmented cal-modes', role: 'group', 'aria-label': 'View' },
        MODES.map(([k, label]) => h('button', {
          type: 'button',
          class: view.mode === k ? 'seg active' : 'seg',
          'aria-pressed': String(view.mode === k),
          onclick: () => { view.mode = k; store.refresh(); },
        }, label)))));

  // The side column: a small month, then the filters. On a phone the month is hidden and the filters sit in a row.
  // Projects that have a calendar, then project labels in their colours.
  const choices = [
    ...projects.filter((p) => linked.has(p.id) || p.id === view.project).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
    ...labels.filter((c) => linkedLabels.has(c.id) || c.id === labelFilter).map((c) => ({ value: `label:${c.id}`, label: c.name, color: labelColor(c) })),
  ];
  const side = h('aside', { class: 'cal-side' },
    miniMonth(store, d, from, to),
    h('div', { class: 'cal-filters' },
      calendarFilter(store, accounts),
      choices.length
        ? pickChip({
            value: view.project === 'all' ? null : view.project,
            options: choices,
            nullable: true,
            nullLabel: 'All projects',
            className: 'cal-project-pick',
            onPick: (/** @type {string | null} */ v) => { view.project = v ?? 'all'; store.refresh(); },
          })
        : null,
      h('label', { class: 'check row' },
        h('input', { type: 'checkbox', checked: view.tasks, onchange: (/** @type {Event} */ e) => { view.tasks = /** @type {HTMLInputElement} */ (e.target).checked; store.refresh(); } }), 'Task deadlines')),
    agenda(store, byProject));

  const offline = accounts.filter((a) => !isCalendarConnected(a.email));
  const banners = [
    !clientId ? setupBanner('google', 'Calendar needs a Google OAuth Client ID.') : null,
    clientId && !accounts.length ? setupBanner('google', 'Add a Google account to see its calendars here.') : null,
    clientId && offline.length
      ? notice({
          tone: 'info',
          text: connected.length ? 'Some accounts are not connected.' : 'Connect your accounts to read their events. They stay connected.',
          actions: offline.map((a) => h('button', { type: 'button', class: 'btn-small', onclick: () => connectAccount(store, clientId, a.email) }, icon('plus'), a.email)),
        })
      : null,
    read.key === key && read.errors.length ? notice({ text: read.errors.join('\n') }) : null,
  ].filter(Boolean);

  const days = view.mode === 'day' ? 1 : 7;
  const body = view.mode === 'month'
    ? monthView(store, from, to, d.getMonth(), events, tasks)
    : gridView(store, from, days, events, tasks);

  root.replaceChildren(
    h('div', { class: 'stack-lg calendar' },
      ...banners,
      resizableSide(h('div', { class: 'cal-layout' },
        side,
        h('div', { class: 'cal-main' }, toolbar, body)), 'calendar', { def: 260, min: 220, max: 460 })));
  if (view.mode !== 'month') scrollGrid(root, from, days);
  requestAnimationFrame(fillWindow);
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'calendar',
  title: 'Calendar',
  icon: 'calendar',
  collection: null,
  render: draw,
  serialize: () => ({ mode: view.mode === 'week' ? '' : view.mode, date: view.date, project: view.project === 'all' ? '' : view.project, tasks: view.tasks ? '' : '0' }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.mode = MODES.some(([k]) => k === p.mode) ? p.mode : 'week';
    view.date = /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '') ? p.date : '';
    view.project = p.project || 'all';
    view.tasks = p.tasks !== '0';
  },
});
