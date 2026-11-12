// Monitoring → Board runners: the processes `bun start` runs (the static server, the command runner and the worker),
// and the status of each job the worker runs. Settings → Runners is where the jobs are switched and timed.
import { h, icon, refreshIcon, empty } from '../ui.js';
import { JOBS, jobConfig } from '../runner-jobs.js';
import { heartbeat, runnersOnline, jobState } from '../runners.js';
import { runnerInfo } from '../terminal.js';
import { runnerOf } from '../dev-core.js';
import { sortTable } from './monitoring-web.js';
import { when, exact, outcome, runNow, runningNow } from './settings-runners.js';

const POLL_MS = 10000;
// What the two processes the heartbeat does not cover answered, asked while the tab is shown.
// term: the command runner's /info, null when it does not answer. serve: whether this page's server sends no-cache.
const probe = { term: undefined, serve: undefined, timer: 0 };

const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);

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

function uptime(at) {
  const ms = Date.now() - Date.parse(at);
  if (!(ms > 0)) return '—';
  const m = Math.floor(ms / 60000);
  return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d ${Math.floor((m % 1440) / 60)} h`;
}

const took = (ms) => (ms === undefined || ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)} s`);

function processCard(title, state, lines) {
  return h('section', { class: 'card stack runner-proc' },
    h('div', { class: 'row' }, h('h3', { class: 'grow' }, title), state),
    lines.filter(Boolean).map((l) => h('p', { class: 'muted small' }, l)));
}

function processes(store) {
  const beat = heartbeat()?.worker;
  const online = runnersOnline();
  const term = probe.term;
  return h('div', { class: 'runner-procs' },
    processCard('Static server', badge('Online', 'done'), [
      `Serves this page on ${location.host}.`,
      probe.serve === false ? 'It sends no no-cache header, so reload with Cmd+Shift+R to run changed code. tools/serve.js sends it.' : null,
    ]),
    processCard('Command runner',
      term === undefined ? badge('Checking', 'todo') : term ? badge('Online', 'done') : badge('Offline', 'high'),
      term
        ? [`${term.running} of ${term.max} commands running.`, `On ${runnerOf(store).replace(/^https?:\/\//, '')}, in ${term.root}.`]
        : term === null ? [`Does not answer on ${runnerOf(store).replace(/^https?:\/\//, '')}. Dev, worktrees and Cron's Dev steps need it.`] : []),
    processCard('Worker',
      online ? badge('Online', 'done') : badge('Offline', 'high'),
      online
        ? [`Up ${uptime(beat.startedAt)} (process ${beat.pid}).`, `Last heartbeat ${when(beat.beatAt)}.`]
        : [beat?.beatAt ? `No heartbeat since ${exact(beat.beatAt)}.` : 'Has not written to this folder yet.', 'Start the board with bun start.']));
}

// One word per job for the counts and for sorting: failed jobs sort before the rest.
function stateOf(store, job) {
  const s = jobState(job.id);
  if (!jobConfig(store.get('settings'), job.id).on) return 'off';
  if (s?.running || runningNow(job.id)) return 'running';
  if (!s?.lastRunAt) return 'pending';
  if (s.waiting) return 'waiting';
  return s.ok ? 'ok' : 'failed';
}
const RANK = { failed: 0, waiting: 1, running: 2, pending: 3, ok: 4, off: 5 };

export function runnersTab(store, shown) {
  poll(store, shown);
  const online = runnersOnline();
  const settings = store.get('settings');
  const rows = JOBS.map((job) => ({ job, cfg: jobConfig(settings, job.id), s: jobState(job.id), state: stateOf(store, job) }));
  const count = (k) => rows.filter((r) => r.state === k).length;
  const mini = (n, label) => h('div', { class: 'mini' }, h('strong', null, String(n)), h('span', { class: 'muted small' }, label));

  return h('div', { class: 'stack-lg' },
    processes(store),
    h('section', { class: 'card stack' },
      h('div', { class: 'row' },
        h('h3', { class: 'grow' }, 'Jobs'),
        h('a', { class: 'btn-link small', href: '#/settings?section=runners' }, icon('settings'), 'Switch and time jobs')),
      h('div', { class: 'mini-stats' },
        mini(count('ok'), 'OK'), mini(count('failed'), 'Failed'), mini(count('waiting'), 'Waiting'),
        mini(count('running'), 'Running'), mini(count('off'), 'Off')),
      !online ? h('p', { class: 'small error' }, icon('alert'), ' The worker is offline: the statuses below are from its last heartbeat.') : null,
      rows.length
        ? sortTable('runner-jobs', [
            {
              label: 'Job', value: (r) => r.job.label,
              format: (v, r) => h('div', null,
                h('strong', null, v),
                r.state === 'failed' || r.state === 'waiting'
                  ? h('div', { class: r.state === 'failed' ? 'small error' : 'muted small' }, r.s.error || r.s.waiting)
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
          ], rows)
        : empty('No jobs yet.')));
}
