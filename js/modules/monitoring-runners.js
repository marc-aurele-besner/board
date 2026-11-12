// Monitoring → Board runners: the processes `bun start` runs (the static server, the command runner and the worker),
// and the status of each job the worker runs. Settings → Runners is where the jobs are switched and timed.
import { h, icon, refreshIcon, empty } from '../ui.js';
import { JOBS, jobConfig } from '../runner-jobs.js';
import { heartbeat, runnersOnline, jobState } from '../runners.js';
import { runnerInfo } from '../terminal.js';
import { runnerOf } from '../dev-core.js';
import { sortTable } from './monitoring-web.js';
import { when, exact, outcome, runNow, runningNow } from './settings-runners.js';
/** @import { Store, RunnerJobState, RunnerWorker, IconName } from '../../types/data' */
/** @import { RunnerInfo } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @typedef {typeof JOBS[number]} Job */
/** @typedef {{ job: Job, cfg: ReturnType<typeof jobConfig>, s: RunnerJobState | null, state: string }} JobRow */
// A column of sortTable() (js/modules/monitoring-web.js). Each column's value has its own type, so format takes never.
/** @typedef {{ label: string, num?: boolean, value: (r: JobRow) => unknown, format?: (v: never, r: JobRow) => Child }} JobColumn */

const POLL_MS = 10000;
const HOUR = 3600000;
// What the two processes the heartbeat does not cover answered, asked while the tab is shown.
// term: the command runner's /info, null when it does not answer. serve: whether this page's server sends no-cache.
/** @type {{ term: RunnerInfo | null | undefined, serve: boolean | null | undefined, timer: number | string }} */
const probe = { term: undefined, serve: undefined, timer: 0 };
// filter: one job state, or null for every job. layout: 'cards' or 'list'.
/** @type {{ filter: string | null, layout: string }} */
const view = { filter: null, layout: 'cards' };

// Each job state's name, in the order the ring and the legend show them. The rs-<state> class sets its colour.
const STATES = [['ok', 'OK'], ['running', 'Running'], ['waiting', 'Waiting'], ['pending', 'Not run yet'], ['failed', 'Failed'], ['off', 'Off']];
const NAME = Object.fromEntries(STATES);
/** @type {Record<string, number>} */
const RANK = { failed: 0, waiting: 1, running: 2, pending: 3, ok: 4, off: 5 };

/** @param {Store} store */
async function ask(store) {
  const [term, serve] = await Promise.all([
    runnerInfo(runnerOf(store)).catch(() => null),
    fetch(location.pathname, { method: 'HEAD', cache: 'no-store' })
      .then((res) => /no-cache|no-store/.test(res.headers.get('cache-control') ?? ''))
      .catch(() => null),
  ]);
  const changed = JSON.stringify([term, serve]) !== JSON.stringify([probe.term, probe.serve]);
  probe.term = term;
  probe.serve = serve;
  return changed;
}

// Asks now and every few seconds while `shown()` holds; draws again only when an answer changed.
/**
 * @param {Store} store
 * @param {() => boolean} shown
 */
function poll(store, shown) {
  if (probe.timer) return;
  const step = async () => {
    probe.timer = 'asking';
    if (!shown()) return (probe.timer = 0);
    if ((await ask(store)) && shown()) store.refresh();
    probe.timer = setTimeout(step, POLL_MS);
  };
  probe.timer = setTimeout(step, 0);
}

/** @param {string} at */
function uptime(at) {
  const ms = Date.now() - Date.parse(at);
  if (!(ms > 0)) return '—';
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

/** @param {number | null | undefined} ms */
const took = (ms) => (ms === undefined || ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);
/** @param {{ every: number }} cfg */
const every = (cfg) => (cfg.every < 1 ? `Every ${Math.round(cfg.every * 60)} s` : cfg.every >= 60 && cfg.every % 60 === 0 ? `Every ${cfg.every / 60} h` : `Every ${cfg.every} min`);
/** @param {string} url */
const host = (url) => url.replace(/^https?:\/\//, '');

// One word per job for the counts, the colours and sorting.
/**
 * @param {Store} store
 * @param {Job} job
 */
function stateOf(store, job) {
  const s = jobState(job.id);
  if (!jobConfig(store.get('settings'), job.id).on) return 'off';
  if (s?.running || runningNow(job.id)) return 'running';
  if (!s?.lastRunAt) return 'pending';
  if (s.waiting) return 'waiting';
  return s.ok ? 'ok' : 'failed';
}

// The ring of job states, drawn with a conic gradient so it needs no SVG.
/**
 * @param {Record<string, number>} counts
 * @param {number} total
 */
function ring(counts, total) {
  let at = 0;
  const stops = STATES.filter(([k]) => counts[k]).map(([k]) => {
    const from = at;
    at += (counts[k] / total) * 100;
    return `var(--rs-${k}) ${from.toFixed(2)}% ${at.toFixed(2)}%`;
  });
  return h('div', { class: 'rs-ring', style: { '--ring': stops.length ? `conic-gradient(${stops.join(', ')})` : 'var(--surface-2)' } },
    h('div', { class: 'rs-ring-hole' },
      h('strong', null, String(counts.ok), h('span', null, `/${total - counts.off}`)),
      h('span', { class: 'muted small' }, 'jobs OK')));
}

/**
 * @param {Store} store
 * @param {JobRow[]} rows
 * @param {boolean} online
 */
function hero(store, rows, online) {
  const counts = Object.fromEntries(STATES.map(([k]) => [k, rows.filter((r) => r.state === k).length]));
  const beat = heartbeat()?.worker;
  const [tone, title, line] = !online
    ? ['failed', 'The worker is offline', beat?.beatAt ? `No heartbeat since ${exact(beat.beatAt)}. The statuses below are from then.` : 'It has not written to this folder yet. Start the board with bun start.']
    : counts.failed
      ? ['failed', `${counts.failed} ${counts.failed === 1 ? 'job is' : 'jobs are'} failing`, 'Each failed tile says what went wrong. Run now tries again at once.']
      : counts.waiting
        ? ['waiting', `${counts.waiting} ${counts.waiting === 1 ? 'job is' : 'jobs are'} waiting`, 'Each waits for something to be set up first.']
        : ['ok', 'All runners are healthy', `Every job that is on ran fine. Last heartbeat ${when(beat?.beatAt)}.`];

  return h('section', { class: `card rs-hero rs-${tone}` },
    ring(counts, rows.length || 1),
    h('div', { class: 'rs-hero-text' },
      h('div', { class: 'row' }, h('span', { class: `rs-dot${tone === 'ok' ? ' live' : ''}` }), h('h3', { class: 'rs-title' }, title)),
      h('p', { class: 'muted small' }, line),
      h('div', { class: 'rs-legend', role: 'group', 'aria-label': 'Show the jobs that are' },
        STATES.map(([k, label]) => h('button', {
          type: 'button',
          class: `rs-chip rs-${k}${view.filter === k ? ' active' : ''}`,
          'aria-pressed': String(view.filter === k),
          disabled: !counts[k] && view.filter !== k,
          onclick: () => {
            view.filter = view.filter === k ? null : k;
            store.refresh();
          },
        }, h('span', { class: 'rs-dot' }), label, h('strong', null, String(counts[k])))))));
}

/**
 * @param {string} name
 * @param {IconName} iconName
 * @param {string} tone
 * @param {string} status
 * @param {string} metric
 * @param {string[]} lines
 * @param {HTMLElement | null} [meter]
 */
function proc(name, iconName, tone, status, metric, lines, meter = null) {
  return h('section', { class: `card rs-proc rs-${tone}` },
    h('div', { class: 'rs-proc-head' },
      h('span', { class: 'rs-proc-icon' }, icon(iconName)),
      h('div', { class: 'grow' }, h('div', { class: 'muted small' }, name), h('strong', { class: 'rs-proc-metric' }, metric)),
      h('span', { class: 'rs-status' }, h('span', { class: `rs-dot${tone === 'ok' ? ' live' : ''}` }), status)),
    meter,
    lines.filter(Boolean).map((l) => h('p', { class: 'muted small' }, l)));
}

/** @param {Store} store */
function processes(store) {
  const beat = heartbeat()?.worker;
  const online = runnersOnline();
  const term = probe.term;
  return h('div', { class: 'rs-procs' },
    proc('Static server', 'globe', probe.serve === false ? 'waiting' : 'ok', 'Online', location.host, [
      probe.serve === false
        ? 'Sends no no-cache header, so reload with Cmd+Shift+R to run changed code. tools/serve.js sends it.'
        : 'Serves this page. A reload runs changed code.',
    ]),
    proc('Command runner', 'terminal',
      term === undefined ? 'pending' : term ? 'ok' : 'failed',
      term === undefined ? 'Checking' : term ? 'Online' : 'Offline',
      term ? `${term.running} of ${term.max} running` : host(runnerOf(store)),
      term ? [`In ${term.root}.`] : term === null ? ['Does not answer. Dev, worktrees and Cron’s Dev steps need it.'] : [],
      term ? h('div', { class: 'rs-meter', title: `${term.running} of ${term.max} commands running` },
        h('span', { style: { '--p': String(Math.min(1, term.running / (term.max || 1))) } })) : null),
    proc('Worker', 'cpu', online ? 'ok' : 'failed', online ? 'Online' : 'Offline',
      // Online means a heartbeat was read.
      online ? `Up ${uptime(/** @type {RunnerWorker} */ (beat).startedAt)}` : 'Stopped',
      online
        ? [`Process ${/** @type {RunnerWorker} */ (beat).pid}, last heartbeat ${when(/** @type {RunnerWorker} */ (beat).beatAt)}.`]
        : [beat?.beatAt ? `No heartbeat since ${exact(beat.beatAt)}.` : 'Has not written to this folder yet.', 'Start the board with bun start.']));
}

// How far the job is between its last run and its next one. The bar keeps filling by itself until the run is due.
/** @param {JobRow} r */
function countdown(r) {
  if (r.state === 'running' || (r.job.fixed && r.state !== 'off')) return h('div', { class: 'rs-track busy' }, h('span'));
  const last = Date.parse(r.s?.lastRunAt ?? '');
  const next = Date.parse(r.s?.nextRunAt ?? '');
  if (r.state === 'off' || !(next > last)) return h('div', { class: 'rs-track' });
  const p = Math.min(1, Math.max(0, (Date.now() - last) / (next - last)));
  return h('div', { class: 'rs-track', title: `Next run ${exact(/** @type {RunnerJobState} */ (r.s).nextRunAt)}` },
    h('span', { style: { '--p': String(p), '--left': `${Math.max(0, next - Date.now())}ms` } }));
}

/**
 * @param {Store} store
 * @param {JobRow} r
 * @param {boolean} online
 * @param {number} i
 */
function jobTile(store, r, online, i) {
  const note = r.state === 'failed' ? r.s?.error : r.state === 'waiting' ? r.s?.waiting : null;
  const next = r.state === 'off' ? 'Off'
    : r.job.fixed ?? (r.state === 'running' ? 'Running…' : r.s?.nextRunAt ? `Next ${when(r.s.nextRunAt)}` : every(r.cfg));
  return h('article', { class: `rs-job rs-${r.state}`, style: { '--i': String(Math.min(i, 12)) } },
    h('div', { class: 'rs-job-head' },
      h('span', { class: `rs-dot${r.state === 'running' ? ' live' : ''}`, title: NAME[r.state] }),
      h('strong', { class: 'grow' }, r.job.label),
      h('span', { class: 'rs-every' }, r.job.fixed ? 'Always' : every(r.cfg)),
      h('button', {
        type: 'button', class: 'icon-btn rs-run', title: `Run ${r.job.label} now`, 'aria-label': `Run ${r.job.label} now`,
        disabled: r.state === 'running' || !online,
        onclick: () => runNow(store, r.job),
      }, refreshIcon(r.state === 'running'))),
    h('p', { class: 'muted small rs-job-desc' }, r.job.description),
    note ? h('p', { class: `small rs-job-note${r.state === 'failed' ? ' error' : ''}` }, icon(r.state === 'failed' ? 'alert' : 'clock'), h('span', null, note)) : null,
    countdown(r),
    h('div', { class: 'rs-job-foot' },
      h('span', { title: exact(r.s?.lastRunAt) }, r.s?.lastRunAt ? `Ran ${when(r.s.lastRunAt)} · ${took(r.s.durationMs)}` : NAME[r.state]),
      h('span', { title: exact(r.s?.nextRunAt) }, next)));
}

/**
 * @param {Store} store
 * @param {JobRow[]} rows
 * @param {boolean} online
 */
function jobTable(store, rows, online) {
  return sortTable('runner-jobs', /** @satisfies {JobColumn[]} */ ([
    {
      label: 'Job', value: (r) => r.job.label,
      format: (v, r) => h('div', null,
        h('strong', null, v),
        r.state === 'failed' || r.state === 'waiting'
          ? h('div', { class: r.state === 'failed' ? 'small error' : 'muted small' }, /** @type {RunnerJobState} */ (r.s).error || /** @type {RunnerJobState} */ (r.s).waiting)
          : null),
    },
    { label: 'Status', value: (r) => RANK[r.state], format: (v, r) => outcome(r.state === 'running' ? { ...r.s, running: true } : r.s, r.cfg.on) },
    { label: 'Last run', num: true, value: (r) => Date.parse(r.s?.lastRunAt ?? '') || null, format: (v, r) => h('span', { title: exact(r.s?.lastRunAt) }, when(r.s?.lastRunAt)) },
    { label: 'Took', num: true, value: (r) => r.s?.durationMs ?? null, format: took },
    { label: 'Last success', num: true, value: (r) => Date.parse(r.s?.lastOkAt ?? '') || null, format: (v, r) => h('span', { title: exact(r.s?.lastOkAt) }, when(r.s?.lastOkAt)) },
    { label: 'Next run', num: true, value: (r) => (r.cfg.on && Date.parse(r.s?.nextRunAt ?? '')) || null, format: (v, r) => (r.cfg.on ? h('span', { title: exact(r.s?.nextRunAt) }, when(r.s?.nextRunAt)) : '—') },
    { label: 'Every', num: true, value: (r) => r.cfg.every, format: (v, r) => r.job.fixed ?? `${v} min` },
    {
      label: '', value: () => null,
      format: (v, r) => h('button', {
        type: 'button', class: 'btn-small', title: `Run ${r.job.label} now`,
        disabled: r.state === 'running' || !online,
        onclick: () => runNow(store, r.job),
      }, refreshIcon(r.state === 'running'), 'Run now'),
    },
  ]), rows);
}

// How long each job's last run took, longest first, on one scale.
/** @typedef {JobRow & { s: RunnerJobState & { durationMs: number } }} TimedRow */
/** @param {JobRow[]} rows */
function durations(rows) {
  // undefined > 0 is false: a job that has not run has no duration.
  const timed = rows.filter(/** @returns {r is TimedRow} */ (r) => /** @type {number} */ (r.s?.durationMs) > 0 && !r.job.fixed).sort((a, b) => b.s.durationMs - a.s.durationMs);
  const max = timed[0]?.s.durationMs ?? 1;
  return h('section', { class: 'card stack' },
    h('h3', null, 'Last run time'),
    timed.length
      ? h('ul', { class: 'rs-bars' }, timed.map((r) => h('li', { class: `rs-${r.state}`, title: `${r.job.label}: ${took(r.s.durationMs)}` },
          h('span', { class: 'rs-bar-name' }, r.job.label),
          h('span', { class: 'rs-bar' }, h('span', { style: { '--p': String(Math.max(0.02, r.s.durationMs / max)) } })),
          h('span', { class: 'rs-bar-val' }, took(r.s.durationMs)))))
      : empty('No job has run yet.'));
}

// Every run due in the next hour, one lane per job, so the busy minutes stand out.
/** @param {JobRow[]} rows */
function nextHour(rows) {
  const now = Date.now();
  const lanes = rows
    .filter((r) => r.state !== 'off' && !r.job.fixed)
    .map((r) => {
      const step = r.cfg.every * 60000;
      let at = Math.max(now, Date.parse(r.s?.nextRunAt ?? '') || now);
      /** @type {number[]} */
      const runs = [];
      for (; at <= now + HOUR && runs.length < 60; at += step) runs.push((at - now) / HOUR);
      return { r, runs };
    })
    .filter((l) => l.runs.length)
    .sort((a, b) => a.r.cfg.every - b.r.cfg.every || a.runs[0] - b.runs[0]);
  const total = lanes.reduce((n, l) => n + l.runs.length, 0);
  return h('section', { class: 'card stack' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, 'Next hour'), h('span', { class: 'muted small' }, `${total} ${total === 1 ? 'run' : 'runs'}`)),
    lanes.length
      ? h('div', { class: 'rs-lanes' },
          lanes.map(({ r, runs }) => h('div', { class: `rs-lane rs-${r.state}` },
            h('span', { class: 'rs-bar-name' }, r.job.label),
            h('span', { class: runs.length > 20 ? 'rs-lane-track dense' : 'rs-lane-track', title: `${r.job.label}: ${runs.length} ${runs.length === 1 ? 'run' : 'runs'} in the next hour` },
              runs.map((p) => h('i', { style: { '--x': `${(p * 100).toFixed(2)}%` } }))))),
          h('div', { class: 'rs-lane rs-axis' }, h('span'), h('span', { class: 'rs-lane-track' },
            ['Now', '15 min', '30 min', '45 min', '1 h'].map((t, i) => h('b', { style: { '--x': `${i * 25}%` } }, t)))))
      : empty('No run is due in the next hour.'));
}

/** @param {Store} store */
function layoutSwitch(store) {
  return h('div', { class: 'segmented rs-layout', role: 'group', 'aria-label': 'View' },
    /** @type {[string, string, IconName][]} */ ([['cards', 'Cards', 'cards'], ['list', 'List', 'list']]).map(([key, label, iconName]) =>
      h('button', {
        type: 'button',
        class: view.layout === key ? 'seg active' : 'seg',
        'aria-pressed': String(view.layout === key),
        onclick: () => {
          view.layout = key;
          store.refresh();
        },
      }, icon(iconName), label)));
}

/**
 * @param {Store} store
 * @param {() => boolean} shown
 */
export function runnersTab(store, shown) {
  poll(store, shown);
  const online = runnersOnline();
  const settings = store.get('settings');
  // Failed jobs first, so trouble is the first thing seen.
  const rows = JOBS.map((job) => ({ job, cfg: jobConfig(settings, job.id), s: jobState(job.id), state: stateOf(store, job) }))
    .sort((a, b) => RANK[a.state] - RANK[b.state]);
  const listed = view.filter ? rows.filter((r) => r.state === view.filter) : rows;

  return h('div', { class: 'stack-lg rs' },
    hero(store, rows, online),
    processes(store),
    h('section', { class: 'card stack' },
      h('div', { class: 'row' },
        h('h3', { class: 'grow' }, 'Jobs', view.filter ? h('span', { class: 'muted' }, ` · ${NAME[view.filter]}`) : null),
        view.filter ? h('button', { type: 'button', class: 'btn-link-inline', onclick: () => { view.filter = null; store.refresh(); } }, 'Show all') : null,
        h('a', { class: 'btn-link small', href: '#/settings?section=runners' }, icon('settings'), ' Switch and time jobs'),
        layoutSwitch(store)),
      !listed.length ? empty('No jobs here.')
        : view.layout === 'list' ? jobTable(store, listed, online)
          : h('div', { class: 'rs-jobs' }, listed.map((r, i) => jobTile(store, r, online, i)))),
    h('div', { class: 'split-2' }, durations(rows), nextHour(rows)));
}
