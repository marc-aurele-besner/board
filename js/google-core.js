// Google sign-ins without the DOM: google.json's tokens, the token request, and live access tokens. The board and the
// runners (tools/worker.js) both load it. Only the runners renew a token (tools/jobs/google.js): two renewers on one
// refresh token would fight. The board asks them through `useRenewer`, see js/google.js.

export const GOOGLE = 'google';
// tokens: { "<gmail|gcal>:<address>" or "web": { refresh, access, expiresAt, scope, at } }; pictures: { <address>: url }.
export const GOOGLE_DEFAULTS = { tokens: {}, pictures: {} };

const TOKEN = 'https://oauth2.googleapis.com/token';
// An access token is renewed this long before it expires, so a read never starts with one about to lapse.
export const EARLY = 5 * 60 * 1000;

const SCOPES = {
  analytics: 'https://www.googleapis.com/auth/analytics.readonly',
  search: 'https://www.googleapis.com/auth/webmasters.readonly',
};
export const WEB = 'web';
export const scopeOf = (service) => SCOPES[service];
export const SERVICE_SCOPES = Object.values(SCOPES);

let store = null;
export const googleStore = () => store;
const data = () => store?.get(GOOGLE) ?? GOOGLE_DEFAULTS;
const tokens = () => data().tokens;

export const googleData = data;
export const saveGoogleData = (mutate) => store?.save(GOOGLE, mutate);
export const bindGoogleStore = (next) => {
  store = next;
};

// Gets a live access token for a sign-in whose token expired: the runners request one, the board asks the runners.
let renewer = null;
export const useRenewer = (fn) => {
  renewer = fn;
};

export async function tokenRequest(fields) {
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

export const hasToken = (key) => Boolean(tokens()[key]?.refresh);
export const tokenScopes = (key) => String(tokens()[key]?.scope ?? '').split(' ').filter(Boolean);
// Whether a token is still good for `margin` more milliseconds.
export const tokenFresh = (key, margin = EARLY) => {
  const t = tokens()[key];
  return Boolean(t?.access && t.expiresAt - margin > Date.now());
};

// A removed sign-in leaves { removed: true, at }, so a tab that still holds the old one takes the removal in
// instead of writing the sign-in back.
export const removeToken = (key) => store.update(GOOGLE, (d) => {
  d.tokens[key] = { removed: true, at: Date.now() };
});

// Renews one sign-in's access token at Google and saves it. The runners' job only: see the note at the top.
export async function renewToken(key) {
  const token = tokens()[key];
  if (!token?.refresh) throw new Error('Not connected to Google.');
  try {
    const body = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refresh });
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

const renewing = new Map();

// A live access token for a sign-in, renewed first when it is close to expiring (or when `force` is set, after
// Google refused it).
export function accessToken(key, force = false) {
  if (!hasToken(key)) return Promise.reject(new Error('Not connected to Google.'));
  if (!force && tokenFresh(key)) return Promise.resolve(tokens()[key].access);
  if (!renewer) return Promise.reject(new Error('Google sign-ins cannot be renewed here.'));
  if (!renewing.has(key)) renewing.set(key, Promise.resolve().then(() => renewer(key, force)).finally(() => renewing.delete(key)));
  return renewing.get(key);
}

// True when the sign-in covers the service: 'analytics' or 'search'.
export const isConnected = (service) => hasToken(WEB) && tokenScopes(WEB).includes(SCOPES[service]);

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
