// Reads the Vercel and Netlify preview links of the PRs of open tasks and recent Cron runs into github.json. The
// board asks it for PRs it has never read (POST /run/previews { prs }).
import { configure } from '../../js/github.js';
import { duePrs, readPreviews } from '../../js/previews.js';

export default {
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
};
