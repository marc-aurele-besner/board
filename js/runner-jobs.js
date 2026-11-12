// The jobs the local worker (tools/worker.js) runs, shared by the worker and Settings → Runners.
// `every` is the default interval in minutes. settings.json `runners.<id>` holds the user's { every, on }.
// No DOM here: the worker imports this file under Node.

export const JOBS = [
  { id: 'google', label: 'Google sign-ins', every: 1, description: 'Renews each Google account’s access token before it expires.' },
  { id: 'gmail', label: 'Gmail', every: 2, description: 'Reads new mail of every connected Gmail account into the Inbox.' },
  { id: 'resend', label: 'Resend', every: 5, description: 'Reads the emails each project sends and receives through Resend.' },
  { id: 'calendar', label: 'Calendar', every: 10, description: 'Reads every shown calendar from the start of last month to three months ahead.' },
  { id: 'monitoring', label: 'Monitoring', every: 5, description: 'Deadlines, budgets, site checks (health on the Tools interval, the rest daily), status pages and the automation rules.' },
  { id: 'telegram', label: 'Telegram', every: 0.5, fixed: 'Listens all the time', description: 'Turns messages sent to your bot into tasks, within a second or two.' },
  { id: 'github', label: 'GitHub', every: 15, description: 'Reads open issue and PR counts and the newest open items of every project’s repos.' },
  { id: 'webstats', label: 'Bing search data', every: 360, description: 'Reads each project website’s Bing Webmaster numbers for Monitoring.' },
  { id: 'fx', label: 'Exchange rates', every: 1440, description: 'Reads the USD to CAD rate of every day Money needs.' },
  { id: 'dev-usage', label: 'Dev usage', every: 1, description: 'Reads what each task’s claude session used from Claude Code’s transcripts.' },
  { id: 'worktrees', label: 'Done-task worktrees', every: 5, description: 'Removes the worktree a Dev session made once its tasks are done. Also runs as soon as a task changes.' },
];

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
