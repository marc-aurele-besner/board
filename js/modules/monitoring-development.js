// Monitoring → Development: how the claude sessions Dev ran for tasks went, turn by turn. A turn is one prompt and
// claude's work on it; the runners read them from Claude Code's transcripts into usage.json (tools/usage.js). Time
// is split three ways: claude working, claude waiting on an answer within a turn (a question or a plan to approve),
// and the user reviewing between turns (reading the answer, checking the work, writing the next prompt).
import { h, empty } from '../ui.js';
import { barChart, legend } from '../chart.js';
import { usageRecords, fmtDuration } from '../dev-usage.js';
import { stat } from './monitoring.js';
import { pickChip } from '../inline.js';
import { projectIcon } from './projects.js';
import { sortTable } from './monitoring-web.js';
import { devProjectOf, projectLabel, segmented, NO_PROJECT } from './monitoring-ai.js';
/** @import { DevTurn, DevUsage, Store } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */
/** @import { ChartTip } from '../chart.js' */

// A pause between turns longer than this is time away, not review.
const AWAY_MS = 60 * 60000;
const RECENT = 40;
const MEASURES = [['time', 'Time'], ['turns', 'Turns']];
const PARTS = /** @type {const} */ ([
  ['work', 'Claude working', 'var(--accent)'],
  ['wait', 'Waiting on you', 'var(--warn)'],
  ['review', 'Reviewing', 'var(--info)'],
]);
// Turn lengths (claude's working time) for the distribution, by upper bound.
const LENGTHS = [[60000, '< 1 min'], [5 * 60000, '1–5 min'], [15 * 60000, '5–15 min'], [30 * 60000, '15–30 min'], [60 * 60000, '30–60 min'], [Infinity, '> 1 h']];

// The tab's filter and chart measure. project: '' for all, '-' for tasks without a project, or an id.
export const developmentView = { project: '', measure: 'time' };

const workOf = (/** @type {DevTurn} */ t) => Math.max(0, t.end - t.at - t.wait);
const reviewOf = (/** @type {DevTurn} */ t) => (t.review <= AWAY_MS ? t.review : 0);
const median = (/** @type {number[]} */ list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Durations down to seconds: most turns take less than a minute or two.
/** @param {number} ms */
export function fmtSpan(ms) {
  if (!ms) return '—';
  if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} s`;
  if (ms < 10 * 60000) {
    const s = Math.round((ms % 60000) / 1000);
    return s && s < 60 ? `${Math.floor(ms / 60000)} min ${s} s` : `${Math.round(ms / 60000)} min`;
  }
  return fmtDuration(ms);
}
const pct = (/** @type {number} */ n, /** @type {number} */ d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

/** @param {Store} store @param {PeriodWindow} w */
export function developmentTab(store, w) {
  const tasks = store.get('todos').items;
  const projects = store.get('projects').projects;
  const projectOf = new Map(projects.map((p) => [p.id, p]));
  const set = (/** @type {Partial<typeof developmentView>} */ patch) => {
    Object.assign(developmentView, patch);
    store.refresh();
  };
  const all = usageRecords(store).filter((r) => r.turns?.length);
  const shown = (/** @type {DevUsage} */ r) => {
    const p = devProjectOf(tasks, r);
    return !developmentView.project || (developmentView.project === NO_PROJECT ? !p : p === developmentView.project);
  };
  const inWindow = (/** @type {DevTurn} */ t) => t.at >= w.start && t.at < w.end;
  // The records with a turn in the period, and those turns.
  const records = all.filter((r) => shown(r) && r.turns?.some(inWindow));
  const turns = records.flatMap((r) => (r.turns ?? []).filter(inWindow).map((t) => ({ t, r })));
  const usedProjects = new Set(all.map((r) => devProjectOf(tasks, r)).filter(Boolean));
  const projectChoices = projects.filter((p) => usedProjects.has(p.id) || p.id === developmentView.project).sort((a, b) => a.name.localeCompare(b.name));

  const filters = h('div', { class: 'row ai-filters' },
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

  // --- Summary ---
  const works = turns.map(({ t }) => workOf(t));
  const work = works.reduce((s, v) => s + v, 0);
  const wait = turns.reduce((s, { t }) => s + t.wait, 0);
  const review = turns.reduce((s, { t }) => s + reviewOf(t), 0);
  const interrupted = turns.filter(({ t }) => t.interrupted).length;
  const longest = turns.reduce((a, b) => (workOf(b.t) > workOf(a.t) ? b : a));
  /** @param {DevUsage} r */
  const taskOf = (r) => {
    const list = r.turns ?? [];
    const named = tasks.filter((t) => r.taskIds?.includes(t.id)).map((t) => t.text);
    const project = devProjectOf(tasks, r);
    const rw = list.map(workOf);
    return {
      name: r.name,
      label: named.join(', ') || r.name,
      projectId: project,
      project: project ? projectOf.get(project)?.name ?? 'Removed project' : '',
      turns: list.length,
      work: rw.reduce((s, v) => s + v, 0),
      median: median(rw),
      longest: Math.max(0, ...rw),
      wait: list.reduce((s, t) => s + t.wait, 0),
      review: list.reduce((s, t) => s + reviewOf(t), 0),
      interrupted: list.filter((t) => t.interrupted).length,
      // From the first prompt to claude's last reply, whatever happened between.
      elapsed: list.length ? Math.max(...list.map((t) => t.end)) - list[0].at : 0,
      last: Math.max(...list.map((t) => t.end)),
    };
  };
  const rows = records.map(taskOf);
  const oneShot = rows.filter((r) => r.turns === 1).length;

  // --- Over time ---
  const fmt = developmentView.measure === 'turns' ? (/** @type {number} */ v) => String(Math.round(v)) : fmtSpan;
  const bucket = (/** @type {number} */ ms) => w.items.findIndex((b) => ms >= b.start && ms < b.end);
  const series = developmentView.measure === 'turns'
    ? [
        { key: 'done', name: 'Answered', color: 'var(--accent)', values: w.items.map(() => 0) },
        { key: 'interrupted', name: 'Interrupted', color: 'var(--warn)', values: w.items.map(() => 0) },
      ]
    : PARTS.map(([key, name, color]) => ({ key, name, color, values: w.items.map(() => 0) }));
  for (const { t } of turns) {
    const b = bucket(t.at);
    if (b < 0) continue;
    if (developmentView.measure === 'turns') series[t.interrupted ? 1 : 0].values[b]++;
    else {
      series[0].values[b] += workOf(t);
      series[1].values[b] += t.wait;
      series[2].values[b] += reviewOf(t);
    }
  }
  /** @type {ChartTip} */
  const tip = (i) => {
    const count = turns.filter(({ t }) => bucket(t.at) === i).length;
    return [
      h('span', { class: 'muted' }, w.items[i].label),
      series.map((sr) => h('span', { class: 'tip-row' }, h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`), h('strong', null, fmt(sr.values[i])))),
      developmentView.measure === 'time' ? h('span', { class: 'tip-row' }, h('span', null, 'Turns'), h('strong', null, String(count))) : null,
    ];
  };

  // --- Turn lengths ---
  const lengths = LENGTHS.map(() => 0);
  for (const v of works) lengths[LENGTHS.findIndex(([max]) => v < /** @type {number} */ (max))]++;

  const recent = [...turns].sort((a, b) => b.t.at - a.t.at).slice(0, RECENT);
  const rowOf = new Map(rows.map((r) => [r.name, r]));
  // No swatch beside it here, so a project without an image still gets its dot.
  const turnIcon = (/** @type {string | undefined} */ id) => {
    const p = id ? projectOf.get(id) : null;
    return p ? projectIcon(p, 'project-icon dev-by-icon') : null;
  };

  return h('div', { class: 'stack-lg' },
    filters,
    h('div', { class: 'summary' },
      stat('Turns', String(turns.length), `across ${rows.length} task${rows.length === 1 ? '' : 's'} · ${(turns.length / rows.length).toFixed(1)} per task`),
      stat('Time per turn', fmtSpan(median(works)), `median of claude's work · average ${fmtSpan(work / turns.length)}`),
      stat('Claude working', fmtSpan(work), `longest turn ${fmtSpan(workOf(longest.t))}`),
      stat('Review', fmtSpan(review + wait), `${fmtSpan(review)} between turns · ${fmtSpan(wait)} answering questions and plans`),
      stat('Task time', fmtSpan(median(rows.map((r) => r.elapsed))), 'median, first prompt to last reply'),
      stat('Interrupted', String(interrupted), `${pct(interrupted, turns.length)} of turns · ${pct(oneShot, rows.length)} of tasks done in one turn`)),
    h('section', { class: 'card stack' },
      h('div', { class: 'row between ai-chart-head' },
        h('h3', null, 'Over time'),
        h('div', { class: 'row ai-chart-controls' },
          segmented(/** @type {[string, string][]} */ (MEASURES), developmentView.measure, 'Measure', (measure) => set({ measure })))),
      barChart(w.items.map((b) => b.label), series, { format: fmt, tip }),
      legend(series),
      h('p', { class: 'muted small' }, `A turn counts in the period its prompt was sent. Reviewing is the time between claude's answer and the next prompt; a pause over an hour counts as time away.`)),
    h('section', { class: 'card stack' },
      h('h3', null, 'Turn length'),
      barChart(LENGTHS.map(([, label]) => String(label)), [{ name: 'Turns', color: 'var(--accent)', values: lengths }], { format: (v) => String(v) }),
      h('p', { class: 'muted small' }, 'How long claude worked on each prompt, without the time it waited on your answer.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Tasks'),
      sortTable('development-tasks', [
        { label: 'Task', clip: true, value: (r) => r.label, format: (v, r) => h('span', { title: r.name }, v) },
        { label: 'Project', clip: true, value: (r) => r.project || null, format: (_v, r) => (r.projectId ? projectLabel(projectOf.get(r.projectId)) : '—') },
        { label: 'Turns', num: true, value: (r) => r.turns },
        { label: 'Claude', num: true, value: (r) => r.work, format: fmtSpan },
        { label: 'Per turn', num: true, value: (r) => r.median, format: fmtSpan },
        { label: 'Longest', num: true, value: (r) => r.longest, format: fmtSpan },
        { label: 'Waiting', num: true, value: (r) => r.wait, format: fmtSpan },
        { label: 'Review', num: true, value: (r) => r.review, format: fmtSpan },
        { label: 'Interrupted', num: true, value: (r) => r.interrupted, format: (v) => (v ? String(v) : '—') },
        { label: 'Task time', num: true, value: (r) => r.elapsed, format: fmtSpan },
        { label: 'Last reply', num: true, value: (r) => r.last, format: (v) => new Date(v).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) },
      ], rows.sort((a, b) => b.last - a.last)),
      h('p', { class: 'muted small' }, 'Each task counts all its turns, also those before the period. Per turn is the median.')),
    h('section', { class: 'card stack' },
      h('h3', null, 'Recent turns'),
      h('ul', { class: 'mon-recent dev-turn-log' }, recent.map(({ t, r }) => h('li', null,
        h('span', { class: 'muted small time' }, new Date(t.at).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })),
        h('span', { class: 'grow cell-clip', title: t.text }, h('span', null, t.text || '—'),
          h('span', { class: 'muted small' }, ' ·', turnIcon(rowOf.get(r.name)?.projectId), ` ${rowOf.get(r.name)?.label ?? r.name}`)),
        t.interrupted ? h('span', { class: 'pill tone-failed' }, 'Interrupted') : null,
        t.wait ? h('span', { class: 'muted small', title: 'Waiting on your answer to a question or a plan' }, `waited ${fmtSpan(t.wait)}`) : null,
        reviewOf(t) ? h('span', { class: 'muted small', title: 'Time since the previous turn ended' }, `after ${fmtSpan(reviewOf(t))}`) : null,
        h('span', { class: 'num', title: "claude's working time" }, fmtSpan(workOf(t))))))));
}
