// Reads every project's npm org and packages into npm.json: the org's package list, and each package's latest
// version, last publish and weekly downloads. The board asks it for one it does not hold yet (POST /run/npm).
import { readNpm, npmOf } from '../../js/npm.js';

const linksOf = (store) => {
  const projects = store.get('projects').projects.map(npmOf);
  return {
    orgs: [...new Set(projects.map((n) => n.org).filter(Boolean))],
    packages: [...new Set(projects.flatMap((n) => n.packages).filter(Boolean))],
  };
};

export default {
  id: 'npm',
  delay: 8000,
  timeout: 3 * 60000,
  async run({ store, params }) {
    const asked = params.orgs?.length || params.packages?.length;
    const links = asked ? { orgs: params.orgs ?? [], packages: params.packages ?? [] } : linksOf(store);
    const total = links.orgs.length + links.packages.length;
    if (!total) return { waiting: 'No project lists an npm org or package.' };
    const errors = await readNpm(store, links);
    if (errors.length && errors.length >= total) throw new Error(errors.slice(0, 3).join('; '));
    return { read: total, errors: errors.map((text) => ({ text })) };
  },
};
