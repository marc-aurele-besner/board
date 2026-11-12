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

const MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const MONTH_CELL = 3; // events listed in a month cell before "+N more"

// View state. date: the day the view is anchored on, YYYY-MM-DD.
// mini: the month the small calendar shows when paged away from the main view. scroll: the time grid's position, kept
// across redraws.
const view = { mode: 'week', date: '', project: 'all', tasks: true, mini: '', scroll: null };
// Events come from calendar.json, which the runners keep read. key: the range and calendars last checked, so a range
// the file does not hold yet is asked of the runners once; errors: what that ask, or Refresh, reported.
const read = { key: '', busy: false, errors: [] };

const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const anchor = () => (view.date ? eventDate(view.date) : new Date(new Date().setHours(0, 0, 0, 0)));
// Weeks start on Monday.
const weekStart = (d) => addDays(d, -((d.getDay() + 6) % 7));

// [first day, day after the last] of what is on screen. A month shows whole weeks.
function rangeOf(mode, d) {
  if (mode === 'day') return [d, addDays(d, 1)];
  if (mode === 'week') return [weekStart(d), addDays(weekStart(d), 7)];
  const first = weekStart(new Date(d.getFullYear(), d.getMonth(), 1));
  const last = new Date(d.getFullYear(), d.getMonth() + 1, 1);
  const weeks = Math.ceil((last - first) / (7 * 86400000));
  return [first, addDays(first, weeks * 7)];
}

function step(dir) {
  const d = anchor();
  if (view.mode === 'day') view.date = isoOf(addDays(d, dir));
  else if (view.mode === 'week') view.date = isoOf(addDays(d, 7 * dir));
  else view.date = isoOf(new Date(d.getFullYear(), d.getMonth() + dir, 1));
}

function titleOf(mode, d) {
  if (mode === 'day') return d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (mode === 'month') return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
  const [from, to] = rangeOf('week', d);
  const end = addDays(to, -1);
  const short = (x) => x.toLocaleDateString([], { month: 'short', day: 'numeric' });
  // "Nov 9 – 15, 2026", or "Nov 30 – Dec 6, 2026" across months.
  return `${short(from)} – ${from.getMonth() === end.getMonth() ? end.getDate() : short(end)}, ${end.getFullYear()}`;
}

function ago(t) {
  const min = Math.round((Date.now() - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const hours = Math.round(min / 60);
  return hours < 24 ? `${hours} h ago` : new Date(t).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

const clock = (d) => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const timeLabel = (e) => (e.allDay ? 'All day' : clock(eventDate(e.start)));

// "Wed, Nov 11 · 10:00 – 11:00", or the days of an all-day event.
function whenOf(e) {
  const start = eventDate(e.start);
  const end = eventDate(e.end || e.start);
  const day = (d) => d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
  if (e.allDay) {
    const last = addDays(end, -1);
    return last > start ? `${day(start)} – ${day(last)}` : `${day(start)} · All day`;
  }
  return start.toDateString() === end.toDateString() ? `${day(start)} · ${clock(start)} – ${clock(end)}` : `${day(start)} ${clock(start)} – ${day(end)} ${clock(end)}`;
}

// True when an event takes up part of the day that starts at `d`.
function onDay(e, d) {
  const next = addDays(d, 1);
  const start = eventDate(e.start);
  const end = e.end ? eventDate(e.end) : start;
  return start < next && (end > d || (end.getTime() === start.getTime() && start >= d));
}

// Google sends descriptions as light HTML. Parsed in an inert document, so nothing in it runs; only the text is kept.
function plainText(html) {
  if (!/[<&]/.test(html)) return html;
  const marked = html.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n');
  return (new DOMParser().parseFromString(marked, 'text/html').body.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
}

// A calendar event as a task in the calendar's project, due on the event's day. Home uses it too.
export function eventAsTask(store, e) {
  const description = [whenOf(e), e.location, e.link].filter(Boolean).join('\n');
  store.update('todos', (d) =>
    d.items.push(makeTask({ text: e.title, description, due: isoOf(eventDate(e.start)), projectId: e.projectId ?? null })));
  toast(`Task added: ${e.title}`);
}

// --- Reading ---

// What a read depends on: the range, the shown calendars and which accounts are connected.
function keyOf(store, from, to) {
  const shown = calendarAccounts(store).map((a) => `${a.email}:${isCalendarConnected(a.email)}:${a.calendars.filter((c) => c.on).map((c) => `${c.id}=${calendarProject(a, c) ?? ''}/${calendarLabel(a, c) ?? ''}`).join(',')}`);
  return `${isoOf(from)}|${isoOf(to)}|${shown.join(';')}`;
}

// Asks the runners for a range calendar.json does not hold, or (`force`, from Refresh) to read it again now.
function load(store, key, from, to, { force = false } = {}) {
  read.key = key;
  read.busy = true;
  store.refresh();
  const [start, end] = calendarWindow();
  const inWindow = from >= start && to <= end;
  const work = force
    ? runJob('calendar', inWindow ? {} : { from: from.toISOString(), to: to.toISOString() }).then(() => store.sync()).then(() => ({ errors: [] }))
    : calendarEvents(store, from, to);
  work
    .then(({ errors }) => {
      if (read.key === key) read.errors = errors;
    })
    .catch((err) => {
      if (read.key === key) read.errors = [err.message];
    })
    .finally(() => {
      if (read.key === key) read.busy = false;
      store.refresh();
    });
}

function connectAccount(store, clientId, email) {
  connectCalendar(clientId, email)
    .then(() => store.refresh())
    .catch((err) => toast(err.message));
}

// --- Pieces ---

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
      text ? h('p', { class: 'cal-notes' }, text) : null,
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => { eventAsTask(store, e); dialog.close(); } }, icon('check-square'), 'Make a task'),
        e.meet ? h('a', { class: 'btn-small', href: e.meet, target: '_blank', rel: 'noopener' }, 'Join the call') : null,
        e.link ? h('a', { class: 'btn-small', href: e.link, target: '_blank', rel: 'noopener' }, 'Open in Google Calendar') : null)),
  });
}

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
    h('span', { class: 'cal-chip-text' }, e.title));

const taskChip = (t) =>
  h('a', { class: 'cal-chip cal-task', href: `#/todos?filter=${t.projectId ?? 'personal'}`, title: `Task due: ${t.text}` },
    icon('check-square'), h('span', { class: 'cal-chip-text' }, t.text));

const openDay = (store, d) => () => {
  view.mode = 'day';
  view.date = isoOf(d);
  store.refresh();
};

// --- Time grid (day and week), laid out as Google Calendar does ---

const HOUR = 48; // px per hour
const DAY_MS = 86400000;
// Whole-day events, and timed ones that last a day or more, go in the strip above the hours.
const isLong = (e) => e.allDay || eventDate(e.end || e.start) - eventDate(e.start) >= DAY_MS;
const midnight = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
// Days between two midnights; rounded, so a daylight-saving change does not shift a column.
const dayIndex = (from, d) => Math.round((midnight(d) - from) / DAY_MS);
const hourLabel = (hour) => new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' });
// "2 PM" or "2:30 PM": the minutes only when there are some, as Google's grid shows them.
const shortClock = (d) => d.toLocaleTimeString([], { hour: 'numeric', ...(d.getMinutes() ? { minute: '2-digit' } : {}) });

// The part of each timed event that falls on day `d`, in hours from midnight.
function segmentsOf(timed, d) {
  const next = addDays(d, 1);
  const hoursOf = (x) => (x >= next ? 24 : x <= d ? 0 : x.getHours() + x.getMinutes() / 60);
  return timed.filter((e) => onDay(e, d)).map((e) => {
    const top = Math.min(hoursOf(eventDate(e.start)), 23.5);
    return { e, top, bottom: Math.max(hoursOf(eventDate(e.end || e.start)), top + 0.5) };
  });
}

// Events that overlap share the width: each takes the first free column of its cluster.
function placeSegments(segs) {
  segs.sort((x, y) => x.top - y.top || y.bottom - x.bottom);
  let cluster = [];
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
  return segs;
}

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
    h('span', { class: 'cal-event-title' }, e.title),
    h('span', { class: 'cal-event-time' }, `${shortClock(eventDate(e.start))} – ${shortClock(eventDate(e.end || e.start))}`),
    e.location && !short ? h('span', { class: 'cal-event-place' }, e.location) : null);
}

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
    }, h('span', { class: 'cal-chip-text' }, e.title));
  });
  const due = tasks.map((t) => {
    const chip = taskChip(t);
    chip.style.gridColumn = String(dayIndex(from, eventDate(t.due)) + 1);
    return chip;
  });
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
    h('div', { class: 'cal-grid-scroll', onscroll: (ev) => { view.scroll = ev.currentTarget.scrollTop; } },
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

function monthView(store, from, to, month, events, tasks) {
  const days = [];
  for (let d = from; d < to; d = addDays(d, 1)) days.push(d);
  return h('div', { class: 'card cal-month' },
    h('div', { class: 'cal-month-grid cal-month-head', 'aria-hidden': 'true' },
      days.slice(0, 7).map((d) => h('span', null, d.toLocaleDateString([], { weekday: 'short' })))),
    h('div', { class: 'cal-month-grid' },
      days.map((d) => {
        const list = events.filter((e) => onDay(e, d));
        const due = tasks.filter((t) => t.due === isoOf(d));
        const items = [...list.map((e) => eventChip(store, e, { time: false })), ...due.map(taskChip)];
        const today = d.toDateString() === new Date().toDateString();
        return h('div', { class: ['cal-cell', d.getMonth() === month ? '' : 'outside', today ? 'today' : ''].filter(Boolean).join(' ') },
          h('button', { type: 'button', class: 'cal-cell-date', onclick: openDay(store, d), 'aria-label': d.toLocaleDateString([], { dateStyle: 'full' }) }, d.getDate()),
          items.slice(0, MONTH_CELL),
          items.length > MONTH_CELL ? h('button', { type: 'button', class: 'cal-more', onclick: openDay(store, d) }, `+${items.length - MONTH_CELL} more`) : null);
      })));
}

// The calendars of every account as a searchable tree: each account (with its Google picture) and its calendars.
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
    onToggle: ({ account, id }, next) => {
      if (id) return setCalendar(store, account, id, { on: next });
      const a = calendarAccounts(store).find((x) => x.email === account);
      if (a) setCalendarAccount(store, account, { calendars: a.calendars.map((c) => ({ ...c, on: next })) });
    },
  });
}

// A small month to jump to any day, as in Google's side column. Its arrows page through months on their own.
function miniMonth(store, d, from, to) {
  const month = view.mini ? eventDate(view.mini) : new Date(d.getFullYear(), d.getMonth(), 1);
  const [first, last] = rangeOf('month', month);
  const days = [];
  for (let x = first; x < last; x = addDays(x, 1)) days.push(x);
  const today = new Date().toDateString();
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

// --- Page ---

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
  const byProject = (x) => view.project === 'all' ||
    (labelFilter ? underLabel(projects, x.projectId, x.labelId ?? null, labelFilter) : x.projectId === view.project);
  const events = cached.events.filter(byProject);
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
            onPick: (v) => { view.project = v ?? 'all'; store.refresh(); },
          })
        : null,
      h('label', { class: 'check row' },
        h('input', { type: 'checkbox', checked: view.tasks, onchange: (e) => { view.tasks = e.target.checked; store.refresh(); } }), 'Task deadlines')));

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
      h('header', null,
        h('h2', null, 'Calendar'),
        h('p', { class: 'muted small' }, 'Your Google calendars side by side, with task deadlines on their days. Read-only.')),
      ...banners,
      h('div', { class: 'cal-layout' },
        side,
        h('div', { class: 'stack cal-main' }, toolbar, body))));
  if (view.mode !== 'month') scrollGrid(root, from, days);
}

export default {
  id: 'calendar',
  title: 'Calendar',
  icon: 'calendar',
  collection: null,
  render: draw,
  serialize: () => ({ mode: view.mode === 'week' ? '' : view.mode, date: view.date, project: view.project === 'all' ? '' : view.project, tasks: view.tasks ? '' : '0' }),
  restore: (p = {}) => {
    view.mode = MODES.some(([k]) => k === p.mode) ? p.mode : 'week';
    view.date = /^\d{4}-\d{2}-\d{2}$/.test(p.date ?? '') ? p.date : '';
    view.project = p.project || 'all';
    view.tasks = p.tasks !== '0';
  },
};
