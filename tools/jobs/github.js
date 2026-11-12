// Reads every project's GitHub repos into github.json: open issue and PR counts and the newest open items. The board
// asks it for one repo it does not hold yet (POST /run/github { repos }).
/** @import { Job, NodeStore } from '../../types/runner' */
import { configure, readRepos } from '../../js/github.js';

/** @param {NodeStore} store */
const reposOf = (store) => [...new Set(store.get('projects').projects.flatMap((p) => p.github?.repos ?? []).filter(Boolean))];

export default /** @satisfies {Job} */ ({
  id: 'github',
  delay: 6000,
  timeout: 3 * 60000,
  async run({ store, params }) {
    configure(store.get('settings').github);
    const repos = params.repos?.length ? params.repos : reposOf(store);
    if (!repos.length) return { waiting: 'No project lists a GitHub repo.' };
    const errors = await readRepos(store, repos);
    if (errors.length === repos.length) throw new Error(errors.slice(0, 3).join('; '));
    return { repos: repos.length - errors.length, errors: errors.map((text) => ({ text })) };
  },
});
