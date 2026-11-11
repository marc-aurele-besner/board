// Gmail, read-only, straight from the browser. Each account signs in on its own and may belong to a project (a
// project can have several) and carry a project label for the Inbox filter; both are optional. Sign-ins are kept in google.json and renewed by themselves (see js/google.js).
import { PROFILE_SCOPE, rememberPicture, signIn, saveToken, forgetToken, hasToken, accessToken } from './google.js';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
const PAGE = 100;
// A first read brings in one page per folder; later reads go back until they reach a message already saved.
const MAX_PAGES = 10;
const KEEP = 1000;
// Messages are read one by one for their headers; a few at a time keeps within Gmail's per-user rate.
const PARALLEL = 5;
const HEADERS = ['From', 'To', 'Cc', 'Subject', 'Date'];

const keyOf = (address) => `gmail:${address}`;

export const gmailAccounts = (store) => store.get('settings').gmail?.accounts ?? [];
export const isGmailConnected = (address) => hasToken(keyOf(address));
// Projects that have at least one Gmail account, in project order.
export const gmailProjects = (store) => {
  const ids = new Set(gmailAccounts(store).map((a) => a.projectId));
  return store.get('projects').projects.filter((p) => ids.has(p.id));
};
// The connected Gmail addresses that belong to a project.
export const connectedGmailOf = (store, projectId) =>
  gmailAccounts(store).filter((a) => a.projectId === projectId && isGmailConnected(a.email)).map((a) => a.email);

async function call(value, path) {
  const res = await fetch(API + path, { headers: { Authorization: `Bearer ${value}` } });
  if (!res.ok) {
    const detail = await res.json().then((d) => d.error?.message).catch(() => '');
    const err = new Error(res.status === 401 ? 'Gmail refused the sign-in. Connect again.' : `Gmail error ${res.status}${detail ? `: ${detail}` : ''}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function get(address, path) {
  if (!isGmailConnected(address)) throw new Error(`Connect ${address} to read its mail.`);
  try {
    return await call(await accessToken(keyOf(address)), path);
  } catch (err) {
    if (err.status !== 401) throw err;
    // Refused before it expired: renewed once and tried again.
    return call(await accessToken(keyOf(address), true), path);
  }
}

// Opens Google's sign-in. Must run from a click. With an address it reconnects that account;
// without one Google asks which account to add. Resolves to the address that signed in.
export async function connectGmail(_clientId, address = '') {
  // The profile is only read for the account's picture.
  const token = await signIn({ scopes: [SCOPE, PROFILE_SCOPE], address });
  if (!token.scope.split(' ').includes(SCOPE)) throw new Error('Google did not grant Gmail access. Tick its box on the consent screen.');
  const { emailAddress } = await call(token.access, '/profile');
  const signedIn = String(emailAddress ?? '').toLowerCase();
  if (address && signedIn !== address) throw new Error(`You signed in as ${signedIn}, not ${address}.`);
  saveToken(keyOf(signedIn), token);
  await rememberPicture(signedIn, token.access, token.scope);
  return signedIn;
}

export const disconnectGmail = (address) => forgetToken(keyOf(address));

// "A <a@x.com>, \"B, C\" <b@x.com>" -> two addresses. Commas inside quotes or angle brackets do not split.
function splitAddresses(value) {
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

const headerOf = (payload, name) => payload?.headers?.find((x) => x.name.toLowerCase() === name.toLowerCase())?.value ?? '';
export const gmailRowId = (address, msgId) => `gmail:${address}:${msgId}`;

async function listIds(address, label, known) {
  const ids = [];
  let pageToken = '';
  for (let page = 0; page < (known.size ? MAX_PAGES : 1); page++) {
    const params = new URLSearchParams({ labelIds: label, maxResults: String(PAGE), ...(pageToken ? { pageToken } : {}) });
    const { messages = [], nextPageToken } = await get(address, `/messages?${params}`);
    ids.push(...messages.map((m) => m.id));
    if (!nextPageToken || messages.some((m) => known.has(m.id))) break;
    pageToken = nextPageToken;
  }
  return ids;
}

async function headersOf(address, ids) {
  const params = new URLSearchParams({ format: 'metadata' });
  for (const name of HEADERS) params.append('metadataHeaders', name);
  const out = [];
  for (let i = 0; i < ids.length; i += PARALLEL) {
    out.push(...await Promise.all(ids.slice(i, i + PARALLEL).map((id) => get(address, `/messages/${id}?${params}`))));
  }
  return out;
}

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
export async function syncGmail(store) {
  const accounts = gmailAccounts(store);
  const saved = store.get('inbox').emails.filter((e) => e.source === 'gmail');
  const fresh = [];
  const errors = [];
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
      errors.push({ projectIds: account.projectId ? [account.projectId] : [], text: `${account.email}: ${err.message}` });
    }
  }

  let added = 0;
  store.update('inbox', (d) => {
    const owner = new Map(accounts.map((a) => [a.email, a.projectId ?? null]));
    const byId = new Map(d.emails.map((e) => [e.id, e]));
    for (const r of fresh) {
      if (byId.has(r.id)) continue;
      added++;
      byId.set(r.id, { ...r, taskId: null });
    }
    const perAccount = new Map();
    d.emails = [...byId.values()]
      // Mail of a removed account goes; mail of an account moved to another project follows it.
      .filter((e) => e.source !== 'gmail' || owner.has(e.account))
      .map((e) => (e.source === 'gmail' && e.projectId !== owner.get(e.account) ? { ...e, projectId: owner.get(e.account) } : e))
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
async function partsOf(address, msgId, part, found = {}) {
  if (!part) return found;
  const type = (part.mimeType ?? '').toLowerCase();
  const attachment = Boolean(part.filename);
  if (!attachment && (type === 'text/html' || type === 'text/plain')) {
    const key = type === 'text/html' ? 'html' : 'text';
    if (!found[key]) {
      // Large parts are not sent inline; they are read like an attachment.
      const data = part.body?.data ?? (part.body?.attachmentId
        ? (await get(address, `/messages/${msgId}/attachments/${part.body.attachmentId}`)).data
        : '');
      if (data) found[key] = decode(data, headerOf(part, 'Content-Type'));
    }
  }
  for (const child of part.parts ?? []) await partsOf(address, msgId, child, found);
  return found;
}

// The full message, read when it is opened. Not saved: bodies can be large.
const bodies = new Map();
export async function readGmail(row) {
  if (bodies.has(row.id)) return bodies.get(row.id);
  const m = await get(row.account, `/messages/${row.msgId}?format=full`);
  const { html = '', text = '' } = await partsOf(row.account, row.msgId, m.payload);
  const body = { html, text, replyTo: splitAddresses(headerOf(m.payload, 'Reply-To')), bcc: splitAddresses(headerOf(m.payload, 'Bcc')) };
  bodies.set(row.id, body);
  return body;
}
