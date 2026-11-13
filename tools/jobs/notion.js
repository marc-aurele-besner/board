// Reads every Notion database linked in Settings → Notion into tasks. Node is not bound by CORS, so it calls
// api.notion.com (and, for a browser session, www.notion.so with its cookie) directly; Settings asks this job to
// check a token or a session, to finish an OAuth sign-in, and to read a database it adds.
/** @import { Job } from '../../types/runner' */
/** @import { NotionSettings, NotionSession } from '../../types/data' */
import { syncNotion, hasNotion, checkNotionToken, checkSession, describeDatabase, exchangeNotionCode, parseDatabaseId, normalizeNotion } from '../../js/notion.js';

export default /** @satisfies {Job} */ ({
  id: 'notion',
  delay: 5000,
  timeout: 5 * 60000,
  async run({ store, params }) {
    if (!hasNotion(store)) return { waiting: 'No Notion sign-in or database is set up.' };
    const { added, updated, errors, count } = await syncNotion(store, { ids: params.ids });
    if (errors.length && errors.length >= count) throw new Error(errors.map((e) => `${e.link}: ${e.text}`).join('; '));
    return { added, updated, errors };
  },
  routes: {
    'POST /notion/check': async (body) => checkNotionToken(String(body.token ?? '')),
    'POST /notion/session': async (body) => checkSession(/** @type {NotionSession} */ (body.session ?? { tokenV2: '' })),
    'POST /notion/oauth': async (body) => exchangeNotionCode({
      clientId: String(body.clientId ?? ''),
      clientSecret: String(body.clientSecret ?? ''),
      code: String(body.code ?? ''),
      redirectUri: String(body.redirectUri ?? ''),
    }),
    'POST /notion/database': async (body) => {
      const id = parseDatabaseId(String(body.databaseId ?? ''));
      if (!id) throw new Error('This is not a Notion database link or id.');
      const cfg = normalizeNotion(/** @type {NotionSettings | undefined} */ (body.cfg));
      return { id, ...(await describeDatabase(cfg, id, body.account ? String(body.account) : undefined)) };
    },
  },
});
