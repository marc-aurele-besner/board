// @ts-check
// Reads every connected Gmail account's new mail into inbox.json. Tokens come from google.json, renewed by the
// google job. One email's body is still read by the board when it is opened (js/gmail.js readGmail).
/** @import { Job } from '../../types/runner' */
import { syncGmail, gmailAccounts } from '../../js/gmail.js';

export default /** @satisfies {Job} */ ({
  id: 'gmail',
  delay: 3000,
  timeout: 5 * 60000,
  async run({ store }) {
    const accounts = gmailAccounts(store);
    if (!accounts.length) return { waiting: 'No Gmail account is added.' };
    const { added, errors, waiting } = await syncGmail(store);
    if (waiting.length === accounts.length) return { waiting: `Not connected: ${waiting.join(', ')}.` };
    if (errors.length && errors.length + waiting.length >= accounts.length) throw new Error(errors.map((e) => e.text).join('; '));
    return { added, errors, waiting: waiting.length ? `Not connected: ${waiting.join(', ')}.` : null };
  },
});
