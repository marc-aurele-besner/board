// Google, read-only, straight from the browser (Google Identity Services): Calendar, Analytics and Search Console.
// One access token covers the services you connected. It lives in memory only and lasts about an hour,
// so reconnecting is one click.
const SCOPES = {
  calendar: 'https://www.googleapis.com/auth/calendar.readonly',
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  search: 'https://www.googleapis.com/auth/webmasters.readonly',
};
const GIS_SRC = 'https://accounts.google.com/gsi/client';
const EVENTS = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

let token = null; // { value, expiresAt, scopes: Set }
let loading = null;

// Gmail (js/gmail.js) signs in to each of its accounts with the same library.
export function loadGis() {
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

const live = () => Boolean(token && token.expiresAt > Date.now());
// True when the current session covers the service: 'calendar' (default), 'analytics' or 'search'.
export const isConnected = (service = 'calendar') => live() && token.scopes.has(SCOPES[service]);

// Opens Google's consent window. Must run from a click, or the browser blocks it.
// Services already connected in this session stay connected.
export async function connect(clientId, service = 'calendar') {
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings first.');
  await loadGis();
  const wanted = new Set([...(live() ? token.scopes : []), SCOPES[service]]);
  return new Promise((resolve, reject) => {
    const client = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope: [...wanted].join(' '),
      callback: (resp) => {
        if (resp.error) return reject(new Error(resp.error_description || resp.error));
        const granted = new Set(String(resp.scope ?? '').split(' ').filter(Boolean));
        token = { value: resp.access_token, expiresAt: Date.now() + (Number(resp.expires_in) - 60) * 1000, scopes: granted.size ? granted : wanted };
        if (!token.scopes.has(SCOPES[service])) return reject(new Error('Google did not grant this permission. Tick its box on the consent screen.'));
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

// A signed request to a Google API. `name` is how the service is called in error messages.
export async function googleFetch(service, name, url, options = {}) {
  if (!isConnected(service)) throw new Error(`Connect ${name} in Settings first.`);
  const res = await fetch(url, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${token.value}` } });
  if (res.status === 401) {
    token = null;
    throw new Error('The Google session expired. Connect again.');
  }
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    throw new Error(`${name} error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// Events from now until `days` ahead, in start order.
export async function upcomingEvents(days = 2) {
  const start = new Date();
  const end = new Date(start.getTime() + days * 86400000);
  const params = new URLSearchParams({
    timeMin: start.toISOString(),
    timeMax: end.toISOString(),
    singleEvents: 'true',
    orderBy: 'startTime',
    maxResults: '50',
  });
  const { items = [] } = await googleFetch('calendar', 'Google Calendar', `${EVENTS}?${params}`);
  return items.map((e) => ({
    id: e.id,
    title: e.summary ?? '(no title)',
    start: e.start?.dateTime ?? e.start?.date,
    allDay: Boolean(e.start?.date),
    location: e.location ?? '',
  }));
}
