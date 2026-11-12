// Google Calendar, read-only. Like Gmail, each account signs in on its own, so several accounts can be shown side by
// side. Sign-ins are kept in google.json and renewed by the runners (see js/google-core.js).
// settings.json keeps gcal: { accounts: [{ email, projectId, labelId, calendars: [{ id, name, color, on, projectId, labelId }] }] }.
// The account's project and project label are optional defaults; a calendar's own ones win. The runners
// (tools/jobs/calendar.js) read every shown calendar's window, from the start of last month to three months ahead, into
// calendar.json every 10 minutes. The board only reads that file, and asks the runners for a range outside it.
import { PROFILE_SCOPE, rememberPicture, signIn, saveToken, forgetToken, hasToken, accessToken } from './google.js';
import { runJob, jobState } from './runners.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const PAGE = 250;
const MAX_PAGES = 4;

const keyOf = (address) => `gcal:${address}`;

// --- Event cache ---
// calendar.json: { calendars: { "<address>|<calendarId>": [{ from, to, at, events }] } }, each calendar's reads, newest
// first: the window, plus the last few ranges read outside it. A read is used for any range it covers.
export const CALENDAR = 'calendar';
export const CALENDAR_DEFAULTS = { calendars: {} };
export const CALENDAR_TTL = 10 * 60 * 1000;
const CACHE_READS = 7; // the window and 6 more
const cacheKey = (address, calendarId) => `${address}|${calendarId}`;

// The range the runners keep read: the start of last month to the end of the third month ahead.
export function calendarWindow(now = new Date()) {
  return [new Date(now.getFullYear(), now.getMonth() - 1, 1), new Date(now.getFullYear(), now.getMonth() + 4, 1)];
}

function cachedReads(store, address, calendarId) {
  const list = store.get(CALENDAR)?.calendars?.[cacheKey(address, calendarId)];
  return Array.isArray(list) ? list : [];
}

function cacheRead(store, address, calendarId, from, to, events) {
  const read = { from: from.getTime(), to: to.getTime(), at: Date.now(), events };
  // Reads the new one covers are dropped.
  const kept = cachedReads(store, address, calendarId).filter((r) => r.from < read.from || r.to > read.to);
  store.save(CALENDAR, (d) => {
    d.calendars = { ...d.calendars, [cacheKey(address, calendarId)]: [read, ...kept].slice(0, CACHE_READS) };
  });
}

// The newest cached read of a calendar that covers [from, to), with only the events in that range, or null.
function fromCache(store, account, cal, from, to) {
  const hit = cachedReads(store, account.email, cal.id).find((r) => r.from <= from.getTime() && r.to >= to.getTime());
  if (!hit) return null;
  // Same overlap rule as Google's timeMin/timeMax. The calendar's name, project and label are taken from settings, as they may
  // have changed since the read.
  const events = hit.events
    .filter((e) => eventDate(e.start) < to && eventDate(e.end || e.start) > from)
    .map((e) => ({ ...e, calendar: cal.name, projectId: calendarProject(account, cal), labelId: calendarLabel(account, cal) }));
  return { at: hit.at, events };
}

export function clearCalendarCache(store, address = '') {
  store.save(CALENDAR, (d) => {
    d.calendars = Object.fromEntries(Object.entries(d.calendars ?? {}).filter(([key]) => address && !key.startsWith(`${address}|`)));
  });
}

export const calendarAccounts = (store) => store.get('settings').gcal?.accounts ?? [];
export const isCalendarConnected = (address) => hasToken(keyOf(address));
export const anyCalendarConnected = (store) => calendarAccounts(store).some((a) => isCalendarConnected(a.email));

async function call(value, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${value}` } });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    const err = new Error(res.status === 401 ? 'Google Calendar refused the sign-in. Connect again.' : `Google Calendar error ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function get(address, path) {
  if (!isCalendarConnected(address)) throw new Error(`Connect ${address} to read its calendars.`);
  try {
    return await call(await accessToken(keyOf(address)), path);
  } catch (err) {
    if (err.status !== 401) throw err;
    // Refused before it expired: renewed once and tried again.
    return call(await accessToken(keyOf(address), true), path);
  }
}

// The calendars an account can see, in Google's order, primary first.
async function listCalendars(address) {
  const { items = [] } = await get(address, '/users/me/calendarList?minAccessRole=reader');
  return items
    .filter((c) => !c.deleted)
    .sort((a, b) => Number(Boolean(b.primary)) - Number(Boolean(a.primary)))
    .map((c) => ({ id: c.id, name: c.summaryOverride || c.summary || c.id, color: c.backgroundColor || '', primary: Boolean(c.primary), hidden: Boolean(c.hidden) }));
}

// Opens Google's sign-in. Must run from a click. With an address it reconnects that account; without one Google asks
// which account to add. Resolves to the address that signed in.
export async function connectCalendar(_clientId, address = '') {
  // The profile is only read for the account's picture.
  const token = await signIn({ scopes: [SCOPE, PROFILE_SCOPE], address });
  if (!token.scope.split(' ').includes(SCOPE)) throw new Error('Google did not grant calendar access. Tick its box on the consent screen.');
  // The primary calendar's id is the account's address, so no profile scope is needed.
  const { id } = await call(token.access, '/calendars/primary');
  const signedIn = String(id ?? '').toLowerCase();
  if (address && signedIn !== address) throw new Error(`You signed in as ${signedIn}, not ${address}.`);
  saveToken(keyOf(signedIn), token);
  await rememberPicture(signedIn, token.access, token.scope);
  return signedIn;
}

export const disconnectCalendar = (address) => forgetToken(keyOf(address));

const saveAccounts = (store, mutate) => store.update('settings', (d) => {
  d.gcal = { ...d.gcal, accounts: mutate(d.gcal?.accounts ?? []) };
});

// Reads an account's calendar list into settings. Calendars it already had keep their choices; new ones are shown
// unless Google hides them; ones that are gone are dropped.
export async function syncCalendarList(store, address) {
  const fresh = await listCalendars(address);
  saveAccounts(store, (accounts) => {
    const before = accounts.find((a) => a.email === address);
    const old = new Map((before?.calendars ?? []).map((c) => [c.id, c]));
    const calendars = fresh.map((c) => {
      const kept = old.get(c.id);
      return { id: c.id, name: c.name, color: c.color, on: kept ? kept.on : !c.hidden, projectId: kept?.projectId ?? null, labelId: kept?.labelId ?? null };
    });
    return before ? accounts.map((a) => (a.email === address ? { ...a, calendars } : a)) : [...accounts, { email: address, calendars }];
  });
}

export const removeCalendarAccount = (store, address) => {
  disconnectCalendar(address);
  clearCalendarCache(store, address);
  saveAccounts(store, (accounts) => accounts.filter((a) => a.email !== address));
};

// Changes an account's saved fields: { projectId } or { labelId }.
export const setCalendarAccount = (store, address, patch) => saveAccounts(store, (accounts) =>
  accounts.map((a) => (a.email === address ? { ...a, ...patch } : a)));

// The project and project label a calendar's events carry: its own, else its account's. Both may be empty.
export const calendarProject = (account, cal) => cal.projectId ?? account.projectId ?? null;
export const calendarLabel = (account, cal) => cal.labelId ?? account.labelId ?? null;

// The connected Calendar addresses that feed a project: through the account itself or one of its shown calendars.
export const connectedCalendarsOf = (store, projectId) => calendarAccounts(store)
  .filter((a) => isCalendarConnected(a.email)
    && (a.projectId === projectId || (a.calendars ?? []).some((c) => c.on && calendarProject(a, c) === projectId)))
  .map((a) => a.email);

// Changes one calendar's saved fields: { on }, { projectId } or { labelId }.
export const setCalendar = (store, address, calendarId, patch) => saveAccounts(store, (accounts) =>
  accounts.map((a) => (a.email !== address ? a : { ...a, calendars: a.calendars.map((c) => (c.id === calendarId ? { ...c, ...patch } : c)) })));

const eventOf = (account, cal, e) => ({
  key: `${account.email}|${cal.id}|${e.id}`,
  account: account.email,
  calendarId: cal.id,
  calendar: cal.name,
  color: e.backgroundColor || cal.color,
  projectId: calendarProject(account, cal),
  labelId: calendarLabel(account, cal),
  title: e.summary ?? '(no title)',
  // All-day events give dates; their end date is the day after the last one.
  start: e.start?.dateTime ?? e.start?.date ?? '',
  end: e.end?.dateTime ?? e.end?.date ?? '',
  allDay: Boolean(e.start?.date),
  location: e.location ?? '',
  description: e.description ?? '',
  link: e.htmlLink ?? '',
  meet: e.hangoutLink ?? '',
});

async function eventsOf(account, cal, from, to) {
  const out = [];
  let pageToken = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      timeMin: from.toISOString(),
      timeMax: to.toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: String(PAGE),
      ...(pageToken ? { pageToken } : {}),
    });
    const { items = [], nextPageToken } = await get(account.email, `/calendars/${encodeURIComponent(cal.id)}/events?${params}`);
    out.push(...items.filter((e) => e.status !== 'cancelled').map((e) => eventOf(account, cal, e)));
    if (!nextPageToken) break;
    pageToken = nextPageToken;
  }
  return out;
}

const byDay = (a, b) => eventDate(a.start).setHours(0, 0, 0, 0) - eventDate(b.start).setHours(0, 0, 0, 0)
  || Number(b.allDay) - Number(a.allDay) || eventDate(a.start) - eventDate(b.start);

// Reads every shown calendar of every connected account into calendar.json: the window, or [from, to). Runners only.
// Returns { read: calendars read, errors: [text], waiting: [addresses not connected] }.
export async function readCalendars(store, { from, to } = {}) {
  const [start, end] = from && to ? [new Date(from), new Date(to)] : calendarWindow();
  const errors = [];
  const waiting = [];
  let read = 0;
  for (const account of calendarAccounts(store)) {
    if (!isCalendarConnected(account.email)) {
      waiting.push(account.email);
      continue;
    }
    for (const cal of account.calendars.filter((c) => c.on)) {
      try {
        cacheRead(store, account.email, cal.id, start, end, await eventsOf(account, cal, start, end));
        read += 1;
      } catch (err) {
        // The last read stays while Google cannot be reached.
        errors.push(`${cal.name}: ${err.message}`);
      }
    }
  }
  return { read, errors, waiting };
}

// How a range outside the cache gets read: the board asks the runners; the runners read it themselves.
let rangeReader = async (store, from, to) => {
  await runJob('calendar', { from: from.toISOString(), to: to.toISOString() });
  await store.sync();
};
export const useRangeReader = (fn) => {
  rangeReader = fn;
};

// Events of every shown calendar of every account between two dates, in day order, from calendar.json. A range it does
// not cover yet is read first (see rangeReader). Accounts not connected show their cached events, of any age.
// Returns { events, errors: [text], waiting: [addresses not connected], at: time of the oldest read used, or 0 }.
export async function calendarEvents(store, from, to) {
  const errors = [];
  const missing = calendarAccounts(store).some((a) => isCalendarConnected(a.email)
    && a.calendars.some((c) => c.on && !fromCache(store, a, c, from, to)));
  if (missing) {
    try {
      await rangeReader(store, from, to);
    } catch (err) {
      errors.push(err.message);
    }
  }
  const { events, at } = cachedCalendarEvents(store, from, to);
  const last = jobState('calendar');
  if (last?.ok === false) errors.push(last.error);
  else errors.push(...(last?.errors ?? []));
  const waiting = calendarAccounts(store).filter((a) => !isCalendarConnected(a.email)).map((a) => a.email);
  return { events, errors, waiting, at };
}

// What the cache already holds for a range, without asking Google: shown while a read is on its way.
export function cachedCalendarEvents(store, from, to) {
  const events = [];
  const times = [];
  for (const account of calendarAccounts(store)) {
    for (const cal of account.calendars.filter((c) => c.on)) {
      const cached = fromCache(store, account, cal, from, to);
      if (!cached) continue;
      events.push(...cached.events);
      times.push(cached.at);
    }
  }
  events.sort(byDay);
  return { events, at: times.length ? Math.min(...times) : 0 };
}

// "2026-11-11" or a date-time, as a local Date. A bare date is midnight local time, not UTC.
export const eventDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value));
