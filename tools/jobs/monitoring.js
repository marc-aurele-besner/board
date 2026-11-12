// @ts-check
// The board's watch round, every 5 minutes: deadlines and budgets announced under the bell, site checks (health on
// the Tools interval; SSL, domain, DNS and crawl daily), status pages when due, and the rules that turn results into
// tasks. Tools → Check all now runs it with { parts } (sites) or { providers: true } (status pages).
/** @import { Job } from '../../types/runner' */
import { checkDeadlines } from '../../js/notify-core.js';
import { checkBudgets, checkDueSites, checkAllSites, checkProviders, providersDue } from '../../js/automations.js';
import { loadBudgetRates } from '../../js/money-core.js';

export default /** @satisfies {Job} */ ({
  id: 'monitoring',
  delay: 3000,
  timeout: 10 * 60000,
  async run({ store, params }) {
    if (params.providers) {
      await checkProviders(store);
      return { providers: store.get('tools').providers.length };
    }
    if (params.parts) return { tasks: await checkAllSites(store, params.parts) };
    checkDeadlines(store);
    await loadBudgetRates(store);
    checkBudgets(store);
    const tasks = await checkDueSites(store);
    // Status pages follow the same interval as website health.
    if (providersDue(store)) await checkProviders(store);
    return { tasks };
  },
});
