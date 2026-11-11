// Google, read-only, straight from the browser (Google Identity Services): Analytics and Search Console.
// One access token covers the services you connected. Calendar (js/gcal.js) and Gmail sign in per account instead. It lives in memory only and lasts about an hour,
// so reconnecting is one click.
import { h } from './ui.js';

const SCOPES = {
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  search: 'https://www.googleapis.com/auth/webmasters.readonly',
};
const GIS_SRC = 'https://accounts.google.com/gsi/client';

let token = null; // { value, expiresAt, scopes: Set }
let loading = null;

// Gmail and Calendar sign in to each of its accounts with the same library.
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
// True when the current session covers the service: 'analytics' or 'search'.
export const isConnected = (service) => live() && token.scopes.has(SCOPES[service]);

// Opens Google's consent window. Must run from a click, or the browser blocks it.
// Services already connected in this session stay connected.
export async function connect(clientId, service) {
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

// --- Account pictures ---
// Gmail and Calendar also ask for the basic profile, only to show each account's Google picture. The picture's URL is
// kept in this browser (localStorage), so it shows before the account signs in again this session.
export const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';
const PICTURE_PREFIX = 'board:google-picture:';

// Reads the signed-in account's picture with a fresh token and keeps it. Without the profile scope, nothing happens.
export async function rememberPicture(address, accessToken, grantedScope) {
  if (!String(grantedScope ?? '').split(' ').includes(PROFILE_SCOPE)) return;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessToken}` } });
    const { picture = '' } = res.ok ? await res.json() : {};
    if (picture) localStorage.setItem(PICTURE_PREFIX + address, picture);
  } catch {
    /* the letter stands in */
  }
}

export function pictureOf(address) {
  try {
    return localStorage.getItem(PICTURE_PREFIX + address) ?? '';
  } catch {
    return '';
  }
}

// A round avatar for a Google account: its picture, or its first letter when there is none or it fails to load.
export function accountAvatar(address, className = 'account-avatar') {
  const letter = () => h('span', { class: `${className} is-letter`, 'aria-hidden': 'true' }, (address[0] ?? '?').toUpperCase());
  const url = pictureOf(address);
  if (!url) return letter();
  // Google's picture host refuses some requests that carry a referrer.
  const img = h('img', { class: className, src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(letter()), { once: true });
  return img;
}
