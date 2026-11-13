// Reads every Notion database linked in Settings → Notion into tasks. Node is not bound by CORS, so it calls
// api.notion.com directly; Settings asks this job to check a token and to read a database it adds.
/** @import { Job } from '../../types/runner' */
import { syncNotion, hasNotion, checkNotionToken, describeDatabase, parseDatabaseId } from '../../js/notion.js';

export default /** @satisfies {Job} */ ({
  id: 'notion',
  delay: 5000,
  timeout: 5 * 60000,
  async run({ store, params }) {
    if (!hasNotion(store)) return { waiting: 'No Notion token or database is set up.' };
    const { added, updated, errors, count } = await syncNotion(store, { ids: params.ids });
    if (errors.length && errors.length >= count) throw new Error(errors.map((e) => `${e.link}: ${e.text}`).join('; '));
    return { added, updated, errors };
  },
  routes: {
    'POST /notion/check': async (body) => ({ text: await checkNotionToken(String(body.token ?? '')) }),
    'POST /notion/database': async (body) => {
      const id = parseDatabaseId(String(body.databaseId ?? ''));
      if (!id) throw new Error('This is not a Notion database link or id.');
      return { id, ...(await describeDatabase(String(body.token ?? ''), id)) };
    },
  },
});
