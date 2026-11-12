// Reads each project's Resend emails into inbox.json. Node is not bound by CORS, so it calls api.resend.com
// directly; the board asks this job for one email's body and for a key check.
import { syncInbox, keyedProjects, readEmailOf, checkResendKey } from '../../js/resend.js';

export default {
  id: 'resend',
  delay: 4000,
  timeout: 5 * 60000,
  async run({ store }) {
    if (!keyedProjects(store).length) return { waiting: 'No project has a Resend key.' };
    const { added, errors } = await syncInbox(store);
    if (errors.length && errors.length >= keyedProjects(store).length) throw new Error(errors.map((e) => e.text).join('; '));
    return { added, errors };
  },
  routes: {
    'GET /resend/email/*': (_body, id, store) => readEmailOf(store, id),
    'POST /resend/check': async (body) => ({ text: await checkResendKey(String(body.key ?? '')) }),
  },
};
