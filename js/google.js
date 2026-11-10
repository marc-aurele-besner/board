// Google Calendar, read-only, straight from the browser (Google Identity Services).
// The access token lives in memory only and lasts about an hour, so reconnecting is one click.
const SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

let token = null; // { value, expiresAt }
let loading = null;

function loadGis() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.onload = resolve;
    script.onerror = () => {
      loading = null;
      reject(new Error('Could not load Google sign-in. Check your connection.'));
    };
    document.head.append(script);
  });
  return loading;
}

export const isConnected = () => Boolean(token && token.expiresAt > Date.now());

// Opens Google's consent window. Must run from a click, or the browser blocks it.
export async function connect(clientId) {
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings first.');
  await loadGis();
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: SCOPE,
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) - 60) * 1000 };
        resolve();
      },
      error_callback: (err) => reject(new Error(err?.message || 'Google sign-in was closed.')),
    });
    client.requestAccessToken({ prompt: '' });
  });
}

export function disconnect() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token.value, () => {});
  token = null;
}

// Events from now until `days` ahead, in start order.
export async function upcomingEvents(days = 2) {
  if (!isConnected()) throw new Error('Connect Google Calendar in Settings first.');
  const start = new Date();
  const end = new Date(start.getTime() + days * 86400000);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const res = await fetch(`${EVENTS}?${params}`, { headers: { Authorization: `Bearer ${token.value}` } });
  if (res.status === 401) {
    token = null;
    throw new Error('The Google session expired. Connect again.');
  }
  if (!res.ok) throw new Error(`Google Calendar error ${res.status}`);
  const { items = [] } = await res.json();
  return items.map((e) => ({
    id: e.id,
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date,
    allDay: Boolean(e.start?.date),
    location: e.location ?? '',
  }));
}
