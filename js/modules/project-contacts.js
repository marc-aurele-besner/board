// Contacts on screen: the Contacts block of a project's page, the full list (Projects → Contacts), the dialog that adds
// or edits one, and the chips Inbox and Calendar show for a known address. The data side is js/contacts-core.js.
/** @import { Store, Contact, CalendarEvent, CalendarAttendee } from '../../types/data' */
import { h, icon, empty } from '../ui.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import { CONTACTS, addContacts, findByEmail, contactsOf, linkedinHandle, linkedinUrl, nameFromHandle, cleanEmail } from '../contacts-core.js';
import { projectIcon, projectTree } from './projects.js';
import { removeWithUndo } from '../remove.js';

// The full list's search, kept across redraws.
const listView = { query: '' };

/** @param {Store} store */
const allContacts = (store) => store.get(CONTACTS)?.contacts ?? [];
/** @param {Contact} a @param {Contact} b */
const byName = (a, b) => a.name.localeCompare(b.name);

// The picture, or the initials.
/** @param {Contact} c @param {string} [size] '' or 'small' */
export function contactAvatar(c, size = '') {
  const cls = `contact-avatar${size ? ` ${size}` : ''}`;
  if (c.image) return h('img', { class: cls, src: c.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' });
  const initials = c.name.split(/\s+/).filter((w) => /^\p{L}/u.test(w)).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';
  return h('span', { class: `${cls} is-letter`, 'aria-hidden': 'true' }, initials);
}

/** @param {Contact} c */
const linkedinLink = (c) => (c.linkedin
  ? h('a', { class: 'icon-btn contact-li', href: linkedinUrl(c.linkedin), target: '_blank', rel: 'noopener', title: 'LinkedIn profile', 'aria-label': `${c.name} on LinkedIn` }, icon('linkedin'))
  : null);

/** @param {Contact} c */
const roleOf = (c) => [c.headline, c.company && !(c.headline ?? '').includes(c.company) ? c.company : ''].filter(Boolean).join(' · ');

// A small chip for a known person: picture, name, headline and LinkedIn. A click on the name edits the contact.
/** @param {Store} store @param {Contact} c */
export function contactChip(store, c) {
  const role = roleOf(c);
  return h('span', { class: 'contact-chip' },
    contactAvatar(c, 'small'),
    h('button', { type: 'button', class: 'link-btn', title: 'Edit this contact', onclick: () => openContactDialog(store, c) }, c.name),
    role ? h('span', { class: 'muted small contact-chip-role' }, role) : null,
    linkedinLink(c));
}

// The contact an address belongs to, from "Name <address>" or a bare address.
/** @param {Store} store @param {string} from */
export function contactOfSender(store, from) {
  const m = String(from ?? '').match(/<([^>]+)>/);
  return findByEmail(store, m ? m[1] : from);
}

/**
 * Adds or edits a contact. A new one goes through addContacts, so pasting a profile or address already saved fills in
 * that contact instead of making a second one.
 * @param {Store} store
 * @param {Contact | null} contact
 * @param {{ projectId?: string | null, prefill?: Partial<Contact>, source?: string, onSaved?: (c: Contact) => void }} [opts]
 */
export function openContactDialog(store, contact, { projectId = null, prefill = {}, source = 'manual', onSaved } = {}) {
  const c = contact ?? /** @type {Contact} */ ({ id: '', name: '', emails: [], projectIds: projectId ? [projectId] : [], createdAt: 0, ...prefill });
  const projects = projectTree(store.get('projects').projects);
  /** @param {string} name @param {string} label @param {string} [value] @param {Record<string, unknown>} [attrs] */
  const field = (name, label, value = '', attrs = {}) => h('label', null, label, h('input', { name, value, autocomplete: 'off', ...attrs }));
  const form = /** @type {HTMLFormElement} */ (h('form', {
    class: 'stack contact-form',
    onsubmit: (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      const f = new FormData(form);
      const text = (/** @type {string} */ k) => String(f.get(k) ?? '').trim();
      const linkedin = linkedinHandle(text('linkedin'));
      const emails = [...new Set(text('emails').split(/[\s,;]+/).map(cleanEmail).filter((x) => x.includes('@')))];
      const name = text('name') || (linkedin ? nameFromHandle(linkedin) : '') || emails[0] || '';
      if (!name) return;
      const fields = {
        name,
        headline: text('headline'),
        company: text('company'),
        location: text('location'),
        image: text('image'),
        notes: text('notes'),
        linkedin,
        emails,
        projectIds: f.getAll('projects').map(String),
      };
      let saved;
      if (contact) {
        store.update(CONTACTS, (d) => {
          const x = d.contacts.find((y) => y.id === contact.id);
          if (!x) return;
          for (const [k, v] of Object.entries(fields)) {
            if (v === '' && k !== 'name') delete x[/** @type {keyof Contact} */ (k)];
            else Object.assign(x, { [k]: v });
          }
          x.updatedAt = Date.now();
          saved = x;
        });
      } else {
        const { added, updated } = addContacts(store, [fields], { source });
        saved = added[0] ?? updated[0];
        toast(added.length ? `${name} added to contacts` : `${name} was already a contact; filled in what was missing`);
      }
      dialog.close();
      if (saved) onSaved?.(saved);
    },
  },
    field('linkedin', 'LinkedIn profile', c.linkedin ? linkedinUrl(c.linkedin) : '', {
      type: 'url',
      placeholder: 'https://www.linkedin.com/in/…',
      // A pasted profile link gives a first guess at the name.
      oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
        const nameInput = /** @type {HTMLInputElement} */ (form.elements.namedItem('name'));
        const handle = linkedinHandle(e.target.value);
        if (handle.startsWith('in/') && (!nameInput.value || nameInput.dataset.guess === nameInput.value)) {
          nameInput.value = nameFromHandle(handle);
          nameInput.dataset.guess = nameInput.value;
        }
      },
    }),
    field('name', 'Name', c.name, { required: true }),
    h('div', { class: 'row wrap' },
      field('headline', 'Headline', c.headline ?? '', { placeholder: 'Founder at …' }),
      field('company', 'Company', c.company ?? '')),
    field('emails', 'Email addresses', (c.emails ?? []).join(', '), { placeholder: 'name@example.com, …' }),
    h('div', { class: 'row wrap' },
      field('location', 'Location', c.location ?? ''),
      field('image', 'Picture link', c.image ?? '', { type: 'url' })),
    h('label', null, 'Notes', h('textarea', { name: 'notes', rows: 3 }, c.notes ?? '')),
    h('fieldset', { class: 'contact-projects' },
      h('legend', null, 'Projects'),
      projects.length
        ? projects.map(({ project: p, depth }) => h('label', { class: 'check', style: { paddingLeft: `${depth * 14}px` } },
            h('input', { type: 'checkbox', name: 'projects', value: p.id, checked: (c.projectIds ?? []).includes(p.id) }),
            projectIcon(p), p.name))
        : h('p', { class: 'muted small' }, 'No projects yet.')),
    h('div', { class: 'row between' },
      contact
        ? h('button', {
            type: 'button',
            class: 'btn-small danger',
            onclick: () => {
              const removed = removeWithUndo(store, {
                ask: `Delete ${contact.name} from contacts?`,
                done: `Deleted ${contact.name}`,
                collections: [CONTACTS],
                run: () => store.update(CONTACTS, (d) => { d.contacts = d.contacts.filter((x) => x.id !== contact.id); }),
              });
              if (removed) dialog.close();
            },
          }, icon('trash'), 'Delete')
        : h('span'),
      h('button', { class: 'primary', type: 'submit' }, contact ? 'Save' : 'Add contact'))));
  const dialog = openDialog({ title: contact ? contact.name : 'New contact', body: form });
}

/** @param {Store} store @param {Contact} c @param {{ projects?: boolean }} [opts] */
function contactRow(store, c, { projects = false } = {}) {
  const role = roleOf(c);
  const all = store.get('projects').projects;
  const mine = projects ? all.filter((p) => (c.projectIds ?? []).includes(p.id)) : [];
  return h('li', { class: 'contact-row' },
    contactAvatar(c),
    h('div', { class: 'contact-main' },
      h('button', { type: 'button', class: 'link-btn contact-name', onclick: () => openContactDialog(store, c) }, c.name),
      role ? h('span', { class: 'muted small' }, role) : null,
      (c.emails ?? []).length
        ? h('span', { class: 'small contact-emails' }, c.emails.map((e) => h('a', { href: `mailto:${e}` }, e)))
        : null,
      mine.length ? h('span', { class: 'row small muted contact-projects-line' }, mine.map((p) => h('span', { class: 'row' }, projectIcon(p), p.name))) : null,
      c.notes ? h('span', { class: 'muted small contact-notes' }, c.notes) : null),
    linkedinLink(c));
}

/** @param {Store} store @param {string | null} projectId */
const addButton = (store, projectId) => h('button', {
  type: 'button',
  class: 'btn-small',
  onclick: () => openContactDialog(store, null, { projectId }),
}, icon('plus'), 'Add contact');

// The Contacts block of a project's page.
/** @param {Store} store @param {{ id: string }} p @param {() => void} showAll Opens the full list. */
export function contactsBlock(store, p, showAll) {
  const list = contactsOf(store, p.id).sort(byName);
  return h('section', { class: 'pp-block' },
    h('h3', null, 'Contacts'),
    list.length
      ? h('ul', { class: 'contact-list' }, list.map((c) => contactRow(store, c)))
      : h('p', { class: 'muted small' }, 'People tied to this project. Paste a LinkedIn profile link to add one; Inbox and Calendar then recognise their addresses.'),
    h('div', { class: 'row' },
      addButton(store, p.id),
      allContacts(store).length ? h('button', { type: 'button', class: 'btn-small', onclick: showAll }, icon('users'), 'All contacts') : null));
}

/** @param {Contact} c @param {string} q */
const matches = (c, q) => {
  const text = [c.name, c.headline, c.company, c.location, c.notes, c.linkedin, ...(c.emails ?? [])].join(' ').toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((w) => text.includes(w));
};

// Every contact, with a search that redraws only the list. `query` comes from the URL (the search page links here).
/**
 * @param {Store} store
 * @param {{ query?: string, onBack: () => void, onQuery: (q: string) => void }} opts
 */
export function contactsPanel(store, { query, onBack, onQuery }) {
  if (query !== undefined) listView.query = query;
  const all = [...allContacts(store)].sort(byName);
  const listBox = h('ul', { class: 'contact-list' });
  const fill = () => {
    const q = listView.query.trim().toLowerCase();
    const shown = q ? all.filter((c) => matches(c, q)) : all;
    listBox.replaceChildren(...(shown.length
      ? shown.map((c) => contactRow(store, c, { projects: true }))
      : [empty(all.length ? 'No contact matches.' : 'No contacts yet. Add one here or from a project’s page.')]));
  };
  fill();
  return h('div', { class: 'stack' },
    h('div', { class: 'row between wrap' },
      h('button', { type: 'button', class: 'btn-small', onclick: onBack }, icon('arrow-left'), 'Projects'),
      addButton(store, null)),
    h('h2', null, `Contacts (${all.length})`),
    all.length
      ? h('input', {
          type: 'search',
          placeholder: 'Search contacts',
          'aria-label': 'Search contacts',
          value: listView.query,
          oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
            listView.query = e.target.value;
            onQuery(listView.query);
            fill();
          },
        })
      : null,
    listBox);
}

// A calendar event's guests: a contact chip for each known one, and Add as contact for the others. The dialog is not
// redrawn with the page, so the list redraws itself after an add.
/** @param {Store} store @param {CalendarEvent} e */
export function eventGuests(store, e) {
  const guests = (e.attendees ?? []).filter((a) => !a.self);
  if (!guests.length) return null;
  const box = h('ul', { class: 'cal-guests' });
  /** @param {CalendarAttendee} a */
  const row = (a) => {
    const c = findByEmail(store, a.email);
    const response = a.response && a.response !== 'needsAction' ? h('span', { class: 'muted small' }, a.response) : null;
    if (c) return h('li', { class: 'row' }, contactChip(store, c), response);
    return h('li', { class: 'row' },
      h('span', null, a.name ? `${a.name} ` : '', h('span', { class: a.name ? 'muted small' : '' }, a.email)),
      response,
      h('button', {
        type: 'button',
        class: 'btn-small',
        onclick: () => openContactDialog(store, null, {
          projectId: e.projectId,
          source: 'calendar',
          prefill: { name: a.name ?? '', emails: [a.email] },
          onSaved: paint,
        }),
      }, icon('plus'), 'Add as contact'));
  };
  const paint = () => box.replaceChildren(...guests.map(row));
  paint();
  return h('div', { class: 'stack' }, h('h3', { class: 'small muted' }, `Guests (${guests.length})`), box);
}
