// Monitoring → Development → Skills & MCP and Tools: what the turns ran and called, counted in the period the turn
// was sent and under the tab's project filter. Skills & MCP lists each skill, MCP tool or MCP server with its uses,
// turns, tasks, failures and time per call; Tools shows where the calls and their time went, every tool together.
import { h, empty } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { mcpTool, fmtTokens } from '../dev-usage.js';
import { workOf, sum, median, fmtSpan, pct, callsOf, isMcp, skillUses, groupUses, toolGroup, USES } from '../dev-turns.js';
import { stat } from './monitoring.js';
import { sortTable } from './monitoring-web.js';
import { segmented, PALETTE, OTHER, TOP } from './monitoring-ai.js';
import { developmentView, KINDS, withChange, projectCell, projectName, uncounted } from './monitoring-development.js';
import { dateLocale } from '../locale.js';
/** @import { ChartTip } from '../chart.js' */
/** @import { TurnRow, UseRow } from '../dev-turns.js' */
/** @import { DevContext } from './monitoring-development.js' */
/** @import { SortColumn } from '../../types/monitoring' */

const TOOL_MEASURES = [['calls', 'Calls'], ['failed', 'Failed'], ['time', 'Time']];
const HEAVIEST = 10;
const when = (/** @type {number} */ v) => new Date(v).toLocaleString(dateLocale(), { dateStyle: 'short', timeStyle: 'short' });
const rate = (/** @type {number} */ v) => `${(v * 100).toFixed(1)}%`;

/** @typedef {UseRow & { label: string, color: string }} Row */

// The rows of a grouping, the most used first, the top ones coloured for the chart and the rest as Other.
/** @param {Map<string, UseRow>} groups @param {(key: string) => string} labelOf @param {(r: UseRow) => number} valueOf */
function ranked(groups, labelOf, valueOf) {
  /** @type {Row[]} */
  const rows = [...groups.values()].map((r) => ({ ...r, label: labelOf(r.key), color: OTHER.color }))
    .sort((a, b) => valueOf(b) - valueOf(a) || b.calls - a.calls || a.label.localeCompare(b.label));
  const charted = rows.filter((r) => valueOf(r));
  const shown = charted.slice(0, charted.length > TOP + 1 ? TOP : TOP + 1);
  shown.forEach((r, i) => (r.color = PALETTE[i % PALETTE.length]));
  return { rows, shown };
}

// The period's chart: a stacked series per shown row, each turn counted in the bucket its prompt was sent.
/**
 * @param {DevContext} ctx @param {Row[]} shown @param {(x: TurnRow) => [string, number][]} valuesOf
 * @param {(v: number) => string} fmt
 */
function chart(ctx, shown, valuesOf, fmt) {
  const { w } = ctx;
  const keys = new Set(shown.map((r) => r.key));
  const values = new Map([...keys, OTHER.key].map((k) => [k, w.items.map(() => 0)]));
  for (const x of ctx.read) {
    const b = ctx.bucket(x.t.at);
    if (b < 0) continue;
    for (const [key, v] of valuesOf(x)) /** @type {number[]} */ (values.get(keys.has(key) ? key : OTHER.key))[b] += v;
  }
  const other = /** @type {number[]} */ (values.get(OTHER.key));
  const series = [...shown.map((r) => ({ name: r.label, color: r.color, values: /** @type {number[]} */ (values.get(r.key)) })),
    ...(other.some(Boolean) ? [{ name: OTHER.label, color: OTHER.color, values: other }] : [])];
  /** @type {ChartTip} */
  const tip = (i) => {
    const list = series.filter((sr) => sr.values[i]).sort((a, b) => b.values[i] - a.values[i]);
    return [
      h('span', { class: 'muted' }, w.items[i].label),
      list.length
        ? list.map((sr) => h('span', { class: 'tip-row' }, h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`), h('strong', null, fmt(sr.values[i]))))
        : h('span', { class: 'tip-row' }, h('span', null, 'Nothing')),
    ];
  };
  return [barChart(w.items.map((b) => b.label), series, { format: fmt, tip }), legend(series)];
}

/** @param {number} v @param {Row} r */
const share = (v, r) => h('span', { class: 'ai-share' },
  h('span', { class: 'ai-share-bar' }, h('span', { style: { width: `${(v * 100).toFixed(1)}%`, background: r.color } })),
  `${Math.round(v * 100)}%`);
/** @param {string} v @param {Row} r */
const named = (v, r) => h('span', { title: [...r.names].sort().join('\n') }, h('span', { class: 'legend-swatch', style: { background: r.color } }), ` ${v}`);
/** @param {DevContext} ctx @returns {SortColumn<Row>} */
const projectsColumn = (ctx) => ({
  label: 'Projects',
  clip: true,
  value: (r) => [...r.projects].map((id) => projectName(ctx, id)).join(', ') || null,
  format: (_v, r) => h('span', { class: 'ai-project-list' }, [...r.projects].map((id) => projectCell(ctx, id))),
});
/** @type {SortColumn<Row>[]} */
const FAILURES = [
  { label: 'Failed', num: true, value: (r) => r.errors, format: (v) => (v ? String(v) : '—') },
  { label: 'Failure rate', num: true, value: (r) => (r.calls ? r.errors / r.calls : 0), format: (v, r) => h('span', { class: r.calls >= 10 && v >= 0.1 ? 'dev-bad' : null }, v ? rate(v) : '—') },
  { label: 'Per call', num: true, value: (r) => (r.calls ? r.ms / r.calls : 0), format: fmtSpan },
  { label: 'Time', num: true, value: (r) => r.ms, format: fmtSpan },
];

// --- Skills & MCP ---

/** @param {DevContext} ctx */
export function skillsView(ctx) {
  const { read, prev } = ctx;
  if (!read.length) return h('section', { class: 'card' }, empty('No turn of this period kept its tools yet. The runners read them from the transcripts Claude still has, a few seconds after they start.'));
  const kind = developmentView.kind;
  const prevRead = prev.filter((x) => x.t.tools);
  const had = prevRead.length > 0;
  const mcpOf = (/** @type {TurnRow[]} */ list) => list.map((x) => callsOf(x.t, isMcp));
  const mcp = mcpOf(read);
  const mcpCalls = sum(mcp.map((c) => c.calls));
  const mcpErrors = sum(mcp.map((c) => c.errors));
  const mcpMs = sum(mcp.map((c) => c.ms));
  const skills = sum(read.map((x) => skillUses(x.t)));
  const withSkill = read.filter((x) => skillUses(x.t));
  const withMcp = read.filter((x) => callsOf(x.t, isMcp).calls);
  const names = new Set(read.flatMap((x) => Object.keys(x.t.skills ?? {})));
  const servers = new Set(read.flatMap((x) => Object.keys(x.t.tools ?? {}).filter(isMcp).map((n) => mcpTool(n).server)));
  const work = sum(read.map((x) => workOf(x.t)));
  const medianOf = (/** @type {TurnRow[]} */ list) => median(list.map((x) => workOf(x.t)));
  // A turn's median with and without: said only when there is a turn on each side.
  const versus = (/** @type {TurnRow[]} */ withIt, /** @type {string} */ noun) => {
    const without = read.filter((x) => !withIt.includes(x));
    return stat(`Turn with ${noun}`, withIt.length ? fmtSpan(medianOf(withIt)) : '—',
      withIt.length ? `median of ${withIt.length} turn${withIt.length === 1 ? '' : 's'}${without.length ? ` · ${fmtSpan(medianOf(without))} without` : ''}` : `No turn used ${noun} in this period`);
  };

  const { rows, shown } = ranked(groupUses(read, USES[kind]), (key) => (kind === 'skills' ? `/${key}` : kind === 'mcp' ? mcpTool(key).tool || mcpTool(key).server : key), (r) => r.calls);
  const total = sum(rows.map((r) => r.calls));
  const noun = kind === 'skills' ? 'Skill' : kind === 'mcp' ? 'MCP tool' : 'MCP server';
  /** @type {SortColumn<Row>[]} */
  const columns = [
    { label: noun, clip: true, value: (r) => r.label, format: named },
    ...(kind === 'mcp' ? [{ label: 'Server', clip: true, value: (/** @type {Row} */ r) => mcpTool(r.key).server }] : []),
    ...(kind === 'servers' ? [{ label: 'Tools', num: true, value: (/** @type {Row} */ r) => r.names.size }] : []),
    { label: kind === 'skills' ? 'Uses' : 'Calls', num: true, value: (r) => r.calls },
    { label: 'Turns', num: true, value: (r) => r.turns },
    { label: 'Tasks', num: true, value: (r) => r.tasks.size },
    projectsColumn(ctx),
    ...(kind === 'skills' ? [] : FAILURES),
    { label: 'Turn time', num: true, value: (r) => median(r.works), format: fmtSpan },
    { label: 'Last used', num: true, value: (r) => r.last || null, format: when },
    { label: 'Share', num: true, value: (r) => (total ? r.calls / total : 0), format: share },
  ];

  return [
    h('div', { class: 'summary' },
      stat('Skill uses', String(skills), withChange(`${names.size} skill${names.size === 1 ? '' : 's'} · in ${pct(withSkill.length, read.length)} of turns`, skills, sum(prevRead.map((x) => skillUses(x.t))), had)),
      stat('MCP calls', String(mcpCalls), withChange(`${servers.size} server${servers.size === 1 ? '' : 's'} · in ${pct(withMcp.length, read.length)} of turns`, mcpCalls, sum(mcpOf(prevRead).map((c) => c.calls)), had)),
      stat('MCP failures', mcpCalls ? rate(mcpErrors / mcpCalls) : '—', mcpCalls ? `${mcpErrors} of ${mcpCalls} calls failed or were refused` : 'No MCP tool was called'),
      versus(withSkill, 'a skill'),
      versus(withMcp, 'MCP'),
      stat('Time in MCP calls', fmtSpan(mcpMs), mcpCalls ? `${fmtSpan(mcpMs / mcpCalls)} per call · ${pct(mcpMs, work)} of claude's working time` : 'No MCP tool was called')),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'Skills and MCP'),
        h('div', { class: 'row ai-chart-controls' },
          segmented(/** @type {[string, string][]} */ (KINDS), kind, 'Show skills or MCP', (v) => ctx.set({ kind: v })))),
      rows.length
        ? [
            chart(ctx, shown, (x) => USES[kind](x.t).map(([key, u]) => [key, u.calls]), (v) => String(Math.round(v))),
            sortTable(`development-${kind}`, columns, rows),
          ]
        : empty(kind === 'skills' ? 'No skill ran in this period.' : 'No MCP tool was called in this period.'),
      h('p', { class: 'muted small' }, kind === 'skills'
        ? 'A skill counts when claude ran it through the Skill tool, or when you typed it as a slash command. Turn time is the median working time of the turns it ran in.'
        : 'A call failed when its result was an error, or when you refused it. Per call is the time from the call to its result, a permission prompt included. Turn time is the median working time of the turns that called it.'),
      uncounted(ctx)),
  ];
}

// --- Tools ---

/** @param {DevContext} ctx */
export function toolsView(ctx) {
  const { read, prev } = ctx;
  if (!read.length) return h('section', { class: 'card' }, empty('No turn of this period kept its tools yet. The runners read them from the transcripts Claude still has, a few seconds after they start.'));
  const measure = developmentView.tool;
  const valueOf = (/** @type {{ calls: number, errors: number, ms: number }} */ r) => (measure === 'failed' ? r.errors : measure === 'time' ? r.ms : r.calls);
  const fmt = measure === 'time' ? fmtSpan : (/** @type {number} */ v) => String(Math.round(v));
  const labels = new Map(read.flatMap((x) => Object.keys(x.t.tools ?? {})).map((name) => [toolGroup(name).key, toolGroup(name).label]));
  const { rows, shown } = ranked(groupUses(read, USES.tools), (key) => labels.get(key) ?? key, valueOf);
  const total = sum(rows.map(valueOf));
  const all = read.map((x) => callsOf(x.t));
  const calls = sum(all.map((c) => c.calls));
  const errors = sum(all.map((c) => c.errors));
  const ms = sum(all.map((c) => c.ms));
  const work = sum(read.map((x) => workOf(x.t)));
  const prevAll = prev.filter((x) => x.t.tools).map((x) => callsOf(x.t));
  const had = prevAll.length > 0;
  const prevCalls = sum(prevAll.map((c) => c.calls));
  const prevErrors = sum(prevAll.map((c) => c.errors));
  const agents = rows.find((r) => r.key === 'Agent');
  const tokens = read.map((x) => x.t.tokens ?? 0);
  const withErrors = all.filter((c) => c.errors).length;
  const heaviest = read.map((x) => ({ x, ...callsOf(x.t) })).filter((r) => r.calls).sort((a, b) => b.calls - a.calls).slice(0, HEAVIEST);
  const labelOf = new Map(ctx.rows.map((r) => [r.name, r.label]));

  return [
    h('div', { class: 'summary' },
      stat('Tool calls', String(calls), withChange(`${(calls / read.length).toFixed(1)} per turn · ${rows.length} tool${rows.length === 1 ? '' : 's'}`, calls, prevCalls, had)),
      stat('Failed calls', calls ? rate(errors / calls) : '—', withChange(`${errors} failed or refused · in ${pct(withErrors, read.length)} of turns`, calls ? errors / calls : 0, prevCalls ? prevErrors / prevCalls : 0, had && prevCalls > 0)),
      stat('Time in calls', fmtSpan(ms), calls ? `${fmtSpan(ms / calls)} per call${ms <= work ? ` · ${pct(ms, work)} of claude's working time` : ''}` : ''),
      stat('Most used', rows[0]?.label ?? '—', rows[0] ? `${rows[0].calls} calls in ${rows[0].turns} turn${rows[0].turns === 1 ? '' : 's'}` : ''),
      stat('Subagents', String(agents?.calls ?? 0), agents ? `started in ${agents.turns} turn${agents.turns === 1 ? '' : 's'} · ${agents.tasks.size} task${agents.tasks.size === 1 ? '' : 's'}` : 'No turn started one'),
      stat('Output per turn', fmtTokens(Math.round(median(tokens))), `median tokens claude wrote · ${fmtTokens(sum(tokens))} in all`)),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'By tool'),
        h('div', { class: 'row ai-chart-controls' },
          segmented(/** @type {[string, string][]} */ (TOOL_MEASURES), measure, 'Measure', (v) => ctx.set({ tool: v })))),
      shown.length
        ? chart(ctx, shown, (x) => USES.tools(x.t).map(([key, u]) => [key, valueOf({ calls: u.calls, errors: u.errors ?? 0, ms: u.ms ?? 0 })]), fmt)
        : empty(measure === 'failed' ? 'No call failed in this period.' : 'No tool was called in this period.'),
      sortTable('development-tools', /** @type {SortColumn<Row>[]} */ ([
        { label: 'Tool', clip: true, value: (r) => r.label, format: named },
        { label: 'Calls', num: true, value: (r) => r.calls },
        { label: 'Turns', num: true, value: (r) => r.turns },
        { label: 'Per turn', num: true, value: (r) => r.calls / r.turns, format: (/** @type {number} */ v) => v.toFixed(1) },
        ...FAILURES,
        { label: 'Share', num: true, value: (r) => (total ? valueOf(r) / total : 0), format: share },
      ]), rows),
      h('p', { class: 'muted small' }, 'The main session’s calls; a subagent’s own calls are not counted. MCP tools are grouped by server (each tool is in Skills & MCP). A call failed when its result was an error, or when you refused it. Time runs from a call to its result, a permission prompt included; calls made together overlap.'),
      uncounted(ctx)),
    h('section', { class: 'card stack' },
      h('h3', null, 'Heaviest turns'),
      sortTable('development-heaviest', [
        { label: 'Prompt', clip: true, value: (r) => r.x.t.text, format: (v, r) => h('span', { title: r.x.t.text }, v || '—') },
        { label: 'Task', clip: true, value: (r) => labelOf.get(r.x.r.name) ?? r.x.r.name },
        { label: 'Calls', num: true, value: (r) => r.calls },
        { label: 'Failed', num: true, value: (r) => r.errors, format: (v) => (v ? String(v) : '—') },
        { label: 'Time in calls', num: true, value: (r) => r.ms, format: fmtSpan },
        { label: 'Output', num: true, value: (r) => r.x.t.tokens ?? 0, format: fmtTokens },
        { label: 'Claude', num: true, value: (r) => workOf(r.x.t), format: fmtSpan },
        { label: 'Sent', num: true, value: (r) => r.x.t.at, format: when },
      ], heaviest),
      h('p', { class: 'muted small' }, `The ${HEAVIEST} turns of the period with the most tool calls.`)),
  ];
}
