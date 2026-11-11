// Calendar: the events of every connected Google account, by day, week or month, with task deadlines on the same days.
// Events of the range on screen show from the browser's cache at once, then are read again when the cache is stale. Settings → Google Calendar lists the accounts.
import { h, icon, refreshIcon, notice, statusOf, empty } from '../ui.js';
import { projectIcon, projectTree, labelsOf, underLabel } from './projects.js';
import { setupBanner } from '../integrations.js';
import { calendarAccounts, calendarEvents, cachedCalendarEvents, CALENDAR_TTL, connectCalendar, isCalendarConnected, setCalendar, eventDate, calendarProject, calendarLabel } from '../gcal.js';
import { makeTask } from '../capture.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';

const MODES = [['day', 'Day'], ['week', 'Week'], ['month', 'Month']];
const MONTH_CELL = 3; // events listed in a month cell before "+N more"

// View state. date: the day the view is anchored on, YYYY-MM-DD.
const view = { mode: 'week', date: '', project: 'all', tasks: true };
// The last read: the range and calendars it covered, so a change of either reads again. at: when the oldest of its
// events was read from Google; checked: when the board last asked, so a stale view refreshes itself once per TTL.
const read = { key: '', busy: false, events: [], errors: [], waiting: [], at: 0, checked: 0 };

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

function load(store, key, from, to, { maxAge } = {}) {
  // A new range shows what the cache has right away; a refresh of the same range keeps what is on screen.
  if (read.key !== key) Object.assign(read, cachedCalendarEvents(store, from, to), { errors: [], waiting: [] });
  read.key = key;
  read.busy = true;
  read.checked = Date.now();
  store.refresh();
  calendarEvents(store, from, to, { maxAge })
    .then(({ events, errors, waiting, at }) => {
      if (read.key !== key) return;
      Object.assign(read, { events, errors, waiting, at });
    })
    .catch((err) => {
      if (read.key === key) Object.assign(read, { events: [], errors: [err.message] });
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

function dayHead(d, { long = false, onclick } = {}) {
  const today = d.toDateString() === new Date().toDateString();
  return h('button', { type: 'button', class: today ? 'cal-day-head today' : 'cal-day-head', onclick, title: 'Show this day' },
    h('span', { class: 'cal-weekday' }, d.toLocaleDateString([], { weekday: long ? 'long' : 'short' })),
    h('span', { class: 'cal-date' }, d.getDate()));
}

const openDay = (store, d) => () => {
  view.mode = 'day';
  view.date = isoOf(d);
  store.refresh();
};

function dayView(store, d, events, tasks) {
  const list = events.filter((e) => onDay(e, d));
  const due = tasks.filter((t) => t.due === isoOf(d));
  if (!list.length && !due.length) return h('div', { class: 'card' }, empty('Nothing on this day.'));
  return h('section', { class: 'card' },
    h('ul', { class: 'cal-agenda' },
      list.map((e) =>
        h('li', null,
          h('button', { type: 'button', class: 'cal-agenda-row', style: { '--c': e.color || 'var(--accent)' }, onclick: () => openEvent(store, e) },
            h('span', { class: 'cal-agenda-time' }, e.allDay ? 'All day' : `${clock(eventDate(e.start))} – ${clock(eventDate(e.end || e.start))}`),
            h('span', { class: 'gcal-swatch' }),
            h('span', { class: 'grow cal-agenda-text' },
              h('strong', null, e.title),
              h('span', { class: 'muted small' }, [e.location, e.calendar].filter(Boolean).join(' · ')))))),
      due.map((t) => h('li', null, taskChip(t)))));
}

function weekView(store, from, events, tasks) {
  return h('div', { class: 'cal-week' },
    Array.from({ length: 7 }, (_, i) => {
      const d = addDays(from, i);
      const list = events.filter((e) => onDay(e, d));
      const due = tasks.filter((t) => t.due === isoOf(d));
      return h('section', { class: 'card cal-col' },
        dayHead(d, { onclick: openDay(store, d) }),
        h('div', { class: 'cal-items' },
          list.map((e) => eventChip(store, e)),
          due.map(taskChip),
          !list.length && !due.length ? h('span', { class: 'muted small cal-free' }, 'Free') : null));
    }));
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

// The calendars of every account, as chips that show or hide them.
function legend(store, accounts) {
  const all = accounts.flatMap((a) => a.calendars.map((c) => ({ a, c })));
  if (!all.length) return null;
  return h('div', { class: 'cal-legend', role: 'group', 'aria-label': 'Calendars' },
    all.map(({ a, c }) =>
      h('button', {
        type: 'button',
        class: c.on ? 'cal-toggle on' : 'cal-toggle',
        style: { '--c': c.color || 'var(--accent)' },
        'aria-pressed': String(c.on),
        title: `${c.name} · ${a.email}`,
        onclick: () => setCalendar(store, a.email, c.id, { on: !c.on }),
      }, h('span', { class: 'gcal-swatch' }), c.name)));
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
  const stale = connected.length && !read.busy && Date.now() - read.checked > CALENDAR_TTL;
  if (accounts.length && (key !== read.key || stale)) queueMicrotask(() => load(store, key, from, to));

  // Events carry their calendar's label; tasks only have their project's.
  const byProject = (x) => view.project === 'all' ||
    (labelFilter ? underLabel(projects, x.projectId, x.labelId ?? null, labelFilter) : x.projectId === view.project);
  const events = read.key === key ? read.events.filter(byProject) : [];
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

  const toolbar = h('div', { class: 'row between cal-toolbar' },
    h('div', { class: 'row' },
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Previous', title: 'Previous', onclick: () => { step(-1); store.refresh(); } }, icon('chevron-left')),
      h('button', { type: 'button', class: 'btn-small', onclick: () => { view.date = ''; store.refresh(); } }, 'Today'),
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Next', title: 'Next', onclick: () => { step(1); store.refresh(); } }, icon('chevron-right')),
      h('h3', { class: 'cal-title' }, titleOf(view.mode, d))),
    h('div', { class: 'row' },
      h('select', { 'aria-label': 'Project', onchange: (e) => { view.project = e.target.value; store.refresh(); } },
        h('option', { value: 'all', selected: view.project === 'all' }, 'All projects'),
        projects.filter((p) => linked.has(p.id) || p.id === view.project).map((p) => h('option', { value: p.id, selected: p.id === view.project }, p.name)),
        labels.some((c) => linkedLabels.has(c.id) || c.id === labelFilter)
          ? h('optgroup', { label: 'Project labels' },
              labels.filter((c) => linkedLabels.has(c.id) || c.id === labelFilter)
                .map((c) => h('option', { value: `label:${c.id}`, selected: c.id === labelFilter }, c.name)))
          : null),
      h('label', { class: 'check row' },
        h('input', { type: 'checkbox', checked: view.tasks, onchange: (e) => { view.tasks = e.target.checked; store.refresh(); } }), 'Task deadlines'),
      h('button', {
        type: 'button',
        class: 'btn-small',
        disabled: read.busy || !connected.length,
        onclick: () => load(store, key, from, to, { maxAge: 0 }),
      }, refreshIcon(read.busy), read.busy ? 'Reading…' : 'Refresh'),
      read.key === key && read.at ? h('span', { class: 'muted small', title: new Date(read.at).toLocaleString() }, `Updated ${ago(read.at)}`) : null));

  const offline = accounts.filter((a) => !isCalendarConnected(a.email));
  const banners = [
    !clientId ? setupBanner('google', 'Calendar needs a Google OAuth Client ID.') : null,
    clientId && !accounts.length ? setupBanner('google', 'Add a Google account to see its calendars here.') : null,
    clientId && offline.length
      ? notice({
          tone: 'info',
          text: connected.length ? 'Some accounts are not connected this session.' : 'Connect your accounts to read their events. A connection lasts about an hour.',
          actions: offline.map((a) => h('button', { type: 'button', class: 'btn-small', onclick: () => connectAccount(store, clientId, a.email) }, icon('plus'), a.email)),
        })
      : null,
    read.key === key && read.errors.length ? notice({ text: read.errors.join('\n') }) : null,
  ].filter(Boolean);

  const body = view.mode === 'day' ? dayView(store, d, events, tasks)
    : view.mode === 'week' ? weekView(store, from, events, tasks)
      : monthView(store, from, to, d.getMonth(), events, tasks);

  root.replaceChildren(
    h('div', { class: 'stack-lg calendar' },
      h('header', { class: 'row between' },
        h('div', null,
          h('h2', null, 'Calendar'),
          h('p', { class: 'muted small' }, 'Your Google calendars side by side, with task deadlines on their days. Read-only.')),
        h('div', { class: 'segmented cal-modes', role: 'group', 'aria-label': 'View' },
          MODES.map(([k, label]) => h('button', {
            type: 'button',
            class: view.mode === k ? 'seg active' : 'seg',
            'aria-pressed': String(view.mode === k),
            onclick: () => { view.mode = k; store.refresh(); },
          }, label)))),
      ...banners,
      legend(store, accounts),
      toolbar,
      body));
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
