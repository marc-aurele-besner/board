// The board's side of LinkedIn's official sign-in: the popup, and the runners' trade of its code for a token.
// What runs without the DOM (the trade itself, posting) is in linkedin-core.js.
import { workerCall } from './runners.js';
import { LINKEDIN, LINKEDIN_AUTHORIZE, LINKEDIN_SCOPES } from './linkedin-core.js';
/** @import { Store, LinkedinAuth, LinkedinSettings } from '../types/data' */

const SIGN_IN_WAIT = 5 * 60000;
// The redirect address to add to the app. oauth.html hands the code back over a BroadcastChannel.
export const linkedinRedirect = () => `${location.origin}/oauth.html`;

/** @param {Store} store */
export const linkedinApp = (store) => /** @type {LinkedinSettings} */ (store.get('settings').linkedin ?? {});

// Opens LinkedIn's sign-in in a popup (from a click, or the browser blocks it), waits for oauth.html to pass the code
// on, and has the runners trade it for a token, saved in linkedin.json.
/** @param {Store} store @returns {Promise<LinkedinAuth>} */
export async function linkedinSignIn(store) {
  const { clientId, clientSecret } = linkedinApp(store);
  if (!clientId || !clientSecret) throw new Error('Save the app’s Client ID and Client Secret first.');
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: linkedinRedirect(), scope: LINKEDIN_SCOPES, state });
  const popup = window.open(`${LINKEDIN_AUTHORIZE}?${params}`, 'board-linkedin-sign-in', 'width=600,height=760');
  if (!popup) throw new Error('The browser blocked LinkedIn’s sign-in. Allow popups for the board and try again.');
  /** @type {{ state?: string, code?: string, error?: string }} */
  const answer = await new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('board-oauth');
    const timer = setTimeout(() => {
      channel.close();
      reject(new Error('LinkedIn’s sign-in was not finished.'));
    }, SIGN_IN_WAIT);
    channel.onmessage = ({ data: msg }) => {
      if (msg?.state !== state) return;
      clearTimeout(timer);
      channel.close();
      resolve(msg);
    };
  });
  if (answer.error || !answer.code) {
    throw new Error(answer.error === 'user_cancelled_login' || answer.error === 'user_cancelled_authorize' ? 'LinkedIn’s sign-in was cancelled.' : `LinkedIn sign-in error: ${answer.error ?? 'no code'}`);
  }
  const auth = /** @type {LinkedinAuth} */ (await workerCall('POST', '/linkedin/token', { clientId, clientSecret, code: answer.code, redirectUri: linkedinRedirect() }, 30000));
  store.update(LINKEDIN, (d) => {
    d.auth = auth;
  });
  return auth;
}

/** @param {Store} store */
export function linkedinSignOut(store) {
  store.update(LINKEDIN, (d) => {
    d.auth = null;
  });
}
