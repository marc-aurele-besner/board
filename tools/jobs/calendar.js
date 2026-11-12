// Reads every shown calendar into calendar.json: the window from the start of last month to three months ahead, or the
// range a Calendar page outside it asks for (POST /run/calendar { from, to }).
/** @import { DataStore } from '../../types/data' */
/** @import { Job } from '../../types/runner' */
import { readCalendars, calendarAccounts, useRangeReader } from '../../js/gcal.js';

export default /** @satisfies {Job} */ ({
  id: 'calendar',
  delay: 2500,
  timeout: 3 * 60000,
  setup() {
    // Cron's gather step reads ranges here too, without the HTTP hop.
    useRangeReader((/** @type {DataStore} */ store, /** @type {Date | string} */ from, /** @type {Date | string} */ to) => readCalendars(store, { from, to }));
  },
  async run({ store, params }) {
    // Events used to be cached in google.json; they live in calendar.json now.
    if (store.get('google').events) store.save('google', (d) => { delete d.events; });
    const accounts = calendarAccounts(store);
    if (!accounts.length) return { waiting: 'No Google Calendar account is added.' };
    const { read, errors, waiting } = await readCalendars(store, params.from && params.to ? params : {});
    if (!read && waiting.length === accounts.length) return { waiting: `Not connected: ${waiting.join(', ')}.` };
    if (!read && errors.length) throw new Error(errors.join('; '));
    return { read, errors, waiting: waiting.length ? `Not connected: ${waiting.join(', ')}.` : null };
  },
});
