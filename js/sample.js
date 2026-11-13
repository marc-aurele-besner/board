// "Explore with sample data": a data folder that lives in memory, filled with placeholder content.
// It has the few methods of a real folder handle that storage.js and store.js call, so the rest of the app cannot tell.
// Nothing is written to disk, and it is gone when the page reloads.

/** @import { Collections, Task, FinanceEntry, DevUsage, InboxMessage, Site } from '../types/data' */

/** @param {number} n */
const pad = (n) => String(n).padStart(2, '0');
// A date as YYYY-MM-DD, `offset` days from today, so the sample always has something due today and something late.
/** @param {number} offset */
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// One filled profile, so the Projects page shows what a built profile looks like.
const SAMPLE_PROFILE = {
  text: [
    '## What it is',
    'Atlas Site is the marketing site of a sample product. It is for visitors comparing plans before they sign up.',
    '## Stack and layout',
    '- Static pages with a small amount of JavaScript',
    '- pages/ for content, assets/ for images and styles',
    '## How to work on it',
    '- Run a local static server and open the home page',
    '- Check every page at phone width before publishing',
    '## Recent focus',
    '- A new pricing page and fixes to the footer links',
    '## Website and blog',
    '- https://example.com presents the product and its plans',
    '## Unknowns',
    '- No repository or local folder is set, so the test commands are not known',
  ].join('\n'),
  sources: [],
  updated: new Date(Date.now() - 2 * 86400000).toISOString(),
  edited: false,
  usageId: '',
};

/** @param {string} name @param {Record<string, string | Blob>} initial */
function memoryFolder(name, initial) {
  const files = new Map(Object.entries(initial)); // path -> text or Blob
  const missing = () => Object.assign(new Error('Not found'), { name: 'NotFoundError' });
  /** @param {string} prefix @returns {object} */
  const folder = (prefix) => ({
    name,
    kind: 'directory',
    getDirectoryHandle: async (/** @type {string} */ part) => folder(`${prefix}${part}/`),
    /** @param {string} file @param {{ create?: boolean }} [options] */
    async getFileHandle(file, { create = false } = {}) {
      const path = prefix + file;
      if (!files.has(path)) {
        if (!create) throw missing();
        files.set(path, '');
      }
      return {
        async getFile() {
          const value = files.get(path);
          return value instanceof Blob ? value : new Blob([/** @type {string} */ (value)], { type: 'application/json' });
        },
        async createWritable() {
          /** @type {string | Blob} */
          let next = '';
          return {
            write: async (/** @type {string | Blob} */ data) => {
              next = data;
            },
            close: async () => {
              files.set(path, next);
            },
          };
        },
      };
    },
    /** @param {string} file */
    async removeEntry(file) {
      files.delete(prefix + file);
    },
  });
  return folder('');
}

// Top-level fields left out are filled with the collection's defaults when the store loads.
/** @returns {{ [K in keyof Collections]?: Partial<Collections[K]> }} */
function collections() {
  const at = new Date().toISOString();
  /**
   * @param {string} id @param {string} text @param {string} status @param {string} priority @param {string | null} projectId
   * @param {Partial<Task>} [more]
   * @returns {Task}
   */
  const task = (id, text, status, priority, projectId, more = {}) =>
    ({ id, text, description: '', status, priority, category: '', projectId, due: '', created: at, ...more });
  /**
   * @param {string} id @param {number} offset @param {string} type @param {number} amount @param {string} category @param {string} note
   * @param {string | null} [projectId]
   * @returns {FinanceEntry}
   */
  const entry = (id, offset, type, amount, category, note, projectId = null) =>
    ({ id, date: day(offset), type, amount, tax: 0, billId: '', currency: 'USD', category, note, projectId, source: '', created: at });
  // models: { id: [input, output, cache read, cache write, cost] }; the session ended `offset` days from today.
  /**
   * @param {string} name @param {string[]} taskIds @param {number} offset @param {Record<string, number[]>} models @param {string} effort
   * @returns {DevUsage}
   */
  const devRecord = (name, taskIds, offset, models, effort) => {
    const end = Date.now() + offset * 86400000 - 3600000;
    const list = Object.entries(models);
    return {
      name, cwd: '', added: at, taskIds, sessions: 1, start: end - 40 * 60000, end, duration: 38 * 60000, apiDuration: 21 * 60000,
      linesAdded: 214, linesRemoved: 37, replies: 60, efforts: { [effort]: 60 },
      cost: list.reduce((sum, [, m]) => sum + m[4], 0),
      models: Object.fromEntries(list.map(([id, [input, output, cacheRead, cacheWrite, cost]]) => [id, { provider: 'Anthropic', input, output, thinking: 0, cacheRead, cacheWrite, cost }])),
    };
  };
  /**
   * @param {string} id @param {string} dir @param {number} hoursAgo @param {string} from @param {string} subject
   * @param {Partial<InboxMessage>} [more]
   * @returns {InboxMessage}
   */
  const mail = (id, dir, hoursAgo, from, subject, more = {}) => ({
    id, dir, from, to: ['Atlas <hello@example.com>'], cc: [], subject, status: '', projectId: 'p-atlas', taskId: null,
    at: new Date(Date.now() - hoursAgo * 3600000).toISOString(), ...more,
  });
  /** @param {boolean} up @param {number} sslDays @returns {Site} */
  const site = (up, sslDays) => ({
    health: { status: up ? 'up' : 'down', ms: up ? 182 : 0, at },
    history: Array.from({ length: 30 }, (_, i) => ({ at, ok: up || i < 28, ms: 150 + i * 3 })),
    ssl: { until: day(sslDays), issuer: 'Sample CA', at },
    domain: { name: 'example.com', until: day(21), registrar: 'Sample Registrar', at },
  });
  return {
    projects: {
      categories: [{ id: 'cat-web', name: 'Web', color: '#3b6ea8' }, { id: 'cat-personal', name: 'Personal', color: '#2f6f4e' }],
      projects: [
        { id: 'p-atlas', name: 'Atlas Site', color: '#3b6ea8', description: 'Marketing site.', website: 'https://example.com', labels: ['cat-web'], parentId: null, github: { org: '', repos: [] }, profile: SAMPLE_PROFILE, created: at },
        { id: 'p-docs', name: 'Atlas Docs', color: '#2e8a8a', description: '', website: 'https://docs.example.com', labels: ['cat-web'], parentId: 'p-atlas', github: { org: '', repos: [] }, created: at },
        { id: 'p-reno', name: 'Home Reno', color: '#a3432b', description: '', website: '', labels: ['cat-personal'], parentId: null, github: { org: '', repos: [] }, created: at },
      ],
    },
    todos: {
      categories: [],
      items: [
        task('t1', 'Ship the pricing page', 'doing', 'high', 'p-atlas', { due: day(0), prs: [{ repo: 'example-org/atlas-site', number: 42, url: 'https://github.com/example-org/atlas-site/pull/42', title: 'Pricing page' }] }),
        task('t2', 'Fix the footer links', 'todo', 'none', 'p-atlas', { due: day(1) }),
        task('t3', 'Pick the bathroom tile', 'todo', 'high', 'p-reno', { due: day(-1) }),
        task('t4', 'Renew the domain example.com', 'todo', 'high', 'p-atlas', { due: day(21), auto: 'domain', autoRef: 'example.com', description: 'Created automatically: the domain expires soon.' }),
        task('t5', 'Ask about the invoice', 'todo', 'none', null, { auto: 'telegram', inbox: true }),
        task('t6', 'Write the install guide', 'review', 'medium', 'p-docs', { due: day(3) }),
        task('t7', 'Book the plumber', 'done', 'none', 'p-reno'),
        task('t8', 'Buy oat milk', 'todo', 'low', null),
      ],
    },
    // The pricing task's PR, with the previews a Vercel and a Netlify token would read (js/previews.js).
    github: {
      repos: {},
      previews: {
        'example-org/atlas-site#42': {
          at: Date.now(), first: Date.now() - 3600000, branch: 'feat/pricing', error: null,
          items: [
            { provider: 'vercel', name: 'atlas-site', url: 'https://atlas-site-git-feat-pricing.example.com', state: 'ready', id: 'dpl_sample', inspect: 'https://example.com/atlas-site/deployments', sha: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345', created: Date.now() - 50 * 60000, ready: Date.now() - 48 * 60000 },
            { provider: 'netlify', name: 'atlas-docs', url: 'https://deploy-preview-42--atlas-docs.example.com', state: 'failed', id: 'sample-deploy', site: 'sample-site', inspect: 'https://example.com/atlas-docs/deploys', error: 'Build script returned non-zero exit code: 2', sha: '3f9c2a1b7d4e5f60718293a4b5c6d7e8f9012345', created: Date.now() - 50 * 60000 },
          ],
        },
      },
    },
    recipes: {
      recipes: [
        { id: 'r1', title: 'Overnight focaccia', status: 'testing', tags: ['bread', 'vegan'], ingredients: ['500 g flour', '400 g water', '10 g salt', '3 g yeast'], steps: ['Mix', 'Rest overnight', 'Bake at 230 °C'], notes: 'A wetter dough gives bigger holes.', versions: [{ id: 'v1', date: day(-20), changes: 'Baseline', rating: 3, notes: '' }, { id: 'v2', date: day(-6), changes: '80% hydration', rating: 5, notes: 'Best so far.' }], created: at },
        { id: 'r2', title: 'Maple granola', status: 'final', tags: ['breakfast'], ingredients: ['Oats', 'Maple syrup', 'Pecans'], steps: ['Toss', 'Bake low and slow'], notes: 'Keeps three weeks in a jar.', versions: [{ id: 'v3', date: day(-90), changes: 'Less syrup', rating: 4, notes: '' }], created: at },
        { id: 'r3', title: 'Quick kimchi', status: 'idea', tags: ['ferment'], ingredients: [], steps: [], notes: '', versions: [], created: at },
      ],
    },
    finance: {
      categories: ['Groceries', 'Rent', 'Dining', 'Salary'],
      bills: [],
      categoryColors: { Groceries: '#2f6f4e' },
      recurring: [],
      budgets: { Groceries: { amount: 150, currency: 'USD' }, Dining: { amount: 200, currency: 'USD' } },
      entries: [
        entry('e1', 0, 'expense', 84.2, 'Groceries', 'Weekly shop'),
        entry('e2', 0, 'expense', 97.1, 'Groceries', 'Market'),
        entry('e3', 0, 'expense', 32.5, 'Dining', 'Ramen', 'p-reno'),
        entry('e4', 0, 'income', 4200, 'Salary', 'Monthly pay'),
      ],
    },
    // A few fee collections, so the Fees collected view of Liquidity Pools has something to chart.
    pools: {
      // Two positions on two chains, so the chain and token filters have something to pick from.
      collected: [[-2, 41.2], [-9, 37.5], [-16, 52.8], [-30, 18.4], [-44, 60.1], [-58, 33.9], [-75, 47.3]].map(([offset, usd], i) => ({
        id: `fc${i}`, at: `${day(offset)}T12:00:00.000Z`, source: i % 3 ? 'auto' : 'manual', usd, note: '',
        ...(i % 2
          ? { ref: '42161:200002', pair: 'WBTC / ETH', chain: 'Arbitrum One', tokenId: '200002' }
          : { ref: '8453:v4:100001', pair: 'ETH / USDC', chain: 'Base', tokenId: '100001' }),
      })),
    },
    // Two claude sessions Dev ran for tasks, so Monitoring, the tasks and Dev show what they used. No folder, so
    // the runner is never asked about them.
    usage: {
      entries: [],
      dev: {
        'ship-the-pricing-page-a1b2c3': devRecord('ship-the-pricing-page-a1b2c3', ['t1'], -1, { 'claude-opus-5-5': [820, 31200, 4100000, 160000, 2.84], 'claude-haiku-5-5': [1300, 210, 0, 0, 0.0003] }, 'high'),
        'write-the-install-guide-d4e5f6': devRecord('write-the-install-guide-d4e5f6', ['t6'], 0, { 'claude-sonnet-5-5': [410, 18400, 1900000, 90000, 0.97] }, 'medium'),
      },
    },
    tools: { every: 60, sites: { 'p-atlas': site(true, 64), 'p-docs': site(false, 9) } },
    inbox: {
      syncedAt: at,
      emails: [
        mail('m1', 'received', 1, 'Sam Rivera <sam@example.net>', 'Re: Pricing page feedback', { unread: true }),
        mail('m2', 'sent', 5, 'Atlas <hello@example.com>', 'Pricing page feedback', { to: ['Sam Rivera <sam@example.net>'], status: 'opened' }),
        mail('m3', 'received', 8, 'Billing <billing@example.org>', 'Your invoice is ready', { unread: true, starred: true }),
        mail('m4', 'sent', 26, 'Atlas <hello@example.com>', 'Welcome to Atlas', { to: ['new.user@example.net'], status: 'delivered' }),
        mail('m5', 'received', 30, 'Alex Kim <alex@example.net>', 'Question about the docs', { projectId: 'p-docs', to: ['help@docs.example.com'] }),
        mail('m6', 'sent', 50, 'Atlas <hello@example.com>', 'Password reset', { to: ['someone@example.net'], status: 'bounced' }),
        mail('m7', 'received', 200, 'Newsletter <news@example.org>', 'This month in web design', { archived: true }),
      ],
    },
    // Two accounts with three months of follower counts, so Monitoring → Socials has lines to draw.
    socials: {
      accounts: [
        { id: 's-x', network: 'x', handle: 'atlas_example', name: 'Atlas', projectId: 'p-atlas', followers: 1789, following: 180, at: Date.now() - 2 * 3600000, error: null },
        { id: 's-li', network: 'linkedin', handle: 'company/atlas-example', name: 'Atlas', projectId: 'p-atlas', followers: 784, at: Date.now() - 2 * 3600000, error: null },
      ],
      history: {
        's-x': Object.fromEntries(Array.from({ length: 90 }, (_, i) => [day(i - 89), 1240 + i * 6 + (i % 7) * 3])),
        's-li': Object.fromEntries(Array.from({ length: 90 }, (_, i) => [day(i - 89), 610 + i * 2 - (i % 5)])),
      },
    },
    notifications: {
      prefs: {},
      items: [
        { id: 'n1', kind: 'health', text: 'docs.example.com did not answer.', href: '#/tools', key: '', at, read: false },
        { id: 'n2', kind: 'telegram', text: 'New task from Telegram: “Ask about the invoice”. It waits in To Organize.', href: '#/todos?filter=organize', key: '', at, read: false },
      ],
    },
  };
}

export function sampleFolder() {
  const files = Object.fromEntries(Object.entries(collections()).map(([name, data]) => [`${name}.json`, JSON.stringify(data)]));
  // Not a real handle: it has only the methods storage.js and store.js call.
  return /** @type {FileSystemDirectoryHandle} */ (memoryFolder('Sample data', files));
}
