import { h, icon, money, empty, notice } from '../ui.js';
import { openDialog } from '../modal.js';
import { barChart, legend } from '../chart.js';
import { LOG_LIMIT } from '../ai.js';
import { getCatalog } from '../model-picker.js';
import { fetchActivity } from '../github.js';
import { setupBanner } from '../integrations.js';
import { analyticsTab, searchTab, sortTable } from './monitoring-web.js';
import { runnersTab } from './monitoring-runners.js';
import { socialsTab } from './monitoring-socials.js';
import { contractsActivityTab, contractsActivitySerialize, contractsActivityRestore } from './monitoring-contracts.js';
import { usageRecords, sumUsage, modelName, modelsByUse, fmtDuration, tokensOf } from '../dev-usage.js';
import { sessionStatus } from '../terminal.js';
import { runnerOf } from '../dev-core.js';
/** @import { AiCallMeta, AiMessage, DevUsage, Store, UsageEntry } from '../../types/data' */
/** @import { RunnerStatus } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @import { MonitoringView, PeriodBucket, PeriodWindow } from '../../types/monitoring' */
/** @import { RepoActivity } from '../github.js' */

const COLLECTION = 'usage';
const DAY = 86400000;
const HOUR = 3600000;
const TABS = [['ai', 'AI usage'], ['github', 'GitHub activity'], ['analytics', 'Web analytics'], ['search', 'Search'], ['socials', 'Socials'], ['contracts', 'Contracts'], ['runners', 'Board runners']];
/** @type {Record<string, string>} */
const SUBTITLES = {
  ai: 'AI calls made by the board, and what the claude sessions Dev ran for tasks used.',
  github: 'Commits, pull requests and issues across the repos linked to your projects.',
  analytics: 'Visitors and page views for each project website, from Google Analytics.',
  search: 'How each project website shows up in Google and Bing search.',
  socials: 'Followers of the X, LinkedIn and GitHub accounts added in Settings, GitHub stars, and how they grew.',
  contracts: 'Transactions and events on the smart contracts saved in Settings.',
  runners: 'The processes bun start runs on this computer, and how each background job of the worker is doing.',
};
const PERIODS = [['today', 'Today'], ['yesterday', 'Yesterday'], ['7', '7 days'], ['30', '30 days'], ['90', '90 days']];
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// View state: the sub-tab and the period. The period applies to every chart and number on the page.
// `site` and `engine` belong to the two website tabs: the project shown, and Google or Bing.
/** @type {MonitoringView} */
const view = { tab: 'ai', period: '7', site: '', engine: 'google' };
// Prices per model (USD per token), used to estimate calls that had no reported cost.
/** @type {{ status: string, map: Map<string, { prompt: number, completion: number }> }} */
const prices = { status: 'idle', map: new Map() };
// GitHub activity for the linked repos over the period. Reloaded when the period changes.
/** @type {{ key: string, scheduled: string, status: string, data: Record<string, RepoActivity>, errors: Record<string, string> }} */
const gh = { key: '', scheduled: '', status: 'idle', data: {}, errors: {} };

// --- Periods: local-time buckets (hours for one day, days otherwise) ---

/** @param {string} period @returns {PeriodWindow} */
function periodWindow(period) {
  const now = new Date();
  const today0 = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (period === 'today' || period === 'yesterday') {
    const dayStart = period === 'today' ? today0 : new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() - 1);
    const dayEnd = period === 'today' ? now : today0;
    /** @type {PeriodBucket[]} */
    const items = [];
    for (let hr = 0; hr < 24; hr++) {
      const s = new Date(dayStart.getFullYear(), dayStart.getMonth(), dayStart.getDate(), hr).getTime();
      if (s >= dayEnd.getTime()) break;
      items.push({ start: s, end: Math.min(s + HOUR, dayEnd.getTime()), label: String(hr).padStart(2, '0') });
    }
    return { start: dayStart.getTime(), end: dayEnd.getTime(), items, hourly: true };
  }
  const days = Number(period);
  /** @type {PeriodBucket[]} */
  const items = [];
  for (let i = days - 1; i >= 0; i--) {
    const s = new Date(today0.getFullYear(), today0.getMonth(), today0.getDate() - i);
    const e = new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1);
    items.push({ start: s.getTime(), end: e.getTime(), label: `${s.getMonth() + 1}/${s.getDate()}` });
  }
  return { start: items[0].start, end: items[items.length - 1].end, items, hourly: false };
}

const inWindow = (/** @type {number | null} */ ms, /** @type {PeriodWindow} */ w) => ms !== null && ms >= w.start && ms < w.end;
// A null time is in no bucket.
const bucketOf = (/** @type {number | null | undefined} */ ms, /** @type {PeriodWindow} */ w) => w.items.findIndex((b) => /** @type {number} */ (ms) >= b.start && /** @type {number} */ (ms) < b.end);
const parseTime = (/** @type {string | null | undefined} */ iso) => (iso ? Date.parse(iso) : null);
const median = (/** @type {number[]} */ list) => {
  if (!list.length) return null;
  const sorted = [...list].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const hoursLabel = (/** @type {number | null} */ hours) => {
  if (hours === null) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} min`;
  if (hours < 48) return `${hours.toFixed(1)} h`;
  return `${(hours / 24).toFixed(1)} days`;
};

/** @param {string} label @param {Child} value @param {Child} [hint] */
export function stat(label, value, hint) {
  return h('div', { class: 'card stat' },
    h('span', { class: 'muted small' }, label),
    h('strong', null, value),
    hint ? h('span', { class: 'muted small' }, hint) : null);
}

// --- AI usage ---

const usd = (/** @type {number} */ n) => money(n, 'USD');
const usdPrecise = (/** @type {number} */ n) => (n < 0.01 ? `$${n.toFixed(4)}` : usd(n));
const fmtTokens = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));

// A call's cost: the reported one, or an estimate from the model's price. Null when neither is known.
/** @param {UsageEntry} e @returns {{ value: number, estimated: boolean } | null} */
function costOf(e) {
  if (e.cost !== null && e.cost !== undefined) return { value: e.cost, estimated: false };
  const p = prices.map.get(e.model);
  if (!p) return null;
  return { value: e.promptTokens * p.prompt + e.completionTokens * p.completion, estimated: true };
}

/** @param {Store} store */
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

/** @param {string} title @param {CallGroup[]} rows @param {string} label */
function groupTable(title, rows, label) {
  return h('section', { class: 'card stack' },
    h('h3', null, title),
    rows.length
      ? sortTable(`ai-${label}`, [
          { label, value: (r) => r.label },
          { label: 'Calls', num: true, value: (r) => r.calls },
          { label: 'Tokens', num: true, value: (r) => r.tokens, format: fmtTokens },
          { label: 'Cost', num: true, value: (r) => r.cost, format: (v, r) => (v === null ? '—' : `${r.estimated ? '≈ ' : ''}${usdPrecise(v)}`) },
        ], rows)
      : empty('No calls in this period.'));
}

/** @typedef {{ label: string, calls: number, tokens: number, cost: number | null, priced: number, estimated: boolean }} CallGroup */
/** @param {UsageEntry[]} entries @param {(e: UsageEntry) => string} keyOf @param {(e: UsageEntry) => string} labelOf @returns {CallGroup[]} */
function groupCalls(entries, keyOf, labelOf) {
  /** @type {Map<string, { label: string, calls: number, tokens: number, cost: number, priced: number, estimated: boolean }>} */
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

// Features send their data as compact JSON; indent it so it can be read.
/** @param {string} text */
function pretty(text) {
  if (!/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

// One message's content as text. Parts that are not text (images, files) show as a short placeholder.
/** @param {AiMessage['content']} content */
function contentText(content) {
  if (typeof content === 'string') return pretty(content);
  if (!Array.isArray(content)) return JSON.stringify(content, null, 2);
  return content.map((part) => {
    if (part?.type === 'text') return part.text;
    if (part?.type === 'image_url') return `[image: ${part.image_url?.url ?? ''}]`;
    if (part?.type === 'file') return `[file: ${part.file?.filename ?? ''} ${part.file?.file_data ?? ''}]`;
    return JSON.stringify(part, null, 2);
  }).join('\n\n');
}

/** @param {HTMLElement} btn @param {string} text */
async function copyText(btn, text) {
  try {
    await navigator.clipboard.writeText(text);
    /** @type {ChildNode} */ (btn.lastChild).textContent = 'Copied';
  } catch {
    // Clipboard blocked: select the text so Cmd/Ctrl+C still works.
    getSelection()?.selectAllChildren(/** @type {HTMLPreElement} */ (/** @type {HTMLElement} */ (btn.closest('.call-block')).querySelector('pre')));
  }
}

const block = (/** @type {string} */ title, /** @type {string} */ text) =>
  h('section', { class: 'call-block' },
    h('header', { class: 'row' },
      h('strong', { class: 'grow' }, title),
      h('button', { type: 'button', class: 'btn-small', onclick: (/** @type {MouseEvent} */ e) => copyText(/** @type {HTMLElement} */ (e.currentTarget), text) }, icon('copy'), h('span', null, 'Copy'))),
    h('pre', { class: 'call-pre' }, text || '(empty)'));

// The call's details: what was sent, what came back, and how.
/** @param {UsageEntry} e @param {string} task */
function showCall(e, task) {
  const c = costOf(e);
  const m = /** @type {Partial<AiCallMeta>} */ (e.meta ?? {});
  const facts = /** @type {[string, string][]} */ ([
    ['Time', new Date(e.at).toLocaleString()],
    ['Task', task],
    ['Model asked', e.model],
    m.servedModel && m.servedModel !== e.model ? ['Model served', m.servedModel] : null,
    m.provider ? ['Provider', m.provider] : null,
    m.overridden ? ['Model source', 'Picked by the caller (a Cron step)'] : null,
    ['Input tokens', String(e.promptTokens)],
    ['Output tokens', String(e.completionTokens)],
    m.usage?.completion_tokens_details?.reasoning_tokens ? ['Reasoning tokens', String(m.usage.completion_tokens_details.reasoning_tokens)] : null,
    m.usage?.prompt_tokens_details?.cached_tokens ? ['Cached tokens', String(m.usage.prompt_tokens_details.cached_tokens)] : null,
    ['Cost', c ? `${c.estimated ? '≈ ' : ''}${usdPrecise(c.value)}${c.estimated ? ' (estimated from the model price)' : ''}` : '—'],
    m.ms !== undefined ? ['Duration', m.ms >= 1000 ? `${(m.ms / 1000).toFixed(1)} s` : `${m.ms} ms`] : null,
    m.status ? ['HTTP status', String(m.status)] : null,
    m.finishReason ? ['Finish reason', m.finishReason] : null,
    m.generationId ? ['Generation id', m.generationId] : null,
  ].filter(Boolean));
  const messages = Array.isArray(e.input) ? e.input : [];
  openDialog({
    title: `${task} · ${new Date(e.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}`,
    wide: true,
    body: h('div', { class: 'stack call-detail' },
      e.error ? notice({ text: e.error }) : null,
      h('dl', { class: 'call-facts' }, facts.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
      'input' in e
        ? [
            h('h3', null, `Input · ${messages.length} message${messages.length === 1 ? '' : 's'}`),
            messages.map((msg, i) => block(`${i + 1}. ${msg.role}`, contentText(msg.content))),
            h('h3', null, 'Output'),
            block('Reply', pretty(e.output ?? '')),
            m.usage ? block('Usage as reported', JSON.stringify(m.usage, null, 2)) : null,
          ]
        : notice({ tone: 'info', text: `The full input and output are not kept for this call. They are kept for the latest ${LOG_LIMIT} calls made since call logging was added.` })),
  });
}

/** @param {Store} store @param {PeriodWindow} w */
function aiTab(store, w) {
  const all = store.get(COLLECTION).entries;
  const entries = all.filter((e) => inWindow(parseTime(e.at), w));
  const tasks = new Map((store.get('settings').models?.tasks ?? []).map((t) => [t.id, t.name]));
  const taskName = (/** @type {string} */ id) => tasks.get(id) ?? id;

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
      entries.length ? barChart(w.items.map((b) => b.label), series, { format: usdPrecise }) : empty('No AI calls in this period.'),
      entries.length ? legend(series) : null),
    h('div', { class: 'split-2' },
      groupTable('By model', groupCalls(entries, (e) => e.model, (e) => e.model), 'Model'),
      groupTable('By task', groupCalls(entries, (e) => e.task, (e) => taskName(e.task)), 'Task')),
    devSessions(store, w),
    h('section', { class: 'card stack' },
      h('h3', null, 'Recent calls'),
      recent.length
        ? h('ul', { class: 'mon-recent mon-calls' }, recent.map((e) => {
            const c = costOf(e);
            return h('li', null,
              h('button', { type: 'button', class: 'call-row', title: 'Show this call', onclick: () => showCall(e, taskName(e.task)) },
                h('span', { class: 'muted small time' }, e.at.slice(0, 16).replace('T', ' ')),
                h('span', { class: 'grow' }, taskName(e.task), h('span', { class: 'muted small' }, ` · ${e.model}`)),
                e.error ? h('span', { class: 'pill tone-failed' }, 'Failed') : null,
                h('span', { class: 'muted small' }, `${fmtTokens(e.promptTokens + e.completionTokens)} tokens`),
                h('span', { class: 'num' }, c ? `${c.estimated ? '≈ ' : ''}${usdPrecise(c.value)}` : '—')));
          }))
        : empty('No AI calls yet. Calls appear here after you use a feature such as Tidy with AI or reading a bill.'),
      recent.length ? h('p', { class: 'muted small' }, 'Select a call to see what was sent, the full reply and its details.') : null));
}

// --- Dev sessions: what claude used for tasks, from its transcripts (dev-usage.js) ---

// What each Dev session's terminal is doing, asked of the command runner while the AI tab is shown, so the sessions
// still running stand out from the finished ones. Working or waiting for you counts as in progress.
const LIVE_POLL_MS = 5000;
/** @type {{ status: Record<string, RunnerStatus>, ids: string[], timer: number | 'asking' }} */
const live = { status: {}, ids: [], timer: 0 };
/** @type {Record<string, string>} */
const LIVE_STATES = { working: 'Working', waiting: 'Waiting for you' };
const aiShown = () => location.hash.startsWith('#/monitoring') && view.tab === 'ai';
const runnersShown = () => location.hash.startsWith('#/monitoring') && view.tab === 'runners';

// Asks for `ids` now and every few seconds while the AI tab is shown; the page draws again only when a state changed.
/** @param {Store} store @param {string[]} ids */
function pollLive(store, ids) {
  live.ids = ids;
  if (live.timer || !ids.length) return;
  const poll = async () => {
    // Held while the runner answers, so a page drawn meanwhile does not start a second poll.
    live.timer = 'asking';
    if (!aiShown() || !live.ids.length) return (live.timer = 0);
    try {
      const status = await sessionStatus(runnerOf(store), live.ids);
      const changed = JSON.stringify(status) !== JSON.stringify(live.status);
      live.status = status;
      if (changed && aiShown()) store.refresh();
    } catch {
      // An unreachable runner says nothing about the sessions: they show as they were.
    }
    live.timer = setTimeout(poll, LIVE_POLL_MS);
  };
  live.timer = setTimeout(poll, 0);
}

// A session counts in the period its last reply falls in.
/** @param {Store} store @param {PeriodWindow} w */
function devSessions(store, w) {
  const records = usageRecords(store).filter((r) => inWindow(r.end ?? null, w));
  const tasks = store.get('todos').items;
  const sum = sumUsage(records);
  const included = w.items.map(() => 0);
  const extra = w.items.map(() => 0);
  for (const r of records) {
    const b = bucketOf(r.end, w);
    if (b < 0 || !r.cost) continue;
    const x = Math.min(r.cost, r.extraCost ?? 0);
    extra[b] += x;
    included[b] += r.cost - x;
  }
  const round = (/** @type {number} */ v) => Number(v.toFixed(4));
  const series = [
    { name: 'Included in plan', color: 'var(--accent)', values: included.map(round) },
    { name: 'Extra, billed', color: 'var(--warn)', values: extra.map(round) },
  ];
  const models = modelsByUse(sum).map((id) => ({ id, ...sum.models[id], tokens: tokensOf(sum.models[id]) }));
  // The terminal session of a record: its own, or one of its tasks' (records saved before they named it).
  const sessionOf = (/** @type {DevUsage} */ r) => r.session || tasks.find((t) => r.taskIds?.includes(t.id) && t.devSession)?.devSession || '';
  pollLive(store, [...new Set(records.map(sessionOf).filter(Boolean))]);
  const rows = records.map((r) => {
    const one = sumUsage([r]);
    const named = tasks.filter((t) => r.taskIds?.includes(t.id)).map((t) => t.text);
    const state = live.status[sessionOf(r)]?.state;
    return { label: named.join(', ') || r.name, name: r.name, one, end: r.end, state: LIVE_STATES[/** @type {string} */ (state)] ? state : '' };
  });
  const running = rows.filter((r) => r.state).length;
  const costCell = /** @param {number | null} v @param {boolean} [partial] */ (v, partial) => (v === null ? '—' : `${partial ? '≥ ' : ''}${usdPrecise(v)}`);
  return h('section', { class: 'card stack' },
    h('h3', null, 'Dev sessions'),
    h('p', { class: 'muted small' }, 'What the claude sessions started from tasks used, read from Claude Code\'s transcripts while the board and its runner are open. Costs are at API prices, as Claude Code counts them, and known once claude quits. Included is what the Claude plan covers; Extra is billed beyond it: replies after the plan\'s limit switched to extra usage, sessions without a plan login, and Bedrock or Vertex models.'),
    records.length
      ? [
          h('div', { class: 'summary' },
            stat('Included', costCell(sum.included, sum.costPartial), sum.billing === 'api' ? 'no Claude plan: every token is billed' : 'covered by the Claude plan'),
            stat('Extra', costCell(sum.extraCost), sum.costPartial ? 'some sessions still running' : 'billed beyond the plan'),
            stat('Sessions', String(sum.sessions), `for ${rows.length} task worktree${rows.length === 1 ? '' : 's'}${running ? `, ${running} in progress` : ''}`),
            stat('Tokens', fmtTokens(sum.tokens), 'input, cache and output'),
            stat('Time', fmtDuration(sum.duration), sum.linesAdded || sum.linesRemoved ? `+${sum.linesAdded} −${sum.linesRemoved} lines` : 'worked')),
          barChart(w.items.map((b) => b.label), series, { format: usdPrecise }),
          sortTable('dev-models', [
            { label: 'Model', value: (m) => modelName(m.id), format: (v, m) => h('span', { title: m.id }, v) },
            { label: 'Provider', value: (m) => m.provider },
            { label: 'Input', num: true, value: (m) => m.input + m.cacheRead + m.cacheWrite, format: fmtTokens },
            { label: 'Cached', num: true, value: (m) => m.cacheRead, format: fmtTokens },
            { label: 'Output', num: true, value: (m) => m.output, format: fmtTokens },
            { label: 'Cost', num: true, value: (m) => m.cost, format: (v) => costCell(v) },
            { label: 'Extra', num: true, value: (m) => m.extraCost, format: (v) => costCell(v) },
          ], models),
          sortTable('dev-tasks', [
            { label: 'Task', clip: true, value: (r) => r.label, format: (v, r) => h('span', { title: r.name }, v) },
            { label: 'Status', value: (r) => (r.state ? 0 : 1), format: (v, r) => h('span', { class: `pill dev-state dev-${r.state || 'finished'}`, title: r.state ? 'claude is still running: the numbers keep growing until it quits' : 'claude has quit or nothing is running' }, r.state ? LIVE_STATES[r.state] : 'Finished') },
            { label: 'Model', value: (r) => modelsByUse(r.one).map(modelName).join(', ') },
            { label: 'Effort', value: (r) => r.one.effort || '—' },
            { label: 'Tokens', num: true, value: (r) => r.one.tokens, format: fmtTokens },
            { label: 'Cost', num: true, value: (r) => r.one.cost, format: (v, r) => costCell(v, r.one.costPartial) },
            { label: 'Extra', num: true, value: (r) => r.one.extraCost, format: (v) => costCell(v) },
            { label: 'Time', num: true, value: (r) => r.one.duration, format: fmtDuration },
            { label: 'Last reply', num: true, value: (r) => r.end, format: (v) => new Date(v).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) },
          ], rows.sort((a, b) => /** @type {number} */ (b.end) - /** @type {number} */ (a.end)), (r) => (r.state ? `dev-live dev-${r.state}` : '')),
        ]
      : empty('No Dev sessions in this period. Start claude on a task with its Dev button and its usage shows here.'));
}

// --- GitHub activity ---

// Loads commits, pull requests and issues of every linked repo for the period. Results that arrive for an old period are ignored.
/** @param {Store} store @param {string[]} repos @param {string} sinceIso @param {string} key */
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
      .catch((/** @type {Error} */ err) => {
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
/** @param {PeriodWindow} w */
function activity(w) {
  /** @type {(RepoActivity['commits'][number] & { repo: string })[]} */
  const commits = [];
  /** @type {(RepoActivity['pulls'][number] & { repo: string })[]} */
  const prs = [];
  /** @type {(RepoActivity['issues'][number] & { repo: string })[]} */
  const issues = [];
  /** @type {Record<string, { repo: string, commits: number, merged: number, issuesClosed: number, openPrs: number, openIssues: number }>} */
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
  const stalePrs = openPrs.filter((p) => now - /** @type {number} */ (parseTime(p.updated)) > 14 * DAY);
  const issuesOpened = issues.filter((i) => inWindow(parseTime(i.created), w));
  const issuesClosed = issues.filter((i) => inWindow(parseTime(i.closed), w));
  const openIssues = issues.filter((i) => i.state === 'open');
  const mergeHours = mergedIn.map((p) => (/** @type {number} */ (parseTime(p.merged)) - /** @type {number} */ (parseTime(p.created))) / HOUR).filter((x) => x >= 0);
  const closeHours = issuesClosed.map((i) => (/** @type {number} */ (parseTime(i.closed)) - /** @type {number} */ (parseTime(i.created))) / HOUR).filter((x) => x >= 0);

  /** @type {Map<string, number>} */
  const authors = new Map();
  for (const c of commitsIn) authors.set(c.author, (authors.get(c.author) ?? 0) + 1);
  const weekdays = WEEKDAYS.map(() => 0);
  for (const c of commitsIn) weekdays[new Date(/** @type {number} */ (parseTime(c.at))).getDay()] += 1;

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
    const b = bucketOf(parseTime(/** @type {{ merged?: string | null, closed: string | null }} */ (x).merged ?? x.closed), w);
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

/** @param {Store} store @param {PeriodWindow} w */
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
        ? sortTable('gh-repos', [
            { label: 'Repo', value: (r) => r.repo },
            { label: 'Commits', num: true, value: (r) => r.commits },
            { label: 'PRs merged', num: true, value: (r) => r.merged },
            { label: 'Issues closed', num: true, value: (r) => r.issuesClosed },
            { label: 'Open PRs', num: true, value: (r) => r.openPrs },
            { label: 'Open issues', num: true, value: (r) => r.openIssues },
          ], a.repos)
        : empty('Nothing loaded yet.')));
}

/** @param {number} n @param {string} label */
function miniStat(n, label) {
  return h('div', { class: 'mini' }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));
}

// --- Page ---

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  if (prices.status === 'idle') setTimeout(() => loadPrices(store), 0);
  const w = periodWindow(view.period);
  const body = view.tab === 'github' ? githubTab(store, w)
    : view.tab === 'analytics' ? analyticsTab(store, view, w)
      : view.tab === 'search' ? searchTab(store, view, w)
      : view.tab === 'socials' ? socialsTab(store, w)
      : view.tab === 'contracts' ? contractsActivityTab(store, w, view.period)
      : view.tab === 'runners' ? runnersTab(store, runnersShown)
        : aiTab(store, w);
  const periodName = PERIODS.find(([k]) => k === view.period)?.[1] ?? '';

  root.replaceChildren(
    h('div', { class: 'stack-lg mon' },
      h('nav', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Monitoring sections' },
        TABS.map(([key, label]) =>
          h('button', {
            type: 'button',
            role: 'tab',
            class: view.tab === key ? 'sub-tab active' : 'sub-tab',
            'aria-selected': String(view.tab === key),
            // What the tab shows, now the page has no header to say it.
            title: SUBTITLES[key],
            onclick: () => {
              view.tab = key;
              store.refresh();
            },
          }, label))),
      // The runners have no period: they show how things stand now.
      view.tab === 'runners' ? null : h('div', { class: 'period-row' },
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

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'monitoring',
  title: 'Monitoring',
  icon: 'activity',
  collection: COLLECTION,
  defaults: { entries: [] },
  render: draw,
  // The heartbeat's run times change every few seconds; only the Board runners tab shows them.
  get readsRunners() {
    return view.tab === 'runners' ? 'all' : false;
  },
  serialize: () => {
    const web = view.tab === 'analytics' || view.tab === 'search';
    return {
      tab: view.tab === 'ai' ? '' : view.tab,
      period: view.period === '7' ? '' : view.period,
      site: web ? view.site : '',
      engine: view.tab === 'search' && view.engine === 'bing' ? 'bing' : '',
      contract: view.tab === 'contracts' ? contractsActivitySerialize() : '',
    };
  },
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.tab = TABS.some(([k]) => k === p.tab) ? p.tab : 'ai';
    view.site = p.site || '';
    view.engine = p.engine === 'bing' ? 'bing' : 'google';
    view.period = PERIODS.some(([k]) => k === p.period) ? p.period : '7';
    contractsActivityRestore(p.contract);
  },
});
