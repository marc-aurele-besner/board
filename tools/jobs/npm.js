// Reads every project's npm org and packages into npm.json: the org's package list, and each package's latest
// version, last publish and weekly downloads. The board asks it for one it does not hold yet (POST /run/npm).
/** @import { Job, NodeStore } from '../../types/runner' */
import { readNpm, npmOf } from '../../js/npm.js';

/** @param {NodeStore} store */
const linksOf = (store) => {
  const projects = store.get('projects').projects.map(npmOf);
  return {
    orgs: [...new Set(projects.map((n) => n.org).filter(Boolean))],
    packages: [...new Set(projects.flatMap((n) => n.packages).filter(Boolean))],
  };
};

export default /** @satisfies {Job} */ ({
  id: 'npm',
  delay: 8000,
  timeout: 3 * 60000,
  async run({ store, params }) {
    const asked = params.orgs?.length || params.packages?.length;
    const links = asked ? { orgs: params.orgs ?? [], packages: params.packages ?? [] } : linksOf(store);
    const total = links.orgs.length + links.packages.length;
    if (!total) return { waiting: 'No project lists an npm org or package.' };
    // readNpm() is not typed yet: its defaults `orgs = []` read as empty arrays only.
    const errors = await readNpm(store, /** @type {Parameters<typeof readNpm>[1]} */ (links));
    if (errors.length && errors.length >= total) throw new Error(errors.slice(0, 3).join('; '));
    return { read: total, errors: errors.map((text) => ({ text })) };
  },
});
