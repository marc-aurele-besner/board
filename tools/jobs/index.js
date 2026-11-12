// Every job the worker runs. Each file in this folder exports one job: { id, timeout, delay, setup(store), run(ctx) }.
// Its label and default interval are in js/runner-jobs.js, which Settings → Runners reads too.
/** @import { Job } from '../../types/runner' */
import google from './google.js';
import gmail from './gmail.js';
import resend from './resend.js';
import calendar from './calendar.js';
import monitoring from './monitoring.js';
import telegram from './telegram.js';
import github from './github.js';
import previews from './previews.js';
import npm from './npm.js';
import webstats from './webstats.js';
import fx from './fx.js';
import devUsage from './dev-usage.js';
import worktrees from './worktrees.js';
import cron from './cron.js';
import defi from './defi.js';

/** @type {Job[]} */
export const jobs = [google, gmail, resend, calendar, monitoring, telegram, github, previews, npm, webstats, fx, devUsage, worktrees, cron, ...defi];
