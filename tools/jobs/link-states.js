// Reads whether the issues and PRs linked to tasks are open, merged or closed into github.json. The board asks it for
// links it has never read (POST /run/link-states { links }).
/** @import { Job } from '../../types/runner' */
import { configure } from '../../js/github.js';
import { dueLinks, readLinkStates } from '../../js/link-states.js';

export default /** @satisfies {Job} */ ({
  id: 'link-states',
  delay: 15000,
  timeout: 2 * 60000,
  async run({ store, params }) {
    configure(store.get('settings').github);
    const links = params.links?.length ? params.links.slice(0, 30) : dueLinks(store);
    if (!links.length) return { waiting: 'No task has an issue or PR due a read.' };
    const errors = await readLinkStates(store, links);
    if (errors.length === links.length) throw new Error(errors.slice(0, 3).join('; '));
    return { links: links.length - errors.length, errors: errors.map((text) => ({ text })) };
  },
});
