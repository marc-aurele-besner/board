// contacts.json: people worth remembering, tied to projects. Added by hand from a LinkedIn link, by Cron's
// "Save contacts" step, or from a calendar guest; Inbox and Calendar match them by email.

export interface Contact {
  id: string;
  name: string;
  headline?: string;
  company?: string;
  // The LinkedIn profile path, 'in/<name>' (js/socials.js parseHandle).
  linkedin?: string;
  emails: string[];
  projectIds: string[];
  notes?: string;
  image?: string;
  location?: string;
  // Where it came from: 'manual', 'cron', 'calendar'.
  source?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface ContactsData {
  contacts: Contact[];
  schemaVersion?: number;
}
