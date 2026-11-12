// Settings → Runners: the local worker that does the background work, its data folder, and each job's switch,
// interval, last outcome and Run now.
import { h, icon, refreshIcon, empty } from '../ui.js';
import { toast } from '../toast.js';
import { JOBS, jobConfig } from '../runner-jobs.js';
import { heartbeat, runnersOnline, jobState, runJob, workerStatus, setWorkerFolder, findWorkerFolder, readRunnersNow } from '../runners.js';
import { pickFolder } from '../folder-picker.js';
import { runnerOf } from '../dev-core.js';

const STATUS_TTL_MS = 5000;
// The worker's live status (GET /status), fetched when the card shows. running: job ids waiting on Run now.
const view = { status: undefined, statusAt: 0, loading: false, folder: null, saving: false, running: new Set() };

const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
const head = (title, intro, right) =>
  h('header', { class: 'panel-head' }, h('div', null, h('h2', null, title), h('p', { class: 'muted' }, intro)), right ? h('div', { class: 'row' }, right) : null);

// "3 minutes ago", "in 2 hours".
export function when(at) {
  if (!at) return '—';
  const diff = Date.parse(at) - Date.now();
  const abs = Math.abs(diff);
  if (abs < 45000) return diff > 0 ? 'in a moment' : 'just now';
  const [n, unit] = abs < 3600000 ? [Math.round(abs / 60000), 'min'] : abs < 86400000 ? [Math.round(abs / 3600000), 'h'] : [Math.round(abs / 86400000), 'd'];
  return diff > 0 ? `in ${n} ${unit}` : `${n} ${unit} ago`;
}
export const exact = (at) => (at ? new Date(at).toLocaleString() : '');

function loadStatus(store) {
  if (view.loading || Date.now() - view.statusAt < STATUS_TTL_MS) return;
  view.loading = true;
  workerStatus().then((status) => {
    view.status = status;
    view.statusAt = Date.now();
    view.loading = false;
    if (view.folder === null) view.folder = status?.folder?.path ?? '';
    store.refresh();
  });
}

function setJob(store, id, patch) {
  store.update('settings', (d) => {
    d.runners = { ...d.runners, [id]: { ...d.runners?.[id], ...patch } };
  });
}

// Shared with Monitoring → Board runners, so a job started on one page shows as running on the other.
export const runningNow = (id) => view.running.has(id);
export async function runNow(store, job) {
  view.running.add(job.id);
  store.refresh();
  try {
    await runJob(job.id);
    toast(`${job.label}: done.`);
  } catch (err) {
    toast(`${job.label}: ${err.message}`);
  } finally {
    view.running.delete(job.id);
    await readRunnersNow(store);
    store.refresh();
  }
}

async function saveFolder(store, e) {
  e?.preventDefault();
  view.saving = true;
  store.refresh();
  try {
    await setWorkerFolder(view.folder.trim());
    toast(view.folder.trim() ? 'The runners now use this folder.' : 'The runners have no data folder now.');
  } catch (err) {
    toast(err.message);
  } finally {
    view.saving = false;
    view.statusAt = 0;
    setTimeout(() => readRunnersNow(store), 2000);
    store.refresh();
  }
}

async function findFolder(store) {
  view.saving = true;
  store.refresh();
  try {
    const answer = await findWorkerFolder(store);
    if (answer.ok) {
      view.folder = answer.folder.path;
      toast(`The runners now use ${answer.folder.path}.`);
    } else {
      toast(answer.found?.length
        ? `More than one folder matches: ${answer.found.join(', ')}. Pick one with Browse.`
        : `No folder named “${store.folderName}” was found in your home, Desktop, Documents, Downloads or iCloud Drive. Pick it with Browse.`);
    }
  } catch (err) {
    toast(err.message);
  } finally {
    view.saving = false;
    view.statusAt = 0;
    setTimeout(() => readRunnersNow(store), 2000);
    store.refresh();
  }
}

function browse(store) {
  pickFolder({
    base: runnerOf(store),
    start: view.folder || '',
    title: 'Choose the data folder',
    onPick: (path) => {
      view.folder = path;
      saveFolder(store);
    },
  });
}

export function outcome(state, on) {
  if (!on) return badge('Off', 'plain');
  if (!state?.lastRunAt) return badge(state?.running ? 'Running' : 'Not run yet', 'todo');
  if (state.running) return badge('Running', 'doing');
  if (state.waiting) return h('span', { title: state.waiting }, badge('Waiting', 'todo'));
  return state.ok ? badge('OK', 'done') : h('span', { title: state.error ?? '' }, badge('Failed', 'high'));
}

function jobRow(store, job) {
  const cfg = jobConfig(store.get('settings'), job.id);
  const state = jobState(job.id);
  const busy = view.running.has(job.id) || state?.running;
  const detail = !cfg.on ? '' : state?.waiting || (!state?.ok && state?.error) || '';
  return h('tr', null,
    h('td', null,
      h('strong', null, job.label),
      h('div', { class: 'muted small' }, job.description),
      detail ? h('div', { class: state?.waiting ? 'muted small' : 'small error' }, detail) : null),
    h('td', null, outcome(state, cfg.on)),
    h('td', { class: 'num', title: exact(state?.lastOkAt) }, when(state?.lastOkAt)),
    h('td', { class: 'num', title: exact(state?.nextRunAt) }, cfg.on ? when(state?.nextRunAt) : '—'),
    h('td', null,
      job.fixed
        ? h('span', { class: 'muted small' }, job.fixed)
        : h('label', { class: 'row runner-every' },
            h('input', {
              type: 'number', min: '0.5', step: '0.5', value: cfg.custom ? String(cfg.every) : '', placeholder: String(job.every),
              'aria-label': `${job.label}: minutes between runs`,
              onchange: (e) => setJob(store, job.id, { every: Number(e.target.value) > 0 ? Number(e.target.value) : null }),
            }),
            h('span', { class: 'muted small' }, 'min'))),
    h('td', null, h('input', { type: 'checkbox', checked: cfg.on, 'aria-label': `${job.label}: on`, onchange: (e) => setJob(store, job.id, { on: e.target.checked }) })),
    h('td', null, h('button', {
      type: 'button', class: 'btn-small', disabled: busy || !runnersOnline(), title: 'Run now',
      onclick: () => runNow(store, job),
    }, refreshIcon(busy), 'Run now')));
}

export function runnersCard(store) {
  loadStatus(store);
  const online = runnersOnline();
  const worker = heartbeat()?.worker;
  const status = view.status;
  const ours = store.get('settings').folderId ?? '';
  // The worker read a folderId from its folder; another one means it fetches into a folder this tab does not show.
  // The worker answers but has no folder, so it cannot write its heartbeat: it is running, not offline.
  const noFolder = Boolean(!online && status && (!status.folder?.path || status.folder?.error));
  const otherFolder = status && status.worker?.folderId !== undefined && status.folder?.path && ours && status.worker.folderId !== ours;
  return h('section', { class: 'card panel' },
    head('Runners',
      'A worker on this computer does the background work: it reads mail, calendars and wallets, checks sites, reads Telegram and runs Cron flows on a schedule, and saves what it finds in the data folder. It runs inside bun start, whether or not a board tab is open.',
      online ? badge('Online', 'done') : noFolder ? badge('No folder', 'todo') : status ? badge('Starting', 'todo') : badge('Offline', 'high')),
    h('div', { class: 'card-inset stack' },
      noFolder
        ? h('p', { class: 'small' }, `The runners are running (process ${status.worker?.pid}) but do not know where “${store.folderName}” is on disk. Find it, or give its path below.`)
        : online
        ? h('p', { class: 'small' }, `Running since ${exact(worker.startedAt)} (process ${worker.pid}). Last heartbeat ${when(worker.beatAt)}.`)
        : h('p', { class: 'small' }, worker?.beatAt
            ? `No heartbeat since ${exact(worker.beatAt)}. Start the board with bun start (or bun dev) to run them again. Sections show the last data they saved.`
            : 'The runners have not written to this folder yet. Start the board with bun start, then set the folder path below.'),
      status === null && !online ? h('p', { class: 'muted small' }, 'The runners do not answer on this computer.') : null,
      noFolder && status.folder?.from !== 'BOARD_DATA'
        ? h('div', null, h('button', { type: 'button', class: 'btn-small', disabled: view.saving, onclick: () => findFolder(store) }, icon('search'), 'Find this folder'))
        : null,
      otherFolder
        ? h('p', { class: 'small error' }, icon('alert'), ' The runners use another data folder than this tab. Check the path below: it must be the folder this tab has open.')
        : null),
    h('form', { class: 'svc-section', onsubmit: (e) => saveFolder(store, e) },
      h('h3', null, 'Folder path for runners'),
      h('div', { class: 'input-group' },
        h('input', {
          type: 'text', placeholder: '~/Documents/board-data', value: view.folder ?? '', 'aria-label': 'Folder path for runners',
          disabled: !status || status.folder?.from === 'BOARD_DATA',
          oninput: (e) => { view.folder = e.target.value; },
        }),
        h('button', {
          type: 'button', class: 'input-addon', title: 'Find the folder on this machine',
          disabled: !status || view.saving || status.folder?.from === 'BOARD_DATA',
          onclick: () => browse(store),
        }, icon('folder'), 'Browse')),
      h('div', { class: 'svc-actions' },
        h('button', { class: 'primary', type: 'submit', disabled: !status || view.saving || status.folder?.from === 'BOARD_DATA' }, view.saving ? 'Saving…' : 'Save')),
      h('p', { class: 'muted small' },
        status?.folder?.from === 'BOARD_DATA'
          ? 'Set by BOARD_DATA where the board was started.'
          : `The browser never tells the board where “${store.folderName}” is on disk, so give its path once. It is kept in ~/.config/board/worker.json.`),
      status?.folder?.error ? h('p', { class: 'small error' }, status.folder.error) : null),
    JOBS.length
      ? h('div', { class: 'mon-scroll' },
          h('table', { class: 'mon-table runners-table' },
            h('thead', null, h('tr', null,
              h('th', null, 'Job'), h('th', null, 'Status'), h('th', { class: 'num' }, 'Last success'), h('th', { class: 'num' }, 'Next run'),
              h('th', null, 'Every'), h('th', null, 'On'), h('th', null, ''))),
            h('tbody', null, JOBS.map((job) => jobRow(store, job)))))
      : empty('No jobs yet.'),
    h('p', { class: 'muted small' }, 'An empty interval uses the default shown in grey. A change applies from the job’s next run. A job that fails waits twice as long before its next try, up to 30 minutes.'));
}
