// Monitoring → AI usage → Skills and MCP: the skills the Dev sessions ran and the MCP tools they called, each
// counted on its own: uses over the period, and a table of each skill or tool with its sessions and projects.
import { h, empty } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { byUse, mcpTool } from '../dev-usage.js';
import { stat } from './monitoring.js';
import { sortTable } from './monitoring-web.js';
import { devProjectOf, segmented, PALETTE, OTHER, TOP } from './monitoring-ai.js';
/** @import { DevUsage, Store } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { ChartTip } from '../chart.js' */

const KINDS = [['skills', 'Skills'], ['mcp', 'MCP tools'], ['servers', 'MCP servers']];
export const toolsView = { kind: 'skills' };

// A record's counts as the view groups them: by skill, by MCP tool, or by MCP server.
/** @param {DevUsage} r @returns {[string, number][]} */
function countsOf(r) {
  if (toolsView.kind === 'skills') return byUse(r.skills);
  if (toolsView.kind === 'mcp') return byUse(r.mcp);
  /** @type {Record<string, number>} */
  const servers = {};
  for (const [name, n] of byUse(r.mcp)) {
    const { server } = mcpTool(name);
    servers[server] = (servers[server] ?? 0) + n;
  }
  return byUse(servers);
}

/** @param {string} key */
function labelOf(key) {
  if (toolsView.kind === 'skills') return `/${key}`;
  if (toolsView.kind === 'servers') return key;
  const { server, tool } = mcpTool(key);
  return tool || server;
}

/** @param {Store} store @param {PeriodWindow} w @param {DevUsage[]} records Dev records in the period */
export function toolUsage(store, w, records) {
  const tasks = store.get('todos').items;
  const projectName = new Map(store.get('projects').projects.map((p) => [p.id, p.name]));
  const set = (/** @type {string} */ kind) => {
    toolsView.kind = kind;
    store.refresh();
  };
  // Records saved before skills and MCP were counted have neither field: they are left out of the counts.
  const read = records.filter((r) => r.skills || r.mcp);
  const all = (/** @type {'skills' | 'mcp'} */ k) => read.reduce((t, r) => t + Object.values(r[k] ?? {}).reduce((a, n) => a + n, 0), 0);
  const skillUses = all('skills');
  const mcpCalls = all('mcp');
  const skillNames = new Set(read.flatMap((r) => Object.keys(r.skills ?? {})));
  const servers = new Set(read.flatMap((r) => Object.keys(r.mcp ?? {}).map((n) => mcpTool(n).server)));

  /** @typedef {{ key: string, label: string, server: string, uses: number, sessions: number, projects: Set<string>, last: number, color: string }} Row */
  /** @type {Map<string, Row>} */
  const groups = new Map();
  for (const r of read) {
    const project = devProjectOf(tasks, r);
    for (const [key, n] of countsOf(r)) {
      let row = groups.get(key);
      if (!row) groups.set(key, (row = { key, label: labelOf(key), server: toolsView.kind === 'mcp' ? mcpTool(key).server : '', uses: 0, sessions: 0, projects: new Set(), last: 0, color: '' }));
      row.uses += n;
      row.sessions += r.sessions ?? 1;
      if (project) row.projects.add(project);
      row.last = Math.max(row.last, r.end ?? 0);
    }
  }
  const rows = [...groups.values()].sort((a, b) => b.uses - a.uses || a.label.localeCompare(b.label));
  const shown = rows.slice(0, rows.length > TOP + 1 ? TOP : TOP + 1);
  shown.forEach((r, i) => (r.color = PALETTE[i % PALETTE.length]));
  for (const r of rows) if (!r.color) r.color = OTHER.color;
  const shownKeys = new Set(shown.map((r) => r.key));

  // A record counts in the bucket of its last reply, as in Dev sessions.
  const values = new Map([...shownKeys, OTHER.key].map((k) => [k, w.items.map(() => 0)]));
  for (const r of read) {
    const b = w.items.findIndex((x) => (r.end ?? 0) >= x.start && (r.end ?? 0) < x.end);
    if (b < 0) continue;
    for (const [key, n] of countsOf(r)) /** @type {number[]} */ (values.get(shownKeys.has(key) ? key : OTHER.key))[b] += n;
  }
  const otherValues = /** @type {number[]} */ (values.get(OTHER.key));
  const series = [...shown.map((r) => ({ key: r.key, name: r.label, color: r.color, values: /** @type {number[]} */ (values.get(r.key)) })),
    ...(otherValues.some(Boolean) ? [{ key: OTHER.key, name: OTHER.label, color: OTHER.color, values: otherValues }] : [])];
  const fmt = (/** @type {number} */ v) => String(Math.round(v));
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
  const total = rows.reduce((t, r) => t + r.uses, 0);
  const noun = toolsView.kind === 'skills' ? 'skill' : toolsView.kind === 'mcp' ? 'MCP tool' : 'MCP server';

  return h('section', { class: 'card stack' },
    h('h3', null, 'Skills and MCP'),
    h('p', { class: 'muted small' }, 'The skills the Dev sessions ran (through the Skill tool or typed as a slash command) and the MCP tools they called, read from the same transcripts as Dev sessions. Each is counted on its own.'),
    read.length
      ? [
          h('div', { class: 'summary' },
            stat('Skill uses', String(skillUses), `${skillNames.size} ${skillNames.size === 1 ? 'skill' : 'skills'}`),
            stat('MCP calls', String(mcpCalls), `${servers.size} ${servers.size === 1 ? 'server' : 'servers'}`),
            stat('Sessions', String(read.reduce((t, r) => t + (r.sessions ?? 0), 0)), `${read.filter((r) => Object.keys(r.skills ?? {}).length).length} ran a skill, ${read.filter((r) => Object.keys(r.mcp ?? {}).length).length} called MCP`)),
          h('div', { class: 'row ai-chart-controls' },
            h('span', { class: 'muted small' }, 'Show'),
            segmented(/** @type {[string, string][]} */ (KINDS), toolsView.kind, 'Show skills or MCP', set)),
          rows.length
            ? [
                barChart(w.items.map((b) => b.label), series, { format: fmt, tip }),
                legend(series),
                sortTable(`dev-tools-${toolsView.kind}`, [
                  {
                    label: noun[0].toUpperCase() + noun.slice(1),
                    clip: true,
                    value: (r) => r.label,
                    format: (v, r) => h('span', { title: r.key }, h('span', { class: 'legend-swatch', style: { background: r.color } }), ` ${v}`),
                  },
                  ...(toolsView.kind === 'mcp' ? [{ label: 'Server', clip: true, value: (/** @type {Row} */ r) => r.server }] : []),
                  { label: toolsView.kind === 'skills' ? 'Uses' : 'Calls', num: true, value: (r) => r.uses },
                  { label: 'Sessions', num: true, value: (r) => r.sessions },
                  { label: 'Projects', clip: true, value: (r) => [...r.projects].map((id) => projectName.get(id) ?? 'Removed project').join(', ') || null },
                  { label: 'Last used', num: true, value: (r) => r.last || null, format: (v) => new Date(v).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) },
                  {
                    label: 'Share',
                    num: true,
                    value: (r) => (total ? r.uses / total : 0),
                    format: (v, r) => h('span', { class: 'ai-share' },
                      h('span', { class: 'ai-share-bar' }, h('span', { style: { width: `${(v * 100).toFixed(1)}%`, background: r.color } })),
                      `${Math.round(v * 100)}%`),
                  },
                ], rows),
              ]
            : empty(toolsView.kind === 'skills' ? 'No skill ran in this period.' : 'No MCP tool was called in this period.'),
        ]
      : empty('No Dev sessions with skill or MCP counts in this period. They are counted from the sessions read since this was added.'));
}
