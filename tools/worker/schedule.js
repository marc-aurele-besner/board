// Runs each job on its interval and keeps runners.json, the heartbeat the board reads.
// A job is { id, timeout, delay, loop, quiet, setup(store, { kick }), run(ctx) }; `every` comes from settings.json runners.<id> when set there.
// A job still running at its next tick is skipped, not queued. A failure doubles the wait, up to 30 minutes, and one
// success resets it. A Mac that slept finds its jobs overdue on wake and runs each once.
/** @import { Settings } from '../../types/data' */
/** @import { Job, JobParams, JobResult, Logger, NodeStore } from '../../types/runner' */
import { jobConfig } from '../../js/runner-jobs.js';
import { writeOwn } from './store.js';

const MINUTE = 60000;
const TICK_MS = 1000;
const BEAT_MS = 30000;
const MAX_BACKOFF_MS = 30 * MINUTE;
const DEFAULT_TIMEOUT_MS = 5 * MINUTE;

export const VERSION = 1;

/** @typedef {JobResult & { ok: boolean, error: string | null }} RunAnswer */
/** @typedef {{ running: Promise<RunAnswer> | null, failures: number, nextAt: number, state: Omit<JobResult, 'lastRunAt'> & { lastRunAt?: string | null } }} LiveJob */

/** @param {{ jobs: Job[], log: Logger }} options */
export function createScheduler({ jobs, log }) {
  /** @type {NodeStore | null} */
  let store = null;
  let folderId = '';
  /** @type {NodeJS.Timeout | number} */
  let tickTimer = 0;
  /** @type {NodeJS.Timeout | number} */
  let beatTimer = 0;
  const startedAt = new Date().toISOString();
  // Per job: { running, failures, nextAt, state } where state is what runners.json shows.
  /** @type {Map<string, LiveJob>} */
  const live = new Map(jobs.map((job) => [job.id, { running: null, failures: 0, nextAt: 0, state: {} }]));

  // Without a folder, every job reads as its defaults.
  const settings = () => store?.get('settings') ?? /** @type {Settings} */ ({});
  /** @param {Job} job */
  const intervalOf = (job) => jobConfig(settings(), job.id).every * MINUTE;
  /** @param {number} ms */
  const iso = (ms) => (ms ? new Date(ms).toISOString() : null);

  function heartbeat() {
    return {
      worker: { pid: process.pid, startedAt, beatAt: new Date().toISOString(), version: VERSION, folderId },
      jobs: Object.fromEntries([...live].map(([id, l]) => [id, {
        ...l.state,
        on: jobConfig(settings(), id).on,
        running: Boolean(l.running),
        nextRunAt: jobConfig(settings(), id).on && l.nextAt ? iso(l.nextAt) : null,
      }])),
    };
  }

  function beat() {
    if (!store) return;
    try {
      folderId = settings().folderId ?? '';
      writeOwn(store.dir, 'runners', heartbeat());
    } catch (err) {
      log.error(`Could not write runners.json: ${/** @type {Error} */ (err).message}`);
    }
  }

  // Runs one job now. `params` comes from a Run now request (a Calendar range, a Cron flow id).
  /** @param {Job} job @param {{ force?: boolean, params?: JobParams }} [options] @returns {Promise<RunAnswer>} */
  function run(job, { force = false, params = {} } = {}) {
    const l = /** @type {LiveJob} */ (live.get(job.id));
    // A run already going covers a plain Run now; one with its own params (a range, some repos) waits its turn.
    if (l.running) return Object.keys(params).length ? l.running.then(() => run(job, { force, params })) : l.running;
    const started = Date.now();
    const controller = new AbortController();
    const timeout = job.timeout ?? DEFAULT_TIMEOUT_MS;
    /** @type {NodeJS.Timeout | number} */
    let timer = 0;
    // Only runs with a store: use() and run(id) check.
    const ctx = { store: /** @type {NodeStore} */ (store), log, signal: controller.signal, force, params };
    l.running = Promise.race([
      Promise.resolve().then(() => job.run(ctx)),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`Timed out after ${Math.round(timeout / 1000)} s`));
        }, timeout);
      }),
    ])
      .then((result = {}) => {
        l.failures = 0;
        l.state = { lastRunAt: iso(started), lastOkAt: iso(Date.now()), durationMs: Date.now() - started, ok: true, error: null, ...result };
        const said = Object.entries(result).filter(([, v]) => (typeof v === 'number' || typeof v === 'string') && v !== '').map(([k, v]) => `${k} ${v}`).join(', ');
        if (!job.quiet || result.added) log.info(`${job.id} ok in ${Date.now() - started} ms${said ? ` (${said})` : ''}`);
        return { ok: true, error: null, ...result };
      })
      .catch((err) => {
        l.failures += 1;
        l.state = { lastOkAt: l.state.lastOkAt ?? null, lastRunAt: iso(started), durationMs: Date.now() - started, ok: false, error: err.message };
        log.error(`${job.id} failed in ${Date.now() - started} ms: ${err.message}`);
        return { ok: false, error: err.message };
      })
      .finally(() => {
        clearTimeout(timer);
        store?.flush();
        // A `loop` job (Telegram's long poll) starts again at once; it waits inside its own run.
        const base = job.loop ? (l.failures ? 5000 : 0) : intervalOf(job);
        const wait = Math.min(base * 2 ** l.failures, Math.max(MAX_BACKOFF_MS, base));
        l.nextAt = Date.now() + wait;
        l.running = null;
        beat();
      });
    return l.running;
  }

  function tick() {
    if (!store) return;
    const now = Date.now();
    for (const job of jobs) {
      const l = /** @type {LiveJob} */ (live.get(job.id));
      if (l.running || !jobConfig(settings(), job.id).on) continue;
      // A shorter interval saved in Settings takes effect at once, not after the old wait.
      const last = Date.parse(l.state.lastRunAt ?? '') || 0;
      if (last && !l.failures && !job.loop) l.nextAt = Math.min(l.nextAt, last + intervalOf(job));
      if (now >= l.nextAt) run(job);
    }
  }

  return {
    // Points the scheduler at a store (a data folder), or at none. Jobs start staggered: `delay` per job.
    /** @param {NodeStore | null} next */
    use(next) {
      store = next;
      clearInterval(tickTimer);
      clearInterval(beatTimer);
      if (!store) return;
      const now = Date.now();
      for (const job of jobs) {
        // kick(): run the job at its next tick, for a job that watches a file.
        job.setup?.(store, { kick: () => { /** @type {LiveJob} */ (live.get(job.id)).nextAt = 0; } });
        /** @type {LiveJob} */ (live.get(job.id)).nextAt = now + (job.delay ?? 2000);
      }
      beat();
      tickTimer = setInterval(tick, TICK_MS);
      beatTimer = setInterval(beat, BEAT_MS);
    },
    /** @param {string} id @param {{ params?: JobParams }} [options] */
    run(id, options) {
      const job = jobs.find((j) => j.id === id);
      if (!job) return Promise.resolve({ ok: false, error: `No job named ${id}.` });
      if (!store) return Promise.resolve({ ok: false, error: 'The runners have no data folder. Set it in Settings → Runners.' });
      return run(job, { force: true, ...options });
    },
    status: () => ({ ...heartbeat(), folder: store?.dir ?? null }),
    store: () => store,
    stop() {
      clearInterval(tickTimer);
      clearInterval(beatTimer);
    },
  };
}
