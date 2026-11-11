// Google, read-only, straight from the browser. Every sign-in (Gmail and Calendar per account, Analytics and Search
// Console together) is kept in google.json in the data folder, with a refresh token, so any browser profile that opens
// the folder is connected and the board renews each access token before it expires. Nothing is kept in the browser.
import { h } from './ui.js';

export const GOOGLE = 'google';
// tokens: { "<gmail|gcal>:<address>" or "web": { refresh, access, expiresAt, scope, at } }
// pictures: { <address>: url }; events: { "<address>|<calendarId>": [{ from, to, at, events }] }, Calendar's cache.
export const GOOGLE_DEFAULTS = { tokens: {}, pictures: {}, events: {} };

const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const REVOKE = 'https://oauth2.googleapis.com/revoke';
// An access token is renewed this long before it expires, so a read never starts with one about to lapse.
const EARLY = 5 * 60 * 1000;
const SIGN_IN_WAIT = 5 * 60 * 1000;

const SCOPES = {
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  search: 'https://www.googleapis.com/auth/webmasters.readonly',
};
const WEB = 'web';

let store = null;
const data = () => store?.get(GOOGLE) ?? GOOGLE_DEFAULTS;
const tokens = () => data().tokens;

// google.json for the other Google modules: Calendar keeps its event cache in it. Saved without a re-render.
export const googleData = data;
export const saveGoogleData = (mutate) => store?.save(GOOGLE, mutate);

// Gives google.json's store to the Google modules. Runs once the data folder is open.
export function useGoogleStore(next) {
  store = next;
  // Earlier versions kept tokens, pictures and the event cache in the browser; none of it is read any more.
  try {
    for (const key of Object.keys(localStorage)) {
      if (/^board:(google-token|google-picture|gcal):/.test(key)) localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked */
  }
}

// The redirect address to register on the OAuth client in Google Cloud Console.
export const redirectUri = () => `${location.origin}/oauth.html`;

const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

async function tokenRequest(fields) {
  const { clientId = '', clientSecret = '' } = store?.get('settings').google ?? {};
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, ...fields }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(body.error_description || body.error || `Google sign-in error ${res.status}`);
    err.code = body.error ?? '';
    throw err;
  }
  return body;
}

let pending = null;

// Opens Google's sign-in in a popup. Must run from a click, or the browser blocks it. Google answers on oauth.html,
// which hands the code back over a BroadcastChannel: Google's pages cut the link between a popup and its opener.
// Resolves to { refresh, access, expiresAt, scope }.
export async function signIn({ scopes, address = '' }) {
  const { clientId, clientSecret } = store?.get('settings').google ?? {};
  if (!clientId) throw new Error('Add your Google OAuth Client ID in Settings → Google Calendar first.');
  if (!clientSecret) throw new Error('Add your Google OAuth Client secret in Settings → Google Calendar first.');
  const state = randomText();
  const verifier = randomText();
  const challenge = base64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri(),
    response_type: 'code',
    scope: scopes.join(' '),
    // A refresh token comes only with offline access, and only when the consent screen shows.
    access_type: 'offline',
    prompt: address ? 'consent' : 'consent select_account',
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...(address ? { login_hint: address } : {}),
  });
  const popup = window.open(`${AUTH}?${params}`, 'board-google-sign-in', 'width=500,height=650');
  if (!popup) throw new Error('The browser blocked Google sign-in. Allow popups for the board and try again.');

  pending?.reject(new Error('Another Google sign-in was started.'));
  const answer = await new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('board-oauth');
    const done = () => {
      clearTimeout(timer);
      channel.close();
      pending = null;
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error('Google sign-in was not finished.'));
    }, SIGN_IN_WAIT);
    pending = { reject: (err) => { done(); reject(err); } };
    channel.onmessage = ({ data: msg }) => {
      if (msg?.state !== state) return;
      done();
      resolve(msg);
    };
  });
  if (answer.error) throw new Error(answer.error === 'access_denied' ? 'Google sign-in was cancelled.' : `Google sign-in error: ${answer.error}`);
  const body = await tokenRequest({ grant_type: 'authorization_code', code: answer.code, code_verifier: verifier, redirect_uri: redirectUri() });
  if (!body.refresh_token) throw new Error('Google sent no refresh token. Try connecting again.');
  return { refresh: body.refresh_token, access: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000, scope: body.scope ?? '' };
}

export const hasToken = (key) => Boolean(tokens()[key]?.refresh);
export const tokenScopes = (key) => String(tokens()[key]?.scope ?? '').split(' ').filter(Boolean);

export function saveToken(key, token) {
  store.update(GOOGLE, (d) => {
    d.tokens[key] = { ...token, at: Date.now() };
  });
}

// A removed sign-in leaves { removed: true, at }, so a profile that still holds the old one in memory takes the
// removal in (see mergeFromDisk) instead of writing the sign-in back.
const removeToken = (key) => store.update(GOOGLE, (d) => {
  d.tokens[key] = { removed: true, at: Date.now() };
});

// Removes a sign-in. Revoking at Google ends every sign-in of that account to this client (Gmail and Calendar
// share it), so a Gmail or Calendar one is revoked only when the other service is not connected to the same account.
// `revoke: false` keeps it alive at Google.
export function forgetToken(key, { revoke = true } = {}) {
  const token = tokens()[key];
  if (!token?.refresh) return;
  const [, address] = key.split(':');
  const shared = address && Object.entries(tokens()).some(([k, t]) => k !== key && t.refresh && k.split(':')[1] === address);
  if (revoke && address && !shared) {
    fetch(REVOKE, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ token: token.refresh }) }).catch(() => {});
  }
  removeToken(key);
}

const refreshing = new Map();

async function renew(key) {
  const token = tokens()[key];
  try {
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh });
    // Saved without a re-render: nothing on screen changes.
    store.save(GOOGLE, (d) => {
      if (!d.tokens[key]) return;
      Object.assign(d.tokens[key], {
        access: body.access_token,
        expiresAt: Date.now() + Number(body.expires_in) * 1000,
        ...(body.refresh_token ? { refresh: body.refresh_token } : {}),
        at: Date.now(),
      });
    });
    return body.access_token;
  } catch (err) {
    // Revoked, expired or the password changed: the sign-in is gone for good. Other failures are tried again later.
    if (err.code === 'invalid_grant') {
      removeToken(key);
      throw new Error('Google signed this account out. Connect it again.');
    }
    throw err;
  }
}

// A live access token for a sign-in, renewed first when it is close to expiring (or when `force` is set, after
// Google refused it).
export function accessToken(key, force = false) {
  const token = tokens()[key];
  if (!token?.refresh) return Promise.reject(new Error('Not connected to Google.'));
  if (!force && token.access && token.expiresAt - EARLY > Date.now()) return Promise.resolve(token.access);
  if (!refreshing.has(key)) refreshing.set(key, renew(key).finally(() => refreshing.delete(key)));
  return refreshing.get(key);
}

// Another profile may have the folder open too and written google.json since it was loaded. Its newer sign-ins
// and pictures are taken in, so this profile does not write over them with older ones.
async function mergeFromDisk() {
  let disk;
  try {
    disk = JSON.parse(await (await store.files.read(`${GOOGLE}.json`)).text());
  } catch {
    return;
  }
  const ours = data();
  const newer = Object.entries(disk.tokens ?? {}).filter(([key, t]) => t && (t.at ?? 0) > (ours.tokens[key]?.at ?? 0));
  const pictures = Object.entries(disk.pictures ?? {}).filter(([address, url]) => url && !ours.pictures[address]);
  if (!newer.length && !pictures.length) return;
  store.update(GOOGLE, (d) => {
    for (const [key, t] of newer) d.tokens[key] = t;
    for (const [address, url] of pictures) d.pictures[address] = url;
  });
}

// Renews every access token that expires soon. Runs from the background timer.
export async function refreshTokens() {
  if (!store) return;
  await mergeFromDisk();
  for (const [key, token] of Object.entries(tokens())) {
    if (token.refresh && !(token.expiresAt - 2 * EARLY > Date.now())) {
      await accessToken(key, true).catch((err) => console.warn(`Google token ${key} was not renewed:`, err.message));
    }
  }
}

// --- Analytics and Search Console ---
// One sign-in covers both. Connecting the second asks for both permissions again.

// True when the sign-in covers the service: 'analytics' or 'search'.
export const isConnected = (service) => hasToken(WEB) && tokenScopes(WEB).includes(SCOPES[service]);

export async function connect(_clientId, service) {
  const wanted = new Set([...(hasToken(WEB) ? tokenScopes(WEB).filter((s) => Object.values(SCOPES).includes(s)) : []), SCOPES[service]]);
  const token = await signIn({ scopes: [...wanted] });
  if (!token.scope.split(' ').includes(SCOPES[service])) throw new Error('Google did not grant this permission. Tick its box on the consent screen.');
  // The new sign-in replaces the old one. Neither is revoked: the account may also be connected to Gmail or Calendar,
  // and revoking would sign those out too.
  saveToken(WEB, token);
}

export const disconnect = () => forgetToken(WEB, { revoke: false });

// A signed request to a Google API. `name` is how the service is called in error messages.
export async function googleFetch(service, name, url, options = {}) {
  if (!isConnected(service)) throw new Error(`Connect ${name} in Settings first.`);
  const send = async (force) => fetch(url, { ...options, headers: { ...(options.headers ?? {}), Authorization: `Bearer ${await accessToken(WEB, force)}` } });
  let res = await send(false);
  if (res.status === 401) res = await send(true);
  if (res.status === 401) throw new Error('Google refused the sign-in. Connect again.');
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    throw new Error(`${name} error ${res.status}${detail ? `: ${detail}` : ''}`);
  }
  return res.json();
}

// --- Account pictures ---
// Gmail and Calendar also ask for the basic profile, only to show each account's Google picture. Its URL is kept in
// google.json.
export const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

// Reads the signed-in account's picture with a fresh token and keeps it. Without the profile scope, nothing happens.
export async function rememberPicture(address, accessValue, grantedScope) {
  if (!String(grantedScope ?? '').split(' ').includes(PROFILE_SCOPE)) return;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessValue}` } });
    const { picture = '' } = res.ok ? await res.json() : {};
    if (picture && store) store.update(GOOGLE, (d) => {
      d.pictures[address] = picture;
    });
  } catch {
    /* the letter stands in */
  }
}

export const pictureOf = (address) => data().pictures[address] ?? '';

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
