// Emails sent and received through Resend, one API key per project. Read-only.
// Resend sends no CORS header, so a web page cannot read its answers: the runners (tools/jobs/resend.js) read the
// lists into inbox.json, and the board asks them for one email's body or a key check.
import { hostOf } from './sitecheck.js';
import { workerCall } from './runners.js';
/** @import { DataStore, InboxMessage, Project, ResendSettings, RunnerJobError } from '../types/data' */
/**
 * An email in a Resend list or read alone, as far as it is read.
 * @typedef {{ id: string, from?: string, to?: string | string[], cc?: string | string[], subject?: string, created_at?: string, scheduled_at?: string, last_event?: string, html?: string, text?: string, reply_to?: string | string[], bcc?: string | string[] }} ResendEmail
 */
/** @typedef {{ html: string, text: string, replyTo: string[], bcc: string[] }} ResendBody */
/** @typedef {Pick<InboxMessage, 'id' | 'dir' | 'from' | 'to' | 'cc' | 'subject' | 'at' | 'status'>} ResendRow */

const API = 'https://api.resend.com';
const PAGE = 100;
// The first read of a key goes back this many pages per direction; later reads stop at the newest email already saved.
const FIRST_PAGES = 5;
// Kept per project, newest first, so inbox.json stays small.
const KEEP = 1000;
// Resend allows a few requests per second per team. Requests are spaced out across every key.
const GAP_MS = 550;

/** @type {Promise<unknown>} */
let queue = Promise.resolve();
/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {DataStore} store
 * @returns {Partial<ResendSettings>}
 */
export const resendSettings = (store) => store.get('settings').resend ?? { keys: {} };
// Projects that have a key, in project order.
/** @param {DataStore} store */
export const keyedProjects = (store) => {
  const { keys = {} } = resendSettings(store);
  return store.get('projects').projects.filter((p) => keys[p.id]);
};

/**
 * @param {number} status
 * @param {{ name?: string, message?: string } | null} body
 */
function explain(status, body) {
  if (body?.name === 'restricted_api_key') return 'This key can only send emails. Create a key with Full access in Resend.';
  if (status === 401 || status === 403 || body?.name === 'validation_error') return 'Resend rejected this key.';
  if (status === 429) return 'Resend is limiting requests. Try again in a minute.';
  return body?.message ? `Resend: ${body.message}` : `Resend error ${status}`;
}

// One GET to Resend, queued behind every other Resend request. Runs in the runners only.
/**
 * @param {string} key
 * @param {string} path
 * @returns {Promise<unknown>}
 */
function get(key, path) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, { headers: { Authorization: `Bearer ${key}`, 'user-agent': 'board-runners' } });
      } catch {
        throw new Error('Could not reach Resend. Check the connection.');
      }
      const body = await res.json().catch(() => null);
      if (res.ok) return body;
      if (res.status === 429 && attempt < 2) {
        await wait(1500);
        continue;
      }
      throw new Error(explain(res.status, body));
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => wait(GAP_MS));
  return result;
}

// Runners side of Settings' key check.
/** @param {string} key */
export async function checkResendKey(key) {
  const { data = [] } = /** @type {{ data?: ResendEmail[] }} */ (await get(key, '/emails?limit=1'));
  return data.length ? 'Connected. Emails can be read.' : 'Connected. No emails sent yet.';
}

// Settings → Resend: checks a key through the runners.
/** @param {string} key */
export const checkResend = async (key) => (await workerCall('POST', '/resend/check', { key }, 30000)).text;

/** @param {string} dir */
const listPath = (dir) => (dir === 'sent' ? '/emails' : '/emails/receiving');

// Newest first, until a page reaches an email already known, or the page limit.
/**
 * @param {string} key
 * @param {string} dir
 * @param {Set<string>} known
 */
async function listNew(key, dir, known) {
  /** @type {ResendEmail[]} */
  const out = [];
  let after = '';
  for (let page = 0; page < (known.size ? 50 : FIRST_PAGES); page++) {
    const { data = [], has_more: more } = /** @type {{ data?: ResendEmail[], has_more?: boolean }} */ (await get(key, `${listPath(dir)}?limit=${PAGE}${after ? `&after=${after}` : ''}`));
    out.push(...data);
    if (!more || !data.length || data.some((e) => known.has(e.id))) break;
    after = data[data.length - 1].id;
  }
  return out;
}

/** @param {unknown} v */
const addresses = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
// "Name <a@b.com>" -> "b.com"
/** @param {string} address */
const domainOf = (address) => (address.match(/@([^\s>]+)/)?.[1] ?? '').toLowerCase();

// When several projects share one Resend account, an email goes to the project whose website matches
// the sending address (sent) or a receiving address (received). Otherwise to the first of them.
/**
 * @param {Project[]} projects
 * @param {ResendRow} row
 */
function ownerOf(projects, row) {
  if (projects.length === 1) return projects[0].id;
  const domains = (row.dir === 'sent' ? [row.from] : row.to).map(domainOf).filter(Boolean);
  const match = projects.find((p) => {
    const host = p.website ? hostOf(p.website).replace(/^www\./, '') : '';
    return host && domains.some((d) => d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`));
  });
  return (match ?? projects[0]).id;
}

/**
 * @param {ResendEmail} e
 * @param {string} dir
 * @returns {ResendRow}
 */
const rowOf = (e, dir) => ({
  id: e.id,
  dir,
  from: String(e.from ?? ''),
  to: addresses(e.to),
  cc: addresses(e.cc),
  subject: String(e.subject ?? ''),
  at: e.created_at ?? '',
  status: dir === 'sent' ? (e.scheduled_at && !e.last_event ? 'scheduled' : e.last_event ?? '') : '',
});

// Reads every key's new emails into inbox.json. Returns { added, errors: [{ projectIds, text }] }. Runners only.
/** @param {DataStore} store */
export async function syncInbox(store) {
  const { keys = {} } = resendSettings(store);
  const projects = keyedProjects(store);
  /** @type {Map<string, Project[]>} */
  const groups = new Map();
  for (const p of projects) groups.set(keys[p.id], [...(groups.get(keys[p.id]) ?? []), p]);

  const saved = store.get('inbox').emails;
  /** @type {(ResendRow & { projectId: string, unread: boolean })[]} */
  const fresh = [];
  /** @type {RunnerJobError[]} */
  const errors = [];
  for (const [key, group] of groups) {
    /** @type {Set<string | null>} */
    const ids = new Set(group.map((p) => p.id));
    for (const dir of ['sent', 'received']) {
      const known = new Set(saved.filter((e) => e.dir === dir && ids.has(e.projectId)).map((e) => e.id));
      try {
        const rows = (await listNew(key, dir, known)).map((e) => rowOf(e, dir));
        // A key's first read brings in its history; only mail that arrives after it counts as unread.
        const unread = dir === 'received' && known.size > 0;
        fresh.push(...rows.map((r) => ({ ...r, projectId: ownerOf(group, r), unread })));
      } catch (err) {
        errors.push({ projectIds: /** @type {string[]} */ ([...ids]), dir, text: /** @type {Error} */ (err).message });
        // A failed key fails both directions the same way; the second request would only repeat the error.
        if (dir === 'sent') break;
      }
    }
  }

  let added = 0;
  store.update('inbox', (d) => {
    const byId = new Map(d.emails.map((e) => [e.id, e]));
    for (const r of fresh) {
      const old = byId.get(r.id);
      if (!old) added++;
      // The status of a sent email moves on (delivered, then opened or bounced); read, star, archive and task stay.
      byId.set(r.id, old ? { ...old, ...r, unread: Boolean(old.unread) } : { ...r, taskId: null });
    }
    /** @type {Set<string | null>} */
    const live = new Set(projects.map((p) => p.id));
    /** @type {Map<string | null, number>} */
    const perProject = new Map();
    // Rows with a source (Gmail) are kept and trimmed by their own reader.
    d.emails = [...byId.values()]
      .filter((e) => e.source || live.has(e.projectId))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .filter((e) => {
        if (e.source) return true;
        const n = (perProject.get(e.projectId) ?? 0) + 1;
        perProject.set(e.projectId, n);
        return n <= KEEP;
      });
    d.syncedAt = new Date().toISOString();
  });
  return { added, errors };
}

// The full email (html and text) as the runners read it, by the id of its row in inbox.json.
/**
 * @param {DataStore} store
 * @param {string} id
 * @returns {Promise<ResendBody>}
 */
export async function readEmailOf(store, id) {
  const row = store.get('inbox').emails.find((e) => e.id === id && !e.source);
  if (!row) throw new Error('This email is not in the Inbox any more.');
  // Resend rows always carry their project.
  const key = resendSettings(store).keys?.[/** @type {string} */ (row.projectId)];
  if (!key) throw new Error('This project has no Resend key any more.');
  const e = /** @type {ResendEmail} */ (await get(key, `${listPath(row.dir)}/${encodeURIComponent(row.id)}`));
  return { html: e.html ?? '', text: e.text ?? '', replyTo: addresses(e.reply_to), bcc: addresses(e.bcc) };
}

// The full email, read when it is opened, through the runners. Not saved: bodies can be large.
/** @type {Map<string, ResendBody>} */
const bodies = new Map();
/**
 * @param {unknown} _store
 * @param {InboxMessage} row
 * @returns {Promise<ResendBody>}
 */
export async function readEmail(_store, row) {
  if (bodies.has(row.id)) return /** @type {ResendBody} */ (bodies.get(row.id));
  const body = await workerCall('GET', `/resend/email/${encodeURIComponent(row.id)}`, null, 60000);
  bodies.set(row.id, body);
  return body;
}
