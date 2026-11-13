// contacts.json without the DOM: people tied to projects, matched by email in Inbox and Calendar. The runners import this file.
/** @import { Contact, ContactsData, DataStore } from '../types/data' */
import { uid } from './ui.js';
import { parseHandle } from './socials.js';

export const CONTACTS = 'contacts';
/** @type {ContactsData} */
export const CONTACTS_DEFAULTS = { contacts: [] };

/**
 * A contact as callers hand it in: any Contact field, the LinkedIn handle as a handle or a profile link, and one
 * address as `email` when there is no `emails` list.
 * @typedef {Partial<Contact> & { email?: string }} ContactInput
 */

/** @param {unknown} email */
export const cleanEmail = (email) => String(email ?? '').trim().toLowerCase();

// 'in/<name>' from a handle or profile link; '' when it is not a person's or a company's page.
/** @param {unknown} text */
export const linkedinHandle = (text) => (String(text ?? '').trim() ? parseHandle('linkedin', String(text)) : '');

/** @param {string} handle */
export const linkedinUrl = (handle) => `https://www.linkedin.com/${handle}/`;

// A name guessed from a profile slug: 'in/jane-doe-1a2b3c' gives 'Jane Doe'. The trailing id LinkedIn adds to
// common names is dropped when it has a digit in it.
/** @param {string} handle */
export function nameFromHandle(handle) {
  const slug = String(handle ?? '').replace(/^[a-z]+\//, '');
  const words = slug.split(/[-_.]+/).filter(Boolean);
  if (words.length > 1 && /\d/.test(words[words.length - 1])) words.pop();
  return words.filter((w) => !/^\d+$/.test(w)).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
}

/** @param {DataStore} store */
const list = (store) => store.get(CONTACTS)?.contacts ?? [];

/** @param {DataStore} store @param {string} email @returns {Contact | null} */
export function findByEmail(store, email) {
  const e = cleanEmail(email);
  if (!e) return null;
  return list(store).find((c) => (c.emails ?? []).some((x) => cleanEmail(x) === e)) ?? null;
}

/** @param {DataStore} store @param {string} handle A handle or a profile link. @returns {Contact | null} */
export function findByLinkedin(store, handle) {
  const h = linkedinHandle(handle).toLowerCase();
  if (!h) return null;
  return list(store).find((c) => (c.linkedin ?? '').toLowerCase() === h) ?? null;
}

/** @param {DataStore} store @param {string} projectId @returns {Contact[]} */
export const contactsOf = (store, projectId) => list(store).filter((c) => (c.projectIds ?? []).includes(projectId));

/** @param {Contact[]} contacts @param {Contact} c */
const sameAs = (contacts, c) => contacts.find((x) => (c.linkedin && (x.linkedin ?? '').toLowerCase() === c.linkedin.toLowerCase())
  || c.emails.some((e) => (x.emails ?? []).map(cleanEmail).includes(e)));

/**
 * Adds contacts, merging each with the one that shares its LinkedIn handle or one of its addresses: empty fields are
 * filled, addresses and projects joined, notes kept. Entries with neither a name, a handle nor an address are skipped.
 * @param {DataStore} store
 * @param {ContactInput[]} items
 * @param {{ projectId?: string | null, source?: string }} [opts] The project every entry joins, and where they came from.
 * @returns {{ added: Contact[], updated: Contact[] }}
 */
export function addContacts(store, items, { projectId = null, source = 'manual' } = {}) {
  /** @type {Contact[]} */
  const added = [];
  /** @type {Contact[]} */
  const updated = [];
  const at = Date.now();
  /** @type {Contact[]} */
  const incoming = [];
  for (const raw of items ?? []) {
    if (!raw || typeof raw !== 'object') continue;
    const linkedin = linkedinHandle(raw.linkedin);
    const emails = [...new Set([...(raw.emails ?? []), raw.email].map(cleanEmail).filter((e) => e.includes('@')))];
    const name = String(raw.name ?? '').trim() || (linkedin ? nameFromHandle(linkedin) : '') || emails[0] || '';
    if (!name && !linkedin && !emails.length) continue;
    const projectIds = [...new Set([...(raw.projectIds ?? []), projectId ?? ''].filter(Boolean))];
    /** @type {Contact} */
    const c = { id: uid(), name, emails, projectIds, source: raw.source || source, createdAt: at };
    for (const k of /** @type {const} */ (['headline', 'company', 'notes', 'image', 'location'])) {
      const v = String(raw[k] ?? '').trim();
      if (v) c[k] = v;
    }
    if (linkedin) c.linkedin = linkedin;
    incoming.push(c);
  }
  if (!incoming.length) return { added, updated };
  store.update(CONTACTS, (d) => {
    d.contacts ??= [];
    for (const c of incoming) {
      const x = sameAs(d.contacts, c);
      if (!x) {
        d.contacts.push(c);
        added.push(c);
        continue;
      }
      let changed = false;
      for (const k of /** @type {const} */ (['headline', 'company', 'notes', 'image', 'location', 'linkedin'])) {
        if (!x[k] && c[k]) { x[k] = c[k]; changed = true; }
      }
      // A name guessed from an address gives way to a real one.
      if (c.name && (!x.name || (x.name.includes('@') && !c.name.includes('@')))) { x.name = c.name; changed = true; }
      const emails = [...new Set([...(x.emails ?? []), ...c.emails])];
      const projectIds = [...new Set([...(x.projectIds ?? []), ...c.projectIds])];
      if (emails.length !== (x.emails ?? []).length) { x.emails = emails; changed = true; }
      if (projectIds.length !== (x.projectIds ?? []).length) { x.projectIds = projectIds; changed = true; }
      if (changed) {
        x.updatedAt = at;
        if (!updated.includes(x)) updated.push(x);
      }
    }
  });
  return { added, updated };
}
