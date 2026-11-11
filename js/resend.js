// Emails sent and received through Resend, one API key per project. Read-only.
// Resend sends no CORS header, so requests go through tools/relays.js running on this machine.
import { hostOf } from './sitecheck.js';

export const RESEND_RELAY = 'http://127.0.0.1:8418';
const PAGE = 100;
// The first read of a key goes back this many pages per direction; later reads stop at the newest email already saved.
const FIRST_PAGES = 5;
// Kept per project, newest first, so inbox.json stays small.
const KEEP = 1000;
// Resend allows a few requests per second per team. Requests are spaced out across every key.
const GAP_MS = 550;

let queue = Promise.resolve();
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const resendSettings = (store) => store.get('settings').resend ?? { relay: '', keys: {} };
// Projects that have a key, in project order.
export const keyedProjects = (store) => {
  const { keys = {} } = resendSettings(store);
  return store.get('projects').projects.filter((p) => keys[p.id]);
};

function explain(status, body) {
  if (body?.name === 'restricted_api_key') return 'This key can only send emails. Create a key with Full access in Resend.';
  if (status === 401 || status === 403 || body?.name === 'validation_error') return 'Resend rejected this key.';
  if (status === 429) return 'Resend is limiting requests. Try again in a minute.';
  return body?.message ? `Resend: ${body.message}` : `Resend error ${status}`;
}

// One GET through the relay, queued behind every other Resend request.
function get(key, path, relay) {
  const run = async () => {
    const base = (relay || RESEND_RELAY).replace(/\/+$/, '');
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(base + path, { headers: { Authorization: `Bearer ${key}` } });
      } catch {
        throw new Error(`Could not reach the Resend relay at ${base}. Start it with: bun tools/start.js`);
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

export async function checkResend(key, relay) {
  const { data = [] } = await get(key, '/emails?limit=1', relay);
  return data.length ? 'Connected. Emails can be read.' : 'Connected. No emails sent yet.';
}

const listPath = (dir) => (dir === 'sent' ? '/emails' : '/emails/receiving');

// Newest first, until a page reaches an email already known, or the page limit.
async function listNew(key, dir, relay, known) {
  const out = [];
  let after = '';
  for (let page = 0; page < (known.size ? 50 : FIRST_PAGES); page++) {
    const { data = [], has_more: more } = await get(key, `${listPath(dir)}?limit=${PAGE}${after ? `&after=${after}` : ''}`, relay);
    out.push(...data);
    if (!more || !data.length || data.some((e) => known.has(e.id))) break;
    after = data[data.length - 1].id;
  }
  return out;
}

const addresses = (v) => (Array.isArray(v) ? v : v ? [v] : []).map(String);
// "Name <a@b.com>" -> "b.com"
const domainOf = (address) => (address.match(/@([^\s>]+)/)?.[1] ?? '').toLowerCase();

// When several projects share one Resend account, an email goes to the project whose website matches
// the sending address (sent) or a receiving address (received). Otherwise to the first of them.
function ownerOf(projects, row) {
  if (projects.length === 1) return projects[0].id;
  const domains = (row.dir === 'sent' ? [row.from] : row.to).map(domainOf).filter(Boolean);
  const match = projects.find((p) => {
    const host = p.website ? hostOf(p.website).replace(/^www\./, '') : '';
    return host && domains.some((d) => d === host || d.endsWith(`.${host}`) || host.endsWith(`.${d}`));
  });
  return (match ?? projects[0]).id;
}

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

// Reads every key's new emails into inbox.json. Returns { added, errors: [{ projectId, text }] }.
export async function syncInbox(store) {
  const { keys = {}, relay = '' } = resendSettings(store);
  const projects = keyedProjects(store);
  const groups = new Map();
  for (const p of projects) groups.set(keys[p.id], [...(groups.get(keys[p.id]) ?? []), p]);

  const saved = store.get('inbox').emails;
  const fresh = [];
  const errors = [];
  for (const [key, group] of groups) {
    const ids = new Set(group.map((p) => p.id));
    for (const dir of ['sent', 'received']) {
      const known = new Set(saved.filter((e) => e.dir === dir && ids.has(e.projectId)).map((e) => e.id));
      try {
        const rows = (await listNew(key, dir, relay, known)).map((e) => rowOf(e, dir));
        // A key's first read brings in its history; only mail that arrives after it counts as unread.
        const unread = dir === 'received' && known.size > 0;
        fresh.push(...rows.map((r) => ({ ...r, projectId: ownerOf(group, r), unread })));
      } catch (err) {
        errors.push({ projectIds: [...ids], dir, text: err.message });
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
    const live = new Set(projects.map((p) => p.id));
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

// The full email (html and text), read when it is opened. Not saved: bodies can be large.
const bodies = new Map();
export async function readEmail(store, row) {
  if (bodies.has(row.id)) return bodies.get(row.id);
  const { keys = {}, relay = '' } = resendSettings(store);
  const key = keys[row.projectId];
  if (!key) throw new Error('This project has no Resend key any more.');
  const e = await get(key, `${listPath(row.dir)}/${encodeURIComponent(row.id)}`, relay);
  const body = { html: e.html ?? '', text: e.text ?? '', replyTo: addresses(e.reply_to), bcc: addresses(e.bcc) };
  bodies.set(row.id, body);
  return body;
}
