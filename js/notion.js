// Notion: the pages of chosen databases become tasks, each database in its own project (Settings → Notion).
// Notion's API does not answer web pages (no CORS), so the runners call it (tools/jobs/notion.js) and Settings asks
// them for its checks. A database is read one of three ways (its link's `via`): with an internal integration's
// secret, with a public integration's OAuth sign-in, both at api.notion.com, or with the browser session through
// notion.so's own API (js/notion-session.js). Each sign-in is an account (several of each way, one per workspace or
// person), and a database is read with its own account. No DOM here: the worker imports this file.
// A page edited later in Notion updates its task, field by field, only where Notion's value changed since the last
// read (task.notion keeps it), so what was changed on the board stays. Nothing is written back to Notion.
import { makeTask } from './capture.js';
import { notify } from './notify-core.js';
import { workerCall } from './runners.js';
import { sessionDatabase, sessionPages, checkSession } from './notion-session.js';
/** @import { DataStore, NotionAccount, NotionLink, NotionSettings, Task, TaskNotion } from '../types/data' */
/**
 * A database property or a page's property value, as far as it is read.
 * @typedef {{ type: string, name?: string, title?: { plain_text?: string }[], status?: { name?: string } | null,
 *   select?: { name?: string } | null, checkbox?: boolean, date?: { start?: string } | null }} NotionProperty
 * @typedef {{ id: string, url: string, last_edited_time: string, archived?: boolean, in_trash?: boolean,
 *   properties: Record<string, NotionProperty> }} NotionPage
 * @typedef {{ title?: { plain_text?: string }[], properties?: Record<string, NotionProperty> }} NotionDatabase
 * @typedef {{ title: string, status: string, due: string, priority: string }} PropertyNames
 */

const API = 'https://api.notion.com/v1';
const VERSION = '2022-06-28';
// Notion allows about three requests a second.
const GAP_MS = 350;

// Settings saved before accounts kept one secret, one OAuth sign-in and one session: each becomes an account, with
// the way as its id, and each database points at the account its `via` named. Saving writes the new shape.
/** @param {Partial<NotionSettings> | undefined} raw @returns {NotionSettings & { accounts: NotionAccount[] }} */
export function normalizeNotion(raw) {
  const { token, session, oauth, accounts: saved, links = [], ...rest } = raw ?? {};
  const accounts = [...(saved ?? [])];
  const has = (/** @type {string} */ id) => accounts.some((a) => a.id === id);
  if (token && !has('token')) accounts.push({ id: 'token', way: 'token', token });
  if (oauth?.accessToken && !has('oauth')) {
    accounts.push({ id: 'oauth', way: 'oauth', name: oauth.workspace ?? '', accessToken: oauth.accessToken, refreshToken: oauth.refreshToken ?? '', workspace: oauth.workspace ?? '' });
  }
  if (session?.tokenV2 && !has('session')) accounts.push({ id: 'session', way: 'session', tokenV2: session.tokenV2, userId: session.userId ?? '' });
  return {
    ...rest,
    ...(oauth ? { oauth: { clientId: oauth.clientId ?? '', clientSecret: oauth.clientSecret ?? '' } } : {}),
    accounts,
    links: links.map(({ via, ...l }) => (l.account ? l : { ...l, account: via ?? 'token' })),
  };
}

/** @param {DataStore} store */
export const notionSettings = (store) => normalizeNotion(store.get('settings').notion);
/** @param {DataStore} store */
export const hasNotion = (store) => {
  const cfg = notionSettings(store);
  return Boolean(cfg.accounts.length && cfg.links.some((l) => l.on !== false));
};

export const WAY_LABELS = { token: 'Integration secret', oauth: 'OAuth', session: 'Browser session' };
/** @param {NotionAccount | undefined} a */
export const wayLabel = (a) => WAY_LABELS[/** @type {keyof typeof WAY_LABELS} */ (a?.way)] ?? '';
/** @param {NotionAccount | undefined} a */
export const accountName = (a) => (a ? a.name || a.workspace || wayLabel(a) : 'Removed account');

// The project a database's new tasks go to: its own, or else its account's.
/** @param {NotionSettings} cfg @param {NotionLink} link @returns {string | null} */
export function linkProject(cfg, link) {
  if (link.projectId !== undefined) return link.projectId;
  return cfg.accounts?.find((a) => a.id === link.account)?.projectId ?? null;
}

// The database id in a pasted link or id. In a link it ends the last part of the path, after the title
// ("My-Tasks-0123…"); ?v= names a view, not the database.
/** @param {string} raw */
export function parseDatabaseId(raw) {
  const path = String(raw ?? '').trim().split(/[?#]/)[0];
  const dashed = path.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi);
  if (dashed) return dashed[dashed.length - 1].replace(/-/g, '').toLowerCase();
  const last = path.split('/').filter(Boolean).pop() ?? '';
  return last.match(/[0-9a-f]{32}$/i)?.[0].toLowerCase() ?? '';
}

/** @param {number} ms */
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** @param {number} status @param {{ message?: string, code?: string } | null} body */
function explain(status, body) {
  if (status === 401) return 'Notion rejected this token. Copy the integration secret again, or sign in with Notion again.';
  if (status === 404 || body?.code === 'object_not_found') return 'Notion cannot see this database. Open it in Notion, then ⋯ → Connections, and add the integration.';
  return body?.message || `Notion error ${status}`;
}

let queue = Promise.resolve();
// One request at a time, a short gap apart, and once more after a 429.
/**
 * @param {string} token
 * @param {string} method
 * @param {string} path
 * @param {object} [body]
 * @returns {Promise<any>} any: each caller reads its own shape of Notion's answer
 */
function call(token, method, path, body) {
  const run = async () => {
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + path, {
          method,
          headers: { Authorization: `Bearer ${token}`, 'Notion-Version': VERSION, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        });
      } catch {
        throw new Error('Could not reach Notion. Check the connection.');
      }
      const answer = await res.json().catch(() => null);
      if (res.ok) return answer;
      if (res.status === 429 && attempt < 2) {
        await wait(1000 * (Number(res.headers.get('retry-after')) || 1));
        continue;
      }
      throw Object.assign(new Error(explain(res.status, answer)), { status: res.status });
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {}).then(() => wait(GAP_MS));
  return result;
}

/** @param {{ plain_text?: string }[] | undefined} parts */
const plain = (parts) => (parts ?? []).map((p) => p.plain_text ?? '').join('').trim();

// Which properties of a database hold the title, the status, the deadline and the priority. A name that says what it
// is wins; otherwise the first property of a fitting type.
/** @param {Record<string, NotionProperty>} props @returns {PropertyNames} */
export function pickProperties(props) {
  const list = Object.entries(props);
  /** @param {string[]} types @param {RegExp} [name] */
  const find = (types, name) => list.find(([n, p]) => types.includes(p.type) && (!name || name.test(n)))?.[0] ?? '';
  const priority = find(['select', 'status'], /prio/i);
  const status = find(['status'], /^(?!.*prio)/i) || find(['select'], /status|state|stage/i) || find(['checkbox'], /done|complete|finished/i) || find(['checkbox']);
  return {
    title: find(['title']),
    status,
    due: find(['date'], /due|deadline/i) || find(['date'], /date|when/i) || find(['date']),
    priority,
  };
}

// A Notion status or select name as one of the board's statuses.
/** @param {string} name */
export function statusFrom(name) {
  const n = name.toLowerCase();
  if (/not started|to ?do|^open|^new/.test(n)) return 'todo';
  if (/done|complete|finished|closed|shipped|resolved/.test(n)) return 'done';
  if (/review/.test(n)) return 'review';
  if (/block/.test(n)) return 'blocked';
  if (/pause|hold|waiting/.test(n)) return 'paused';
  if (/progress|doing|started|active|working/.test(n)) return 'doing';
  if (/backlog|later|someday|parking|icebox/.test(n)) return 'parking';
  if (/next|deck|up next|ready/.test(n)) return 'ondeck';
  return 'todo';
}

/** @param {string} name */
export function priorityFrom(name) {
  const n = name.toLowerCase();
  if (/urgent|critical|high|p0|p1/.test(n)) return 'high';
  if (/medium|normal|mid|p2/.test(n)) return 'medium';
  if (/low|minor|p3|p4/.test(n)) return 'low';
  return 'none';
}

// What a page says, in the board's terms.
/** @param {NotionPage} page @param {PropertyNames} names */
export function readPage(page, names) {
  const props = page.properties ?? {};
  const s = props[names.status];
  const status = !s ? 'todo'
    : s.type === 'checkbox' ? (s.checkbox ? 'done' : 'todo')
    : statusFrom(s.status?.name ?? s.select?.name ?? '');
  const p = props[names.priority];
  return {
    text: plain(props[names.title]?.title),
    status,
    // A date with a time keeps only its day.
    due: (props[names.due]?.date?.start ?? '').slice(0, 10),
    priority: priorityFrom(p?.select?.name ?? p?.status?.name ?? ''),
  };
}

// Every page edited since `since` (all of them without it), oldest edit first.
/** @param {string} token @param {string} databaseId @param {string} [since] @returns {Promise<NotionPage[]>} */
async function queryPages(token, databaseId, since) {
  /** @type {NotionPage[]} */
  const pages = [];
  let cursor;
  do {
    /** @type {{ results: NotionPage[], has_more: boolean, next_cursor: string | null }} */
    const answer = await call(token, 'POST', `/databases/${databaseId}/query`, {
      page_size: 100,
      sorts: [{ timestamp: 'last_edited_time', direction: 'ascending' }],
      ...(since ? { filter: { timestamp: 'last_edited_time', last_edited_time: { on_or_after: since } } } : {}),
      ...(cursor ? { start_cursor: cursor } : {}),
    });
    pages.push(...answer.results);
    cursor = answer.has_more ? answer.next_cursor : null;
  } while (cursor);
  return pages;
}

/** @param {string} token @param {string} databaseId @returns {Promise<NotionDatabase>} */
const getDatabase = (token, databaseId) => call(token, 'GET', `/databases/${databaseId}`);

// Runners side of Settings' token check.
// Runners side of Settings' token check: what to say, and a name for the account.
/** @param {string} token @returns {Promise<{ text: string, name: string }>} */
export async function checkNotionToken(token) {
  /** @type {{ name?: string, bot?: { workspace_name?: string } }} */
  const me = await call(token, 'GET', '/users/me');
  const where = me.bot?.workspace_name ? ` in ${me.bot.workspace_name}` : '';
  return { text: `Connected as “${me.name ?? 'integration'}”${where}.`, name: me.bot?.workspace_name || me.name || '' };
}

export { checkSession };

/** @param {NotionAccount} a */
const tokenOf = (a) => (a.way === 'oauth' ? a.accessToken ?? '' : a.token ?? '');

// A database's title and properties, read with one account.
/** @param {NotionAccount} a @param {string} databaseId @returns {Promise<NotionDatabase>} */
const databaseWith = (a, databaseId) => (a.way === 'session'
  ? sessionDatabase({ tokenV2: a.tokenV2 ?? '', userId: a.userId ?? '' }, databaseId)
  : getDatabase(tokenOf(a), databaseId));

// Runners side of adding a database: its title and the properties the sync will read. With no account named, each
// one is tried in turn, so a database only one of them can open is still found; `account` says which one did.
/** @param {NotionSettings} cfg @param {string} databaseId @param {string} [accountId] */
export async function describeDatabase(cfg, databaseId, accountId) {
  const all = cfg.accounts ?? [];
  const list = accountId ? all.filter((a) => a.id === accountId) : all;
  if (!list.length) throw new Error(accountId ? 'This account was removed.' : 'Add an account first: an integration secret, an OAuth sign-in or a browser session.');
  /** @type {string[]} */
  const errors = [];
  for (const a of list) {
    try {
      const db = await databaseWith(a, databaseId);
      return { name: plain(db.title) || 'Untitled database', fields: pickProperties(db.properties ?? {}), account: a.id };
    } catch (err) {
      const message = /** @type {Error} */ (err).message;
      errors.push(list.length > 1 ? `${accountName(a)}: ${message}` : message);
    }
  }
  throw new Error(errors.join(' '));
}

// Runners side of the OAuth sign-in: trades the code (or the refresh token) for an access token. The client secret
// goes only to api.notion.com.
/**
 * @param {{ clientId: string, clientSecret: string, code?: string, redirectUri?: string, refreshToken?: string }} p
 * @returns {Promise<{ accessToken: string, refreshToken: string, workspace: string, workspaceId: string }>}
 */
export async function exchangeNotionCode({ clientId, clientSecret, code, redirectUri, refreshToken }) {
  if (!clientId || !clientSecret) throw new Error('Add the OAuth client ID and secret first.');
  let res;
  try {
    res = await fetch(`${API}/oauth/token`, {
      method: 'POST',
      headers: { Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`, 'Notion-Version': VERSION, 'content-type': 'application/json' },
      body: JSON.stringify(refreshToken
        ? { grant_type: 'refresh_token', refresh_token: refreshToken }
        : { grant_type: 'authorization_code', code, redirect_uri: redirectUri }),
    });
  } catch {
    throw new Error('Could not reach Notion. Check the connection.');
  }
  /** @type {{ access_token?: string, refresh_token?: string, workspace_name?: string, workspace_id?: string, error?: string, error_description?: string, message?: string } | null} */
  const answer = await res.json().catch(() => null);
  if (!res.ok || !answer?.access_token) {
    if (answer?.error === 'invalid_client') throw new Error('Notion does not know this client ID and secret. Copy them again from the integration.');
    throw new Error(answer?.error_description || answer?.message || answer?.error || `Notion error ${res.status}`);
  }
  return { accessToken: answer.access_token, refreshToken: answer.refresh_token ?? refreshToken ?? '', workspace: answer.workspace_name ?? '', workspaceId: answer.workspace_id ?? '' };
}

// Settings → Notion: the checks, through the runners.
/** @param {string} token @returns {Promise<{ text: string, name: string }>} */
export const checkNotion = (token) => workerCall('POST', '/notion/check', { token }, 30000);
/** @param {{ tokenV2: string, userId?: string }} session @returns {Promise<{ text: string, name: string }>} */
export const checkNotionSession = (session) => workerCall('POST', '/notion/session', { session }, 30000);
/** @param {NotionSettings} cfg @param {string} databaseId @param {string} [account] @returns {Promise<{ id: string, name: string, fields: PropertyNames, account: string }>} */
export const readNotionDatabase = (cfg, databaseId, account) => workerCall('POST', '/notion/database', { cfg, databaseId, account }, 45000);
/**
 * @param {{ clientId: string, clientSecret: string, code: string, redirectUri: string }} p
 * @returns {Promise<{ accessToken: string, refreshToken: string, workspace: string, workspaceId: string }>}
 */
export const finishNotionSignIn = (p) => workerCall('POST', '/notion/oauth', p, 30000);

/** @type {(keyof Omit<TaskNotion, 'url' | 'link' | 'edited'>)[]} */
const FIELDS = ['text', 'status', 'due', 'priority'];

// Reads one database and brings its tasks up to date. The first read skips pages already done, so linking a long
// database does not fill the board with finished work.
/** @param {DataStore} store @param {NotionSettings} cfg @param {NotionLink} link */
async function syncLink(store, cfg, link) {
  const account = cfg.accounts?.find((a) => a.id === link.account);
  if (!account) throw new Error('The account that read this database was removed. Remove the database and add it again.');
  /** @type {NotionDatabase} */
  let db;
  /** @type {NotionPage[]} */
  let all;
  if (account.way === 'session') {
    if (!account.tokenV2) throw new Error('This account’s browser session is not set.');
    ({ database: db, pages: all } = await sessionPages({ tokenV2: account.tokenV2, userId: account.userId ?? '' }, link.databaseId, link.syncedAt));
  } else {
    const token = tokenOf(account);
    if (!token) throw new Error(account.way === 'oauth' ? 'This account is signed out. Sign in with Notion again.' : 'This account’s integration secret is not set.');
    db = await getDatabase(token, link.databaseId);
    all = await queryPages(token, link.databaseId, link.syncedAt);
  }
  const projectId = linkProject(cfg, link);
  const names = pickProperties(db.properties ?? {});
  const pages = all.filter((p) => !p.archived && !p.in_trash);
  let added = 0;
  let updated = 0;
  /** @type {Task[]} */
  const made = [];
  store.update('todos', (d) => {
    for (const page of pages) {
      const now = readPage(page, names);
      if (!now.text) continue;
      const task = d.items.find((t) => t.auto === 'notion' && t.autoRef === page.id);
      const snapshot = { url: page.url, link: link.id, edited: page.last_edited_time, ...now };
      if (task) {
        const before = task.notion;
        let changed = false;
        for (const f of FIELDS) {
          if (before && before[f] === now[f]) continue;
          if (task[f] !== now[f]) {
            task[f] = now[f];
            changed = true;
          }
        }
        if (changed) updated += 1;
        task.notion = snapshot;
        continue;
      }
      if (!link.syncedAt && now.status === 'done') continue;
      const fresh = makeTask({ ...now, projectId, auto: 'notion', autoRef: page.id, inbox: !projectId, notion: snapshot });
      d.items.push(fresh);
      made.push(fresh);
      added += 1;
    }
  });
  const newest = pages.reduce((max, p) => (p.last_edited_time > max ? p.last_edited_time : max), link.syncedAt ?? '');
  return { added, updated, made, projectId, syncedAt: newest || new Date().toISOString() };
}

// Reads every linked database (or only `ids`), saves each link's sync time or error, and announces new tasks.
// Runs in the runners.
/** @param {DataStore} store @param {{ ids?: string[] }} [options] */
export async function syncNotion(store, { ids } = {}) {
  const { links } = notionSettings(store);
  const chosen = links.filter((l) => l.on !== false && (!ids?.length || ids.includes(l.id)));
  let added = 0;
  let updated = 0;
  /** @type {{ link: string, text: string }[]} */
  const errors = [];
  for (const link of chosen) {
    /** @type {Partial<NotionLink>} */
    let patch;
    try {
      const r = await syncLink(store, notionSettings(store), link).catch(async (err) => {
        // An OAuth token Notion stopped accepting: renew it once with the refresh token, then read again.
        const { oauth, accounts } = notionSettings(store);
        const account = accounts.find((a) => a.id === link.account);
        if (account?.way !== 'oauth' || err?.status !== 401 || !account.refreshToken || !oauth) throw err;
        const fresh = await exchangeNotionCode({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, refreshToken: account.refreshToken });
        store.update('settings', (d) => {
          const cfg = normalizeNotion(d.notion);
          d.notion = { ...cfg, accounts: cfg.accounts.map((a) => (a.id === account.id ? { ...a, accessToken: fresh.accessToken, refreshToken: fresh.refreshToken } : a)) };
        });
        return syncLink(store, notionSettings(store), link);
      });
      added += r.added;
      updated += r.updated;
      patch = { syncedAt: r.syncedAt, error: '' };
      if (r.made.length) {
        const where = r.projectId ? store.get('projects').projects.find((p) => p.id === r.projectId)?.name : null;
        notify(store, {
          kind: 'notion',
          text: r.made.length === 1
            ? `New task from Notion${where ? ` in ${where}` : ''}: “${r.made[0].text}”.`
            : `${r.made.length} new tasks from ${link.name || 'Notion'}${where ? ` in ${where}` : ''}.`,
          href: r.projectId ? `#/todos?filter=${r.projectId}` : '#/todos?filter=organize',
        });
      }
    } catch (err) {
      const text = /** @type {Error} */ (err).message;
      errors.push({ link: link.name, text });
      patch = { error: text };
    }
    store.update('settings', (d) => {
      const cfg = normalizeNotion(d.notion);
      d.notion = { ...cfg, links: cfg.links.map((l) => (l.id === link.id ? { ...l, ...patch } : l)) };
    });
  }
  return { added, updated, errors, count: chosen.length };
}
