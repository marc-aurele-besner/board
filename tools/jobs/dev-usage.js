// @ts-check
// Reads what each task's claude session used (models, tokens, cost, effort) from Claude Code's transcripts into
// usage.json `dev`. It reads them through tools/usage.js directly, with no HTTP hop to the command runner.
/** @import { Job } from '../../types/runner' */
import { refreshDevUsage, devUsage } from '../../js/dev-usage.js';
import { worktreeUsage } from '../usage.js';

export default /** @satisfies {Job} */ ({
  id: 'dev-usage',
  delay: 5000,
  timeout: 2 * 60000,
  async run({ store }) {
    await refreshDevUsage(store, (list) => worktreeUsage(list));
    return { records: Object.keys(devUsage(store)).length };
  },
});
