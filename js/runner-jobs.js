// The jobs the local worker (tools/worker.js) runs, shared by the worker and Settings → Runners.
// `every` is the default interval in minutes. settings.json `runners.<id>` holds the user's { every, on }.
// No DOM here: the worker imports this file under Node.
/** @import { Settings } from '../types/data' */

export const JOBS = [
  { id: 'google', label: 'Google sign-ins', every: 1, description: 'Renews each Google account’s access token before it expires.' },
  { id: 'gmail', label: 'Gmail', every: 2, description: 'Reads new mail of every connected Gmail account into the Inbox.' },
  { id: 'resend', label: 'Resend', every: 5, description: 'Reads the emails each project sends and receives through Resend.' },
  { id: 'calendar', label: 'Calendar', every: 10, description: 'Reads every shown calendar from the start of last month to three months ahead.' },
  { id: 'monitoring', label: 'Monitoring', every: 5, description: 'Deadlines, budgets, site checks (health on the Tools interval, the rest daily), status pages and the automation rules.' },
  { id: 'telegram', label: 'Telegram', every: 0.5, fixed: 'Listens all the time', description: 'Turns messages sent to your bot into tasks, within a second or two.' },
  { id: 'notion', label: 'Notion', every: 5, description: 'Reads the Notion databases linked in Settings → Notion into tasks, and updates tasks whose pages changed.' },
  { id: 'github', label: 'GitHub', every: 15, description: 'Reads open issue and PR counts and the newest open items of every project’s repos.' },
  { id: 'previews', label: 'PR previews', every: 2, description: 'Reads the Vercel and Netlify preview links posted on the PRs of open tasks and recent Cron runs.' },
  { id: 'link-states', label: 'Task issues and PRs', every: 2, description: 'Reads whether the issues and PRs linked to tasks are open, merged or closed, so Tasks can colour them.' },
  { id: 'npm', label: 'npm', every: 60, description: 'Reads the packages of every project’s npm org, and each listed package’s latest version and weekly downloads.' },
  { id: 'webstats', label: 'Bing search data', every: 360, description: 'Reads each project website’s Bing Webmaster numbers for Monitoring.' },
  { id: 'socials', label: 'Socials', every: 360, description: 'Reads the follower counts of the X, LinkedIn and GitHub accounts added in Settings (and GitHub stars), for Monitoring → Socials.' },
  { id: 'fx', label: 'Exchange rates', every: 1440, description: 'Reads the USD to CAD rate of every day Money needs.' },
  { id: 'dev-usage', label: 'Dev usage', every: 1, description: 'Reads what each task’s claude session used from Claude Code’s transcripts.' },
  { id: 'worktrees', label: 'Done-task worktrees', every: 5, description: 'Removes the worktree a Dev session made once its tasks are done. Also runs as soon as a task changes.' },
  { id: 'cron', label: 'Cron flows', every: 1, description: 'Starts the Cron flows that are due. A flow missed while the runners were stopped runs once.' },
  { id: 'defi-positions', label: 'DeFi positions', every: 5, description: 'Reads the Uniswap v3 and v4 positions, their pools and token prices, and fee APR from the pools’ swaps.' },
  { id: 'defi-history', label: 'DeFi fee history', every: 15, description: 'Searches each position’s history a step further for the fees it collected, from the node and Etherscan.' },
  { id: 'defi-wallets', label: 'DeFi wallets', every: 5, description: 'Reads native and token balances of the wallets on every enabled chain.' },
  { id: 'defi-lending', label: 'DeFi lending', every: 5, description: 'Reads Aave v3 supply, debt and health factor, and warns when a health factor gets low.' },
  { id: 'defi-snapshots', label: 'DeFi snapshots', every: 60, description: 'Keeps one hourly entry of wallet, position and lending values in defi-snapshots.json.' },
];

export const WORKER_URL = 'http://127.0.0.1:8420';

/** @param {string} id */
export const jobOf = (id) => JOBS.find((j) => j.id === id);

// A job's interval and switch, from settings.json. An empty or invalid interval means the default.
/**
 * @param {Settings | undefined} settings
 * @param {string} id
 */
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
