// The jobs the local worker (tools/worker.js) runs, shared by the worker and Settings → Runners.
// `every` is the default interval in minutes. settings.json `runners.<id>` holds the user's { every, on }.
// No DOM here: the worker imports this file under Node.

export const JOBS = [];

export const WORKER_URL = 'http://127.0.0.1:8420';

export const jobOf = (id) => JOBS.find((j) => j.id === id);

// A job's interval and switch, from settings.json. An empty or invalid interval means the default.
export function jobConfig(settings, id) {
  const job = jobOf(id);
  const saved = settings?.runners?.[id] ?? {};
  const every = Number(saved.every);
  return {
    on: saved.on !== false,
    every: Number.isFinite(every) && every > 0 ? every : job?.every ?? 5,
    custom: Number.isFinite(every) && every > 0,
  };
}
