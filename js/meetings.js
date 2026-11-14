// Upcoming meetings with guests, for Cron's "Meeting prep": each event starting soon that has someone other than you,
// its guests matched to contacts, and the latest emails exchanged with each guest. No DOM: the runners import this file.
/** @import { DataStore, CalendarEvent, InboxMessage } from '../types/data' */
import { calendarEvents, calendarAccounts, eventDate } from './gcal.js';
import { findByEmail, cleanEmail, linkedinUrl } from './contacts-core.js';
import { dateLocale } from './locale.js';

// Emails listed per guest, and how long an event description may be.
export const MEETING_EMAILS = 3;
const DESCRIPTION_CHARS = 600;

/**
 * @typedef {{ dir: string, subject: string, at: string, from: string }} MeetingEmail
 * @typedef {{ name: string, headline: string, company: string, location: string, notes: string, linkedin: string }} MeetingContact
 * @typedef {{ email: string, name: string, response: string, contact: MeetingContact | null, emails: MeetingEmail[] }} MeetingGuest
 * @typedef {{ key: string, label: string, title: string, start: string, end: string, when: string, location: string, meet: string, link: string,
 *   projectId: string, project: string, description: string, guests: MeetingGuest[], text: string }} Meeting
 */

/** @param {string} from */
const addressOf = (from) => cleanEmail(String(from ?? '').match(/<([^>]+)>/)?.[1] ?? from);

// Event descriptions are often HTML; the prompt only needs the words.
/** @param {string} html */
const plain = (html) => String(html ?? '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li)>/gi, '\n').replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n').trim();

/** @param {string} v */
const whenOf = (v) => eventDate(v).toLocaleString(dateLocale(), { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

// The latest emails sent to or received from an address, newest first.
/** @param {InboxMessage[]} emails @param {string} address @param {number} max @returns {MeetingEmail[]} */
export function emailsWith(emails, address, max = MEETING_EMAILS) {
  const a = cleanEmail(address);
  return emails
    .filter((e) => !e.deleted && (e.dir === 'sent' ? [...(e.to ?? []), ...(e.cc ?? [])].some((x) => addressOf(x) === a) : addressOf(e.from) === a))
    .sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : 0))
    .slice(0, max)
    .map((e) => ({ dir: e.dir, subject: e.subject || '(no subject)', at: e.at, from: e.from }));
}

/** @param {Meeting} m */
function meetingText(m) {
  const lines = [`## ${m.title}`, `When: ${m.when}${m.location ? ` · ${m.location}` : ''}`];
  if (m.project) lines.push(`Project: ${m.project}`);
  if (m.description) lines.push(`Description: ${m.description}`);
  lines.push('', 'Guests:');
  for (const g of m.guests) {
    const c = g.contact;
    const who = c ? c.name : g.name;
    lines.push(`- ${who ? `${who} <${g.email}>` : g.email}${g.response && g.response !== 'needsAction' ? ` (${g.response})` : ''}`);
    if (c) {
      const role = [c.headline, c.company].filter(Boolean).join(' · ');
      if (role) lines.push(`  ${role}`);
      if (c.location) lines.push(`  Location: ${c.location}`);
      if (c.linkedin) lines.push(`  LinkedIn: ${c.linkedin}`);
      if (c.notes) lines.push(`  Notes: ${c.notes.replace(/\s*\n\s*/g, ' / ')}`);
    } else {
      lines.push('  Not in contacts.');
    }
    if (g.emails.length) {
      lines.push('  Latest emails:');
      for (const e of g.emails) lines.push(`  - ${String(e.at).slice(0, 10)} ${e.dir === 'sent' ? 'sent' : 'received'}: ${e.subject}`);
    } else {
      lines.push('  No emails in the Inbox.');
    }
  }
  return lines.join('\n');
}

/**
 * The events starting within the next `hours` hours with at least one guest besides you, each with its guests and
 * their emails. A meeting on two calendars counts once; one you declined is left out.
 * @param {DataStore} store
 * @param {number} hours
 * @param {{ now?: Date, events?: CalendarEvent[] }} [opts] `events` skips the calendar read (tests).
 * @returns {Promise<Meeting[]>}
 */
export async function upcomingMeetings(store, hours, { now = new Date(), events } = {}) {
  const to = new Date(now.getTime() + hours * 3600000);
  let list = events;
  if (!list) {
    if (!calendarAccounts(store).length) throw new Error('Connect a Google Calendar in Settings first.');
    const read = await calendarEvents(store, now, to);
    if (!read.events.length && (read.waiting.length || read.errors.length)) {
      throw new Error(read.waiting.length ? `Sign in again to ${read.waiting.join(', ')} in Calendar.` : read.errors.join(' · '));
    }
    list = read.events;
  }
  const projects = store.get('projects').projects;
  const inbox = store.get('inbox')?.emails ?? [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {Meeting[]} */
  const out = [];
  for (const e of list) {
    if (e.allDay) continue;
    const start = eventDate(e.start);
    if (start < now || start >= to) continue;
    const self = cleanEmail(e.account);
    const all = e.attendees ?? [];
    if (all.some((a) => (a.self || cleanEmail(a.email) === self) && a.response === 'declined')) continue;
    const guests = all.filter((a) => !a.self && cleanEmail(a.email) !== self);
    if (!guests.length) continue;
    const dup = `${e.title}|${e.start}`;
    if (seen.has(dup)) continue;
    seen.add(dup);
    const when = whenOf(e.start);
    const description = plain(e.description);
    /** @type {Meeting} */
    const m = {
      key: e.key,
      label: `Meeting prep: ${e.title} (${when})`,
      title: e.title,
      start: e.start,
      end: e.end,
      when,
      location: e.location,
      meet: e.meet,
      link: e.link,
      projectId: e.projectId ?? '',
      project: projects.find((p) => p.id === e.projectId)?.name ?? '',
      description: description.length > DESCRIPTION_CHARS ? `${description.slice(0, DESCRIPTION_CHARS)}…` : description,
      guests: guests.map((a) => {
        const c = findByEmail(store, a.email);
        return {
          email: cleanEmail(a.email),
          name: a.name ?? '',
          response: a.response ?? '',
          contact: c ? {
            name: c.name,
            headline: c.headline ?? '',
            company: c.company ?? '',
            location: c.location ?? '',
            notes: c.notes ?? '',
            linkedin: c.linkedin ? linkedinUrl(c.linkedin) : '',
          } : null,
          emails: emailsWith(inbox, a.email),
        };
      }),
      text: '',
    };
    m.text = meetingText(m);
    out.push(m);
  }
  return out.sort((a, b) => eventDate(a.start).getTime() - eventDate(b.start).getTime());
}
