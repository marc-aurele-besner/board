// Reads each project website's Bing Webmaster data into webstats.json. Node is not bound by CORS, so it calls Bing
// directly; Monitoring → Search shows the file. Also answers Settings' key check.
/** @import { Project } from '../../types/data' */
/** @import { Job } from '../../types/runner' */
import { readBing, checkBingKey } from '../../js/webstats.js';
import { sitesOf } from '../../js/automations.js';

export default /** @satisfies {Job} */ ({
  id: 'webstats',
  delay: 8000,
  timeout: 5 * 60000,
  async run({ store, params }) {
    const key = store.get('settings').bing?.key ?? '';
    if (!key) return { waiting: 'No Bing API key is set.' };
    const websites = params.websites?.length ? params.websites : sitesOf(store).map((/** @type {Project} */ p) => p.website);
    if (!websites.length) return { waiting: 'No project has a website.' };
    const errors = await readBing(store, key, websites);
    if (errors.length === websites.length) throw new Error(errors.slice(0, 3).join('; '));
    return { sites: websites.length - errors.length, errors: errors.map((text) => ({ text })) };
  },
  routes: {
    'POST /bing/check': async (body) => ({ text: await checkBingKey(String(body.key ?? '')) }),
  },
});
