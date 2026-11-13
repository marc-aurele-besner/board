// Reads the Vercel and Netlify preview links of the PRs of open tasks and recent Cron runs into github.json. The
// board asks it for PRs it has never read (POST /run/previews { prs }), and for a Netlify build log, which only
// streams over a WebSocket (GET /previews/log/netlify/<site>/<deploy>).
/** @import { Job } from '../../types/runner' */
import { configure } from '../../js/github.js';
import { duePrs, readPreviews } from '../../js/previews.js';
import { deployTokens, netlifyLog } from '../../js/deployments.js';

export default /** @satisfies {Job} */ ({
  id: 'previews',
  delay: 10000,
  timeout: 2 * 60000,
  async run({ store, params }) {
    configure(store.get('settings').github);
    const prs = params.prs?.length ? params.prs : duePrs(store);
    if (!prs.length) return { waiting: 'No open task or recent Cron run has a PR due a read.' };
    const errors = await readPreviews(store, prs);
    if (errors.length === prs.length) throw new Error(errors.slice(0, 3).join('; '));
    return { prs: prs.length - errors.length, errors: errors.map((text) => ({ text })) };
  },
  routes: {
    'GET /previews/log/netlify/*': (_body, rest, store) => {
      const [site, id] = rest.split('/');
      const { netlify } = deployTokens(store);
      if (!netlify) throw Object.assign(new Error('Add a Netlify token in Settings → Netlify to read the log.'), { status: 400 });
      if (!site || !id) throw Object.assign(new Error('Which site and deploy?'), { status: 400 });
      return netlifyLog(netlify, site, id);
    },
  },
});
