// Slack's Web API for the Slack tab, called from Node: a browser session's token only works with its `d` cookie, and
// a page cannot set a Cookie header. The tab sends the token and cookie with each call (POST /slack, /slack/file).
/** @import { RequestBody } from '../types/runner' */

const METHOD = /^[a-z]+(\.[a-zA-Z]+)+$/;
const FILE_MAX = 8 * 1024 * 1024;

/** @param {string} message @param {number} status */
const fail = (message, status) => Object.assign(new Error(message), { status });

// The cookie as Slack sets it is URL-encoded; one copied decoded (with / or +) is encoded again.
/** @param {string} cookie */
const cookieHeader = (cookie) => {
  const value = cookie.trim().replace(/^d=/, '');
  return `d=${value.includes('%') ? value : encodeURIComponent(value)}`;
};

// The workspace's own address when it is a Slack one, so calls land on the right team; slack.com otherwise.
/** @param {unknown} url */
function base(url) {
  try {
    const u = new URL(String(url ?? ''));
    if (u.protocol === 'https:' && /(^|\.)slack\.com$/.test(u.hostname)) return `https://${u.hostname}/api/`;
  } catch {
    // no workspace address yet (the first auth.test)
  }
  return 'https://slack.com/api/';
}

/** @param {RequestBody} body */
function credentials(body) {
  const token = String(body.token ?? '').trim();
  const cookie = String(body.cookie ?? '').trim();
  if (!/^xox[a-z]-/.test(token)) throw fail('A Slack token starts with xoxc-.', 400);
  return { token, cookie };
}

// One Web API call: { method, params, token, cookie, url }. Answers Slack's JSON, with { ok: false, error } as Slack
// reports it; a rate limit adds retryAfter (seconds).
/** @param {RequestBody} body */
export async function slackCall(body) {
  const method = String(body.method ?? '');
  if (!METHOD.test(method)) throw fail(`Not a Slack method: ${method}`, 400);
  const { token, cookie } = credentials(body);
  const form = new URLSearchParams({ token });
  for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (body.params ?? {}))) {
    if (v === undefined || v === null) continue;
    form.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  }
  let res;
  try {
    res = await fetch(base(body.url) + method, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie: cookieHeader(cookie) } : {}) },
      body: form,
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    const cause = /** @type {{ cause?: { message?: string } }} */ (err).cause?.message;
    throw new Error(`Could not reach Slack: ${cause ?? /** @type {Error} */ (err).message}`);
  }
  if (res.status === 429) return { ok: false, error: 'ratelimited', retryAfter: Number(res.headers.get('retry-after')) || 30 };
  const answer = await res.json().catch(() => null);
  if (!answer) return { ok: false, error: `Slack answered ${res.status} without JSON.` };
  return answer;
}

// A file Slack keeps behind the session (an image a message shares), as a data: URL the page can show.
/** @param {RequestBody} body */
export async function slackFile(body) {
  const { cookie, token } = credentials(body);
  const url = new URL(String(body.file ?? ''));
  if (url.protocol !== 'https:' || !/(^|\.)(slack\.com|slack-edge\.com)$/.test(url.hostname)) throw fail('Only Slack files can be read.', 400);
  const res = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, ...(cookie ? { cookie: cookieHeader(cookie) } : {}) },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) return { ok: false, error: `Slack answered ${res.status}.` };
  const type = res.headers.get('content-type') ?? 'application/octet-stream';
  // A sign-in page instead of the file means the session is not accepted.
  if (type.startsWith('text/html')) return { ok: false, error: 'Slack did not accept the session for this file.' };
  const bytes = Buffer.from(await res.arrayBuffer());
  if (bytes.length > FILE_MAX) return { ok: false, error: 'The file is too large to show here.' };
  return { ok: true, dataUrl: `data:${type};base64,${bytes.toString('base64')}` };
}
