// Google Calendar, read-only, straight from the browser. Like Gmail, each account signs in on its own, so several
// accounts can be shown side by side. Tokens live in memory only and last about an hour.
// settings.json keeps gcal: { accounts: [{ email, calendars: [{ id, name, color, on, projectId }] }] }; events are not saved.
import { loadGis } from './google.js';

const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const API = 'https://www.googleapis.com/calendar/v3';
const PAGE = 250;
const MAX_PAGES = 4;

const tokens = new Map(); // address -> { value, expiresAt }

export const calendarAccounts = (store) => store.get('settings').gcal?.accounts ?? [];
export const isCalendarConnected = (address) => (tokens.get(address)?.expiresAt ?? 0) > Date.now();
export const anyCalendarConnected = (store) => calendarAccounts(store).some((a) => isCalendarConnected(a.email));

async function call(value, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${value}` } });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    const err = new Error(res.status === 401 ? 'The Google Calendar session expired. Connect again.' : `Google Calendar error ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function get(address, path) {
  if (!isCalendarConnected(address)) throw new Error(`Connect ${address} to read its calendars.`);
  try {
    return await call(tokens.get(address).value, path);
  } catch (err) {
    if (err.status === 401) tokens.delete(address);
    throw err;
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
export async function connectCalendar(clientId, address = '') {
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings → Google Calendar first.');
  await loadGis();
  const value = await new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      // Other Google services granted earlier are not mixed into a calendar account's token.
      include_granted_scopes: false,
      ...(address ? { login_hint: address } : {}),
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        if (!String(resp.scope ?? '').split(' ').includes(SCOPE)) return reject(new Error('Google did not grant calendar access. Tick its box on the consent screen.'));
        resolve({ value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) - 60) * 1000 });
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google sign-in was closed.')),
    });
    client.requestAccessToken({ prompt: address ? '' : 'select_account' });
  });
  // The primary calendar's id is the account's address, so no profile scope is needed.
  const { id } = await call(value.value, '/calendars/primary');
  const signedIn = String(id ?? '').toLowerCase();
  if (address && signedIn !== address) throw new Error(`You signed in as ${signedIn}, not ${address}.`);
  tokens.set(signedIn, value);
  return signedIn;
}

export function disconnectCalendar(address) {
  const token = tokens.get(address);
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.value, () => {});
  tokens.delete(address);
}

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
      return { id: c.id, name: c.name, color: c.color, on: kept ? kept.on : !c.hidden, projectId: kept?.projectId ?? null };
    });
    return before ? accounts.map((a) => (a.email === address ? { ...a, calendars } : a)) : [...accounts, { email: address, calendars }];
  });
}

export const removeCalendarAccount = (store, address) => {
  disconnectCalendar(address);
  saveAccounts(store, (accounts) => accounts.filter((a) => a.email !== address));
};

// Changes one calendar's saved fields: { on } or { projectId }.
export const setCalendar = (store, address, calendarId, patch) => saveAccounts(store, (accounts) =>
  accounts.map((a) => (a.email !== address ? a : { ...a, calendars: a.calendars.map((c) => (c.id === calendarId ? { ...c, ...patch } : c)) })));

const eventOf = (account, cal, e) => ({
  key: `${account.email}|${cal.id}|${e.id}`,
  account: account.email,
  calendarId: cal.id,
  calendar: cal.name,
  color: e.backgroundColor || cal.color,
  projectId: cal.projectId ?? null,
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

// Events of every shown calendar of every connected account between two dates, in day order.
// Returns { events, errors: [text], waiting: [addresses not connected this session] }.
export async function calendarEvents(store, from, to) {
  const events = [];
  const errors = [];
  const waiting = [];
  await Promise.all(calendarAccounts(store).map(async (account) => {
    if (!isCalendarConnected(account.email)) {
      waiting.push(account.email);
      return;
    }
    await Promise.all(account.calendars.filter((c) => c.on).map(async (cal) => {
      try {
        events.push(...await eventsOf(account, cal, from, to));
      } catch (err) {
        errors.push(`${cal.name}: ${err.message}`);
      }
    }));
  }));
  // By day, then all-day events first, then by time.
  events.sort((a, b) => eventDate(a.start).setHours(0, 0, 0, 0) - eventDate(b.start).setHours(0, 0, 0, 0)
    || Number(b.allDay) - Number(a.allDay) || eventDate(a.start) - eventDate(b.start));
  return { events, errors, waiting };
}

// "2026-11-11" or a date-time, as a local Date. A bare date is midnight local time, not UTC.
export const eventDate = (value) => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value));
