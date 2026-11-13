// LinkedIn through the saved session (Settings → LinkedIn: li_at and JSESSIONID): the one entry point for every read of
// LinkedIn's internal "voyager" API, the one its own pages call. No DOM; the runners import this file.
//
// Contract
//
//   linkedinCall(store, { path, cacheKey?, maxAge?, method?, headers?, signal? }) → Promise<unknown>
//     path      the part after https://www.linkedin.com/voyager/api/ (query string included), e.g.
//               'organization/companies?q=universalName&universalName=acme'
//     cacheKey  names the question; when linkedin.json `cache[cacheKey]` is younger than maxAge, its answer is
//               returned without calling LinkedIn (and without waiting in the queue). Give one to every read that
//               can be repeated (prefix it with your feature: 'company:acme', 'post:<urn>:stats').
//     maxAge    ms, DEFAULT_MAX_AGE (7 days) by default; 0 never reuses (the answer is still saved).
//     method    'GET' by default. headers: extra request headers. signal: stops waiting (runners only).
//     Answers LinkedIn's parsed JSON (null for an empty body).
//
//   Every call goes through one queue in the runners: one call at a time, 20 to 40 s apart (the pace survives a
//   restart), at most settings.linkedin.dailyLimit (60 by default) a day, counted in linkedin.json session.calls.
//   So a call can take minutes: start it from a job, a Cron step or a button that shows it is waiting, never on render.
//   In the runners it runs the queue directly (tools/linkedin-session.js, set with useLinkedinSession at startup).
//   In a tab it asks the runners: POST /linkedin/voyager { path, cacheKey, maxAge, method, headers }.
//
//   It throws a LinkedinSessionError whose `code` is:
//     'no-session'  no li_at / JSESSIONID saved in Settings → LinkedIn
//     'signed-out'  LinkedIn ended the session (302, 401, 999, or it cleared li_at). Every later call throws this
//                   until the session is saved again in Settings; the user is notified once.
//     'limit'       today's calls reached the daily limit
//     'http'        any other non-2xx answer; `status` holds it (404: no such page)
//     'runners'     a tab could not reach the runners
//   A plain Error (aborted, network down) can also come through.
//
//   linkedinQueue() → Promise<{ pending, nextAt }> in a tab: calls waiting and when the next may start (ms).
//   sessionState(store) → what Settings shows: saved, expiredAt, error, today, limit, lastCallAt.
/** @import { DataStore, LinkedinSettings } from '../types/data' */
import { workerCall } from './runners.js';
import { LINKEDIN } from './linkedin-core.js';
import { todayISO } from './ui.js';

export const DEFAULT_DAILY_LIMIT = 60;
export const DEFAULT_MAX_AGE = 7 * 24 * 3600000;
// A tab waits this long for its answer: a full queue of calls 40 s apart.
const TAB_TIMEOUT_MS = 30 * 60000;

/**
 * @typedef {{ path: string, cacheKey?: string, maxAge?: number, method?: string, headers?: Record<string, string>, signal?: AbortSignal }} LinkedinRequest
 * @typedef {(store: DataStore, req: LinkedinRequest) => Promise<unknown>} LinkedinCaller
 * @typedef {'no-session' | 'signed-out' | 'limit' | 'http' | 'runners'} LinkedinErrorCode
 */

export class LinkedinSessionError extends Error {
  /** @param {LinkedinErrorCode} code @param {string} message @param {number} [status] */
  constructor(code, message, status) {
    super(message);
    this.name = 'LinkedinSessionError';
    this.code = code;
    this.status = status;
  }
}

// The cookies as Settings keeps them, cleaned of what a copy from the developer tools may carry. Null when not saved.
/** @param {LinkedinSettings | undefined} saved */
export function sessionCookies(saved) {
  const liAt = String(saved?.liAt ?? '').trim().replace(/^li_at=/, '');
  const jsessionid = String(saved?.jsessionid ?? '').trim().replace(/^JSESSIONID=/, '').replace(/"/g, '');
  return liAt && jsessionid ? { liAt, jsessionid } : null;
}

/** @param {LinkedinSettings | undefined} saved */
export const dailyLimit = (saved) => {
  const n = Number(saved?.dailyLimit);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : DEFAULT_DAILY_LIMIT;
};

/** @param {DataStore} store */
export function sessionState(store) {
  const saved = store.get('settings').linkedin;
  const session = store.get(LINKEDIN).session ?? { calls: {} };
  return {
    saved: Boolean(sessionCookies(saved)),
    expiredAt: session.expiredAt ?? null,
    error: session.error ?? null,
    today: session.calls?.[todayISO()] ?? 0,
    limit: dailyLimit(saved),
    lastCallAt: session.lastCallAt ?? null,
  };
}

/** @type {LinkedinCaller | null} */
let direct = null;
// The runners set the queue itself at startup (tools/worker.js); a tab leaves it unset and asks the runners.
/** @param {LinkedinCaller} fn */
export const useLinkedinSession = (fn) => {
  direct = fn;
};

/** @param {DataStore} store @param {LinkedinRequest} req @returns {Promise<unknown>} */
export async function linkedinCall(store, req) {
  if (direct) return direct(store, req);
  const { signal: _, ...wire } = req;
  let answer;
  try {
    answer = await workerCall('POST', '/linkedin/voyager', wire, TAB_TIMEOUT_MS);
  } catch (err) {
    throw new LinkedinSessionError('runners', /** @type {Error} */ (err).message);
  }
  if (!answer.ok) throw new LinkedinSessionError(answer.code ?? 'http', answer.error ?? 'LinkedIn failed.', answer.status);
  return answer.value;
}

/** @returns {Promise<{ pending: number, nextAt: number | null }>} */
export const linkedinQueue = () => workerCall('GET', '/linkedin/queue', null, 3000);
