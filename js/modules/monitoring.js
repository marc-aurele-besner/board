import { h, money, empty, notice } from '../ui.js';
import { getCatalog } from '../model-picker.js';
import { fetchActivity } from '../github.js';
import { setupBanner } from '../integrations.js';

const COLLECTION = 'usage';
const DAY = 86400000;
const HOUR = 3600000;
const TABS = [['ai', 'AI usage'], ['github', 'GitHub activity']];
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// View state: the sub-tab and the period. The period applies to every chart and number on the page.
const view = { tab: 'ai', period: '7' };
// Prices per model (USD per token), used to estimate calls that had no reported cost.
const prices = { status: 'idle', map: new Map() };
// GitHub activity for the linked repos over the period. Reloaded when the period changes.
const gh = { key: '', scheduled: '', status: 'idle', data: {}, errors: {} };

// --- Periods: local-time buckets (hours for one day, days otherwise) ---

function periodWindow(period) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'today' || period === 'yesterday') {
    const dayStart = period === 'today' ? today0 : new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() - 1);
    const dayEnd = period === 'today' ? now : today0;
    const items = [];
    for (let hr = 0; hr < 24; hr++) {
      const s = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hr).getTime();
      if (s >= dayEnd.getTime()) break;
      items.push({ start: s, end: Math.min(s + HOUR, dayEnd.getTime()), label: String(hr).padStart(2, '0') });
    }
    return { start: dayStart.getTime(), end: dayEnd.getTime(), items, hourly: true };
  }
  const days = Number(period);
  const items = [];
  for (let i = days - 1; i >= 0; i--) {
    const s = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() - i);
    const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
    items.push({ start: s.getTime(), end: e.getTime(), label: `${s.getMonth() + 1}/${s.getDate()}` });
  }
  return { start: items[0].start, end: items[items.length - 1].end, items, hourly: false };
}

const inWindow = (ms, w) => ms !== null && ms >= w.start && ms < w.end;
const bucketOf = (ms, w) => w.items.findIndex((b) => ms >= b.start && ms < b.end);
const parseTime = (iso) => (iso ? Date.parse(iso) : null);
const median = (list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hoursLabel = (hours) => {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
};

// --- Charts: plain SVG bars, drawn from numbers and our own labels only ---

function barChart(labels, series) {
  const W = Math.max(360, labels.length * 24);
  const H = 160;
  const PAD = 22;
  const totals = labels.map((_, i) => series.reduce((s, sr) => s + (sr.values[i] || 0), 0));
  const max = Math.max(1, ...totals);
  const slot = W / labels.length;
  const bw = Math.max(4, slot * 0.6);
  let body = '';
  labels.forEach((label, i) => {
    const x = i * slot + (slot - bw) / 2;
    let y = H - PAD;
    for (const sr of series) {
      const v = sr.values[i] || 0;
      const height = (v / max) * (H - PAD - 8);
      y -= height;
      body += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${sr.color}"><title>${label} · ${sr.name}: ${v}</title></rect>`;
    }
    if (labels.length <= 12 || i % Math.ceil(labels.length / 10) === 0) {
      body += `<text x="${(x + bw / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${label}</text>`;
    }
  });
  const wrap = h('div', { class: 'chart' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${body}</svg>`;
  return wrap;
}

function legend(series) {
  return h('div', { class: 'legend' }, series.map((sr) =>
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', style: { background: sr.color } }), sr.name)));
}

function stat(label, value, hint) {
  return h('div', { class: 'card stat' },
    h('span', { class: 'muted small' }, label),
    h('strong', null, value),
    hint ? h('span', { class: 'muted small' }, hint) : null);
}

// --- AI usage ---

const usd = (n) => money(n, 'USD');
const usdPrecise = (n) => (n < 0.01 ? `$${n.toFixed(4)}` : usd(n));
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// A call's cost: the reported one, or an estimate from the model's price. Null when neither is known.
function costOf(e) {
  if (e.cost !== null && e.cost !== undefined) return { value: e.cost, estimated: false };
  const p = prices.map.get(e.model);
  if (!p) return null;
  return { value: e.promptTokens * p.prompt + e.completionTokens * p.completion, estimated: true };
}

function loadPrices(store) {
  if (prices.status === 'loading' || prices.status === 'ok') return;
  prices.status = 'loading';
  store.refresh();
  getCatalog()
    .then((models) => {
      for (const m of models) prices.map.set(m.id, { prompt: (m.prompt ?? 0) / 1e6, completion: (m.completion ?? 0) / 1e6 });
      prices.status = 'ok';
    })
    .catch(() => {
      prices.status = 'error';
    })
    .finally(() => store.refresh());
}

function groupTable(title, rows, label) {
  return h('section', { class: 'card stack' },
    h('h3', null, title),
    rows.length
      ? h('div', { class: 'mon-scroll' },
          h('table', { class: 'mon-table' },
            h('thead', null, h('tr', null,
              h('th', null, label), h('th', { class: 'num' }, 'Calls'), h('th', { class: 'num' }, 'Tokens'), h('th', { class: 'num' }, 'Cost'))),
            h('tbody', null, rows.map((r) =>
              h('tr', null,
                h('td', null, r.label),
                h('td', { class: 'num' }, String(r.calls)),
                h('td', { class: 'num' }, fmtTokens(r.tokens)),
                h('td', { class: 'num' }, r.cost === null ? '—' : `${r.estimated ? '≈ ' : ''}${usdPrecise(r.cost)}`))))))
      : empty('No calls in this period.'));
}

function groupCalls(entries, keyOf, labelOf) {
  const map = new Map();
  for (const e of entries) {
    const key = keyOf(e);
    const row = map.get(key) ?? { label: labelOf(e), calls: 0, tokens: 0, cost: 0, priced: 0, estimated: false };
    row.calls += 1;
    row.tokens += e.promptTokens + e.completionTokens;
    const c = costOf(e);
    if (c) {
      row.cost += c.value;
      row.priced += 1;
      row.estimated = row.estimated || c.estimated;
    }
    map.set(key, row);
  }
  return [...map.values()]
    .map((r) => ({ ...r, cost: r.priced ? r.cost : null }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0) || b.calls - a.calls);
}

function aiTab(store, w) {
  const all = store.get(COLLECTION).entries;
  const entries = all.filter((e) => inWindow(parseTime(e.at), w));
  const tasks = new Map((store.get('settings').models?.tasks ?? []).map((t) => [t.id, t.name]));
  const taskName = (id) => tasks.get(id) ?? id;

  const costs = w.items.map(() => 0);
  const calls = w.items.map(() => 0);
  let total = 0;
  let tokens = 0;
  let unpriced = 0;
  let estimated = false;
  for (const e of entries) {
    const b = bucketOf(parseTime(e.at), w);
    const c = costOf(e);
    tokens += e.promptTokens + e.completionTokens;
    if (c) {
      total += c.value;
      estimated = estimated || c.estimated;
      if (b >= 0) costs[b] += c.value;
    } else unpriced += 1;
    if (b >= 0) calls[b] += 1;
  }
  const series = [{ name: 'Cost (USD)', color: 'var(--accent)', values: costs.map((v) => Number(v.toFixed(4))) }];
  const recent = [...entries].sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15);

  return h('div', { class: 'stack-lg' },
    prices.status === 'error'
      ? notice({ tone: 'info', text: 'Model prices could not be loaded, so calls without a reported cost are not priced.' })
      : null,
    h('div', { class: 'summary' },
      stat('Cost', `${estimated ? '≈ ' : ''}${usdPrecise(total)}`, unpriced ? `${unpriced} call${unpriced === 1 ? '' : 's'} without a price` : 'USD'),
      stat('Calls', String(entries.length), 'in this period'),
      stat('Tokens', fmtTokens(tokens), 'input + output')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Cost over time'),
      entries.length ? barChart(w.items.map((b) => b.label), series) : empty('No AI calls in this period.'),
      entries.length ? legend(series) : null),
    h('div', { class: 'split-2' },
      groupTable('By model', groupCalls(entries, (e) => e.model, (e) => e.model), 'Model'),
      groupTable('By task', groupCalls(entries, (e) => e.task, (e) => taskName(e.task)), 'Task')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Recent calls'),
      recent.length
        ? h('ul', { class: 'mon-recent' }, recent.map((e) => {
            const c = costOf(e);
            return h('li', null,
              h('span', { class: 'muted small time' }, e.at.slice(0, 16).replace('T', ' ')),
              h('span', { class: 'grow' }, taskName(e.task), h('span', { class: 'muted small' }, ` · ${e.model}`)),
              h('span', { class: 'muted small' }, `${fmtTokens(e.promptTokens + e.completionTokens)} tokens`),
              h('span', { class: 'num' }, c ? `${c.estimated ? '≈ ' : ''}${usdPrecise(c.value)}` : '—'));
          }))
        : empty('No AI calls yet. Calls appear here after you use a feature such as Tidy with AI or reading a bill.')));
}

// --- GitHub activity ---

// Loads commits, pull requests and issues of every linked repo for the period. Results that arrive for an old period are ignored.
function loadGh(store, repos, sinceIso, key) {
  gh.key = key;
  gh.scheduled = '';
  gh.data = {};
  gh.errors = {};
  if (!repos.length) {
    gh.status = 'ok';
    return store.refresh();
  }
  gh.status = 'loading';
  let pending = repos.length;
  for (const repo of repos) {
    fetchActivity(repo, sinceIso)
      .then((d) => {
        if (gh.key === key) gh.data[repo] = d;
      })
      .catch((err) => {
        if (gh.key === key) gh.errors[repo] = err.message;
      })
      .finally(() => {
        if (gh.key !== key) return;
        pending -= 1;
        if (!pending) gh.status = 'ok';
        store.refresh();
      });
  }
  store.refresh();
}

// The numbers for the period, computed from what was loaded.
function activity(w) {
  const commits = [];
  const prs = [];
  const issues = [];
  const perRepo = {};
  for (const [repo, d] of Object.entries(gh.data)) {
    perRepo[repo] = { repo, commits: 0, merged: 0, issuesClosed: 0, openPrs: 0, openIssues: 0 };
    for (const c of d.commits) commits.push({ ...c, repo });
    for (const p of d.pulls) prs.push({ ...p, repo });
    for (const i of d.issues) issues.push({ ...i, repo });
  }
  const now = Date.now();
  const commitsIn = commits.filter((c) => inWindow(parseTime(c.at), w));
  const mergedIn = prs.filter((p) => inWindow(parseTime(p.merged), w));
  const closedUnmerged = prs.filter((p) => !p.merged && inWindow(parseTime(p.closed), w));
  const openedPrs = prs.filter((p) => inWindow(parseTime(p.created), w));
  const openPrs = prs.filter((p) => p.state === 'open');
  const stalePrs = openPrs.filter((p) => now - parseTime(p.updated) > 14 * DAY);
  const issuesOpened = issues.filter((i) => inWindow(parseTime(i.created), w));
  const issuesClosed = issues.filter((i) => inWindow(parseTime(i.closed), w));
  const openIssues = issues.filter((i) => i.state === 'open');
  const mergeHours = mergedIn.map((p) => (parseTime(p.merged) - parseTime(p.created)) / HOUR).filter((x) => x >= 0);
  const closeHours = issuesClosed.map((i) => (parseTime(i.closed) - parseTime(i.created)) / HOUR).filter((x) => x >= 0);

  const authors = new Map();
  for (const c of commitsIn) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
  const weekdays = WEEKDAYS.map(() => 0);
  for (const c of commitsIn) weekdays[new Date(parseTime(c.at)).getDay()] += 1;

  for (const c of commitsIn) if (perRepo[c.repo]) perRepo[c.repo].commits += 1;
  for (const p of mergedIn) if (perRepo[p.repo]) perRepo[p.repo].merged += 1;
  for (const i of issuesClosed) if (perRepo[i.repo]) perRepo[i.repo].issuesClosed += 1;
  for (const p of openPrs) if (perRepo[p.repo]) perRepo[p.repo].openPrs += 1;
  for (const i of openIssues) if (perRepo[i.repo]) perRepo[i.repo].openIssues += 1;

  const commitBuckets = w.items.map(() => 0);
  const openedBuckets = w.items.map(() => 0);
  const closedBuckets = w.items.map(() => 0);
  commitsIn.forEach((c) => {
    const b = bucketOf(parseTime(c.at), w);
    if (b >= 0) commitBuckets[b] += 1;
  });
  [...openedPrs, ...issuesOpened].forEach((x) => {
    const b = bucketOf(parseTime(x.created), w);
    if (b >= 0) openedBuckets[b] += 1;
  });
  [...mergedIn, ...closedUnmerged, ...issuesClosed].forEach((x) => {
    const b = bucketOf(parseTime(x.merged ?? x.closed), w);
    if (b >= 0) closedBuckets[b] += 1;
  });

  // Streak: consecutive days with a commit, counting back from the last day of the period.
  let streak = 0;
  if (!w.hourly) {
    for (let i = commitBuckets.length - 1; i >= 0 && commitBuckets[i] > 0; i--) streak += 1;
  }
  const weeks = Math.max(1 / 7, (w.end - w.start) / (7 * DAY));

  return {
    commits: commitsIn.length,
    activeBuckets: commitBuckets.filter((n) => n > 0).length,
    authors: [...authors].sort((a, b) => b[1] - a[1]),
    weekdays,
    streak,
    opened: openedPrs.length,
    merged: mergedIn.length,
    closedUnmerged: closedUnmerged.length,
    openPrs: openPrs.length,
    stalePrs: stalePrs.length,
    mergeMedian: median(mergeHours),
    issuesOpened: issuesOpened.length,
    issuesClosed: issuesClosed.length,
    openIssues: openIssues.length,
    closeMedian: median(closeHours),
    throughput: (mergedIn.length + issuesClosed.length) / weeks,
    commitBuckets,
    openedBuckets,
    closedBuckets,
    repos: Object.values(perRepo).sort((a, b) => b.commits - a.commits),
  };
}

function githubTab(store, w) {
  const projects = store.get('projects').projects;
  const repos = [...new Set(projects.flatMap((p) => p.github.repos))];
  const since = new Date(w.start).toISOString();
  const key = `${w.start}|${repos.join(',')}`;
  // Start the load after this render, so the refresh does not run inside it.
  if (gh.key !== key && gh.scheduled !== key) {
    gh.scheduled = key;
    setTimeout(() => loadGh(store, repos, since, key), 0);
  }
  if (!repos.length) {
    return setupBanner('github', 'Link a repository to a project to see its commits, pull requests and issues here.');
  }
  const token = Boolean(store.get('settings').github?.token);
  const failed = Object.keys(gh.errors);
  const a = activity(w);
  const loading = gh.status === 'loading' && Object.keys(gh.data).length + failed.length < repos.length;
  const commitSeries = [{ name: 'Commits', color: 'var(--accent)', values: a.commitBuckets }];
  const flowSeries = [
    { name: 'Opened (PRs + issues)', color: '#c7811a', values: a.openedBuckets },
    { name: 'Closed or merged', color: 'var(--accent)', values: a.closedBuckets },
  ];
  const labels = w.items.map((b) => b.label);

  return h('div', { class: 'stack-lg' },
    !token ? setupBanner('github', `Showing public repos only. Add a GitHub token to include private repos and raise the rate limit.`, { tone: 'info' }) : null,
    failed.length
      ? notice({ text: `${failed.length} repo${failed.length > 1 ? 's' : ''} could not be read: ${failed.map((r) => `${r} (${gh.errors[r]})`).join('; ')}` })
      : null,
    loading
      ? h('div', { class: 'progress', role: 'status' },
          h('div', { class: 'progress-label' }, `Reading ${repos.length} repo${repos.length > 1 ? 's' : ''}…`),
          h('div', { class: 'progress-track' }, h('div', { class: 'progress-bar' })))
      : null,

    h('div', { class: 'summary' },
      stat('Commits', String(a.commits), `${a.activeBuckets} active ${w.hourly ? 'hours' : 'days'}${w.hourly ? '' : ` · ${a.streak}-day streak`}`),
      stat('Merged PRs', String(a.merged), `${hoursLabel(a.mergeMedian)} median to merge`),
      stat('Issues closed', String(a.issuesClosed), `${hoursLabel(a.closeMedian)} median to close`),
      stat('Throughput', a.throughput.toFixed(1), 'merged PRs + closed issues per week')),

    h('section', { class: 'card stack' },
      h('h3', null, 'Commits'),
      barChart(labels, commitSeries),
      legend(commitSeries)),

    h('section', { class: 'card stack' },
      h('h3', null, 'Flow'),
      barChart(labels, flowSeries),
      legend(flowSeries)),

    h('div', { class: 'split' },
      h('section', { class: 'card stack' },
        h('h3', null, 'Pull requests'),
        h('div', { class: 'mini-stats' },
          miniStat(a.opened, 'opened'), miniStat(a.merged, 'merged'), miniStat(a.closedUnmerged, 'closed unmerged'),
          miniStat(a.openPrs, 'open now'), miniStat(a.stalePrs, 'stale > 14 days'))),
      h('section', { class: 'card stack' },
        h('h3', null, 'Issues'),
        h('div', { class: 'mini-stats' },
          miniStat(a.issuesOpened, 'opened'), miniStat(a.issuesClosed, 'closed'), miniStat(a.openIssues, 'open now')))),

    h('div', { class: 'split' },
      h('section', { class: 'card stack' },
        h('h3', null, 'Busiest days of the week'),
        a.commits ? barChart(WEEKDAYS, [{ name: 'Commits', color: 'var(--accent)', values: a.weekdays }]) : empty('No commits in this period.')),
      h('section', { class: 'card stack' },
        h('h3', null, 'Top contributors'),
        a.authors.length
          ? h('ul', { class: 'mon-recent' }, a.authors.slice(0, 6).map(([name, n]) =>
              h('li', null, h('span', { class: 'grow' }, name), h('span', { class: 'num' }, `${n} commit${n === 1 ? '' : 's'}`))))
          : empty('No commits in this period.'))),

    h('section', { class: 'card stack' },
      h('h3', null, 'By repo'),
      a.repos.length
        ? h('div', { class: 'mon-scroll' },
            h('table', { class: 'mon-table' },
              h('thead', null, h('tr', null,
                h('th', null, 'Repo'), h('th', { class: 'num' }, 'Commits'), h('th', { class: 'num' }, 'PRs merged'),
                h('th', { class: 'num' }, 'Issues closed'), h('th', { class: 'num' }, 'Open PRs'), h('th', { class: 'num' }, 'Open issues'))),
              h('tbody', null, a.repos.map((r) =>
                h('tr', null,
                  h('td', null, r.repo),
                  h('td', { class: 'num' }, String(r.commits)),
                  h('td', { class: 'num' }, String(r.merged)),
                  h('td', { class: 'num' }, String(r.issuesClosed)),
                  h('td', { class: 'num' }, String(r.openPrs)),
                  h('td', { class: 'num' }, String(r.openIssues)))))))
        : empty('Nothing loaded yet.')));
}

function miniStat(n, label) {
  return h('div', { class: 'mini' }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));
}

// --- Page ---

function draw(root, store) {
  if (prices.status === 'idle') setTimeout(() => loadPrices(store), 0);
  const w = periodWindow(view.period);
  const body = view.tab === 'github' ? githubTab(store, w) : aiTab(store, w);
  const periodName = PERIODS.find(([k]) => k === view.period)?.[1] ?? '';

  root.replaceChildren(
    h('div', { class: 'stack-lg mon' },
      h('header', { class: 'mon-head' },
        h('h2', null, 'Monitoring'),
        h('p', { class: 'muted small' }, view.tab === 'github'
          ? 'Commits, pull requests and issues across the repos linked to your projects.'
          : 'AI calls made by the board, with their cost and tokens.')),
      h('nav', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Monitoring sections' },
        TABS.map(([key, label]) =>
          h('button', {
            type: 'button',
            role: 'tab',
            class: view.tab === key ? 'sub-tab active' : 'sub-tab',
            'aria-selected': String(view.tab === key),
            onclick: () => {
              view.tab = key;
              store.refresh();
            },
          }, label))),
      h('div', { class: 'period-row' },
        h('span', { class: 'muted small' }, `Showing ${periodName.toLowerCase()}`),
        h('div', { class: 'period', role: 'group', 'aria-label': 'Period' },
          PERIODS.map(([key, label]) =>
            h('button', {
              type: 'button',
              class: view.period === key ? 'period-btn active' : 'period-btn',
              'aria-pressed': String(view.period === key),
              onclick: () => {
                view.period = key;
                store.refresh();
              },
            }, label)))),
      body));
}

export default {
  id: 'monitoring',
  title: 'Monitoring',
  icon: 'activity',
  collection: COLLECTION,
  defaults: { entries: [] },
  render: draw,
  serialize: () => ({ tab: view.tab === 'ai' ? '' : view.tab, period: view.period === '7' ? '' : view.period }),
  restore: (p = {}) => {
    view.tab = p.tab === 'github' ? 'github' : 'ai';
    view.period = PERIODS.some(([k]) => k === p.period) ? p.period : '7';
  },
};
