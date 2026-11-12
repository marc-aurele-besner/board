// "Explore with sample data": a data folder that lives in memory, filled with placeholder content.
// It has the few methods of a real folder handle that storage.js and store.js call, so the rest of the app cannot tell.
// Nothing is written to disk, and it is gone when the page reloads.

const pad = (n) => String(n).padStart(2, '0');
// A date as YYYY-MM-DD, `offset` days from today, so the sample always has something due today and something late.
function day(offset) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function memoryFolder(name, initial) {
  const files = new Map(Object.entries(initial)); // path -> text or Blob
  const missing = () => Object.assign(new Error('Not found'), { name: 'NotFoundError' });
  const folder = (prefix) => ({
    name,
    kind: 'directory',
    getDirectoryHandle: async (part) => folder(`${prefix}${part}/`),
    async getFileHandle(file, { create = false } = {}) {
      const path = prefix + file;
      if (!files.has(path)) {
        if (!create) throw missing();
        files.set(path, '');
      }
      return {
        async getFile() {
          const value = files.get(path);
          return value instanceof Blob ? value : new Blob([value], { type: 'application/json' });
        },
        async createWritable() {
          let next = '';
          return {
            write: async (data) => {
              next = data;
            },
            close: async () => {
              files.set(path, next);
            },
          };
        },
      };
    },
    async removeEntry(file) {
      files.delete(prefix + file);
    },
  });
  return folder('');
}

function collections() {
  const at = new Date().toISOString();
  const task = (id, text, status, priority, projectId, more = {}) =>
    ({ id, text, description: '', status, priority, category: '', projectId, due: '', created: at, ...more });
  const entry = (id, offset, type, amount, category, note, projectId = null) =>
    ({ id, date: day(offset), type, amount, tax: 0, billId: '', currency: 'USD', category, note, projectId, source: '', created: at });
  const mail = (id, dir, hoursAgo, from, subject, more = {}) => ({
    id, dir, from, to: ['Atlas <hello@example.com>'], cc: [], subject, status: '', projectId: 'p-atlas', taskId: null,
    at: new Date(Date.now() - hoursAgo * 3600000).toISOString(), ...more,
  });
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
        { id: 'p-atlas', name: 'Atlas Site', color: '#3b6ea8', description: 'Marketing site.', website: 'https://example.com', labels: ['cat-web'], parentId: null, github: { org: '', repos: [] }, created: at },
        { id: 'p-docs', name: 'Atlas Docs', color: '#2e8a8a', description: '', website: 'https://docs.example.com', labels: ['cat-web'], parentId: 'p-atlas', github: { org: '', repos: [] }, created: at },
        { id: 'p-reno', name: 'Home Reno', color: '#a3432b', description: '', website: '', labels: ['cat-personal'], parentId: null, github: { org: '', repos: [] }, created: at },
      ],
    },
    todos: {
      categories: [],
      items: [
        task('t1', 'Ship the pricing page', 'doing', 'high', 'p-atlas', { due: day(0) }),
        task('t2', 'Fix the footer links', 'todo', 'none', 'p-atlas', { due: day(1) }),
        task('t3', 'Pick the bathroom tile', 'todo', 'high', 'p-reno', { due: day(-1) }),
        task('t4', 'Renew the domain example.com', 'todo', 'high', 'p-atlas', { due: day(21), auto: 'domain', autoRef: 'example.com', description: 'Created automatically: the domain expires soon.' }),
        task('t5', 'Ask about the invoice', 'todo', 'none', null, { auto: 'telegram', inbox: true }),
        task('t6', 'Write the install guide', 'review', 'medium', 'p-docs', { due: day(3) }),
        task('t7', 'Book the plumber', 'done', 'none', 'p-reno'),
        task('t8', 'Buy oat milk', 'todo', 'low', null),
      ],
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
  return memoryFolder('Sample data', files);
}
