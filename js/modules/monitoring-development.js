// Monitoring → Development: how the claude sessions Dev ran for tasks went, turn by turn. A turn is one prompt and
// claude's work on it; the runners read them from Claude Code's transcripts into usage.json (tools/usage.js). Time
// is split three ways: claude working, claude waiting on an answer within a turn (a question or a plan to approve),
// and the user reviewing between turns (reading the answer, checking the work, writing the next prompt).
// Four views share the project filter: Overview (summary, insights, time, projects, hours), Turns (lengths, tasks,
// the log), and Skills & MCP and Tools (js/modules/monitoring-development-tools.js).
import { h, empty } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { usageRecords, fmtTokens } from '../dev-usage.js';
import { workOf, reviewOf, sum, median, fmtSpan, pct, callsOf, isMcp, skillUses, insights } from '../dev-turns.js';
import { stat } from './monitoring.js';
import { pickChip } from '../inline.js';
import { projectIcon } from './projects.js';
import { sortTable } from './monitoring-web.js';
import { devProjectOf, projectLabel, segmented, previous, change, NO_PROJECT } from './monitoring-ai.js';
import { skillsView, toolsView } from './monitoring-development-tools.js';
/** @import { DevTurn, DevUsage, Project, Store } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { Child } from '../../types/ui' */
/** @import { ChartTip } from '../chart.js' */
/** @import { TurnRow } from '../dev-turns.js' */

const RECENT = 40;
export const VIEWS = [['overview', 'Overview'], ['turns', 'Turns'], ['skills', 'Skills & MCP'], ['tools', 'Tools']];
export const KINDS = [['skills', 'Skills'], ['mcp', 'MCP tools'], ['servers', 'MCP servers']];
const MEASURES = [['time', 'Time'], ['turns', 'Turns']];
const WHEN = [['hour', 'Hour of day'], ['day', 'Day of week']];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const PARTS = /** @type {const} */ ([
  ['work', 'Claude working', 'var(--accent)'],
  ['wait', 'Waiting on you', 'var(--warn)'],
  ['review', 'Reviewing', 'var(--info)'],
]);
// Turn lengths (claude's working time) for the distribution, by upper bound.
const LENGTHS = [[60000, '< 1 min'], [5 * 60000, '1–5 min'], [15 * 60000, '5–15 min'], [30 * 60000, '15–30 min'], [60 * 60000, '30–60 min'], [Infinity, '> 1 h']];

// The tab's view, filter and chart choices. project: '' for all, '-' for tasks without a project, or an id.
// kind: what Skills & MCP lists; tool: what Tools charts.
export const developmentView = { view: 'overview', project: '', measure: 'time', when: 'hour', kind: 'skills', tool: 'calls' };

/**
 * What every view reads: the period's turns (`read`: those whose tools were kept), the turns of the period before,
 * the tasks they belong to, and the period's buckets.
 * @typedef {{ store: Store, w: PeriodWindow, turns: TurnRow[], read: TurnRow[], prev: TurnRow[], rows: TaskRow[],
 *   projectOf: Map<string, Project>, bucket: (ms: number) => number, set: (patch: Partial<typeof developmentView>) => void }} DevContext
 */
/** @typedef {ReturnType<typeof taskRow>} TaskRow */

// A value's change against the period before, after a stat's hint.
/** @param {string} hint @param {number} cur @param {number} prev @param {boolean} known */
export const withChange = (hint, cur, prev, known) => [hint, known ? h('span', { class: 'dev-change', title: 'Against the period before' }, ` · ${change(cur, prev)}`) : null];

// A task's numbers over all its turns.
/** @param {DevUsage} r @param {string} label @param {string} project */
function taskRow(r, label, project) {
  const list = r.turns ?? [];
  const works = list.map(workOf);
  const calls = list.map((t) => callsOf(t));
  return {
    name: r.name,
    label,
    project,
    turns: list.length,
    work: sum(works),
    median: median(works),
    longest: Math.max(0, ...works),
    wait: sum(list.map((t) => t.wait)),
    review: sum(list.map(reviewOf)),
    interrupted: list.filter((t) => t.interrupted).length,
    // Null when none of its turns kept their tools: not counted, rather than zero.
    calls: list.some((t) => t.tools) ? sum(calls.map((c) => c.calls)) : null,
    failed: list.some((t) => t.tools) ? sum(calls.map((c) => c.errors)) : null,
    tokens: list.some((t) => t.tools) ? sum(list.map((t) => t.tokens ?? 0)) : null,
    // From the first prompt to claude's last reply, whatever happened between.
    elapsed: list.length ? Math.max(...list.map((t) => t.end)) - list[0].at : 0,
    last: Math.max(...list.map((t) => t.end)),
  };
}

/** @param {Store} store @param {PeriodWindow} w */
export function developmentTab(store, w) {
  const tasks = store.get('todos').items;
  const projects = store.get('projects').projects;
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const set = (/** @type {Partial<typeof developmentView>} */ patch) => {
    Object.assign(developmentView, patch);
    store.refresh();
  };
  const all = usageRecords(store).filter((r) => r.turns?.length).map((r) => ({ r, project: devProjectOf(tasks, r) ?? '' }));
  const shown = all.filter(({ project }) => !developmentView.project || (developmentView.project === NO_PROJECT ? !project : project === developmentView.project));
  const prevW = previous(w);
  /** @param {{ start: number, end: number }} win @returns {TurnRow[]} */
  const turnsIn = (win) => shown.flatMap(({ r, project }) => (r.turns ?? []).filter((t) => t.at >= win.start && t.at < win.end).map((t) => ({ t, r, project })));
  const turns = turnsIn(w);
  const usedProjects = new Set(all.map((x) => x.project).filter(Boolean));
  const projectChoices = projects.filter((p) => usedProjects.has(p.id) || p.id === developmentView.project).sort((a, b) => a.name.localeCompare(b.name));

  const filters = h('div', { class: 'row between ai-filters dev-filters' },
    segmented(/** @type {[string, string][]} */ (VIEWS), developmentView.view, 'View', (view) => set({ view })),
    h('label', { class: 'row ai-project' },
      h('span', { class: 'muted small' }, 'Project'),
      // Searchable, with each project's icon: a board with many projects makes a plain dropdown long.
      pickChip({
        value: developmentView.project || null,
        options: [
          { value: NO_PROJECT, label: 'No project' },
          ...projectChoices.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
        ],
        nullable: true,
        nullLabel: 'All projects',
        className: 'field-pick project-field-pick',
        onPick: (v) => set({ project: v ?? '' }),
      })));
  if (!turns.length) {
    return h('div', { class: 'stack-lg' }, filters, h('section', { class: 'card' },
      empty(all.length ? 'No claude turns in this period.' : 'No claude turns yet. Start claude on a task with its Dev button: each prompt and how long claude took on it shows here.')));
  }

  const inPeriod = new Set(turns.map((x) => x.r));
  const rows = shown.filter(({ r }) => inPeriod.has(r)).map(({ r, project }) =>
    taskRow(r, tasks.filter((t) => r.taskIds?.includes(t.id)).map((t) => t.text).join(', ') || r.name, project));
  /** @type {DevContext} */
  const ctx = {
    store, w, turns, rows, projectOf, set,
    read: turns.filter((x) => x.t.tools),
    prev: turnsIn(prevW),
    bucket: (ms) => w.items.findIndex((b) => ms >= b.start && ms < b.end),
  };
  const body = developmentView.view === 'turns' ? turnsView(ctx)
    : developmentView.view === 'skills' ? skillsView(ctx)
      : developmentView.view === 'tools' ? toolsView(ctx)
        : overview(ctx);
  return h('div', { class: 'stack-lg' }, filters, body);
}

// A project cell: its icon and name, or a dash for the tasks without one.
/** @param {DevContext} ctx @param {string} id @returns {Child} */
export const projectCell = (ctx, id) => (id ? projectLabel(ctx.projectOf.get(id)) : h('span', { class: 'muted' }, 'No project'));
/** @param {DevContext} ctx @param {string} id */
export const projectName = (ctx, id) => (id ? ctx.projectOf.get(id)?.name ?? 'Removed project' : 'No project');

// The turns whose tools were not kept, said once under the views that count tools.
/** @param {DevContext} ctx @returns {Child} */
export function uncounted(ctx) {
  const n = ctx.turns.length - ctx.read.length;
  return n ? h('p', { class: 'muted small' }, `${n} turn${n === 1 ? ' is' : 's are'} left out: read before tools were kept, with a transcript Claude has since removed or not read again yet.`) : null;
}

// --- Overview ---

/** @param {DevContext} ctx */
function overview(ctx) {
  const { turns, prev, rows, w } = ctx;
  const works = turns.map((x) => workOf(x.t));
  const work = sum(works);
  const wait = sum(turns.map((x) => x.t.wait));
  const review = sum(turns.map((x) => reviewOf(x.t)));
  const interrupted = turns.filter((x) => x.t.interrupted).length;
  const oneShot = rows.filter((r) => r.turns === 1).length;
  const longest = Math.max(...works);
  const had = prev.length > 0;
  const prevWorks = prev.map((x) => workOf(x.t));
  const prevYours = sum(prev.map((x) => x.t.wait + reviewOf(x.t)));
  const prevInterrupted = prev.filter((x) => x.t.interrupted).length;

  // Over time.
  const byTurns = developmentView.measure === 'turns';
  const fmt = byTurns ? (/** @type {number} */ v) => String(Math.round(v)) : fmtSpan;
  const series = byTurns
    ? [
        { key: 'done', name: 'Answered', color: 'var(--accent)', values: w.items.map(() => 0) },
        { key: 'interrupted', name: 'Interrupted', color: 'var(--warn)', values: w.items.map(() => 0) },
      ]
    : PARTS.map(([key, name, color]) => ({ key, name, color, values: w.items.map(() => 0) }));
  const counts = w.items.map(() => 0);
  for (const { t } of turns) {
    const b = ctx.bucket(t.at);
    if (b < 0) continue;
    counts[b]++;
    if (byTurns) series[t.interrupted ? 1 : 0].values[b]++;
    else {
      series[0].values[b] += workOf(t);
      series[1].values[b] += t.wait;
      series[2].values[b] += reviewOf(t);
    }
  }
  /** @type {ChartTip} */
  const tip = (i) => [
    h('span', { class: 'muted' }, w.items[i].label),
    series.map((sr) => h('span', { class: 'tip-row' }, h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`), h('strong', null, fmt(sr.values[i])))),
    byTurns ? null : h('span', { class: 'tip-row' }, h('span', null, 'Turns'), h('strong', null, String(counts[i]))),
  ];

  // By project.
  /** @type {Map<string, TurnRow[]>} */
  const groups = new Map();
  for (const x of turns) groups.set(x.project, [...(groups.get(x.project) ?? []), x]);
  const projectRows = [...groups].map(([id, list]) => {
    const calls = list.filter((x) => x.t.tools).map((x) => callsOf(x.t));
    const total = sum(calls.map((c) => c.calls));
    return {
      id,
      name: projectName(ctx, id),
      tasks: new Set(list.map((x) => x.r)).size,
      turns: list.length,
      work: sum(list.map((x) => workOf(x.t))),
      median: median(list.map((x) => workOf(x.t))),
      yours: sum(list.map((x) => x.t.wait + reviewOf(x.t))),
      interrupted: list.filter((x) => x.t.interrupted).length,
      calls: calls.length ? total : null,
      failed: total ? sum(calls.map((c) => c.errors)) / total : null,
      mcp: calls.length ? sum(list.map((x) => callsOf(x.t, isMcp).calls)) : null,
      skills: calls.length ? sum(list.map((x) => skillUses(x.t))) : null,
    };
  }).sort((a, b) => b.work - a.work);

  // When the prompts go out.
  const byHour = developmentView.when === 'hour';
  const whenLabels = byHour ? Array.from({ length: 24 }, (_, i) => String(i).padStart(2, '0')) : DAYS;
  const when = [
    { name: 'Prompts', color: 'var(--accent)', values: whenLabels.map(() => 0) },
    { name: 'Interrupted', color: 'var(--warn)', values: whenLabels.map(() => 0) },
  ];
  const whenWork = whenLabels.map(() => 0);
  for (const { t } of turns) {
    const d = new Date(t.at);
    const i = byHour ? d.getHours() : (d.getDay() + 6) % 7;
    when[t.interrupted ? 1 : 0].values[i]++;
    whenWork[i] += workOf(t);
  }
  /** @type {ChartTip} */
  const whenTip = (i) => [
    h('span', { class: 'muted' }, byHour ? `${whenLabels[i]}:00 to ${String((i + 1) % 24).padStart(2, '0')}:00` : whenLabels[i]),
    h('span', { class: 'tip-row' }, h('span', null, 'Prompts'), h('strong', null, String(when[0].values[i] + when[1].values[i]))),
    when[1].values[i] ? h('span', { class: 'tip-row' }, h('span', null, 'Interrupted'), h('strong', null, String(when[1].values[i]))) : null,
    h('span', { class: 'tip-row' }, h('span', null, 'Claude working'), h('strong', null, fmtSpan(whenWork[i]))),
  ];

  const found = insights({ turns, prev, tasks: rows, projectName: (id) => projectName(ctx, id) });
  const viewName = new Map(/** @type {[string, string][]} */ (VIEWS));

  return [
    h('div', { class: 'summary' },
      stat('Turns', String(turns.length), withChange(`across ${rows.length} task${rows.length === 1 ? '' : 's'} · ${(turns.length / rows.length).toFixed(1)} per task`, turns.length, prev.length, had)),
      stat('Time per turn', fmtSpan(median(works)), withChange(`median of claude's work · average ${fmtSpan(work / turns.length)}`, median(works), median(prevWorks), had)),
      stat('Claude working', fmtSpan(work), withChange(`longest turn ${fmtSpan(longest)}`, work, sum(prevWorks), had)),
      stat('Your time', fmtSpan(review + wait), withChange(`${fmtSpan(review)} reviewing · ${fmtSpan(wait)} answering questions and plans`, review + wait, prevYours, had)),
      stat('Task time', fmtSpan(median(rows.map((r) => r.elapsed))), `median, first prompt to last reply · ${pct(oneShot, rows.length)} of tasks done in one turn`),
      stat('Interrupted', String(interrupted), withChange(`${pct(interrupted, turns.length)} of turns`, interrupted, prevInterrupted, had))),
    h('section', { class: 'card stack' },
      h('h3', null, 'Insights'),
      found.length
        ? h('ul', { class: 'dev-insights' }, found.map((f) => h('li', { class: `dev-insight ${f.tone}` },
            h('span', { class: 'dev-insight-mark', 'aria-hidden': 'true' }),
            h('span', { class: 'grow' }, f.text),
            f.view ? h('button', { type: 'button', class: 'btn-link-inline', onclick: () => ctx.set({ view: f.view }) }, viewName.get(f.view)) : null)))
        : empty('Not enough turns in this period to say much yet.'),
      h('p', { class: 'muted small' }, had ? 'Worked out from this period’s turns; changes are against the period before.' : 'Worked out from this period’s turns.')),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'Over time'),
        h('div', { class: 'row ai-chart-controls' },
          segmented(/** @type {[string, string][]} */ (MEASURES), developmentView.measure, 'Measure', (measure) => ctx.set({ measure })))),
      barChart(w.items.map((b) => b.label), series, { format: fmt, tip }),
      legend(series),
      h('p', { class: 'muted small' }, `A turn counts in the period its prompt was sent. Reviewing is the time between claude's answer and the next prompt; a pause over an hour counts as time away.`)),
    h('section', { class: 'card stack' },
      h('h3', null, 'By project'),
      sortTable('development-projects', [
        { label: 'Project', clip: true, value: (r) => r.name, format: (_v, r) => projectCell(ctx, r.id) },
        { label: 'Tasks', num: true, value: (r) => r.tasks },
        { label: 'Turns', num: true, value: (r) => r.turns },
        { label: 'Claude', num: true, value: (r) => r.work, format: fmtSpan },
        { label: 'Per turn', num: true, value: (r) => r.median, format: fmtSpan },
        { label: 'Your time', num: true, value: (r) => r.yours, format: fmtSpan },
        { label: 'Interrupted', num: true, value: (r) => r.interrupted, format: (v, r) => (v ? `${v} · ${pct(v, r.turns)}` : '—') },
        { label: 'Tool calls', num: true, value: (r) => r.calls },
        { label: 'Failed', num: true, value: (r) => r.failed, format: (v) => `${(v * 100).toFixed(1)}%` },
        { label: 'MCP calls', num: true, value: (r) => r.mcp },
        { label: 'Skills', num: true, value: (r) => r.skills },
      ], projectRows),
      h('p', { class: 'muted small' }, 'This period’s turns. Your time is reviewing between turns plus answering questions and plans.')),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'When you work'),
        h('div', { class: 'row ai-chart-controls' },
          segmented(/** @type {[string, string][]} */ (WHEN), developmentView.when, 'Group by', (v) => ctx.set({ when: v })))),
      barChart(whenLabels, when, { format: (v) => String(Math.round(v)), tip: whenTip }),
      legend(when),
      h('p', { class: 'muted small' }, 'The prompts of the period by the time they were sent, in local time.')),
  ];
}

// --- Turns ---

/** @param {DevContext} ctx */
function turnsView(ctx) {
  const { turns, rows } = ctx;
  const works = turns.map((x) => workOf(x.t));
  const lengths = LENGTHS.map(() => 0);
  for (const v of works) lengths[LENGTHS.findIndex(([max]) => v < /** @type {number} */ (max))]++;
  const done = turns.filter((x) => x.t.done).length;
  const followUps = turns.filter((x) => x.t.review > 0).length;
  const tokens = ctx.read.map((x) => x.t.tokens ?? 0);
  const recent = [...turns].sort((a, b) => b.t.at - a.t.at).slice(0, RECENT);
  const labelOf = new Map(rows.map((r) => [r.name, r.label]));
  // No swatch beside it here, so a project without an image still gets its dot.
  const turnIcon = (/** @type {string} */ id) => {
    const p = id ? ctx.projectOf.get(id) : null;
    return p ? projectIcon(p, 'project-icon dev-by-icon') : null;
  };
  const count = (/** @type {number | null} */ v) => (v ? String(v) : '—');

  return [
    h('div', { class: 'summary' },
      stat('Time per turn', fmtSpan(median(works)), `median · longest ${fmtSpan(Math.max(...works))}`),
      stat('Follow-ups', String(followUps), `${pct(followUps, turns.length)} of turns came after an earlier one in their session`),
      stat('Output per turn', tokens.length ? fmtTokens(Math.round(median(tokens))) : '—', tokens.length ? `median tokens claude wrote · ${fmtTokens(sum(tokens))} in all${done ? ` · ${done} turn${done === 1 ? '' : 's'} ended with the done signal` : ''}` : 'Counted from the turns read since tools were kept')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Turn length'),
      barChart(LENGTHS.map(([, label]) => String(label)), [{ name: 'Turns', color: 'var(--accent)', values: lengths }], { format: (v) => String(v) }),
      h('p', { class: 'muted small' }, 'How long claude worked on each prompt, without the time it waited on your answer.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Tasks'),
      sortTable('development-tasks', [
        { label: 'Task', clip: true, value: (r) => r.label, format: (v, r) => h('span', { title: r.name }, v) },
        { label: 'Project', clip: true, value: (r) => (r.project ? projectName(ctx, r.project) : null), format: (_v, r) => projectCell(ctx, r.project) },
        { label: 'Turns', num: true, value: (r) => r.turns },
        { label: 'Claude', num: true, value: (r) => r.work, format: fmtSpan },
        { label: 'Per turn', num: true, value: (r) => r.median, format: fmtSpan },
        { label: 'Waiting', num: true, value: (r) => r.wait, format: fmtSpan },
        { label: 'Review', num: true, value: (r) => r.review, format: fmtSpan },
        { label: 'Interrupted', num: true, value: (r) => r.interrupted, format: count },
        { label: 'Tool calls', num: true, value: (r) => r.calls },
        { label: 'Failed', num: true, value: (r) => r.failed, format: count },
        { label: 'Output', num: true, value: (r) => r.tokens, format: fmtTokens },
        { label: 'Task time', num: true, value: (r) => r.elapsed, format: fmtSpan },
        { label: 'Last reply', num: true, value: (r) => r.last, format: (v) => new Date(v).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) },
      ], [...rows].sort((a, b) => b.last - a.last)),
      h('p', { class: 'muted small' }, 'Each task counts all its turns, also those before the period. Per turn is the median; Output is the tokens claude wrote.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Recent turns'),
      h('ul', { class: 'mon-recent dev-turn-log' }, recent.map(({ t, r, project }) => {
        const all = callsOf(t);
        const mcp = callsOf(t, isMcp);
        return h('li', null,
          h('span', { class: 'muted small time' }, new Date(t.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
          h('span', { class: 'grow cell-clip', title: t.text }, h('span', null, t.text || '—'), h('span', { class: 'muted small' }, ' ·', turnIcon(project), ` ${labelOf.get(r.name) ?? r.name}`)),
          Object.keys(t.skills ?? {}).map((name) => h('span', { class: 'pill tone-doing', title: 'A skill this turn ran' }, `/${name}`)),
          mcp.calls ? h('span', { class: 'pill tone-plain', title: mcpTitle(t) }, `MCP ${mcp.calls}`) : null,
          t.interrupted ? h('span', { class: 'pill tone-failed' }, 'Interrupted') : null,
          all.errors ? h('span', { class: 'muted small', title: 'Tool calls that failed, or that you refused' }, `${all.errors} failed`) : null,
          all.calls ? h('span', { class: 'muted small', title: toolsTitle(t) }, `${all.calls} call${all.calls === 1 ? '' : 's'}`) : null,
          t.wait ? h('span', { class: 'muted small', title: 'Waiting on your answer to a question or a plan' }, `waited ${fmtSpan(t.wait)}`) : null,
          reviewOf(t) ? h('span', { class: 'muted small', title: 'Time since the previous turn ended' }, `after ${fmtSpan(reviewOf(t))}`) : null,
          h('span', { class: 'num', title: "claude's working time" }, fmtSpan(workOf(t))));
      }))),
  ];
}

// A turn's tools for a tooltip, the most called first.
/** @param {DevTurn} t @param {(name: string) => boolean} [keep] */
function toolsTitle(t, keep = () => true) {
  return Object.entries(t.tools ?? {}).filter(([name]) => keep(name)).sort((a, b) => b[1].calls - a[1].calls)
    .map(([name, u]) => `${name.replace(/^mcp__/, '').replace(/__/g, ' · ')}: ${u.calls}${u.errors ? ` (${u.errors} failed)` : ''}`).join('\n');
}
const mcpTitle = (/** @type {DevTurn} */ t) => toolsTitle(t, isMcp);
