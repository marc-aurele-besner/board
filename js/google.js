// @ts-check
// Google, read-only, straight from the browser. Every sign-in (Gmail and Calendar per account, Analytics and Search
// Console together) is kept in google.json in the data folder, with a refresh token, so any browser profile that opens
// the folder is connected; the runners renew each access token before it expires. Nothing is kept in the browser.
// The token handling without the DOM is in google-core.js, which the runners load too.
import { h } from './ui.js';
import { GOOGLE, GOOGLE_DEFAULTS, WEB, scopeOf, SERVICE_SCOPES, googleData, saveGoogleData, bindGoogleStore, useRenewer, tokenRequest, hasToken, tokenScopes, removeToken, accessToken, isConnected, googleFetch } from './google-core.js';
import { runJob } from './runners.js';
/** @import { Store, GoogleSignIn } from '../types/data' */
/** @import { WebService } from './google-core.js' */
/**
 * A new sign-in, before it is saved.
 * @typedef {Omit<GoogleSignIn, 'at' | 'removed'>} NewSignIn
 */

export { GOOGLE, GOOGLE_DEFAULTS, googleData, saveGoogleData, hasToken, tokenScopes, accessToken, isConnected, googleFetch };

const REVOKE = 'https://oauth2.googleapis.com/revoke';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const SIGN_IN_WAIT = 5 * 60 * 1000;

/** @type {Store | null} */
let store = null;
const tokens = () => googleData().tokens;

// Gives google.json's store to the Google modules. Runs once the data folder is open.
// The runners renew every token (tools/jobs/google.js). A tab that finds one expired asks them, then reads the
// renewed token from google.json; it never renews one itself, so the two never fight over a refresh token.
/** @param {Store} next */
export function useGoogleStore(next) {
  store = next;
  bindGoogleStore(next);
  useRenewer(async (key) => {
    await runJob('google', { key });
    await /** @type {Store} */ (store).sync();
    const token = tokens()[key];
    if (token?.removed || !token?.refresh) throw new Error('Google signed this account out. Connect it again.');
    if (!token.access || !(token.expiresAt > Date.now())) throw new Error('Google sign-in could not be renewed. Check Settings → Runners.');
    return token.access;
  });
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

/** @param {ArrayBuffer | Uint8Array} bytes */
const base64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const randomText = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

/** @type {{ reject: (err: Error) => void } | null} */
let pending = null;

// Opens Google's sign-in in a popup. Must run from a click, or the browser blocks it. Google answers on oauth.html,
// which hands the code back over a BroadcastChannel: Google's pages cut the link between a popup and its opener.
// Resolves to { refresh, access, expiresAt, scope }.
/**
 * @param {{ scopes: string[], address?: string }} options
 * @returns {Promise<NewSignIn>}
 */
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
  // What oauth.html passes on from Google's redirect.
  /** @type {{ state?: string, code?: string, error?: string }} */
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
  const body = await tokenRequest({ grant_type: 'authorization_code', code: /** @type {string} */ (answer.code), code_verifier: verifier, redirect_uri: redirectUri() });
  if (!body.refresh_token) throw new Error('Google sent no refresh token. Try connecting again.');
  return { refresh: body.refresh_token, access: body.access_token, expiresAt: Date.now() + Number(body.expires_in) * 1000, scope: body.scope ?? '' };
}

/**
 * @param {string} key
 * @param {NewSignIn} token
 */
export function saveToken(key, token) {
  /** @type {Store} */ (store).update(GOOGLE, (d) => {
    d.tokens[key] = { ...token, at: Date.now() };
  });
}

// Removes a sign-in. Revoking at Google ends every sign-in of that account to this client (Gmail and Calendar
// share it), so a Gmail or Calendar one is revoked only when the other service is not connected to the same account.
// `revoke: false` keeps it alive at Google.
/**
 * @param {string} key
 * @param {{ revoke?: boolean }} [options]
 */
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

// --- Analytics and Search Console ---
// One sign-in covers both. Connecting the second asks for both permissions again.

/**
 * @param {unknown} _clientId
 * @param {WebService} service
 */
export async function connect(_clientId, service) {
  const wanted = new Set([...(hasToken(WEB) ? tokenScopes(WEB).filter((s) => SERVICE_SCOPES.includes(s)) : []), scopeOf(service)]);
  const token = await signIn({ scopes: [...wanted] });
  if (!token.scope.split(' ').includes(scopeOf(service))) throw new Error('Google did not grant this permission. Tick its box on the consent screen.');
  // The new sign-in replaces the old one. Neither is revoked: the account may also be connected to Gmail or Calendar,
  // and revoking would sign those out too.
  saveToken(WEB, token);
}

export const disconnect = () => forgetToken(WEB, { revoke: false });

// --- Account pictures ---
// Gmail and Calendar also ask for the basic profile, only to show each account's Google picture. Its URL is kept in
// google.json.
export const PROFILE_SCOPE = 'https://www.googleapis.com/auth/userinfo.profile';

// Reads the signed-in account's picture with a fresh token and keeps it. Without the profile scope, nothing happens.
/**
 * @param {string} address
 * @param {string} accessValue
 * @param {string | undefined} grantedScope
 */
export async function rememberPicture(address, accessValue, grantedScope) {
  if (!String(grantedScope ?? '').split(' ').includes(PROFILE_SCOPE)) return;
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers: { Authorization: `Bearer ${accessValue}` } });
    /** @type {{ picture?: string }} */
    const { picture = '' } = res.ok ? await res.json() : {};
    if (picture && store) store.update(GOOGLE, (d) => {
      d.pictures[address] = picture;
    });
  } catch {
    /* the letter stands in */
  }
}

/** @param {string} address */
export const pictureOf = (address) => googleData().pictures[address] ?? '';

// A round avatar for a Google account: its picture, or its first letter when there is none or it fails to load.
/** @param {string} address */
export function accountAvatar(address, className = 'account-avatar') {
  const letter = () => h('span', { class: `${className} is-letter`, 'aria-hidden': 'true' }, (address[0] ?? '?').toUpperCase());
  const url = pictureOf(address);
  if (!url) return letter();
  // Google's picture host refuses some requests that carry a referrer.
  const img = h('img', { class: className, src: url, alt: '', referrerpolicy: 'no-referrer', loading: 'lazy' });
  img.addEventListener('error', () => img.replaceWith(letter()), { once: true });
  return img;
}
