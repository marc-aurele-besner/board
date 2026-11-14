// Monitoring → AI usage → Dev sessions: the chart and table that break the claude sessions down by project, model,
// effort or billing, measured in cost, tokens, time or sessions.
import { h } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { sumUsage, modelName, tokensOf, fmtDuration } from '../dev-usage.js';
import { usdPrecise, fmtTokens } from './monitoring.js';
import { sortTable } from './monitoring-web.js';
import { aiView, projectMark, devProjectOf, segmented, PALETTE, OTHER, NO_PROJECT, TOP } from './monitoring-ai.js';
import { numberLocale } from '../locale.js';
/** @import { DevUsage, Store } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { ChartTip } from '../chart.js' */

const BY = [['project', 'Project'], ['model', 'Model'], ['effort', 'Effort'], ['billing', 'Billing']];
const MEASURES = [['cost', 'Cost'], ['tokens', 'Tokens'], ['time', 'Time'], ['sessions', 'Sessions']];
const BILLING = /** @type {Record<string, { label: string, color: string }>} */ ({
  included: { label: 'Included in plan', color: 'var(--accent)' },
  extra: { label: 'Extra, billed', color: 'var(--warn)' },
});

// The card's breakdown and measure; billing splits only the cost, so it measures cost alone.
export const devView = { by: 'project', measure: 'cost' };

/**
 * One record's share of a group. Cost, extra and tokens are the group's own (a model's); time and lines are the
 * record's, weighted by the share; sessions count whole in each group the record is in.
 * @typedef {{ key: string, label: string, title: string, at: number, record: string, cost: number, extra: number,
 *   tokens: number, time: number, lines: number, sessions: number }} Part
 */

/** @param {Store} store @param {DevUsage[]} records @returns {Part[]} */
function partsOf(store, records) {
  const tasks = store.get('todos').items;
  const projectOf = new Map(store.get('projects').projects.map((p) => [p.id, p.name]));
  /** @type {Part[]} */
  const out = [];
  for (const r of records) {
    const one = sumUsage([r]);
    const at = /** @type {number} */ (r.end);
    const base = { at, record: r.name, time: one.duration, lines: one.linesAdded + one.linesRemoved, sessions: one.sessions };
    const cost = one.cost ?? 0;
    const extra = Math.min(cost, one.extraCost ?? 0);
    if (devView.by === 'model') {
      const models = Object.entries(r.models ?? {});
      const total = models.reduce((t, [, m]) => t + tokensOf(m), 0) || 1;
      for (const [id, m] of models) {
        const share = tokensOf(m) / total;
        const c = m.cost ?? 0;
        out.push({ ...base, key: id, label: modelName(id), title: `${id} (${m.provider})`, cost: c, extra: Math.min(c, m.extraCost ?? 0),
          tokens: tokensOf(m), time: base.time * share, lines: base.lines * share });
      }
    } else if (devView.by === 'billing') {
      for (const [key, value] of /** @type {[string, number][]} */ ([['included', cost - extra], ['extra', extra]])) {
        if (value) out.push({ ...base, key, label: BILLING[key].label, title: '', cost: value, extra: key === 'extra' ? value : 0, tokens: 0, time: 0, lines: 0 });
      }
    } else {
      const project = devProjectOf(tasks, r);
      const key = devView.by === 'project' ? project || NO_PROJECT : one.effort || '?';
      const label = devView.by === 'project' ? (project ? projectOf.get(project) ?? 'Removed project' : 'No project')
        : one.effort ? `${one.effort[0].toUpperCase()}${one.effort.slice(1)}` : 'Not reported';
      out.push({ ...base, key, label, title: '', cost, extra, tokens: one.tokens });
    }
  }
  return out;
}

/** @param {Part} p */
const measureOf = (p) => (devView.measure === 'tokens' ? p.tokens : devView.measure === 'time' ? p.time : devView.measure === 'sessions' ? p.sessions : p.cost);
const formatOf = () => (devView.measure === 'tokens' ? fmtTokens : devView.measure === 'time' ? fmtDuration
  : devView.measure === 'sessions' ? (/** @type {number} */ v) => String(Math.round(v)) : usdPrecise);

// The chart with its controls, and a table of the groups. A project row filters the page to it.
/** @param {Store} store @param {PeriodWindow} w @param {DevUsage[]} records */
export function devBreakdown(store, w, records) {
  if (devView.by === 'billing') devView.measure = 'cost';
  const set = (/** @type {Partial<typeof devView>} */ patch) => {
    Object.assign(devView, patch);
    store.refresh();
  };
  const projects = new Map(store.get('projects').projects.map((p) => [p.id, p]));
  const iconOf = (/** @type {string} */ key) => (devView.by === 'project' ? projectMark(projects.get(key)) : null);
  const parts = partsOf(store, records);

  /** @typedef {{ key: string, label: string, title: string, color: string, value: number, cost: number, extra: number, tokens: number, time: number, lines: number, sessions: number, worktrees: Set<string> }} Row */
  /** @type {Map<string, Row>} */
  const groups = new Map();
  for (const p of parts) {
    let row = groups.get(p.key);
    if (!row) groups.set(p.key, (row = { key: p.key, label: p.label, title: p.title, color: '', value: 0, cost: 0, extra: 0, tokens: 0, time: 0, lines: 0, sessions: 0, worktrees: new Set() }));
    row.value += measureOf(p);
    row.cost += p.cost;
    row.extra += p.extra;
    row.tokens += p.tokens;
    row.time += p.time;
    row.lines += p.lines;
    row.sessions += p.sessions;
    row.worktrees.add(p.record);
  }
  const rows = [...groups.values()].sort((a, b) => b.value - a.value || b.sessions - a.sessions);
  const withValue = rows.filter((r) => r.value);
  const shown = withValue.slice(0, withValue.length > TOP + 1 ? TOP : TOP + 1);
  shown.forEach((r, i) => {
    r.color = devView.by === 'billing' ? BILLING[r.key].color : (devView.by === 'project' && projects.get(r.key)?.color) || PALETTE[i % PALETTE.length];
  });
  const shownKeys = new Set(shown.map((r) => r.key));
  for (const r of rows) if (!r.color) r.color = OTHER.color;

  const values = new Map([...shownKeys, OTHER.key].map((k) => [k, w.items.map(() => 0)]));
  for (const p of parts) {
    const b = w.items.findIndex((x) => p.at >= x.start && p.at < x.end);
    if (b >= 0) /** @type {number[]} */ (values.get(shownKeys.has(p.key) ? p.key : OTHER.key))[b] += measureOf(p);
  }
  const otherValues = /** @type {number[]} */ (values.get(OTHER.key));
  const series = [...shown.map((r) => ({ key: r.key, name: r.label, color: r.color, values: /** @type {number[]} */ (values.get(r.key)) })),
    ...(otherValues.some(Boolean) ? [{ key: OTHER.key, name: OTHER.label, color: OTHER.color, values: otherValues }] : [])];
  const fmt = formatOf();
  /** @type {ChartTip} */
  const tip = (i) => {
    const list = series.filter((sr) => sr.values[i]).sort((a, b) => b.values[i] - a.values[i]);
    return [
      h('span', { class: 'muted' }, w.items[i].label),
      list.length
        ? list.map((sr) => h('span', { class: 'tip-row' }, h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), iconOf(sr.key), ` ${sr.name}`), h('strong', null, fmt(sr.values[i]))))
        : h('span', { class: 'tip-row' }, h('span', null, 'Nothing')),
      list.length > 1 ? h('span', { class: 'tip-row' }, h('span', null, 'Total'), h('strong', null, fmt(list.reduce((t, sr) => t + sr.values[i], 0)))) : null,
    ];
  };
  const total = rows.reduce((t, r) => t + r.value, 0);
  const swatch = (/** @type {Row} */ r) => h('span', { class: 'legend-swatch', style: { background: shownKeys.has(r.key) ? r.color : OTHER.color } });
  const lineCount = (/** @type {number} */ v) => (v ? Math.round(v).toLocaleString(numberLocale()) : '—');

  return [
    h('div', { class: 'row ai-chart-controls' },
      h('span', { class: 'muted small' }, 'By'),
      segmented(/** @type {[string, string][]} */ (BY), devView.by, 'Break Dev sessions down by', (by) => set({ by })),
      devView.by === 'billing' ? null : segmented(/** @type {[string, string][]} */ (MEASURES), devView.measure, 'Measure', (measure) => set({ measure }))),
    barChart(w.items.map((b) => b.label), series, { format: fmt, tip }),
    legend(series),
    sortTable(`dev-by-${devView.by}`, [
      {
        label: BY.find(([k]) => k === devView.by)?.[1] ?? '',
        clip: true,
        value: (r) => r.label,
        format: (v, r) => (devView.by === 'project' && !aiView.project
          ? h('button', { type: 'button', class: 'link-btn ai-drill', title: 'Show only this project', onclick: () => { aiView.project = r.key; set({ by: 'model' }); } }, swatch(r), iconOf(r.key), ` ${v}`)
          : h('span', { title: r.title || null }, swatch(r), iconOf(r.key), ` ${v}`)),
      },
      { label: 'Sessions', num: true, value: (r) => r.sessions },
      { label: 'Worktrees', num: true, value: (r) => r.worktrees.size },
      { label: 'Cost', num: true, value: (r) => r.cost, format: (v) => usdPrecise(v) },
      { label: 'Extra', num: true, value: (r) => r.extra, format: (v) => (v ? usdPrecise(v) : '—') },
      { label: 'Per session', num: true, value: (r) => (r.sessions ? r.cost / r.sessions : null), format: (v) => (v === null ? '—' : usdPrecise(v)) },
      ...(devView.by === 'billing' ? [] : [
        { label: 'Tokens', num: true, value: (/** @type {Row} */ r) => r.tokens, format: fmtTokens },
        { label: 'Time', num: true, value: (/** @type {Row} */ r) => r.time, format: fmtDuration },
        { label: 'Lines', num: true, value: (/** @type {Row} */ r) => r.lines, format: lineCount },
      ]),
      {
        label: 'Share',
        num: true,
        value: (r) => (total ? r.value / total : 0),
        format: (v, r) => h('span', { class: 'ai-share' },
          h('span', { class: 'ai-share-bar' }, h('span', { style: { width: `${(v * 100).toFixed(1)}%`, background: shownKeys.has(r.key) ? r.color : OTHER.color } })),
          `${Math.round(v * 100)}%`),
      },
    ], rows),
    h('p', { class: 'muted small' }, [
      `Share is of the ${devView.measure}.`,
      devView.by === 'model' ? 'A session that used several models counts in each; its time and lines are split by tokens.' : '',
      devView.by === 'project' ? 'A worktree counts for the project of its first task that has one.' : '',
      devView.by === 'project' && !aiView.project ? 'Select a project to show only it.' : '',
    ].filter(Boolean).join(' ')),
  ];
}
