// Monitoring → AI usage, the overview: board AI calls (OpenRouter, js/ai.js) and the claude sessions Dev ran
// (dev-usage.js) as one list of spends, filtered by source and project, broken down by project, source, model or
// feature, and compared with the period before.
import { h, empty } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { usageRecords, modelName, tokensOf } from '../dev-usage.js';
import { stat, costOf, usdPrecise, fmtTokens } from './monitoring.js';
import { sortTable } from './monitoring-web.js';
import { projectIcon } from './projects.js';
import { pickChip } from '../inline.js';
/** @import { DevUsage, Store, Task, UsageEntry } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { ChartTip } from '../chart.js' */

const DAY = 86400000;
// Series beyond these are added up as Other, so the chart stays readable.
export const TOP = 6;
export const PALETTE = ['var(--accent)', 'var(--ai)', 'var(--income)', 'var(--warn)', 'var(--info)', 'var(--expense)'];
export const OTHER = { key: '\0other', label: 'Other', color: 'var(--muted)' };
export const NO_PROJECT = '-';
export const SOURCES = [['all', 'All'], ['board', 'Board AI calls'], ['dev', 'Dev sessions']];
export const BREAKDOWNS = [['project', 'Project'], ['source', 'Source'], ['model', 'Model'], ['feature', 'Feature']];
export const MEASURES = [['cost', 'Cost'], ['tokens', 'Tokens'], ['calls', 'Calls']];
const SOURCE_LABELS = /** @type {Record<string, string>} */ ({ board: 'Board AI calls', dev: 'Dev sessions (claude)' });

// The overview's filters and breakdown. project: '' for every project, '-' for spends with no project, or an id.
export const aiView = { source: 'all', project: '', by: 'project', measure: 'cost' };

/**
 * One spend: a board call, or one model's share of a Dev record. `calls` counts the call, or the record's sessions
 * on its first model only, so a record counts once.
 * @typedef {{ at: number, source: string, projectId: string, model: string, modelLabel: string, feature: string,
 *   cost: number | null, estimated: boolean, extra: number, tokens: number, calls: number }} Spend
 */

// The project of a Dev record: the first of its tasks that has one.
/** @param {Task[]} tasks @param {DevUsage} r */
export function devProjectOf(tasks, r) {
  return tasks.find((t) => r.taskIds?.includes(t.id) && t.projectId)?.projectId ?? '';
}

/** @param {string} projectId */
export const projectShown = (projectId) => !aiView.project || (aiView.project === NO_PROJECT ? !projectId : projectId === aiView.project);
export const sourceShown = (/** @type {string} */ source) => aiView.source === 'all' || aiView.source === source;

/** @param {Store} store @returns {Spend[]} */
function spends(store) {
  const tasks = new Map((store.get('settings').models?.tasks ?? []).map((t) => [t.id, t.name]));
  const todos = store.get('todos').items;
  /** @type {Spend[]} */
  const out = [];
  for (const e of /** @type {UsageEntry[]} */ (store.get('usage').entries)) {
    const at = Date.parse(e.at);
    if (Number.isNaN(at)) continue;
    const c = costOf(e);
    out.push({
      at, source: 'board', projectId: e.projectId ?? '', model: e.model, modelLabel: e.model, feature: tasks.get(e.task) ?? e.task,
      cost: c?.value ?? null, estimated: !!c?.estimated, extra: c?.value ?? 0, tokens: e.promptTokens + e.completionTokens, calls: 1,
    });
  }
  for (const r of usageRecords(store)) {
    if (!r.end || !r.sessions) continue;
    const projectId = devProjectOf(todos, r);
    Object.entries(r.models ?? {}).forEach(([id, m], i) => {
      out.push({
        at: /** @type {number} */ (r.end), source: 'dev', projectId, model: id, modelLabel: modelName(id), feature: 'Dev sessions',
        cost: m.cost ?? null, estimated: false, extra: Math.min(m.cost ?? 0, m.extraCost ?? 0), tokens: tokensOf(m), calls: i ? 0 : r.sessions ?? 0,
      });
    });
  }
  return out.filter((s) => sourceShown(s.source) && projectShown(s.projectId));
}

/** @param {Spend} s */
const keyOf = (s) => (aiView.by === 'project' ? s.projectId || NO_PROJECT
  : aiView.by === 'source' ? s.source
    : aiView.by === 'model' ? s.model
      : s.feature);
/** @param {Spend} s */
const measureOf = (s) => (aiView.measure === 'tokens' ? s.tokens : aiView.measure === 'calls' ? s.calls : s.cost ?? 0);
const formatOf = () => (aiView.measure === 'cost' ? usdPrecise : aiView.measure === 'tokens' ? fmtTokens : (/** @type {number} */ v) => String(Math.round(v)));

// The same span just before: the day before for a one-day period (up to the same hour today), else as many days before.
/** @param {PeriodWindow} w */
function previous(w) {
  const span = w.hourly ? DAY : w.end - w.start;
  return { start: w.start - span, end: w.end - span };
}

/** @param {number} cur @param {number} prev */
function change(cur, prev) {
  if (!prev) return cur ? 'new' : '—';
  const p = (cur - prev) / prev;
  return `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p * 100).toFixed(Math.abs(p) < 0.1 ? 1 : 0)}%`;
}

/** @param {[string, string][]} options @param {string} current @param {string} label @param {(key: string) => void} pick */
export function segmented(options, current, label, pick) {
  return h('div', { class: 'segmented ai-seg', role: 'group', 'aria-label': label },
    options.map(([key, text]) => h('button', {
      type: 'button',
      class: current === key ? 'seg active' : 'seg',
      'aria-pressed': String(current === key),
      onclick: () => pick(key),
    }, text)));
}

// The filters, the summary and the chart with its breakdown table.
/** @param {Store} store @param {PeriodWindow} w */
export function aiOverview(store, w) {
  const projects = store.get('projects').projects;
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const all = spends(store);
  const prevW = previous(w);
  const cur = all.filter((s) => s.at >= w.start && s.at < w.end);
  const prev = all.filter((s) => s.at >= prevW.start && s.at < prevW.end);
  const set = (/** @type {Partial<typeof aiView>} */ patch) => {
    Object.assign(aiView, patch);
    store.refresh();
  };

  /** @param {Spend} s */
  const labelOf = (s) => (aiView.by === 'project' ? (s.projectId ? projectOf.get(s.projectId)?.name ?? 'Removed project' : 'No project')
    : aiView.by === 'source' ? SOURCE_LABELS[s.source]
      : aiView.by === 'model' ? s.modelLabel
        : s.feature);
  /** @typedef {{ key: string, label: string, color: string, value: number, prev: number, cost: number, priced: boolean, estimated: boolean, tokens: number, calls: number }} Row */
  /** @type {Map<string, Row>} */
  const groups = new Map();
  const rowOf = (/** @type {Spend} */ s) => {
    const key = keyOf(s);
    let row = groups.get(key);
    if (!row) groups.set(key, (row = { key, label: labelOf(s), color: '', value: 0, prev: 0, cost: 0, priced: false, estimated: false, tokens: 0, calls: 0 }));
    return row;
  };
  for (const s of cur) {
    const row = rowOf(s);
    row.value += measureOf(s);
    row.tokens += s.tokens;
    row.calls += s.calls;
    if (s.cost !== null) {
      row.cost += s.cost;
      row.priced = true;
    }
    row.estimated ||= s.estimated;
  }
  for (const s of prev) rowOf(s).prev += measureOf(s);
  const rows = [...groups.values()].filter((r) => r.value || r.prev || r.calls).sort((a, b) => b.value - a.value || b.calls - a.calls);
  const shown = rows.filter((r) => r.value).slice(0, rows.filter((r) => r.value).length > TOP + 1 ? TOP : TOP + 1);
  shown.forEach((r, i) => {
    const color = aiView.by === 'project' ? projectOf.get(r.key)?.color : '';
    r.color = color || PALETTE[i % PALETTE.length];
  });
  const shownKeys = new Set(shown.map((r) => r.key));
  for (const r of rows) if (!r.color) r.color = OTHER.color;

  // The chart: one stacked series per shown row, the rest as Other.
  const bucket = (/** @type {number} */ ms) => w.items.findIndex((b) => ms >= b.start && ms < b.end);
  const values = new Map([...shownKeys, OTHER.key].map((k) => [k, w.items.map(() => 0)]));
  for (const s of cur) {
    const b = bucket(s.at);
    if (b < 0) continue;
    const k = keyOf(s);
    /** @type {number[]} */ (values.get(shownKeys.has(k) ? k : OTHER.key))[b] += measureOf(s);
  }
  const series = [...shown.map((r) => ({ name: r.label, color: r.color, values: /** @type {number[]} */ (values.get(r.key)) })),
    ...(/** @type {number[]} */ (values.get(OTHER.key)).some(Boolean) ? [{ name: OTHER.label, color: OTHER.color, values: /** @type {number[]} */ (values.get(OTHER.key)) }] : [])];
  const fmt = formatOf();
  /** @type {ChartTip} */
  const tip = (i) => {
    const parts = series.filter((sr) => sr.values[i]).sort((a, b) => b.values[i] - a.values[i]);
    const total = series.reduce((t, sr) => t + sr.values[i], 0);
    return [
      h('span', { class: 'muted' }, w.items[i].label),
      parts.length
        ? parts.map((sr) => h('span', { class: 'tip-row' }, h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`), h('strong', null, fmt(sr.values[i]))))
        : h('span', { class: 'tip-row' }, h('span', null, 'Nothing')),
      parts.length > 1 ? h('span', { class: 'tip-row' }, h('span', null, 'Total'), h('strong', null, fmt(total))) : null,
    ];
  };

  // The summary.
  const sum = (/** @type {Spend[]} */ list, /** @type {(s: Spend) => number} */ f) => list.reduce((t, s) => t + f(s), 0);
  const cost = sum(cur, (s) => s.cost ?? 0);
  const prevCost = sum(prev, (s) => s.cost ?? 0);
  const billed = sum(cur, (s) => s.extra);
  const covered = cost - billed;
  const estimated = cur.some((s) => s.estimated);
  const unpriced = cur.filter((s) => s.cost === null && s.calls).length;
  const boardCalls = sum(cur.filter((s) => s.source === 'board'), (s) => s.calls);
  const sessions = sum(cur.filter((s) => s.source === 'dev'), (s) => s.calls);
  const days = w.hourly ? 1 : w.items.length;
  const costBuckets = w.items.map(() => 0);
  for (const s of cur) {
    const b = bucket(s.at);
    if (b >= 0) costBuckets[b] += s.cost ?? 0;
  }
  const peak = costBuckets.indexOf(Math.max(...costBuckets));
  /** @type {Map<string, number>} */
  const byProject = new Map();
  for (const s of cur) if (s.projectId) byProject.set(s.projectId, (byProject.get(s.projectId) ?? 0) + (s.cost ?? 0));
  const [topId, topCost] = [...byProject].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const vsLabel = w.hourly ? (w.end - w.start < DAY ? 'vs the same hours yesterday' : 'vs the day before') : `vs the ${days} days before`;
  const approx = estimated ? '≈ ' : '';
  const total = sum(cur, measureOf);

  const usedProjects = new Set(all.map((s) => s.projectId).filter(Boolean));
  const projectChoices = projects.filter((p) => usedProjects.has(p.id) || p.id === aiView.project).sort((a, b) => a.name.localeCompare(b.name));

  return [
    h('div', { class: 'row ai-filters' },
      segmented(/** @type {[string, string][]} */ (SOURCES), aiView.source, 'Source', (source) => set({ source })),
      h('label', { class: 'row ai-project' },
        h('span', { class: 'muted small' }, 'Project'),
        // Searchable, with each project's icon: a board with many projects makes a plain dropdown long.
        pickChip({
          value: aiView.project || null,
          options: [
            { value: NO_PROJECT, label: 'No project' },
            ...projectChoices.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
          ],
          nullable: true,
          nullLabel: 'All projects',
          className: 'field-pick project-field-pick',
          onPick: (v) => set({ project: v ?? '' }),
        })),
      aiView.source !== 'all' || aiView.project
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => set({ source: 'all', project: '' }) }, 'Clear filters')
        : null),
    h('div', { class: 'summary ai-summary' },
      stat('Cost', `${approx}${usdPrecise(cost)}`, h('span', null, `${change(cost, prevCost)} ${vsLabel}`, unpriced ? ` · ${unpriced} without a price` : '')),
      stat('Billed', `${approx}${usdPrecise(billed)}`, covered > 0 ? `${usdPrecise(covered)} more covered by the Claude plan` : 'OpenRouter calls and claude extra usage'),
      stat(w.hourly ? 'Busiest hour' : 'Per day', w.hourly ? (costBuckets[peak] ? `${w.items[peak].label}:00` : '—') : usdPrecise(cost / days),
        w.hourly ? (costBuckets[peak] ? usdPrecise(costBuckets[peak]) : 'nothing spent') : `average over ${days} days`),
      stat('Calls', String(boardCalls), `board AI calls · ${sessions} Dev session${sessions === 1 ? '' : 's'}`),
      stat('Tokens', fmtTokens(sum(cur, (s) => s.tokens)), 'input, cache and output'),
      stat('Top project', topId ? projectOf.get(topId)?.name ?? 'Removed project' : '—', topId ? `${usdPrecise(topCost)} · ${Math.round((topCost / (cost || 1)) * 100)}% of the cost` : 'no spend filed under a project')),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'Over time'),
        h('div', { class: 'row ai-chart-controls' },
          h('span', { class: 'muted small' }, 'By'),
          segmented(/** @type {[string, string][]} */ (BREAKDOWNS), aiView.by, 'Break down by', (by) => set({ by })),
          segmented(/** @type {[string, string][]} */ (MEASURES), aiView.measure, 'Measure', (measure) => set({ measure })))),
      cur.length
        ? [barChart(w.items.map((b) => b.label), series, { format: fmt, tip }), legend(series)]
        : empty('No AI use in this period with these filters.'),
      rows.length
        ? sortTable(`ai-breakdown-${aiView.by}`, [
            {
              label: BREAKDOWNS.find(([k]) => k === aiView.by)?.[1] ?? '',
              clip: true,
              value: (r) => r.label,
              format: (v, r) => {
                const swatch = h('span', { class: 'legend-swatch', style: { background: shownKeys.has(r.key) ? r.color : OTHER.color } });
                // A project or a source can be opened: it becomes the filter, and the breakdown moves a level down.
                const drill = aiView.by === 'project' ? () => set({ project: r.key, by: 'feature' })
                  : aiView.by === 'source' ? () => set({ source: r.key, by: 'project' })
                    : null;
                return drill
                  ? h('button', { type: 'button', class: 'link-btn ai-drill', title: 'Show only this', onclick: drill }, swatch, ` ${v}`)
                  : h('span', null, swatch, ` ${v}`);
              },
            },
            { label: 'Cost', num: true, value: (r) => (r.priced ? r.cost : null), format: (v, r) => (v === null ? '—' : `${r.estimated ? '≈ ' : ''}${usdPrecise(v)}`) },
            { label: 'Tokens', num: true, value: (r) => r.tokens, format: fmtTokens },
            { label: 'Calls', num: true, value: (r) => r.calls },
            {
              label: 'Share',
              num: true,
              value: (r) => (total ? r.value / total : 0),
              format: (v, r) => h('span', { class: 'ai-share' },
                h('span', { class: 'ai-share-bar' }, h('span', { style: { width: `${(v * 100).toFixed(1)}%`, background: shownKeys.has(r.key) ? r.color : OTHER.color } })),
                `${Math.round(v * 100)}%`),
            },
            { label: 'Before', num: true, value: (r) => r.prev, format: (v) => (v ? fmt(v) : '—') },
            { label: 'Change', num: true, value: (r) => (r.prev ? (r.value - r.prev) / r.prev : r.value ? Infinity : 0), format: (_v, r) => change(r.value, r.prev) },
          ], rows)
        : null,
      rows.length
        ? h('p', { class: 'muted small' }, `Share and change are of the ${aiView.measure === 'calls' ? 'calls (sessions for Dev)' : aiView.measure}, ${vsLabel.replace(/^vs /, 'against ')}. Dev costs are at API prices; Billed above is what was actually charged.${aiView.by === 'project' || aiView.by === 'source' ? ' Select a row to show only it.' : ''}`)
        : null),
  ];
}
