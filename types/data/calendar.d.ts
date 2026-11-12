// calendar.json: the runners' reads of every shown Google calendar (js/gcal.js, tools/jobs/calendar.js).

export interface CalendarEvent {
  // "<address>|<calendarId>|<eventId>".
  key: string;
  account: string;
  calendarId: string;
  // The calendar's name.
  calendar: string;
  color: string;
  projectId: string | null;
  // A project label id.
  labelId: string | null;
  title: string;
  // A date-time, or a date (YYYY-MM-DD) for an all-day event, whose end is the day after its last.
  start: string;
  end: string;
  allDay: boolean;
  location: string;
  description: string;
  // The event's page in Google Calendar, and its Meet link.
  link: string;
  meet: string;
}

// One read of a calendar over [from, to) (ms).
export interface CalendarRead {
  from: number;
  to: number;
  at: number;
  events: CalendarEvent[];
}

export interface CalendarData {
  // By "<address>|<calendarId>": the reads, newest first.
  calendars: Record<string, CalendarRead[]>;
  schemaVersion?: number;
}
