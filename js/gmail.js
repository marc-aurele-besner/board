// Gmail, read-only, straight from the browser. Each account signs in on its own and may belong to a project (a
// project can have several) and carry a project label for the Inbox filter; both are optional. Sign-ins are kept in google.json and renewed by themselves (see js/google.js).
import { PROFILE_SCOPE, rememberPicture, signIn, saveToken, forgetToken, hasToken, accessToken } from './google.js';
/** @import { DataStore, GmailAccount, InboxMessage, RunnerJobError } from '../types/data' */
/**
 * A part of a Gmail message, as far as it is read.
 * @typedef {{ mimeType?: string, filename?: string, headers?: { name: string, value: string }[], body?: { data?: string, attachmentId?: string }, parts?: GmailPart[] }} GmailPart
 */
/** @typedef {{ id: string, internalDate?: string, labelIds?: string[], payload?: GmailPart }} GmailMessage */
/** @typedef {{ html: string, text: string, replyTo: string[], bcc: string[] }} GmailBody */

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE = 100;
// A first read brings in one page per folder; later reads go back until they reach a message already saved.
const MAX_PAGES = 10;
const KEEP = 1000;
// Messages are read one by one for their headers; a few at a time keeps within Gmail's per-user rate.
const PARALLEL = 5;
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

/** @param {string} address */
const keyOf = (address) => `gmail:${address}`;

/**
 * @param {DataStore} store
 * @returns {GmailAccount[]}
 */
export const gmailAccounts = (store) => store.get('settings').gmail?.accounts ?? [];
/** @param {string} address */
export const isGmailConnected = (address) => hasToken(keyOf(address));
// Projects that have at least one Gmail account, in project order.
/** @param {DataStore} store */
export const gmailProjects = (store) => {
  const ids = new Set(gmailAccounts(store).map((a) => a.projectId));
  return store.get('projects').projects.filter((p) => ids.has(p.id));
};
// The connected Gmail addresses that belong to a project.
/**
 * @param {DataStore} store
 * @param {string | null} projectId
 */
export const connectedGmailOf = (store, projectId) =>
  gmailAccounts(store).filter((a) => a.projectId === projectId && isGmailConnected(a.email)).map((a) => a.email);

/** @typedef {Error & { status?: number }} GmailError */

/**
 * @param {string} value
 * @param {string} path
 * @returns {Promise<unknown>}
 */
async function call(value, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${value}` } });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    /** @type {GmailError} */
    const err = new Error(res.status === 401 ? 'Gmail refused the sign-in. Connect again.' : `Gmail error ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

/**
 * @param {string} address
 * @param {string} path
 */
async function get(address, path) {
  if (!isGmailConnected(address)) throw new Error(`Connect ${address} to read its mail.`);
  try {
    return await call(await accessToken(keyOf(address)), path);
  } catch (err) {
    if (/** @type {GmailError} */ (err).status !== 401) throw err;
    // Refused before it expired: renewed once and tried again.
    return call(await accessToken(keyOf(address), true), path);
  }
}

// Opens Google's sign-in. Must run from a click. With an address it reconnects that account;
// without one Google asks which account to add. Resolves to the address that signed in.
/** @param {unknown} _clientId */
export async function connectGmail(_clientId, address = '') {
  // The profile is only read for the account's picture.
  const token = await signIn({ scopes: [SCOPE, PROFILE_SCOPE], address });
  if (!token.scope.split(' ').includes(SCOPE)) throw new Error('Google did not grant Gmail access. Tick its box on the consent screen.');
  const { emailAddress } = /** @type {{ emailAddress?: string }} */ (await call(token.access, '/profile'));
  const signedIn = String(emailAddress ?? '').toLowerCase();
  if (address && signedIn !== address) throw new Error(`You signed in as ${signedIn}, not ${address}.`);
  saveToken(keyOf(signedIn), token);
  await rememberPicture(signedIn, token.access, token.scope);
  return signedIn;
}

/** @param {string} address */
export const disconnectGmail = (address) => forgetToken(keyOf(address));

// "A <a@x.com>, \"B, C\" <b@x.com>" -> two addresses. Commas inside quotes or angle brackets do not split.
/** @param {string} value */
function splitAddresses(value) {
  /** @type {string[]} */
  const out = [];
  let part = '';
  let quoted = false;
  let angled = false;
  for (const ch of String(value ?? '')) {
    if (ch === '"') quoted = !quoted;
    else if (ch === '<' && !quoted) angled = true;
    else if (ch === '>' && !quoted) angled = false;
    if (ch === ',' && !quoted && !angled) {
      if (part.trim()) out.push(part.trim());
      part = '';
    } else part += ch;
  }
  if (part.trim()) out.push(part.trim());
  return out;
}

/**
 * @param {GmailPart | undefined} payload
 * @param {string} name
 */
const headerOf = (payload, name) => payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
/**
 * @param {string} address
 * @param {string} msgId
 */
export const gmailRowId = (address, msgId) => `gmail:${address}:${msgId}`;

/**
 * @param {string} address
 * @param {string} label
 * @param {Set<string | undefined>} known
 */
async function listIds(address, label, known) {
  /** @type {string[]} */
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < (known.size ? MAX_PAGES : 1); page++) {
    const params = new URLSearchParams({ labelIds: label, maxResults: String(PAGE), ...(pageToken ? { pageToken } : {}) });
    const { messages = [], nextPageToken } = /** @type {{ messages?: { id: string }[], nextPageToken?: string }} */ (await get(address, `/messages?${params}`));
    ids.push(...messages.map((m) => m.id));
    if (!nextPageToken || messages.some((m) => known.has(m.id))) break;
    pageToken = nextPageToken;
  }
  return ids;
}

/**
 * @param {string} address
 * @param {string[]} ids
 */
async function headersOf(address, ids) {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const name of HEADERS) params.append('metadataHeaders', name);
  /** @type {GmailMessage[]} */
  const out = [];
  for (let i = 0; i < ids.length; i += PARALLEL) {
    out.push(.../** @type {GmailMessage[]} */ (await Promise.all(ids.slice(i, i + PARALLEL).map((id) => get(address, `/messages/${id}?${params}`)))));
  }
  return out;
}

/**
 * @param {GmailAccount} account
 * @param {GmailMessage} m
 * @param {string} dir
 * @param {Set<string | undefined>} known
 * @returns {Omit<InboxMessage, 'taskId'>}
 */
const rowOf = (account, m, dir, known) => ({
  id: gmailRowId(account.email, m.id),
  source: 'gmail',
  account: account.email,
  msgId: m.id,
  projectId: account.projectId ?? null,
  dir,
  from: headerOf(m.payload, 'From'),
  to: splitAddresses(headerOf(m.payload, 'To')),
  cc: splitAddresses(headerOf(m.payload, 'Cc')),
  subject: headerOf(m.payload, 'Subject'),
  at: m.internalDate ? new Date(Number(m.internalDate)).toISOString() : '',
  status: '',
  // An account's first read brings in its recent history as read; after that Gmail says what is unread.
  unread: dir === 'received' && known.size > 0 && (m.labelIds ?? []).includes('UNREAD'),
});

// Reads the new mail of every connected account into inbox.json. Accounts not connected are skipped,
// and their saved mail stays. Returns { added, errors: [{ projectIds, text }], waiting: [addresses] }.
/** @param {DataStore} store */
export async function syncGmail(store) {
  const accounts = gmailAccounts(store);
  const saved = store.get('inbox').emails.filter((e) => e.source === 'gmail');
  /** @type {Omit<InboxMessage, 'taskId'>[]} */
  const fresh = [];
  /** @type {RunnerJobError[]} */
  const errors = [];
  /** @type {string[]} */
  const waiting = [];
  for (const account of accounts) {
    if (!isGmailConnected(account.email)) {
      waiting.push(account.email);
      continue;
    }
    try {
      for (const [dir, label] of [['received', 'INBOX'], ['sent', 'SENT']]) {
        const known = new Set(saved.filter((e) => e.account === account.email && e.dir === dir).map((e) => e.msgId));
        const ids = (await listIds(account.email, label, known)).filter((id) => !known.has(id));
        const messages = await headersOf(account.email, ids);
        fresh.push(...messages.map((m) => rowOf(account, m, dir, known)));
      }
    } catch (err) {
      errors.push({ projectIds: account.projectId ? [account.projectId] : [], text: `${account.email}: ${/** @type {Error} */ (err).message}` });
    }
  }

  let added = 0;
  store.update('inbox', (d) => {
    /** @type {Map<string | undefined, string | null>} */
    const owner = new Map(accounts.map((a) => [a.email, a.projectId ?? null]));
    const byId = new Map(d.emails.map((e) => [e.id, e]));
    for (const r of fresh) {
      if (byId.has(r.id)) continue;
      added++;
      byId.set(r.id, { ...r, taskId: null });
    }
    /** @type {Map<string | undefined, number>} */
    const perAccount = new Map();
    d.emails = [...byId.values()]
      // Mail of a removed account goes; mail of an account moved to another project follows it.
      .filter((e) => e.source !== 'gmail' || owner.has(e.account))
      .map((e) => (e.source === 'gmail' && e.projectId !== owner.get(e.account) ? { ...e, projectId: /** @type {string | null} */ (owner.get(e.account)) } : e))
      .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
      .filter((e) => {
        if (e.source !== 'gmail') return true;
        const n = (perAccount.get(e.account) ?? 0) + 1;
        perAccount.set(e.account, n);
        return n <= KEEP;
      });
    d.syncedAt = new Date().toISOString();
  });
  return { added, errors, waiting };
}

// Gmail sends each part base64url-encoded, in the charset its Content-Type names.
/**
 * @param {string} data
 * @param {string} contentType
 */
function decode(data, contentType) {
  const binary = atob(data.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const charset = /charset="?([^";\s]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder().decode(bytes);
  }
}

// The first text/html and text/plain parts, skipping attachments.
/**
 * @param {string} address
 * @param {string} msgId
 * @param {GmailPart | undefined} part
 * @param {{ html?: string, text?: string }} [found]
 */
async function partsOf(address, msgId, part, found = {}) {
  if (!part) return found;
  const type = (part.mimeType ?? '').toLowerCase();
  const attachment = Boolean(part.filename);
  if (!attachment && (type === 'text/html' || type === 'text/plain')) {
    const key = type === 'text/html' ? 'html' : 'text';
    if (!found[key]) {
      // Large parts are not sent inline; they are read like an attachment.
      const data = part.body?.data ?? (part.body?.attachmentId
        ? /** @type {{ data?: string }} */ (await get(address, `/messages/${msgId}/attachments/${part.body.attachmentId}`)).data
        : '');
      if (data) found[key] = decode(data, headerOf(part, 'Content-Type'));
    }
  }
  for (const child of part.parts ?? []) await partsOf(address, msgId, child, found);
  return found;
}

// The full message, read when it is opened. Not saved: bodies can be large.
/** @type {Map<string, GmailBody>} */
const bodies = new Map();
/**
 * A Gmail row of inbox.json: it has its account and message id.
 * @param {InboxMessage & { account: string, msgId: string }} row
 * @returns {Promise<GmailBody>}
 */
export async function readGmail(row) {
  if (bodies.has(row.id)) return /** @type {GmailBody} */ (bodies.get(row.id));
  const m = /** @type {GmailMessage} */ (await get(row.account, `/messages/${row.msgId}?format=full`));
  const { html = '', text = '' } = await partsOf(row.account, row.msgId, m.payload);
  const body = { html, text, replyTo: splitAddresses(headerOf(m.payload, 'Reply-To')), bcc: splitAddresses(headerOf(m.payload, 'Bcc')) };
  bodies.set(row.id, body);
  return body;
}
