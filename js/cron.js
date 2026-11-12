// Cron flows: a schedule that starts a chain of steps (gather data → AI → task or notification).
// Each step gets the previous step's output as {{input}}. The runners (tools/jobs/cron.js) run due flows, whether or not the board is open.
import { uid, now, todayISO, statusOf } from './ui.js';
import { ask } from './ai.js';
import { makeTask } from './capture.js';
import { notify } from './notify-core.js';
import { calendarEvents, calendarAccounts, eventDate } from './gcal.js';
import { sitesOf, siteData } from './automations.js';
import { readPageText } from './sitecheck.js';
import { openPositions } from './defi/positions-read.js';
import { devPresets, devCommandOf, runnerOf, startRunnerSession } from './dev-core.js';
import { sessionStatus, sessionOutcome, exitClaude } from './terminal.js';
import { forgetWorktree } from './task-worktrees.js';
import { findGithubLinks, plainOutput, addTaskLinks, prsOf } from './task-links.js';
import { buildProfile, profileOf, hasProfileSources } from './profile.js';
import { findJson } from './json-extract.js';
/** @import { DataStore, Store, CronStep, CronSource, CronFlow, CronSchedule, CronTemplate, CronRun, CronRunStep, CronRunCurrent, CronTest, CronPr, CronFormatField, Project, Task, DevPreset, SiteLogEntry, TaskLink, IconName } from '../types/data' */
// The variables a step's templates read; $data holds what a name reads into with a path.
/** @typedef {{ [name: string]: unknown, $data?: Record<string, unknown> }} Vars */
// A step's result: what a test saves, with the variables the step saw.
/** @typedef {CronTest & { vars: Vars }} StepResult */
// The Dev terminal a step started (ctx.started).
/** @typedef {Omit<CronRunCurrent, 'stepId'>} StartedInfo */
// The item a loop is on: index counts from 0.
/** @typedef {{ item: unknown, index: number, count: number }} LoopItem */
/**
 * What passes between the steps of a run or a test (see runStep()).
 * @typedef {object} RunCtx
 * @property {StepResult[]} results
 * @property {string} note
 * @property {boolean} [dry]
 * @property {boolean} [live]
 * @property {string} [runId]
 * @property {boolean} [nothing]
 * @property {boolean} [stop]
 * @property {unknown} [data]
 * @property {string} [from]
 * @property {Task | null} [task]
 * @property {(info: StartedInfo) => void} [started]
 * @property {() => void} [beat]
 * @property {DataStore} [store]
 * @property {LoopItem} [loop]
 */

export const COLLECTION = 'cron';
// templates: flows saved as templates. tests: each flow's step test results, by flow id then step id.
export const DEFAULTS = { flows: [], runs: [], templates: [], tests: {} };
export const AI_TASK = 'task-cron';
const MAX_RUNS = 60;
const MINUTE = 60000;

// [type, label, icon, short description]
/** @type {[string, string, IconName, string][]} */
export const STEP_TYPES = [
  ['gather', 'Gather data', 'list', 'Reads tasks, projects, money, calendar, web pages and more; several sources at once.'],
  ['ai', 'AI generate', 'cpu', 'Sends a prompt to a model through OpenRouter.'],
  ['stop', 'Stop if', 'filter', 'Ends the run early, for example when there is nothing to report. In a loop, skips the item.'],
  ['format', 'Format', 'align-left', 'Reshapes the input into cleaner text, a list with one line per item, or named JSON fields.'],
  ['parse', 'Parse JSON', 'code', 'Finds the JSON in a text, such as a model’s or claude’s answer, even with prose around it or cut off, and passes it on as data.'],
  ['loop', 'Loop over items', 'repeat', 'Runs the next steps once for each item of a list, then passes on what they gave for all of them.'],
  ['task', 'Create task', 'check-square', 'Adds a task with a title and description you write, the output by default.'],
  ['notify', 'Notify', 'bell', 'Posts the output under the bell (and Telegram if enabled).'],
  ['profile', 'Refresh project profile', 'refresh', 'Rebuilds a project’s profile from its folder, repos and website, as Projects does.'],
  ['dev', 'Run in Dev', 'terminal', 'Hands a prompt to the project’s Dev command, a preset or your own, in a new Dev terminal.'],
];

// What a "Run in Dev" step starts: the project's Dev command ('claude'), a preset from Settings → Dev environment
// ('preset', step.preset), a Dev command typed on the step ('custom', step.devCommand), each with the Dev prompt,
// or a plain shell command with no prompt ('command').
/** @param {DataStore} store */
export function devRunOptions(store) {
  return [
    ['claude', 'Project’s Dev command'],
    ...devPresets(store).map((/** @type {DevPreset} */ p) => [`preset:${p.id}`, `Preset: ${p.name}`]),
    ['custom', 'Custom Dev command'],
    ['command', 'Shell command (no prompt)'],
  ];
}
/** @param {CronStep} step */
export const devRunValue = (step) => (step.mode === 'preset' ? `preset:${step.preset}` : step.mode || 'claude');

// The Dev command a step starts with its prompt, or '' for the project's own.
/**
 * @param {DataStore} store
 * @param {CronStep} step
 */
function stepDevCommand(store, step) {
  if (step.mode === 'custom') {
    if (!String(step.devCommand ?? '').trim()) throw new Error('Enter the Dev command to run.');
    return step.devCommand;
  }
  if (step.mode !== 'preset') return '';
  const preset = devPresets(store).find((/** @type {DevPreset} */ p) => p.id === step.preset);
  if (!preset?.command?.trim()) throw new Error('The preset of this step was removed. Choose another in Settings → Dev environment.');
  return preset.command;
}

// The command a Dev step runs before its prompt, to show it in the editor.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
export function devCommandPreview(store, flow, step) {
  if (step.mode === 'command') return '';
  try {
    return stepDevCommand(store, step) || devCommandOf(store, store.get('projects').projects.find((p) => p.id === withFlowProject(flow, step).projectId));
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
}

// What a "Refresh project profile" step does with a profile edited by hand. None of them stops the run.
export const PROFILE_EDITED = [
  ['merge', 'Update it and keep my edits'],
  ['replace', 'Replace it with a new one'],
  ['keep', 'Leave it as it is'],
];

// Steps saved before the choice had keepEdited, which stopped the run; they now update the profile and keep the edits.
/** @param {CronStep} step */
export const profileEditedMode = (step) => (PROFILE_EDITED.some(([k]) => k === step.onEdited) ? /** @type {string} */ (step.onEdited) : step.keepEdited === false ? 'replace' : 'merge');

export const STOP_WHEN = [
  ['nothing', 'The data step found nothing'],
  ['empty', 'The input is empty'],
  ['contains', 'The input contains'],
  ['lacks', 'The input does not contain'],
];

// What a source gives when it finds nothing. Later steps still get it, and "Stop if" can end the run on it.
/** @type {Record<string, string>} */
const NOTHING = {
  open: 'No open tasks.',
  due: 'Nothing is due within 7 days.',
  spending: 'No expenses this month yet.',
  calendar: 'No events today.',
  inbox: 'No unread email.',
  sites: 'No site check problems in the last 24 hours.',
  pools: 'No open pool positions.',
  'pools-out': 'Every pool position is in range.',
  page: 'The page had no readable text.',
  history: 'Nothing yet: this is the first run.',
  overdue: 'No task is overdue.',
  high: 'No open high priority task.',
  projects: 'No projects yet.',
  'spending-last': 'No expenses last month.',
  income: 'No income this month yet.',
  'calendar-week': 'No events in the next 7 days.',
  notifications: 'No unread notifications.',
  flow: 'That flow has no successful run yet.',
};

// [key, label, icon]
/** @type {[string, string, IconName][]} */
export const SOURCES = [
  ['open', 'Open tasks', 'check-square'],
  ['due', 'Tasks due within 7 days', 'check-square'],
  ['overdue', 'Overdue tasks', 'alert'],
  ['high', 'High priority open tasks', 'star'],
  ['project', 'One project (description and tasks)', 'folder'],
  ['projects', 'All projects (overview)', 'folder'],
  ['spending', 'Spending this month', 'coins'],
  ['spending-last', 'Spending last month', 'coins'],
  ['income', 'Income this month', 'coins'],
  ['calendar', 'Calendar events today', 'calendar'],
  ['calendar-week', 'Calendar events in the next 7 days', 'calendar'],
  ['inbox', 'Unread emails in the Inbox', 'inbox'],
  ['notifications', 'Unread notifications', 'bell'],
  ['sites', 'Site check problems (last 24 hours)', 'activity'],
  ['pools', 'Liquidity pool positions', 'droplet'],
  ['pools-out', 'Pool positions out of range', 'droplet'],
  ['page', 'A web page (a project’s site, its blog, any link)', 'globe'],
  ['history', 'Past outputs of this flow', 'repeat'],
  ['flow', 'Latest output of another flow', 'repeat'],
  ['text', 'Fixed text', 'align-left'],
];

/**
 * @param {string} [source]
 * @param {Partial<CronSource>} [fields]
 * @returns {CronSource}
 */
export const makeSource = (source = 'open', fields = {}) => ({ id: uid(), source, label: '', projectId: '', url: '', text: '', count: 5, follow: 3, flowId: '', ...fields });

// A data step's sources. Steps saved before a step could hold several kept one source in the step itself.
/** @param {CronStep} step */
export function sourcesOf(step) {
  if (Array.isArray(step.sources)) return step.sources;
  return [makeSource(step.source || 'open', { id: step.id, projectId: step.projectId ?? '', url: step.url ?? '', text: step.text ?? '', count: step.count ?? 5 })];
}

// The flow's project: data, task and Dev steps use it unless they choose another. A flow saved before flows had a
// project takes the one project its steps share, if they share one.
/** @param {CronFlow | null | undefined} flow */
export function flowProjectId(flow) {
  if (typeof flow?.projectId === 'string') return flow.projectId;
  /** @type {Set<string>} */
  const ids = new Set();
  for (const s of flow?.steps ?? []) {
    if (s.type === 'gather') sourcesOf(s).forEach((x) => x.projectId && ids.add(x.projectId));
    else if (s.projectId) ids.add(s.projectId);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

// A step or source with its project filled in from the flow when it has none of its own.
/**
 * @template {{ projectId?: string }} T
 * @param {CronFlow} flow
 * @param {T} item
 */
export const withFlowProject = (flow, item) => ({ ...item, projectId: item.projectId || flowProjectId(flow) });

// The heading a source's data gets when it sits next to other data: its own label, else what it reads.
/**
 * @param {DataStore} store
 * @param {CronSource} src
 */
export function sourceLabel(store, src) {
  if (String(src.label ?? '').trim()) return src.label.trim();
  const base = SOURCES.find(([k]) => k === src.source)?.[1] ?? src.source;
  const project = src.projectId ? store.get('projects').projects.find((p) => p.id === src.projectId) : null;
  if (src.source === 'project') return project ? `Project: ${project.name}` : base;
  if (src.source === 'page') return project ? `${project.name} website${src.url ? ` ${src.url}` : ''}` : src.url || 'Web page';
  if (src.source === 'history') return `Last ${src.count ?? 5} outputs of this flow`;
  if (src.source === 'flow') return `Latest output of “${store.get(COLLECTION).flows.find((f) => f.id === src.flowId)?.name ?? 'a removed flow'}”`;
  return base;
}

// How much of a page is passed on, so one long page does not crowd out the rest of the prompt.
const PAGE_CHARS = 12000;
// A page read because the first one links to it gets less room, so several fit.
const LINKED_CHARS = 4000;
export const MAX_FOLLOW = 10;

/**
 * @param {string} text
 * @param {number} max
 */
const cutPage = (text, max) => (text.length > max ? `${text.slice(0, max)}\n\n[The rest of the page was cut.]` : text);
// Images the reader still leaves in, as ![alt](src) or a link around one, only take room.
/** @param {string} text */
const dropImages = (text) => text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n');

// The pages of the same site a page links to, best first: a page under this one (a post under /blog) before one
// elsewhere, a link with a title or a summary before a one-word menu entry, and an article before a section.
// Files, sign-in and legal pages are left out.
/** @typedef {{ url: string, text: string, score: number, at: number }} PageLink */
/**
 * @param {string} markdown
 * @param {string} pageUrl
 */
export function pageLinks(markdown, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const own = base.pathname.replace(/\/+$/, '');
  const skip = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|xml|json|css|js|mp4|mp3)$|\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|privacy|terms|cookies?|legal)(\/|$)|\/(cdn-cgi|wp-admin|wp-json)\//i;
  /** @param {URL} u */
  const host = (u) => u.hostname.replace(/^www\./, '');
  /** @type {Map<string, PageLink>} */
  const byKey = new Map();
  for (const [, text, href] of markdown.matchAll(/\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    let u;
    try { u = new URL(href, base); } catch { continue; }
    if (!/^https?:$/.test(u.protocol) || host(u) !== host(base)) continue;
    const path = u.pathname.replace(/\/+$/, '');
    if (path === own || skip.test(path)) continue;
    const label = text.trim();
    // Menus name a page in a word or two; content links carry a title or a summary.
    const words = label.split(/\s+/).filter(Boolean).length;
    const under = own && path.startsWith(`${own}/`);
    const score = (under ? 4 : 0) + (words >= 4 ? 2 : words >= 2 ? 0.5 : 0) + Math.min(path.split('/').filter(Boolean).length, 3) * 0.5;
    // A page linked from a menu and from the content counts as a content link.
    const key = u.origin + path;
    const known = byKey.get(key);
    if (!known) byKey.set(key, { url: u.origin + u.pathname + u.search, text: label, score, at: byKey.size });
    else if (score > known.score) Object.assign(known, { text: label, score });
  }
  const ranked = [...byKey.values()].sort((a, b) => b.score - a.score || a.at - b.at);
  // Taken in turns across the site's sections (a guide, a combo, an emoji…), so a home page's few reads cover
  // more than its first list of cards. Under one section, as a blog's posts are, the order stays as ranked.
  /** @param {PageLink} l */
  const section = (l) => new URL(l.url).pathname.slice(own.length).split('/').filter(Boolean)[0] ?? '';
  /** @type {Map<string, PageLink[]>} */
  const groups = new Map();
  for (const l of ranked) groups.set(section(l), [...(groups.get(section(l)) ?? []), l]);
  /** @type {PageLink[]} */
  const spread = [];
  for (let i = 0; spread.length < ranked.length; i++) for (const g of groups.values()) if (g[i]) spread.push(g[i]);
  return spread;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * @param {string} type
 * @returns {CronStep}
 */
export function makeStep(type) {
  const base = { id: uid(), type };
  if (type === 'gather') return { ...base, sources: [makeSource()], append: false };
  if (type === 'ai') return { ...base, prompt: 'Summarize this in five bullet points:\n\n{{input}}', system: '', model: '' };
  if (type === 'task') return { ...base, title: '{{flow}} · {{date}}', description: '{{input}}', projectId: '', priority: 'none', due: '' };
  if (type === 'stop') return { ...base, when: 'nothing', text: '' };
  if (type === 'profile') return { ...base, projectId: '', onEdited: 'merge' };
  if (type === 'format') return { ...base, mode: 'text', text: '{{input}}', items: '{{input}}', itemText: '- {{item}}', separator: 'line', fields: [makeField()] };
  if (type === 'parse') return { ...base, text: '{{input}}', mode: 'largest' };
  if (type === 'loop') return { ...base, items: '{{input}}', span: 1, max: LOOP_MAX };
  if (type === 'dev') return { ...base, mode: 'claude', preset: '', devCommand: '', projectId: '', prompt: '{{input}}', command: '', waitMinutes: DEV_WAIT_MINUTES };
  return { ...base, text: '{{flow}}: {{input}}' };
}

/**
 * @param {Partial<CronFlow>} [fields]
 * @returns {CronFlow}
 */
export function makeFlow(fields = {}) {
  return {
    id: uid(),
    name: 'New flow',
    enabled: false,
    schedule: { every: 'daily', time: '08:00', weekday: 1, days: [1, 2, 3, 4, 5], day: 1, minutes: 60, from: '', to: '' },
    projectId: '',
    steps: [],
    lastRun: '',
    created: now(),
    ...fields,
  };
}

// Starting points for the Templates tab.
export const TEMPLATES = [
  {
    name: 'Morning plan',
    about: 'Picks the five open tasks that matter most today.',
    schedule: { every: 'daily', time: '08:00', weekday: 1, minutes: 60 },
    steps: [
      { type: 'gather', source: 'open' },
      { type: 'ai', prompt: 'Here are my open tasks:\n\n{{input}}\n\nPick the five that matter most today and give one line on why for each.' },
      { type: 'notify', text: 'Plan for {{date}}:\n{{input}}' },
    ],
  },
  {
    name: 'Weekly spending review',
    about: 'Explains where this month’s money went and flags anything unusual.',
    schedule: { every: 'weekly', time: '09:00', weekday: 1, minutes: 60 },
    steps: [
      { type: 'gather', source: 'spending' },
      { type: 'ai', prompt: 'These are my expenses this month:\n\n{{input}}\n\nExplain where the money went and flag anything unusual. Keep it under 150 words.' },
      { type: 'task', title: 'Read the spending review ({{date}})', priority: 'low' },
    ],
  },
  {
    name: 'Daily writing prompt',
    about: 'Adds a task with a fresh writing prompt, due the same day.',
    schedule: { every: 'daily', time: '07:30', weekday: 1, minutes: 60 },
    steps: [
      { type: 'ai', prompt: 'Write one short, specific writing prompt for today ({{date}}). Reply with the prompt only.' },
      { type: 'task', title: 'Write: {{input}}', priority: 'none', due: 'today' },
    ],
  },
  {
    name: 'Day ahead',
    about: 'Reads today’s calendar on workdays and suggests how to fit the day around it.',
    schedule: { every: 'days', time: '07:45', days: [1, 2, 3, 4, 5] },
    steps: [
      { type: 'gather', source: 'calendar' },
      { type: 'ai', prompt: 'These are my events today:\n\n{{input}}\n\nSay in three short lines where the free time is and what kind of work fits it.' },
      { type: 'notify', text: 'Today, {{date}}:\n{{input}}' },
    ],
  },
  {
    name: 'Inbox digest',
    about: 'Summarizes unread mail at the end of the workday, and stays quiet when there is none.',
    schedule: { every: 'days', time: '17:00', days: [1, 2, 3, 4, 5] },
    steps: [
      { type: 'gather', source: 'inbox' },
      { type: 'stop', when: 'nothing' },
      { type: 'ai', prompt: 'These emails are unread:\n\n{{input}}\n\nGroup them by what they need from me (reply, read, ignore). Keep it short.' },
      { type: 'notify', text: 'Inbox digest:\n{{input}}' },
    ],
  },
  {
    name: 'Site watch',
    about: 'Turns site check problems into a task during work hours.',
    schedule: { every: 'interval', minutes: 120, from: '08:00', to: '20:00' },
    steps: [
      { type: 'gather', source: 'sites' },
      { type: 'stop', when: 'nothing' },
      { type: 'task', title: 'Look at the site problems ({{date}})', priority: 'high', due: 'today' },
    ],
  },
  {
    name: 'Pools out of range',
    about: 'Lets you know when a liquidity position leaves its range.',
    schedule: { every: 'interval', minutes: 180, from: '08:00', to: '22:00' },
    steps: [
      { type: 'gather', source: 'pools-out' },
      { type: 'stop', when: 'nothing' },
      { type: 'notify', text: 'Out of range:\n{{input}}' },
    ],
  },
  {
    name: 'Monthly money check',
    about: 'Near the end of each month, reviews its spending and adds a task to act on it.',
    schedule: { every: 'monthly', time: '09:00', day: 28 },
    steps: [
      { type: 'gather', source: 'spending' },
      { type: 'ai', prompt: 'Spending so far this month:\n\n{{input}}\n\nGive three concrete ways to spend less next month.' },
      { type: 'task', title: 'Monthly money check ({{date}})', priority: 'medium' },
    ],
  },
  {
    name: 'Website content ideas',
    about: 'Reads a project’s website and drafts three pieces of content it does not have yet. Choose the flow’s project first.',
    schedule: { every: 'weekly', time: '09:00', weekday: 1 },
    steps: [
      { type: 'gather', source: 'page' },
      { type: 'gather', source: 'history', count: 4, append: true },
      {
        type: 'ai',
        prompt: 'Below is the current content of a website, then the content ideas suggested for it before.\n\n{{input}}\n\n'
          + 'Suggest three new pieces of content this website does not cover yet: a page, a section or an FAQ entry. Do not repeat earlier ideas. '
          + 'For each, give a title, who it is for, and a ready-to-paste draft of 150 to 250 words in the site’s own tone. '
          + 'Do not invent facts, prices or numbers; where a draft needs one, leave a [placeholder]. '
          + 'Start your answer with a one-line summary of the three ideas.',
      },
      { type: 'task', title: 'Website content: {{input}}' },
    ],
  },
  {
    name: 'Blog post draft',
    about: 'Reads a project’s website and its blog, then drafts a post on a topic the blog has not covered. Choose the flow’s project, and the blog’s path if it is not /blog.',
    schedule: { every: 'weekly', time: '09:00', weekday: 4 },
    steps: [
      { type: 'gather', source: 'page' },
      { type: 'gather', source: 'page', url: '/blog', append: true },
      { type: 'gather', source: 'history', count: 6, append: true },
      {
        type: 'ai',
        prompt: 'Below is a website, then its blog index with the posts already published, then the drafts written for it before.\n\n{{input}}\n\n'
          + 'Write one new blog post for this site, on a topic neither the blog nor the earlier drafts cover, that its readers would search for. '
          + 'Reply in Markdown: the post title alone on the first line (no # sign), then a one-sentence summary, then the post, 800 to 1,200 words with ## subheadings, '
          + 'ending with a short call to action that fits the site. Match the tone of the existing posts. '
          + 'Do not invent facts, quotes, customers or numbers; where the post needs one, leave a [placeholder].',
      },
      { type: 'task', title: 'Blog draft: {{input}}' },
    ],
  },
  {
    name: 'Blog post as a PR',
    about: 'Drafts a post from a project’s website and blog, adds it as a task, then has claude add it to the project’s repository and open a PR. Choose the flow’s project; it needs a local folder.',
    schedule: { every: 'weekly', time: '09:00', weekday: 2 },
    steps: [
      { type: 'gather', source: 'page' },
      { type: 'gather', source: 'page', url: '/blog', append: true },
      { type: 'gather', source: 'history', count: 6, append: true },
      {
        type: 'ai',
        prompt: 'Below is a website, then its blog index with the posts already published, then the posts written for it before.\n\n{{input}}\n\n'
          + 'Write one new blog post for this site, on a topic neither the blog nor the earlier posts cover, that its readers would search for. '
          + 'Reply in Markdown: the post title alone on the first line (no # sign), then a one-sentence summary, then the post, 800 to 1,200 words with ## subheadings, '
          + 'ending with a short call to action that fits the site. Match the tone of the existing posts. '
          + 'Do not invent facts, quotes, customers or numbers; where the post needs one, leave a [placeholder].',
      },
      { type: 'task', title: 'Blog post: {{input}}' },
      {
        type: 'dev',
        mode: 'claude',
        prompt: 'Add this blog post to the site in this repository as a new post page, the way the existing posts are made '
          + '(same folder, file format, front matter, and any list or index that names them). Leave [placeholders] as they are. '
          + 'Check that the site still builds, then commit on a new branch, push it and open a pull request.\n\n{{task}}',
      },
    ],
  },
  {
    name: 'Refresh project profile',
    about: 'Rebuilds a project’s profile every week from its folder, commits, repos and website, so AI features read it up to date. A profile you edited by hand is updated with your edits kept. Choose the flow’s project first.',
    schedule: { every: 'weekly', time: '07:00', weekday: 1 },
    steps: [
      { type: 'profile' },
      { type: 'notify', text: 'The profile of {{project}} was refreshed.' },
    ],
  },
  {
    name: 'Social posts (project or org)',
    about: 'Drafts an X post and a LinkedIn post for a project, from its description and website. Choose the flow’s project.',
    schedule: { every: 'days', time: '10:00', days: [1, 3, 5] },
    steps: [
      { type: 'gather', source: 'project' },
      { type: 'gather', source: 'page', append: true },
      { type: 'gather', source: 'history', count: 10, append: true },
      {
        type: 'ai',
        prompt: 'You write social posts for the organization or product described below. After it come the posts written before.\n\n{{input}}\n\n'
          + 'Pick one topic the earlier posts have not used, and write:\n'
          + '1. An X (Twitter) post of at most 280 characters, plain and specific, with at most one hashtag.\n'
          + '2. A LinkedIn post of 80 to 150 words: a hook on the first line, one concrete point, and a question or call to action at the end.\n'
          + 'No emoji unless the brand clearly uses them. Do not invent facts, customers or numbers; leave a [placeholder] instead. '
          + 'Start your answer with the topic on one line, then the two posts under the headings “X” and “LinkedIn”.',
      },
      { type: 'task', title: 'Social posts: {{input}}' },
    ],
  },
  {
    name: 'Social posts (personal)',
    about: 'Drafts an X post and a LinkedIn post for your own account. Fill in the first step with who you are and what you post about.',
    schedule: { every: 'days', time: '08:30', days: [2, 4] },
    steps: [
      {
        type: 'gather',
        source: 'text',
        text: 'About me: (who you are and what you work on)\nAudience: (who you want to reach)\nTopics: (three to five topics you post about)\nTone: (for example plain, practical, a little dry)',
      },
      { type: 'gather', source: 'history', count: 10, append: true },
      {
        type: 'ai',
        prompt: 'You help a person write posts for their own social accounts. Below is who they are, then the posts written before.\n\n{{input}}\n\n'
          + 'Pick one of their topics from an angle the earlier posts have not used, and write, in the first person:\n'
          + '1. An X (Twitter) post of at most 280 characters.\n'
          + '2. A LinkedIn post of 80 to 150 words with a hook on the first line and a question at the end.\n'
          + 'Sound like a person, not a brand. Do not invent experiences, events or numbers; where a post needs one, leave a [placeholder] for them to fill. '
          + 'Start your answer with the topic on one line, then the two posts under the headings “X” and “LinkedIn”.',
      },
      { type: 'task', title: 'Social posts: {{input}}' },
    ],
  },
];

// Built-in templates write a data step's single source on the step itself, which reads shorter. A saved template
// keeps its steps whole, without ids, and its sources get new ids so two flows made from it share none.
/**
 * @param {Omit<CronStep, 'id'>} s
 * @returns {CronStep}
 */
function templateStep(s) {
  if (s.type !== 'gather') return { ...makeStep(s.type), ...s };
  if (s.sources) return { ...makeStep(s.type), ...s, sources: s.sources.map((x) => ({ ...makeSource(x.source), ...x, id: uid() })) };
  const { type, source, append, ...fields } = s;
  return { ...makeStep(type), sources: [makeSource(source, fields)], append: Boolean(append) };
}

// A built-in template has no id or project.
/** @param {Pick<CronTemplate, 'name' | 'schedule' | 'steps'> & { projectId?: string }} t */
export function flowFromTemplate(t) {
  return makeFlow({ name: t.name, schedule: { ...makeFlow().schedule, ...t.schedule }, projectId: t.projectId ?? '', steps: t.steps.map(templateStep) });
}

// A flow saved as a template: its schedule, project and steps. {{stepN}} still points at the right step, since the
// steps keep their order.
/**
 * @param {CronFlow} flow
 * @param {{ name: string, about: string }} fields
 * @returns {CronTemplate}
 */
export function templateFromFlow(flow, { name, about }) {
  return {
    id: uid(),
    name,
    about,
    schedule: structuredClone(flow.schedule),
    projectId: flowProjectId(flow),
    steps: structuredClone(flow.steps).map(({ id, ...step }) => step),
    created: now(),
  };
}

// --- Schedule ---

/**
 * @param {Date} d
 * @param {string | undefined} time
 */
const atTime = (d, time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  const x = new Date(d);
  x.setHours(hh || 0, mm || 0, 0, 0);
  return x;
};

// Flows saved before "weekly" took several days still read; the editor shows them as chosen days.
export const REPEATS = [
  ['interval', 'Every few minutes or hours'],
  ['daily', 'Every day'],
  ['days', 'On chosen days of the week'],
  ['monthly', 'On chosen days of the month'],
  ['custom', 'Custom (cron expression)'],
];

export const SHORT_DAYS = WEEKDAYS.map((d) => d.slice(0, 3));
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const SHORT_MONTHS = MONTHS.map((m) => m.slice(0, 3));
/** @param {number} d */
const validDay = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
/**
 * @param {unknown} t
 * @returns {t is string}
 */
export const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t ?? ''));
/**
 * @template {string | number} T
 * @param {T[]} list
 */
const uniqueSorted = (list) => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The weekdays a slot may fall on, or null for every day. A bad value falls back, so the day search always ends.
/** @param {CronSchedule} s */
export function daysOf(s) {
  if (s.every === 'weekly') return [validDay(Number(s.weekday)) ? Number(s.weekday) : 1];
  if (s.every !== 'days') return null;
  const days = (Array.isArray(s.days) ? s.days : []).map(Number).filter(validDay);
  return days.length ? uniqueSorted(days) : [1, 2, 3, 4, 5];
}

// The times of day a slot falls at. Flows saved with a single `time` keep it.
/** @param {CronSchedule} s */
export function timesOf(s) {
  const list = (Array.isArray(s.times) && s.times.length ? s.times : [s.time]).filter(validTime);
  return list.length ? uniqueSorted(list) : ['08:00'];
}

// The days of the month a monthly flow runs on. Flows saved with a single `day` keep it.
/** @param {CronSchedule} s */
export function monthDaysOf(s) {
  const list = (Array.isArray(s.monthDays) && s.monthDays.length ? s.monthDays : [s.day])
    .map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  return list.length ? uniqueSorted(list) : [1];
}

// The months (0 to 11) a monthly flow runs in. Empty means all of them.
/** @param {CronSchedule} s */
export function monthsOf(s) {
  const list = (Array.isArray(s.months) ? s.months : []).map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 11);
  return list.length ? uniqueSorted(list) : MONTHS.map((_, i) => i);
}

// --- Cron expressions: minute, hour, day of the month, month, day of the week ---

/** @typedef {{ name: string, min: number, max: number, names?: string[] }} CronField */
/** @type {CronField[]} */
const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of the week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
/** @type {Record<string, string>} */
const CRON_MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

/**
 * @param {string} text
 * @param {CronField} field
 */
function cronField(text, { name, min, max, names }) {
  /** @type {Set<number>} */
  const values = new Set();
  /** @param {string} v */
  const value = (v) => {
    const i = names ? names.indexOf(v) : -1;
    const n = i >= 0 ? i + min : /^\d+$/.test(v) ? Number(v) : NaN;
    if (!(n >= min && n <= max)) throw new Error(`“${v}” is not a valid ${name} (${min}–${max}).`);
    return n;
  };
  for (const part of text.split(',')) {
    const m = part.match(/^(\*|[a-z0-9]+(?:-[a-z0-9]+)?)(?:\/(\d+))?$/);
    if (!m) throw new Error(`“${part}” is not a valid ${name}.`);
    let lo = min;
    let hi = max;
    if (m[1] !== '*') {
      const [a, b] = m[1].split('-');
      lo = value(a);
      hi = b !== undefined ? value(b) : m[2] ? max : lo;
    }
    if (lo > hi) throw new Error(`“${part}” runs backwards; write the smaller ${name} first.`);
    const step = m[2] ? Number(m[2]) : 1;
    if (step < 1) throw new Error(`“${part}” needs a step of at least 1.`);
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  return values;
}

// Throws with a readable message when the expression is not valid.
/** @param {string | undefined} expr */
export function parseCron(expr) {
  const text = String(expr ?? '').trim().toLowerCase();
  const parts = (CRON_MACROS[text] ?? text).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute, hour, day of the month, month and day of the week.');
  const [minutes, hours, dom, months, dow] = parts.map((p, i) => cronField(p, CRON_FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  // As in classic cron: when both day fields are restricted, a day matching either one runs.
  return { minutes, hours, dom, months, dow, either: !parts[2].startsWith('*') && !parts[4].startsWith('*') };
}

/** @param {string | undefined} expr */
export function cronError(expr) {
  try {
    parseCron(expr);
    return '';
  } catch (err) {
    return /** @type {Error} */ (err).message;
  }
}

// A cron expression for the schedule as it is, so switching to Custom starts from what the flow already does.
/** @param {CronSchedule} s */
export function cronOf(s) {
  if (s.every === 'custom') return String(s.cron ?? '').trim() || '0 8 * * *';
  if (s.every === 'interval') {
    const m = Math.max(5, Number(s.minutes) || 60);
    if (m < 60 && 60 % m === 0) return `*/${m} * * * *`;
    if (m % 60 === 0 && m <= 24 * 60) return `0 ${m === 60 ? '*' : `*/${m / 60}`} * * *`;
    return '0 8 * * *';
  }
  const times = timesOf(s).map((t) => t.split(':').map(Number));
  // Cron crosses every minute with every hour, so several times only fit when they share their minutes.
  const minute = times[0][1];
  const hours = times.every(([, mm]) => mm === minute) ? times.map(([hh]) => hh) : [times[0][0]];
  if (s.every === 'monthly') {
    const months = monthsOf(s);
    return `${minute} ${hours.join(',')} ${monthDaysOf(s).join(',')} ${months.length === 12 ? '*' : months.map((x) => x + 1).join(',')} *`;
  }
  const days = daysOf(s);
  return `${minute} ${hours.join(',')} * * ${days ? days.join(',') : '*'}`;
}

// --- Slots ---

/** @param {string | undefined} time */
const minutesOf = (time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};

// A fixed schedule as the days it runs on and the minutes of the day it runs at, or null when it has none.
/**
 * @param {CronSchedule} s
 * @returns {{ times: number[], day: (d: Date) => boolean } | null}
 */
function planOf(s) {
  if (s.every === 'custom') {
    let c;
    try {
      c = parseCron(s.cron);
    } catch {
      return null;
    }
    /** @type {number[]} */
    const times = [];
    for (const hh of [...c.hours].sort((a, b) => a - b)) for (const mm of [...c.minutes].sort((a, b) => a - b)) times.push(hh * 60 + mm);
    return {
      times,
      day: (d) => {
        if (!c.months.has(d.getMonth() + 1)) return false;
        const a = c.dom.has(d.getDate());
        const b = c.dow.has(d.getDay());
        return c.either ? a || b : a && b;
      },
    };
  }
  const times = timesOf(s).map(minutesOf);
  if (s.every === 'monthly') {
    const days = monthDaysOf(s);
    const months = monthsOf(s);
    return {
      times,
      // A day past the month's end (31 in April) falls on its last day.
      day: (d) => {
        if (!months.includes(d.getMonth())) return false;
        const last = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
        const n = d.getDate();
        return days.includes(n) || (n === last && days.some((x) => x > last));
      },
    };
  }
  const days = daysOf(s);
  return { times, day: (d) => !days || days.includes(d.getDay()) };
}

// Long enough to reach a 29 February; an expression that never matches (30 February) gives no slot.
const SEARCH_DAYS = 366 * 8;
/**
 * @param {Date} d
 * @param {number} m
 */
const withMinutes = (d, m) => {
  const x = new Date(d);
  x.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return x;
};

// The latest slot at or before `at`, or null. An interval has no fixed slot, so its next run follows the last one.
/**
 * @param {CronSchedule} s
 * @param {Date} at
 */
function lastSlot(s, at) {
  const plan = planOf(s);
  if (!plan?.times.length) return null;
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < SEARCH_DAYS; i++, d.setDate(d.getDate() - 1)) {
    if (!plan.day(d)) continue;
    for (let j = plan.times.length - 1; j >= 0; j--) {
      const t = withMinutes(d, plan.times[j]);
      if (t <= at) return t;
    }
  }
  return null;
}

// The first slot after `at`, or null.
/**
 * @param {CronSchedule} s
 * @param {Date} at
 */
function nextSlot(s, at) {
  const plan = planOf(s);
  if (!plan?.times.length) return null;
  const d = new Date(at);
  d.setHours(0, 0, 0, 0);
  for (let i = 0; i < SEARCH_DAYS; i++, d.setDate(d.getDate() + 1)) {
    if (!plan.day(d)) continue;
    for (const m of plan.times) {
      const t = withMinutes(d, m);
      if (t > at) return t;
    }
  }
  return null;
}

// The next few slots of a fixed schedule, to preview a custom expression.
/**
 * @param {CronSchedule} s
 * @param {number} [count]
 * @param {Date} [at]
 */
export function upcomingSlots(s, count = 3, at = new Date()) {
  /** @type {Date[]} */
  const out = [];
  /** @type {Date | null} */
  let t = at;
  while (out.length < count && (t = nextSlot(s, t))) out.push(t);
  return out;
}

// An interval flow's active hours. A From later than To wraps past midnight (22:00 to 06:00).
/** @param {CronSchedule} s */
const hasWindow = (s) => Boolean(s.from && s.to && s.from !== s.to);
/**
 * @param {CronSchedule} s
 * @param {Date} at
 */
function inWindow(s, at) {
  if (!hasWindow(s)) return true;
  const m = at.getHours() * 60 + at.getMinutes();
  const a = minutesOf(s.from);
  const b = minutesOf(s.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}
/**
 * @param {CronSchedule} s
 * @param {Date} t
 */
function intoWindow(s, t) {
  if (inWindow(s, t)) return t;
  const x = atTime(t, s.from);
  if (x < t) x.setDate(x.getDate() + 1);
  return x;
}

// The later of the last run and the moment the flow was switched on, so switching a flow on never replays a past slot.
/** @param {CronFlow} f */
const sinceOf = (f) => Math.max(Date.parse(f.lastRun) || 0, Date.parse(f.enabledAt || f.created) || 0);

/** @param {CronSchedule} s */
const intervalMs = (s) => Math.max(5, Number(s.minutes) || 60) * MINUTE;

// The next run, or null when the schedule never matches (an invalid or impossible cron expression).
/**
 * @param {CronFlow} flow
 * @param {Date} [at]
 */
export function nextRun(flow, at = new Date()) {
  const s = flow.schedule;
  if (s.every === 'interval') {
    const since = sinceOf(flow) || at.getTime();
    return intoWindow(s, new Date(Math.max(at.getTime(), since + intervalMs(s))));
  }
  return nextSlot(s, at);
}

// Due when a slot has passed since the last run, or since the flow was switched on. A missed slot runs once, not once per slot.
/**
 * @param {CronFlow} flow
 * @param {Date} [at]
 */
export function isDue(flow, at = new Date()) {
  if (!flow.enabled || !flow.steps.length) return false;
  const since = sinceOf(flow);
  const s = flow.schedule;
  if (s.every === 'interval') return at.getTime() - since >= intervalMs(s) && inWindow(s, at);
  const last = lastSlot(s, at);
  return Boolean(last) && /** @type {Date} */ (last).getTime() > since;
}

/** @param {string[]} items */
const listLabel = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

/** @param {number[]} days */
function daysLabel(days) {
  const key = days.join('');
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  if (key === '0123456') return 'Every day';
  if (days.length === 1) return `${WEEKDAYS[days[0]]}s`;
  // Monday first.
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => SHORT_DAYS[d]).join(', ');
}

/** @param {CronSchedule} s */
export function scheduleLabel(s) {
  if (s.every === 'interval') {
    const m = Math.max(5, Number(s.minutes) || 60);
    const every = m % 60 === 0 ? `Every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `Every ${m} minutes`;
    return hasWindow(s) ? `${every}, ${s.from}–${s.to}` : every;
  }
  if (s.every === 'custom') return `Cron ${String(s.cron ?? '').trim() || '(empty)'}`;
  const at = `at ${listLabel(timesOf(s))}`;
  if (s.every === 'weekly' || s.every === 'days') return `${daysLabel(/** @type {number[]} */ (daysOf(s)))} ${at}`;
  if (s.every === 'monthly') {
    const days = monthDaysOf(s);
    const months = monthsOf(s);
    const on = `on day${days.length > 1 ? 's' : ''} ${listLabel(days.map(String))}`;
    if (months.length === 12) return `Monthly ${on} ${at}`;
    // Most of the year reads shorter as the months it skips.
    const skipped = SHORT_MONTHS.filter((_, i) => !months.includes(i));
    return months.length > 6
      ? `Monthly except ${listLabel(skipped)}, ${on} ${at}`
      : `${months.map((m) => SHORT_MONTHS[m]).join(', ')} ${on} ${at}`;
  }
  return `Daily ${at}`;
}

// --- Steps ---

// --- Variables ---
// {{input}}, {{date}}, {{flow}} and {{task}} as before; {{step2}} is the output of step 2, and a path after a name
// ({{step2.items[0].title}}, {{input.title}}) reads into that output when it is JSON, or into what the step made.
// A key that is not a plain word goes in quotes: {{step1["Open tasks"]}}.
const VAR = /\{\{\s*([A-Za-z_]\w*)((?:\.[\w-]+|\[\d+\]|\["[^"\]]*"\])*)\s*\}\}/g;

// A model often wraps JSON in a code fence; anything else that is not JSON stays text.
/**
 * @param {unknown} text
 * @returns {unknown}
 */
export function parseData(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/, '$1').trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

/** @param {unknown} v */
const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

/**
 * @param {unknown} value
 * @param {string} path
 */
function walk(value, path) {
  let v = value;
  for (const [, key, index, quoted] of path.matchAll(/\.([\w-]+)|\[(\d+)\]|\["([^"\]]*)"\]/g)) {
    if (v == null || typeof v !== 'object') return undefined;
    v = /** @type {Record<string, unknown>} */ (v)[key ?? quoted ?? Number(index)];
  }
  return v;
}

// The value of one {{name.path}}, or undefined when there is none, so the placeholder stays as written.
/**
 * @param {Vars} vars
 * @param {string} name
 * @param {string} [path]
 */
function lookup(vars, name, path) {
  if (!(name in vars) || name === '$data') return undefined;
  if (!path) return asText(vars[name]);
  const v = walk(vars.$data?.[name], path);
  return v === undefined ? undefined : asText(v);
}

/**
 * @param {string | undefined} template
 * @param {Vars} vars
 * @param {(text: string) => string} [quote]
 */
const fill = (template, vars, quote = (x) => x) =>
  String(template ?? '').replace(VAR, (m, name, path) => {
    const v = lookup(vars, name, path);
    return v === undefined ? m : quote(v);
  });

// The template cut into plain text and filled variables, for the editor's preview: a part with `name` was a
// placeholder, and `missing` says nothing filled it yet.
/**
 * @param {string | undefined} template
 * @param {Vars} vars
 */
export function fillParts(template, vars) {
  /** @type {{ text: string, name?: string, missing?: boolean }[]} */
  const parts = [];
  let at = 0;
  const text = String(template ?? '');
  for (const m of text.matchAll(VAR)) {
    if (m.index > at) parts.push({ text: text.slice(at, m.index) });
    const v = lookup(vars, m[1], m[2]);
    parts.push(v === undefined ? { text: m[0], name: m[0], missing: true } : { text: v, name: m[0] });
    at = m.index + m[0].length;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}

// A project as {{project}} reads it: its name as text, and with a path its parts ({{project.website}},
// {{project.repo}}, {{project.directory}}). Empty fields stay as '' so a template reads the same for every project.
/** @param {Project | null | undefined} project */
export function projectVars(project) {
  if (!project) return null;
  const repos = project.github?.repos ?? [];
  let domain = '';
  try {
    domain = project.website ? new URL(project.website).hostname.replace(/^www\./, '') : '';
  } catch {}
  return {
    name: project.name ?? '',
    description: project.description ?? '',
    website: project.website ?? '',
    domain,
    repo: repos[0] ?? '',
    repoUrl: repos[0] ? `https://github.com/${repos[0]}` : '',
    repos,
    org: project.github?.org || (repos[0] ?? '').split('/')[0] || '',
    directory: project.localPath ?? '',
    labels: project.labels ?? [],
    npmOrg: project.npm?.org ?? '',
    packages: project.npm?.packages ?? [],
  };
}

// The variables a step sees: its input, the run's date and flow, the project, and every earlier step's output by
// number. $data holds what each name reads into with a path: parsed JSON, or what the step made.
// The project is the step's or source's own when it has one, else the flow's. A data step's sources each choose theirs.
/**
 * @param {CronFlow} flow
 * @param {Pick<RunCtx, 'results' | 'from' | 'store' | 'loop'>} ctx
 * @param {{ type?: string, from?: string, projectId?: string } | null} [step]
 * @param {DataStore} [store]
 */
function varsFor(flow, ctx, step = null, store = ctx.store) {
  const results = ctx.results ?? [];
  const prev = pipedResult(results, step?.from ?? ctx.from);
  /** @type {Vars & { $data: Record<string, unknown> }} */
  const vars = { input: prev?.output ?? '', date: todayISO(), flow: flow.name, $data: { input: prev?.data ?? null } };
  const projectId = (step?.type !== 'gather' && step?.projectId) || flowProjectId(flow);
  const project = projectVars(projectId && store ? store.get('projects').projects.find((p) => p.id === projectId) : null);
  if (project) {
    vars.project = project.name;
    vars.$data.project = project;
  }
  results.forEach((r, i) => {
    vars[`step${i + 1}`] = r.output;
    vars.$data[`step${i + 1}`] = r.data;
  });
  return ctx.loop ? withItem(vars, ctx.loop) : vars;
}

// What a step reads as {{input}}: the step before it by default, a chosen earlier step (its id), or nothing ('none'),
// so a flow can branch: two steps can both read the same data step. A source of a data step reads its step's input.
export const INPUT_NONE = 'none';
/**
 * @template {{ stepId?: string }} R
 * @param {R[]} results
 * @param {string} [from]
 */
export function pipedResult(results, from = '') {
  if (from === INPUT_NONE) return null;
  return from ? results.find((r) => r.stepId === from) ?? null : results.at(-1) ?? null;
}

// A step can only read one before it: after a move, an add or a remove, a pipe from a step that is gone or now comes
// later goes back to the step before.
/** @param {CronStep[]} steps */
export function fixPipes(steps) {
  steps.forEach((s, i) => {
    if (s.from && s.from !== INPUT_NONE && !steps.slice(0, i).some((x) => x.id === s.from)) delete s.from;
  });
}

// Puts the steps in a new order and renumbers every {{stepN}} to follow its step.
/**
 * @param {CronFlow} f
 * @param {CronStep[]} next
 */
export function reorderSteps(f, next) {
  const at = new Map(next.map((s, i) => [s.id, i + 1]));
  remapStepRefs(next, (n) => at.get(f.steps[n - 1]?.id) ?? null);
  f.steps = next;
  fixPipes(f.steps);
}

// The path to one key, in the form a variable reads it.
/**
 * @param {string} path
 * @param {string | number} key
 */
export const pathTo = (path, key) =>
  (typeof key === 'number' ? `${path}[${key}]` : /^[\w-]+$/.test(key) ? `${path}.${key}` : /^[^"\]]*$/.test(key) ? `${path}["${key}"]` : null);

// The variables as one JSON tree for the editor: a key's path is what a click on it puts in a field.
/** @param {Vars} vars */
export function varsTree(vars) {
  /** @type {Record<string, unknown>} */
  const tree = {};
  for (const [k, v] of Object.entries(vars ?? {})) {
    if (k === '$data') continue;
    const data = vars.$data?.[k];
    tree[k] = data != null && typeof data === 'object' ? data : v;
  }
  return tree;
}

// Moving, adding or removing a step changes the numbers after it, so references follow their step.
// `map` turns an old 1-based number into the new one, or null for a removed step.
/**
 * @param {Array<Omit<CronStep, 'id'>>} steps
 * @param {(n: number) => number | null | undefined} map
 */
export function remapStepRefs(steps, map) {
  /** @param {string} text */
  const fix = (text) => text.replace(/(\{\{\s*)step(\d+)(?=[.[\s}])/g, (m, open, n) => {
    const to = map(Number(n));
    return to == null ? `${open}removedStep` : `${open}step${to}`;
  });
  /** @param {object} o */
  const visit = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.includes('{{')) /** @type {Record<string, unknown>} */ (o)[k] = fix(v);
      else if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && visit(x));
    }
  };
  steps.forEach(visit);
}

/**
 * @param {DataStore} store
 * @param {Task[]} list
 */
function taskLines(store, list) {
  const projects = store.get('projects').projects;
  /** @param {string | null} id */
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';
  return list.map((t) => `- ${t.text} [${nameOf(t.projectId)}${t.priority && t.priority !== 'none' ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''}]`).join('\n');
}

// The page a web page step reads: a project's website, a path on it (/blog), or any address.
// With a project, a full link (with or without https://) is read as it is, so a project can point at its docs or repo.
/** @param {string} raw */
const looksLikeLink = (raw) => /^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
/**
 * @param {DataStore} store
 * @param {{ url?: string, projectId?: string }} step
 */
export function pageUrl(store, step) {
  const raw = String(step.url ?? '').trim();
  if (step.projectId) {
    const p = store.get('projects').projects.find((x) => x.id === step.projectId);
    if (!p) throw new Error('Choose the flow’s project, or one for this source.');
    if (raw && looksLikeLink(raw)) return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    if (!p.website) throw new Error(`${p.name} has no website. Add one in Projects, or enter a full link.`);
    try {
      return raw ? new URL(raw, p.website).href : p.website;
    } catch {
      throw new Error(`“${raw}” is not a path or address.`);
    }
  }
  if (!raw) throw new Error('Choose the flow’s project or enter the address of the page to read.');
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
}

/**
 * @param {DataStore} store
 * @param {string} type
 * @param {string} month
 */
function moneyTotals(store, type, month) {
  /** @type {Record<string, number>} */
  const totals = {};
  for (const e of store.get('finance').entries) {
    if (e.type !== type || !e.date?.startsWith(month)) continue;
    const key = `${e.category || 'Other'} (${e.currency || 'USD'})`;
    totals[key] = (totals[key] ?? 0) + Number(e.amount || 0);
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v.toFixed(2)}`).join('\n');
}

// What the pools sources read of a row of openPositions() (js/defi/positions-read.js).
/** @typedef {{ pair: string, chain: string, tokenId: string | number, inRange: boolean, value?: number | null, fees?: number | null }} PoolRow */

// One source's data as plain text, or '' when it found nothing. A page address and fixed text take variables, so
// a source can read {{project.repoUrl}} or quote {{project.description}}.
/**
 * @param {DataStore} store
 * @param {CronSource} step
 * @param {CronFlow} flow
 * @param {Vars} [vars]
 */
async function gather(store, step, flow, vars = {}) {
  if (step.source === 'page') {
    const url = pageUrl(store, { ...step, url: fill(step.url, vars) });
    const { title, text: raw } = await readPageText(url);
    const text = dropImages(raw);
    const main = text ? `Page: ${title || url} (${url})\n\n${cutPage(text, PAGE_CHARS)}` : '';
    const follow = Math.min(MAX_FOLLOW, Math.max(0, Number(step.follow) || 0));
    if (!follow || !text) return main;
    // A page that fails to read is skipped, so one dead link does not fail the step.
    /** @type {string[]} */
    const linked = [];
    for (const link of pageLinks(text, url).slice(0, follow)) {
      try {
        const page = await readPageText(link.url);
        const body = dropImages(page.text);
        if (body) linked.push(`### Linked page: ${page.title || link.text || link.url} (${link.url})\n\n${cutPage(body, LINKED_CHARS)}`);
      } catch { /* skipped */ }
    }
    return linked.length ? `${main}\n\n## Pages it links to\n\n${linked.join('\n\n')}` : main;
  }
  if (step.source === 'history') {
    const count = Math.min(20, Math.max(1, Number(step.count) || 5));
    const past = store.get(COLLECTION).runs.filter((r) => r.flowId === flow.id && r.status === 'ok' && !r.dry).slice(0, count);
    // The start of each is enough to avoid repeating a topic, and keeps a long blog post from filling the prompt.
    /** @param {string} text */
    const excerpt = (text) => (text.length > 800 ? `${text.slice(0, 800)}…` : text);
    return past.map((r) => `### ${r.at.slice(0, 10)}\n${excerpt(r.steps.at(-1)?.output ?? '')}`).join('\n\n');
  }
  const open = store.get('todos').items.filter((t) => statusOf(t) !== 'done');
  if (step.source === 'open') return taskLines(store, open);
  if (step.source === 'due') {
    const limit = new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    return taskLines(store, open.filter((t) => t.due && t.due <= limit));
  }
  if (step.source === 'project') {
    const p = store.get('projects').projects.find((x) => x.id === step.projectId);
    if (!p) throw new Error('Choose the flow’s project, or one for this source.');
    return `Project: ${p.name}\n${p.description || ''}\n\nOpen tasks:\n${taskLines(store, open.filter((t) => t.projectId === p.id)) || 'none'}`;
  }
  if (step.source === 'overdue') return taskLines(store, open.filter((t) => t.due && t.due < todayISO()));
  if (step.source === 'high') return taskLines(store, open.filter((t) => t.priority === 'high'));
  if (step.source === 'projects') return projectsOverview(store, open);
  if (step.source === 'spending') return moneyTotals(store, 'expense', todayISO().slice(0, 7));
  if (step.source === 'income') return moneyTotals(store, 'income', todayISO().slice(0, 7));
  if (step.source === 'spending-last') {
    const d = new Date();
    d.setDate(1);
    d.setMonth(d.getMonth() - 1);
    return moneyTotals(store, 'expense', `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  if (step.source === 'calendar') return gatherCalendar(store, 1);
  if (step.source === 'calendar-week') return gatherCalendar(store, 7);
  if (step.source === 'notifications') {
    const unread = (store.get('notifications')?.items ?? []).filter((n) => !n.read).slice(0, 50);
    return unread.map((n) => `- ${String(n.at ?? '').slice(0, 16).replace('T', ' ')}: ${n.text}`).join('\n');
  }
  if (step.source === 'flow') {
    const other = store.get(COLLECTION).flows.find((f) => f.id === step.flowId);
    if (!other) throw new Error('Choose the flow to read.');
    const last = store.get(COLLECTION).runs.find((r) => r.flowId === other.id && r.status === 'ok' && !r.dry);
    return last?.steps.at(-1)?.output ?? '';
  }
  if (step.source === 'inbox') {
    const unread = (store.get('inbox')?.emails ?? []).filter((e) => e.dir === 'received' && !e.archived && e.unread).slice(0, 50);
    return unread.map((e) => `- ${e.from || 'Unknown sender'}: ${e.subject || '(no subject)'}`).join('\n');
  }
  if (step.source === 'sites') {
    const since = Date.now() - 24 * 60 * MINUTE;
    const lines = sitesOf(store).flatMap((/** @type {Project} */ p) => {
      const s = siteData(store, p.id);
      const log = (s.log ?? []).filter((/** @type {SiteLogEntry} */ e) => e.level !== 'info' && Date.parse(e.at) >= since);
      const down = s.health?.status === 'down' ? [`- ${p.name}: down as of the last check`] : [];
      return [...down, ...log.map((/** @type {SiteLogEntry} */ e) => `- ${p.name} (${e.level === 'error' ? 'error' : 'warning'}): ${e.text}`)];
    });
    return lines.join('\n');
  }
  if (step.source === 'pools' || step.source === 'pools-out') {
    /** @param {number | null | undefined} n */
    const usd = (n) => (n == null ? 'unknown' : `$${n.toFixed(2)}`);
    const rows = openPositions(store).filter((/** @type {PoolRow} */ r) => step.source === 'pools' || !r.inRange);
    return rows.map((/** @type {PoolRow} */ r) => `- ${r.pair} on ${r.chain} #${r.tokenId}: ${r.inRange ? 'in range' : 'out of range'}, value ${usd(r.value)}, unclaimed fees ${usd(r.fees)}`).join('\n');
  }
  return fill(step.text, vars);
}

/**
 * @param {DataStore} store
 * @param {Task[]} open
 */
function projectsOverview(store, open) {
  return store.get('projects').projects.map((p) => {
    const count = open.filter((t) => t.projectId === p.id).length;
    const about = String(p.description ?? '').split('\n')[0].trim();
    return `- ${p.name}${p.website ? ` (${p.website})` : ''}: ${count} open task${count === 1 ? '' : 's'}${about ? `. ${about}` : ''}`;
  }).join('\n');
}

// The events of every shown calendar from today on, for `days` days. Calendar sign-ins last one session,
// so a flow fails until they are renewed.
/**
 * @param {DataStore} store
 * @param {number} days
 */
async function gatherCalendar(store, days) {
  if (!calendarAccounts(store).length) throw new Error('Connect a Google Calendar in Settings first.');
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + days);
  const { events, errors, waiting } = await calendarEvents(store, from, to);
  if (!events.length && (waiting.length || errors.length)) {
    throw new Error(waiting.length ? `Sign in again to ${waiting.join(', ')} in Calendar.` : errors.join(' · '));
  }
  /** @param {string} v */
  const clock = (v) => eventDate(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Over several days each event says its day.
  /** @param {string} v */
  const day = (v) => (days > 1 ? `${eventDate(v).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ` : '');
  return events.map((e) => `- ${day(e.start)}${e.allDay ? 'All day' : `${clock(e.start)}–${clock(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n');
}

// Whether a "Stop if" step ends the run, given its input and whether the last data step found nothing.
/**
 * @param {CronStep} step
 * @param {string} input
 * @param {boolean | undefined} nothing
 */
function stopsOn(step, input, nothing) {
  const text = String(step.text ?? '').trim().toLowerCase();
  if (step.when === 'empty') return !input.trim();
  if (step.when === 'contains') return Boolean(text) && input.toLowerCase().includes(text);
  if (step.when === 'lacks') return Boolean(text) && !input.toLowerCase().includes(text);
  return nothing;
}

/** @param {CronStep} step */
export function stopLabel(step) {
  const label = STOP_WHEN.find(([k]) => k === step.when)?.[1] ?? STOP_WHEN[0][1];
  return step.when === 'contains' || step.when === 'lacks' ? `${label} “${step.text || '…'}”` : label;
}

// --- Format and Loop ---
// A Format step reshapes its input, as n8n's Set and template nodes do: a text template, one line per item of a
// list, or named fields that make a JSON object. A Loop step runs the `span` steps after it once per item of a
// list, as n8n's Loop Over Items does; after it, each of those steps reads as the list of what it gave per item.

export const FORMAT_MODES = [
  ['text', 'Text from a template'],
  ['list', 'One line per item of a list'],
  ['fields', 'JSON fields'],
];
/** @type {Record<string, string>} */
const SEPARATORS = { line: '\n', blank: '\n\n', comma: ', ', space: ' ' };
export const SEPARATOR_OPTIONS = [
  ['line', 'New line'],
  ['blank', 'Blank line'],
  ['comma', 'Comma'],
  ['space', 'Space'],
];
// How many items one loop runs by default and at most, so a long list cannot start hundreds of model calls or terminals.
export const LOOP_MAX = 20;
export const LOOP_LIMIT = 200;

/**
 * @param {Partial<CronFormatField>} [fields]
 * @returns {CronFormatField}
 */
export const makeField = (fields = {}) => ({ id: uid(), name: '', value: '', ...fields });

// The value a field holding a single {{name.path}} points at, kept whole (a list stays a list, a number a number);
// any other text is filled as usual. Undefined when that one variable has no value.
const ONE_VAR = new RegExp(`^${VAR.source}$`);
/**
 * @param {string | undefined} template
 * @param {Vars} vars
 * @returns {unknown}
 */
export function valueOf(template, vars) {
  const m = String(template ?? '').trim().match(ONE_VAR);
  if (!m) return fill(template, vars);
  const [, name, path] = m;
  if (!(name in vars) || name === '$data') return undefined;
  const data = vars.$data?.[name];
  if (!path) return data != null && typeof data === 'object' ? data : vars[name];
  return walk(data, path);
}

// A value as a list of items: a list as it is, JSON text holding a list, else one item per non-empty line with its
// bullet or number taken off, so a data step's "- task" lines loop too.
/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
export function listOf(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  if (typeof value !== 'string') return [value];
  const parsed = parseData(value);
  if (Array.isArray(parsed)) return parsed;
  if (parsed) return [parsed];
  return value.split(/\r?\n/).map((l) => l.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, '')).filter(Boolean);
}

// The items a Loop or a list Format reads. A variable with no value fails the step, so a typo is not a quiet empty loop.
/**
 * @param {string | undefined} template
 * @param {Vars} vars
 */
function itemsOf(template, vars) {
  const t = String(template ?? '').trim() || '{{input}}';
  const value = valueOf(t, vars);
  if (value === undefined) throw new Error(`${t} has no value here.`);
  return listOf(value);
}

// The variables of one item: {{item}} (with paths into it when it is JSON), {{index}} from 1 and {{count}}.
/**
 * @param {Vars} vars
 * @param {LoopItem} loop
 * @returns {Vars}
 */
export function withItem(vars, { item, index, count }) {
  return { ...vars, item: asText(item), index: String(index + 1), count: String(count), $data: { ...vars.$data, item } };
}

/**
 * @param {CronStep} step
 * @param {Vars} vars
 * @param {RunCtx} ctx
 */
function formatStep(step, vars, ctx) {
  if (step.mode === 'fields') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const f of step.fields ?? []) {
      const name = String(f.name ?? '').trim();
      if (!name) continue;
      const v = valueOf(f.value, vars);
      // A variable with no value stays as written, as in any other field.
      out[name] = v === undefined ? fill(f.value, vars) : v;
    }
    if (!Object.keys(out).length) throw new Error('Name at least one field.');
    ctx.data = out;
    return JSON.stringify(out, null, 2);
  }
  if (step.mode === 'list') {
    const items = itemsOf(step.items, vars);
    const lines = items.map((item, index) => fill(step.itemText || '{{item}}', withItem(vars, { item, index, count: items.length })));
    ctx.data = lines;
    ctx.note = `${items.length} item${items.length === 1 ? '' : 's'}.`;
    return lines.join(SEPARATORS[step.separator ?? 'line'] ?? '\n');
  }
  return fill(step.text ?? '{{input}}', vars).trim();
}

// --- Parse JSON ---
// A Parse JSON step reads JSON out of a text that is not only JSON: a model's answer with prose or a code fence
// around it, a Dev terminal's output, or a copy cut off at either end (see js/json-extract.js).

export const PARSE_MODES = [
  ['largest', 'The largest one'],
  ['last', 'The last one'],
  ['first', 'The first one'],
  ['all', 'All of them, as a list'],
];

/**
 * @param {CronStep} step
 * @param {Vars} vars
 * @param {RunCtx} ctx
 */
function parseStep(step, vars, ctx) {
  const t = String(step.text ?? '').trim() || '{{input}}';
  const source = valueOf(t, vars);
  if (source === undefined) throw new Error(`${t} has no value here.`);
  // An earlier step's output that was JSON already is passed on as it is.
  /** @type {import('./json-extract.js').Found[]} */
  const found = source != null && typeof source === 'object' ? [{ value: source, size: 0 }] : findJson(asText(source));
  if (!found.length) throw new Error('No JSON found in the text.');
  const mode = step.mode || 'largest';
  const one = mode === 'first' ? found[0] : mode === 'last' ? found[found.length - 1] : found.reduce((a, b) => (b.size > a.size ? b : a));
  const value = mode === 'all' ? found.map((f) => f.value) : one.value;
  const what = Array.isArray(value) ? `a list of ${value.length} item${value.length === 1 ? '' : 's'}` : 'an object';
  const notes = [`Found ${what}.`];
  if (found.length > 1 && mode !== 'all') notes.push(`Kept the ${mode} of ${found.length} JSON values.`);
  if ((mode === 'all' ? found : [one]).some((f) => f.cut)) notes.push('The text was cut off; only its whole parts were kept.');
  ctx.data = value;
  ctx.note = notes.join(' ');
  return JSON.stringify(value, null, 2);
}

/** @param {CronStep} step */
export const loopMax = (step) => Math.min(LOOP_LIMIT, Math.max(1, Math.round(Number(step.max) || LOOP_MAX)));

// How many steps after the loop at `index` it repeats: its span, cut at the end of the flow and before another loop,
// since loops do not nest.
/**
 * @param {CronFlow} flow
 * @param {number} index
 */
export function loopSpan(flow, index) {
  const step = flow.steps[index];
  if (step?.type !== 'loop') return 0;
  const want = Math.max(1, Math.round(Number(step.span) || 1));
  let n = 0;
  while (n < want && flow.steps[index + 1 + n] && flow.steps[index + 1 + n].type !== 'loop') n++;
  return n;
}

// The index of the loop that repeats the step at `index`, or -1.
/**
 * @param {CronFlow} flow
 * @param {number} index
 */
export function loopOf(flow, index) {
  for (let i = index - 1; i >= 0; i--) {
    if (flow.steps[i].type === 'loop') return index - i <= loopSpan(flow, i) ? i : -1;
  }
  return -1;
}

// What one step gave over all the items it ran on: the list of its data, and its outputs as one text (a JSON list
// when every item gave JSON, else the texts one after the other).
/**
 * @param {CronStep} step
 * @param {StepResult[]} list
 * @param {number} count
 * @param {Vars} vars
 * @returns {StepResult}
 */
function gathered(step, list, count, vars) {
  const data = list.map((r) => r.data);
  const json = data.length > 0 && data.every((d) => d != null && typeof d === 'object');
  const notes = [...new Set(list.map((r) => r.note).filter(Boolean))];
  return {
    ok: true,
    stepId: step.id,
    vars: list[0]?.vars ?? vars,
    output: json ? JSON.stringify(data, null, 2) : list.map((r) => r.output).join('\n\n'),
    data,
    note: [`Ran for ${list.length} of ${count} item${count === 1 ? '' : 's'}.`, ...notes.slice(0, 3)].join(' '),
    ms: list.reduce((n, r) => n + r.ms, 0),
    at: now(),
  };
}

// Runs the loop at `index`, then its steps once per item, each item on its own copy of the run: its first step
// reads the item as {{input}}, and {{stepN}} of a step in the loop is what it gave for this item. A "Stop if" that
// stops skips the rest of the loop for that item only. `until` ends early, at a step being tested; `prepare` sets
// up the run before each step, as the caller does for steps outside a loop.
// Returns the loop's result and each step's gathered result, ending at a failure; the good ones go in ctx.results.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {number} index
 * @param {RunCtx} ctx
 * @param {{ until?: string, prepare?: (step: CronStep, ctx: RunCtx) => void }} [options]
 * @returns {Promise<StepResult[]>}
 */
async function runLoop(store, flow, index, ctx, { until = '', prepare } = {}) {
  const loop = flow.steps[index];
  prepare?.(loop, ctx);
  const head = await stepOnce(store, flow, loop, ctx);
  if (!head.ok || until === loop.id) return [head];
  let body = flow.steps.slice(index + 1, index + 1 + loopSpan(flow, index));
  const end = body.findIndex((s) => s.id === until);
  if (end >= 0) body = body.slice(0, end + 1);
  const items = /** @type {unknown[]} */ (head.data);
  const before = ctx.results.slice(0, -1);
  /** @type {StepResult[][]} */
  const per = body.map(() => []);
  for (const [i, item] of items.entries()) {
    /** @type {RunCtx} */
    const one = { ...ctx, loop: { item, index: i, count: items.length }, stop: false, results: [...before, { ...head, output: asText(item), data: item }] };
    for (const [j, step] of body.entries()) {
      prepare?.(step, one);
      const r = await stepOnce(store, flow, step, one);
      if (!r.ok) {
        const done = body.slice(0, j).map((s, k) => gathered(s, per[k], items.length, head.vars));
        ctx.results.push(...done);
        return [head, ...done, { ...r, stepId: step.id, output: `Item ${i + 1} of ${items.length}: ${r.output}` }];
      }
      ctx.beat?.();
      if (one.stop) break;
      per[j].push(r);
    }
    // A Run in Dev after the loop works on the task its last item made.
    ctx.task = one.task;
  }
  const done = body.map((s, k) => gathered(s, per[k], items.length, head.vars));
  ctx.results.push(...done);
  ctx.note = '';
  return [head, ...done];
}

// A shell word: single quotes keep newlines, quotes and $ as they are. A leading ~/ (a project's folder) stays
// outside them, so the shell still expands it.
/** @param {string} text */
const quoteWord = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
/** @param {string} text */
const shellQuote = (text) => (/^~\//.test(text) ? `~/${quoteWord(text.slice(2))}` : quoteWord(text));

// The task a "Create task" step made in this run, as claude gets a task from its Dev button: a checklist line,
// then its description indented. In a test run no task is made, so it is the title the step would give it.
/**
 * @param {Task | null} task
 * @param {string} fallback
 */
function taskText(task, fallback) {
  if (!task) return fallback;
  const desc = (task.description ?? '').trim();
  return `- [ ] ${task.text}${desc ? `\n${desc.split(/\r?\n/).map((l) => `  ${l}`).join('\n')}` : ''}`;
}

// --- Run in Dev: waiting for the terminal, and what it left behind ---
// A Dev step with steps after it waits for its terminal, so they can build on its work: the branch, the last commit,
// the files changed and the PR it opened. claude stays open once it is done, waiting for its user; a terminal quiet
// for SETTLE_MS more than the runner's own quiet time counts as finished.
export const DEV_WAIT_MINUTES = 60;
const WAIT_POLL_MS = 5000;
const SETTLE_MS = 30000;
const ENDED = ['done', 'failed', 'stopped', 'idle'];
/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether a Dev step waits for its terminal: as the step says, else when a step follows it.
/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
export const devWaits = (flow, step) => step.wait ?? flow.steps.findIndex((s) => s.id === step.id) < flow.steps.length - 1;

// A claude Dev step with another Run in Dev after it can ask for its final answer as JSON, which the next one reads
// as {{stepN.json}}. Only offered there, so a step moved last stops asking.
export const DEV_JSON_PROMPT = 'Output format: Output the final output in valid JSON';
/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
export const devJsonOffered = (flow, step) =>
  step.mode !== 'command' && flow.steps.slice(flow.steps.findIndex((s) => s.id === step.id) + 1).some((s) => s.type === 'dev');
/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
export const devJson = (flow, step) => Boolean(step.json) && devJsonOffered(flow, step);

// The last JSON object or array in a terminal's output. claude draws its answer after a ⏺ and wraps long lines with
// an indent, so a block that does not parse as printed is tried again with its line breaks taken out.
const JSON_SCAN = 40000;
/**
 * @param {string} text
 * @param {number} start
 */
function closingOf(text, start) {
  /** @type {string[]} */
  const stack = [];
  let str = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (str) {
      if (c === '\\') i++;
      else if (c === '"') str = false;
    } else if (c === '"') str = true;
    else if (c === '{' || c === '[') stack.push(c === '{' ? '}' : ']');
    else if (c === '}' || c === ']') {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return i;
    }
  }
  return -1;
}
/** @param {unknown} output */
export function lastJson(output) {
  const text = String(output ?? '').slice(-JSON_SCAN).replace(/⏺/g, ' ');
  /** @param {string} t */
  const parse = (t) => {
    for (const s of [t, t.replace(/\n[ \t]*/g, ' ')]) {
      try {
        return { value: JSON.parse(s) };
      } catch {}
    }
    return null;
  };
  /** @type {unknown} */
  let found;
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue;
    const end = closingOf(text, i);
    if (end < 0) continue;
    const r = parse(text.slice(i, end + 1));
    // A bare [] or [1] in prose is not the answer; an object, or an array of objects or several items, is.
    if (r && (r.value && typeof r.value === 'object') && (!Array.isArray(r.value) || r.value.length > 1 || typeof r.value[0] === 'object')) {
      found = r.value;
      i = end;
    }
  }
  return found;
}

/**
 * @param {DataStore} store
 * @param {string} session
 * @param {number | undefined} minutes
 * @param {() => void} [beat]
 */
async function waitForSession(store, session, minutes, beat) {
  const deadline = Date.now() + Math.max(1, Number(minutes) || DEV_WAIT_MINUTES) * MINUTE;
  let quietSince = 0;
  let misses = 0;
  for (;;) {
    let status = null;
    try {
      status = (await sessionStatus(runnerOf(store), [session]))[session] ?? null;
      misses = 0;
      if (!status) throw Object.assign(new Error('The terminal was closed in Dev before it finished.'), { final: true });
    } catch (err) {
      // A runner restarting is not the end of the work; a few misses in a row are.
      if (/** @type {{ final?: boolean }} */ (err).final || ++misses >= 6) throw /** @type {{ final?: boolean }} */ (err).final ? err : new Error(`Lost the terminal runner: ${/** @type {Error} */ (err).message}`);
    }
    if (status && ENDED.includes(status.state)) return status;
    if (status?.state === 'waiting') {
      quietSince ||= Date.now();
      if (Date.now() - quietSince >= SETTLE_MS) return status;
    } else if (status) quietSince = 0;
    if (Date.now() > deadline) throw new Error(`The terminal was still working after ${minutes} minutes. It keeps running in Dev.`);
    beat?.();
    await sleep(WAIT_POLL_MS);
  }
}

// claude stays open once done. It is sent /exit and asked to remove its worktree when nothing in it would be lost
// (tools/terminal.js decides); the task forgets a removed worktree. Says what happened, for the step's note.
/**
 * @param {DataStore} store
 * @param {string} session
 * @param {{ name: string }} worktree
 */
async function endClaude(store, session, worktree) {
  try {
    const r = await exitClaude(runnerOf(store), session);
    if (r.removed) {
      forgetWorktree(store, worktree.name);
      return 'claude exited and its worktree was removed';
    }
    if (r.kept) return `claude exited; its worktree was kept (${r.kept})`;
    return r.ended ? 'claude exited' : 'claude did not exit';
  } catch (err) {
    return `claude was left open (${/** @type {Error} */ (err).message})`;
  }
}

/** @type {Record<string, string>} */
const STATE_TEXT = { waiting: 'finished, waiting for input', done: 'finished', failed: 'ended with an error', stopped: 'was stopped', idle: 'ended' };
/** @type {Record<string, string>} */
const FILE_STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', '?': 'untracked' };
const OUTPUT_KEPT = 4000;

// What the terminal left: claude's last answer and the files it wrote, the runner's git view of the folder it worked
// in, and the links in its output and answer. A PR the prompt already named is not counted as one it opened.
/**
 * What the runner's git view of a folder holds, as far as it is read here (tools/terminal.js).
 * @typedef {object} RawOutcome
 * @property {string} [output]
 * @property {string} [screen]
 * @property {string} [reply]
 * @property {string[]} [written]
 * @property {boolean} [repo]
 * @property {string} [error]
 * @property {string} [branch]
 * @property {string} [base]
 * @property {string} [commit]
 * @property {string} [short]
 * @property {string} [subject]
 * @property {unknown[]} [commits]
 * @property {{ status: string, path: string, from?: string }[]} [files]
 * @property {number} [more]
 * @property {number} [uncommitted]
 * @property {string} [upstream]
 * @property {number} [ahead]
 */
/**
 * @param {DataStore} store
 * @param {{ session: string, path: string, prompt: string, task: Task | null, json: boolean }} where
 */
async function devOutcome(store, { session, path, prompt, task, json }) {
  /** @type {RawOutcome} */
  let raw = { output: '', repo: false };
  try {
    raw = await sessionOutcome(runnerOf(store), { session, path });
  } catch (err) {
    raw.error = /** @type {Error} */ (err).message;
  }
  const text = plainOutput(raw.output ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  // The screen as it was drawn reads cleanly; an older runner sends only the raw output, read as plain text.
  const screen = raw.screen == null ? text : raw.screen.replace(/[ \t]+\n/g, '\n').trim();
  const answer = (raw.reply ?? '').trim();
  const known = new Set(findGithubLinks(prompt).map((l) => l.url.toLowerCase()));
  const links = [...new Map(findGithubLinks(`${text}\n${answer}`).map((l) => [l.url.toLowerCase(), l])).values()].filter((l) => !known.has(l.url.toLowerCase()));
  // A PR Dev already added to the task (its link watcher reads the terminal while Dev shows it) counts too.
  // A task removed since has no PRs: prsOf() reads only its prs.
  const saved = task ? prsOf(store.get('todos').items.find((t) => t.id === task.id) ?? /** @type {Task} */ ({})) : [];
  const fresh = links.filter((l) => l.kind === 'pr');
  const prs = [...saved.filter((/** @type {TaskLink} */ p) => !fresh.some((l) => l.url.toLowerCase() === p.url.toLowerCase())), ...fresh];
  /** @param {CronPr} pr */
  const pick = ({ repo, number, url }) => ({ repo, number, url });
  return {
    links,
    data: {
      repo: Boolean(raw.repo),
      branch: raw.branch ?? '',
      base: raw.base ?? '',
      commit: raw.commit ?? '',
      commitShort: raw.short ?? '',
      commitSubject: raw.subject ?? '',
      commits: raw.commits ?? [],
      files: (raw.files ?? []).map((f) => ({ ...f, change: FILE_STATUS[f.status] ?? f.status })),
      moreFiles: raw.more ?? 0,
      uncommitted: raw.uncommitted ?? 0,
      pushed: Boolean(raw.upstream) && !raw.ahead,
      // The PR opened last is the one the work ended on.
      pr: prs.length ? pick(/** @type {CronPr} */ (prs.at(-1))) : null,
      prs: prs.map(pick),
      issues: links.filter((l) => l.kind === 'issue').map(pick),
      answer,
      written: raw.written ?? [],
      output: screen.slice(-OUTPUT_KEPT),
      // The answer as claude wrote it, unwrapped by the terminal; the output when there is none.
      ...(json ? { json: lastJson(answer) ?? lastJson(screen) ?? null } : {}),
      ...(raw.error ? { error: raw.error } : {}),
    },
  };
}

// The outcome as text, for {{input}}: what a model or the next Dev prompt reads first.
/** @typedef {Awaited<ReturnType<typeof devOutcome>>['data']} DevOutcome */
/**
 * @param {DevOutcome} o
 * @param {{ terminal: number, where: string, state: string }} at
 */
function outcomeText(o, { terminal, where, state }) {
  const lines = [`Dev terminal ${terminal} ${STATE_TEXT[state] ?? 'ended'}, in ${where}.`];
  if (o.branch) lines.push(`Branch: ${o.branch}${o.base ? ` (from ${o.base}, ${o.commits.length} commit${o.commits.length === 1 ? '' : 's'})` : ''}${o.pushed ? ', pushed' : ''}`);
  if (o.commit) lines.push(`Last commit: ${o.commitShort} ${o.commitSubject}`);
  if (o.pr) lines.push(`Pull request: ${o.pr.url}`);
  for (const p of o.prs.slice(0, -1)) lines.push(`Also a pull request: ${p.url}`);
  for (const i of o.issues) lines.push(`Issue: ${i.url}`);
  if (o.files.length) {
    const shown = o.files.slice(0, 60);
    lines.push('', `Files changed (${o.files.length + o.moreFiles}):`);
    for (const f of shown) lines.push(`- ${f.change}: ${f.from ? `${f.from} → ` : ''}${f.path}`);
    const rest = o.files.length - shown.length + o.moreFiles;
    if (rest) lines.push(`- and ${rest} more`);
  } else if (o.repo) lines.push('', 'No file changed.');
  if (o.uncommitted) lines.push(`${o.uncommitted} change${o.uncommitted === 1 ? ' is' : 's are'} not committed.`);
  if (o.written.length) lines.push('', 'Files claude wrote:', ...o.written.map((f) => `- ${f}`));
  if ('json' in o) lines.push('', o.json == null ? 'No JSON found in its final output.' : `JSON output:\n${JSON.stringify(o.json, null, 2)}`);
  if (o.error) lines.push(`Could not read the outcome: ${o.error}`);
  // claude's answer reads better than its screen, which the terminal output is.
  if (o.answer) lines.push('', 'Its final answer:', o.answer);
  else if (o.output) lines.push('', 'End of the terminal output:', o.output.split('\n').slice(-40).join('\n'));
  return lines.join('\n');
}

// What a Dev step gives in a test that starts no terminal, so later steps can pick its keys already.
const OUTCOME_SHAPE = { terminal: 0, session: '', branch: '', base: '', commit: '', commitShort: '', commitSubject: '', commits: [], files: [], pr: null, prs: [], issues: [], answer: '', written: [], output: '' };

// Starts claude (or a command) in a new Dev terminal. With steps after it, the run waits for the terminal and passes
// on what it did; otherwise it moves on at once. The task made earlier in the run goes with it, as when it is handed
// over from Tasks: it moves to In progress, keeps the terminal and its worktree, and gets the issues and PRs claude prints.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {string} input
 * @param {Vars} vars
 * @param {RunCtx} ctx
 */
async function runDev(store, flow, step, input, vars, ctx) {
  const claude = step.mode !== 'command';
  const task = ctx.task ?? null;
  const projectId = withFlowProject(flow, step).projectId || task?.projectId || '';
  const project = projectId ? store.get('projects').projects.find((p) => p.id === projectId) : null;
  if (projectId && !project) throw new Error('The project of this step was removed. Choose another.');
  if (project && !project.localPath) throw new Error(`${project.name} has no local folder. Add one in Projects.`);
  const v = { ...vars, task: taskText(task, input) };
  const json = devJson(flow, step);
  const filled = claude ? fill(step.prompt || '{{input}}', v).trim() : '';
  const prompt = filled && json ? `${filled}\n\n${DEV_JSON_PROMPT}` : filled;
  // Values go into a command as one quoted word each, so text from a model cannot run as shell.
  const command = claude ? '' : fill(step.command, v, shellQuote).trim();
  if (claude ? !prompt : !command) throw new Error(claude ? 'Write the Dev prompt.' : 'Enter the command to run.');
  const devCommand = claude ? stepDevCommand(store, step) : '';
  const where = project ? `${project.name}’s folder` : 'the board’s folder';
  const waits = devWaits(flow, step);
  // A step tested "in a terminal", and a test of the whole flow, start it for real so its work can be watched.
  if (ctx.dry && !ctx.live) {
    const how = devCommand ? `start “${devCommand.trim()}” with this prompt` : claude ? 'hand this prompt to the project’s Dev command' : 'run this command';
    ctx.note = `Test run: would ${how} in a new Dev terminal, in ${where}${waits ? ', then wait for it and pass on its branch, commit, files and PR' : ''}.`;
    ctx.data = { ...(claude ? { devCommand: devCommand || null, prompt } : { command }), folder: where, ...(waits ? { ...OUTCOME_SHAPE, ...(json ? { json: {} } : {}) } : {}) };
    return claude ? prompt : command;
  }
  // Cast until js/dev-core.js is checked: it infers taskIds as never[] from its default.
  const { id, n, worktree } = await devStarter(/** @type {Parameters<typeof startRunnerSession>[0]} */ ({ store, claude, prompt, command, devCommand, projectId, taskIds: task ? [task.id] : [], title: task?.text || flow.name }));
  if (task) {
    store.update('todos', (d) => {
      const t = d.items.find((x) => x.id === task.id);
      if (!t) return;
      t.devSession = id;
      if (statusOf(t) !== 'done') t.status = 'doing';
      if (worktree && statusOf(t) !== 'done') t.worktrees = [...(t.worktrees ?? []), { ...worktree, session: id }];
    });
  }
  const cwd = project?.localPath || '';
  // claude --worktree works in .claude/worktrees/<name> of the project's repository.
  const workPath = worktree ? `${String(worktree.cwd).replace(/\/+$/, '')}/.claude/worktrees/${worktree.name}` : cwd;
  const on = `Dev terminal ${n}, in ${where}${task ? `, on the task “${task.text}”` : ''}`;
  // session and cwd let the editor show the terminal's output, which the runner keeps, and open it in Dev.
  ctx.data = { terminal: n, session: id, cwd, folder: where, worktree: worktree ? workPath : '', ...(claude ? { prompt } : { command }) };
  ctx.started?.({ session: id, cwd, terminal: n, ...(worktree ? { worktree: worktree.name } : {}), ...(task ? { taskId: task.id } : {}), work: workPath || cwd, where });
  if (!waits) {
    ctx.note = `${ctx.dry ? 'Test: started' : 'Started'} in ${on}.`;
    // Nothing waits for it, but claude is still ended once it is done, in the background.
    if (worktree) {
      // then() cannot infer the type of `false && a promise`; the cast only widens what the callback returns.
      waitForSession(store, id, step.waitMinutes ?? DEV_WAIT_MINUTES)
        .then(/** @type {(status: { state: string }) => Promise<string | false>} */ ((status) => status.state === 'waiting' && endClaude(store, id, worktree)))
        .catch(() => {});
    }
    return input;
  }
  const status = await waitForSession(store, id, step.waitMinutes ?? DEV_WAIT_MINUTES, ctx.beat);
  const done = await finishDev(store, { session: id, terminal: n, work: workPath || cwd, where, on, prompt: claude ? prompt : command, task, json, worktree, dry: Boolean(ctx.dry) }, status);
  ctx.data = { .../** @type {object} */ (ctx.data), ...done.data };
  ctx.note = done.note;
  return done.output;
}

// Once the terminal ended or claude waits: what it did, for the next steps, and claude ended.
/**
 * @param {DataStore} store
 * @param {{ session: string, terminal: number, work: string, where: string, on: string, prompt: string, task: Task | null, json: boolean, worktree: { name: string } | null, dry: boolean }} d
 * @param {{ state: string, code?: number | null }} status
 */
async function finishDev(store, d, status) {
  if (status.state === 'failed') throw new Error(`${d.on} ended with exit ${status.code ?? 'an error'}.`);
  if (status.state === 'stopped') throw new Error(`${d.on} was stopped.`);
  const { links, data } = await devOutcome(store, { session: d.session, path: d.work, prompt: d.prompt, task: d.task, json: d.json });
  // The PR and issues go to the task even when Dev was not open to see them printed.
  // The session has ended or waits for its user by now, so a PR moves the task on to review.
  if (d.task && links.length) addTaskLinks(store, [d.task.id], links, { review: true });
  // Its work was read above, so claude can go, and its worktree with it.
  const ended = d.worktree && status.state === 'waiting' ? await endClaude(store, d.session, d.worktree) : '';
  const note = `${d.dry ? 'Test: ran' : 'Ran'} in ${d.on}; it ${STATE_TEXT[status.state] ?? 'ended'}${data.pr ? `, PR #${data.pr.number}` : ''}${ended ? `; ${ended}` : ''}.`;
  return { data, note, output: outcomeText(data, { terminal: d.terminal, where: d.where, state: status.state }) };
}

// Rebuilds the project's profile through the same call as Projects → Profile. A profile edited by hand never blocks
// the run: by default it is updated with the edits kept; the step can also replace it or leave it as it is.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {RunCtx} ctx
 */
async function runProfile(store, flow, step, ctx) {
  const projectId = withFlowProject(flow, step).projectId;
  if (!projectId) throw new Error('Choose the project whose profile to refresh.');
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  if (!project) throw new Error('The project of this step was removed. Choose another.');
  if (!hasProfileSources(project)) throw new Error(`${project.name} has no local folder, repository or website to read. Add one in Projects.`);
  const current = profileOf(project);
  const mode = current.edited ? profileEditedMode(step) : 'replace';
  if (mode === 'keep') {
    ctx.note = `Kept the profile of ${project.name}, edited by hand.`;
    ctx.data = { project: project.name, text: current.text, updated: current.updated, edited: true, kept: true };
    return current.text;
  }
  const how = mode === 'merge' ? 'update' : 'rebuild';
  if (ctx.dry && !ctx.live) {
    ctx.note = `Test run: would ${how} the profile of ${project.name}${mode === 'merge' ? ', keeping its hand edits' : ''}.`;
    ctx.data = { project: project.name, text: current.text, updated: current.updated, edited: current.edited };
    return current.text;
  }
  const profile = await buildProfile(store, project, { keepEdits: mode === 'merge' });
  ctx.data = { project: project.name, text: profile.text, updated: profile.updated, edited: profile.edited };
  ctx.note = `${ctx.dry ? 'Test: ' : ''}${mode === 'merge' ? 'Updated' : 'Rebuilt'} the profile of ${project.name}${mode === 'merge' ? ', keeping its hand edits' : ''}.`;
  return profile.text;
}

// ctx carries what passes between steps besides the text: whether the last data step found nothing, whether this is
// a test run, and a note a step leaves for the run log (what it would have done, or why the run stopped).
// A step may set ctx.data to what it made, for paths such as {{step3.title}}; by default its output is read as JSON.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {string} input
 * @param {RunCtx} ctx
 */
async function runStep(store, flow, step, input, ctx) {
  const vars = varsFor(flow, ctx, step, store);
  if (step.type === 'gather') {
    const sources = sourcesOf(step);
    if (!sources.length) throw new Error('Add a source to this step.');
    const parts = [];
    for (const own of sources) {
      const src = withFlowProject(flow, own);
      const text = await gather(store, src, flow, varsFor(flow, ctx, src, store));
      parts.push({ src, text, body: text || NOTHING[src.source] || '' });
    }
    ctx.nothing = parts.every((p) => !p.text.trim());
    const appending = step.append && input.trim();
    // Several sources, or data added to earlier data, go under headings so a prompt can tell them apart.
    if (parts.length > 1) ctx.data = Object.fromEntries(parts.map((p) => [sourceLabel(store, p.src), parseData(p.body) ?? p.body]));
    if (parts.length === 1 && !appending) return parts[0].body;
    const sections = parts.map((p) => `## ${sourceLabel(store, p.src)}\n\n${p.body}`).join('\n\n');
    return appending ? `${input}\n\n${sections}` : sections;
  }
  if (step.type === 'stop') {
    ctx.stop = stopsOn(step, input, ctx.nothing);
    ctx.note = ctx.stop ? `Stopped: ${stopLabel(step).replace(/^./, (c) => c.toLowerCase())}.` : 'Went on: the condition was not met.';
    return input;
  }
  if (step.type === 'ai') {
    const messages = [];
    if (step.system?.trim()) messages.push({ role: 'system', content: fill(step.system, vars) });
    messages.push({ role: 'user', content: fill(step.prompt, vars) });
    return (await ask(store, AI_TASK, messages, { model: step.model || '' })).trim();
  }
  if (step.type === 'task') {
    const title = fill(step.title || '{{input}}', vars).split('\n')[0].slice(0, 200).trim() || flow.name;
    const due = step.due === 'today' ? todayISO() : step.due === 'tomorrow' ? new Date(Date.now() + 24 * 60 * MINUTE).toISOString().slice(0, 10) : '';
    const projectId = withFlowProject(flow, step).projectId || null;
    const description = fill(step.description ?? '{{input}}', vars).trim();
    ctx.data = { title, description, projectId, priority: step.priority || 'none', due };
    // A test of the whole flow makes the task for real, so the Dev step after it can work on it.
    if (ctx.dry && !ctx.live) {
      ctx.note = `Test run: would create the task “${title}”${due ? ` due ${due}` : ''}.`;
      return input;
    }
    const task = makeTask({
      text: title,
      description,
      projectId,
      priority: step.priority || 'none',
      due,
      auto: 'cron',
      autoRef: flow.id,
    });
    // The run that made it, so the task can open it (Tasks shows a Cron button).
    if (ctx.runId) task.cronRun = ctx.runId;
    store.update('todos', (d) => d.items.push(task));
    /** @type {{ id?: string }} */ (ctx.data).id = task.id;
    if (ctx.dry) ctx.note = `Test run: created the task “${title}”${due ? ` due ${due}` : ''}.`;
    // A "Run in Dev" step later in the run works on this task.
    ctx.task = task;
    return input;
  }
  if (step.type === 'format') return formatStep(step, vars, ctx);
  if (step.type === 'parse') return parseStep(step, vars, ctx);
  if (step.type === 'loop') {
    const all = itemsOf(step.items, vars);
    const items = all.slice(0, loopMax(step));
    ctx.data = items;
    ctx.note = `${items.length} item${items.length === 1 ? '' : 's'}${all.length > items.length ? `: the first ${items.length} of ${all.length}` : ''}.`;
    return JSON.stringify(items, null, 2);
  }
  if (step.type === 'dev') return runDev(store, flow, step, input, vars, ctx);
  if (step.type === 'profile') return runProfile(store, flow, step, ctx);
  if (step.type === 'notify') {
    const text = fill(step.text, vars).slice(0, 1200);
    if (ctx.dry) {
      ctx.note = 'Test run: would send this notification.';
      return text;
    }
    notify(store, { kind: 'cron', text, href: `#/cron?flow=${flow.id}` });
    return input;
  }
  throw new Error(`Unknown step “${step.type}”.`);
}

/** @type {Set<string>} */
const running = new Set();
/** @param {string} id */
export const isRunning = (id) => running.has(id) || testing.has(id);

// Runs one step on what ctx holds from the steps before it, and adds its result to ctx.results.
/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {RunCtx} ctx
 * @returns {Promise<StepResult>}
 */
async function stepOnce(store, flow, step, ctx) {
  const started = Date.now();
  ctx.note = '';
  ctx.data = undefined;
  ctx.from = step.from ?? '';
  const input = pipedResult(ctx.results, ctx.from)?.output ?? '';
  const vars = varsFor(flow, ctx, step, store);
  try {
    const output = String(await runStep(store, flow, step, input, ctx) ?? '');
    const data = ctx.data !== undefined ? ctx.data : parseData(output) ?? output;
    const result = { ok: true, stepId: step.id, vars, output, data, note: ctx.note, ms: Date.now() - started, at: now(), nothing: ctx.nothing };
    ctx.results.push(result);
    return result;
  } catch (err) {
    return { ok: false, vars, output: /** @type {Error} */ (err).message, data: null, note: '', ms: Date.now() - started, at: now() };
  }
}

// --- Step by step tests ---
// As in n8n, a step can run on its own, as a test (no task, no notification, no terminal), on the results the steps
// before it left. The results are kept in cron.json, so they are there after a reload and in another browser on the
// same folder. Only what cannot be rebuilt is saved: a step's variables come from the results before it, and its
// data from its output when it was read from the output.
/** @type {Set<string>} */
const testing = new Set();
/** @param {string} flowId */
export const isTesting = (flowId) => testing.has(flowId);
/**
 * @param {unknown} a
 * @param {unknown} b
 */
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

/**
 * @param {CronTest & { vars?: Vars }} r
 * @returns {CronTest}
 */
function packTest(r) {
  const { vars, data, ...rest } = r;
  return r.ok && same(data, parseData(r.output) ?? r.output) ? rest : { ...rest, data };
}

/**
 * @param {DataStore} store
 * @param {string} flowId
 * @param {string} stepId
 * @param {CronTest & { vars?: Vars }} result
 */
function saveTest(store, flowId, stepId, result) {
  store.update(COLLECTION, (d) => {
    d.tests ??= {};
    d.tests[flowId] ??= {};
    d.tests[flowId][stepId] = packTest(result);
  });
}

// flowId's test results as stepId → result, each with the variables and data the editor shows.
/**
 * @param {DataStore} store
 * @param {string} flowId
 */
export function testsOf(store, flowId) {
  /** @type {Map<string, StepResult>} */
  const map = new Map();
  const { flows, tests } = store.get(COLLECTION);
  const saved = tests?.[flowId];
  const flow = flows.find((f) => f.id === flowId);
  if (!saved || !flow) return map;
  /** @type {StepResult[]} */
  const results = [];
  for (const [index, step] of flow.steps.entries()) {
    const r = saved[step.id];
    if (!r) continue;
    const result = { ...r, stepId: step.id, data: 'data' in r ? r.data : parseData(r.output) ?? r.output, vars: varsFor(flow, firstItem(flow, index, results), step, store) };
    map.set(step.id, result);
    if (result.ok) results.push(result);
  }
  return map;
}

// The results a step in a loop saw on the loop's first item, so its variables show {{item}} and what the steps
// before it in the loop gave for that item. A step outside a loop sees the results as they are.
/**
 * @param {CronFlow} flow
 * @param {number} index
 * @param {StepResult[]} results
 * @returns {Pick<RunCtx, 'results' | 'loop'>}
 */
function firstItem(flow, index, results) {
  const loop = flow.steps[loopOf(flow, index)];
  const at = loop ? results.findIndex((r) => r.stepId === loop.id) : -1;
  const items = at >= 0 ? results[at].data : null;
  if (!Array.isArray(items) || !items.length) return { results };
  /** @param {StepResult} r */
  const first = (r) => (Array.isArray(r.data) && r.data.length ? { ...r, output: asText(r.data[0]), data: r.data[0] } : r);
  return {
    results: results.map((r, i) => (i === at ? { ...r, output: asText(items[0]), data: items[0] } : i > at ? first(r) : r)),
    loop: { item: items[0], index: 0, count: items.length },
  };
}

// Drops flowId's test results: all of them, or only those of the steps in `stepIds`.
/**
 * @param {DataStore} store
 * @param {string} flowId
 * @param {string[]} [stepIds]
 */
export function clearTests(store, flowId, stepIds) {
  const saved = store.get(COLLECTION).tests?.[flowId];
  if (!saved || (stepIds && !stepIds.some((id) => id in saved))) return;
  store.update(COLLECTION, (d) => {
    if (!stepIds) delete d.tests?.[flowId];
    else for (const id of stepIds) delete d.tests?.[flowId]?.[id];
  });
}

// Tests one step: earlier steps with no result yet run first, then this one runs again. A "Stop if" that would stop
// does not keep the next step from being tested, since testing it is the point.
// With `live`, a Run in Dev step starts its terminal (the steps before it stay tests). While it waits for the
// terminal, its test shows the terminal already.
/**
 * @param {Store} store
 * @param {string} flowId
 * @param {string} stepId
 * @param {{ live?: boolean }} [options]
 */
export async function testStep(store, flowId, stepId, { live = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || running.has(flowId) || testing.has(flowId)) return null;
  const end = flow.steps.findIndex((s) => s.id === stepId);
  if (end < 0) return null;
  testing.add(flowId);
  store.refresh();
  const saved = testsOf(store, flowId);
  /** @type {RunCtx} */
  const ctx = { dry: true, nothing: false, stop: false, note: '', results: [] };
  let last = null;
  /**
   * @param {CronStep} step
   * @param {RunCtx} c
   */
  const prepare = (step, c) => {
    c.live = live && step.id === stepId;
    c.started = (info) => saveTest(store, flowId, step.id, {
      ok: true, pending: true, output: '', data: info, note: `Started in Dev terminal ${info.terminal}; waiting for it to finish.`, ms: 0, at: now(),
    });
  };
  try {
    for (let i = 0; i <= end; i++) {
      const step = flow.steps[i];
      // A loop and its steps run as one: their kept results are used only when all are there and none is tested.
      const span = loopSpan(flow, i);
      const group = flow.steps.slice(i, i + 1 + span);
      const kept = group.map((s) => saved.get(s.id));
      if (kept.every((k) => k?.ok) && !group.some((s) => s.id === stepId)) {
        ctx.results.push(.../** @type {StepResult[]} */ (kept));
        ctx.nothing = kept.at(-1)?.nothing;
        i += span;
        continue;
      }
      if (step.type === 'loop') {
        const results = await runLoop(store, flow, i, ctx, { until: stepId, prepare });
        results.forEach((r, k) => saveTest(store, flowId, flow.steps[i + k].id, r));
        last = /** @type {StepResult} */ (results.at(-1));
        if (!last.ok) break;
        i += span;
        continue;
      }
      prepare(step, ctx);
      last = await stepOnce(store, flow, step, ctx);
      saveTest(store, flowId, step.id, last);
      if (!last.ok) break;
    }
  } finally {
    testing.delete(flowId);
    store.refresh();
  }
  return last;
}

// A Dev step's test waits for its terminal in the tab that started it. Once that tab reloads, the test is left
// waiting; the Cron page picks it up again here, waits for the terminal and saves what it did. The prompt is not
// kept, so a link it named may count as one claude opened.
/** @type {Set<string>} */
const resuming = new Set();
/** @param {DataStore} store */
export function resumeDevTests(store) {
  const { flows, tests } = store.get(COLLECTION);
  for (const [flowId, saved] of Object.entries(tests ?? {})) {
    const flow = flows.find((f) => f.id === flowId);
    if (!flow || testing.has(flowId) || running.has(flowId)) continue;
    for (const [stepId, r] of Object.entries(saved)) {
      const info = r.pending && r.data && typeof r.data === 'object' ? /** @type {Partial<StartedInfo>} */ (r.data) : null;
      const step = flow.steps.find((s) => s.id === stepId);
      if (!info?.session || !step || resuming.has(info.session)) continue;
      const session = info.session;
      resuming.add(session);
      resumeTest(store, flow, step, /** @type {StartedInfo} */ (info), r.at)
        .finally(() => resuming.delete(session));
    }
  }
}

/**
 * @param {DataStore} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {StartedInfo} info
 * @param {string} at
 */
async function resumeTest(store, flow, step, info, at) {
  const startedAt = Date.parse(at) || Date.now();
  // Only while the test still waits on this terminal: not run again, nor cleared, meanwhile.
  const current = () => {
    const r = store.get(COLLECTION).tests?.[flow.id]?.[step.id];
    return Boolean(r?.pending) && /** @type {Partial<StartedInfo> | undefined} */ (r?.data)?.session === info.session;
  };
  /** @type {CronTest} */
  let result;
  try {
    const left = (step.waitMinutes ?? DEV_WAIT_MINUTES) - (Date.now() - startedAt) / MINUTE;
    const status = await waitForSession(store, info.session, left);
    if (!current()) return;
    const task = info.taskId ? store.get('todos').items.find((t) => t.id === info.taskId) ?? null : null;
    const where = info.where || 'its folder';
    const work = info.work || (info.worktree ? `${info.cwd.replace(/\/+$/, '')}/.claude/worktrees/${info.worktree}` : info.cwd);
    const on = `Dev terminal ${info.terminal}, in ${where}`;
    const done = await finishDev(store, {
      session: info.session, terminal: info.terminal, work, where, on, prompt: '', task, json: devJson(flow, step),
      worktree: info.worktree ? { name: info.worktree } : null, dry: true,
    }, status);
    result = { ok: true, output: done.output, data: { ...info, folder: where, ...done.data }, note: done.note, ms: Date.now() - startedAt, at: now() };
  } catch (err) {
    result = { ok: false, output: /** @type {Error} */ (err).message, data: null, note: '', ms: Date.now() - startedAt, at: now() };
  }
  if (current()) saveTest(store, flow.id, step.id, result);
}

// What a run keeps of a step besides its output, so the Runs tab can link to what it made: the task, the terminal,
// and a Dev step's branch, commit and PR.
/**
 * What a step's data holds, as far as it is kept: a task step's task, a Dev step's terminal and outcome.
 * @typedef {object} StepMade
 * @property {string} [id]
 * @property {string} [session]
 * @property {string} [cwd]
 * @property {number} [terminal]
 * @property {string} [worktree]
 * @property {string} [branch]
 * @property {string} [commit]
 * @property {string} [commitShort]
 * @property {CronPr | null} [pr]
 * @property {unknown[]} [files]
 * @property {number} [moreFiles]
 */
/**
 * @param {CronStep} step
 * @param {StepResult} result
 */
function stepRecord(step, result) {
  // A step in a loop made one per item: the last one is kept.
  const made = Array.isArray(result.data) && step.type !== 'loop' ? result.data.at(-1) : result.data;
  const d = result.ok && made && typeof made === 'object' ? /** @type {StepMade} */ (made) : null;
  /** @type {CronRunStep} */
  const out = { stepId: step.id, type: step.type, ok: result.ok, output: result.output.slice(0, 4000), note: result.note, ms: result.ms };
  if (step.type === 'task' && d?.id) out.taskId = d.id;
  if (step.type === 'dev' && d?.session) {
    Object.assign(out, { session: d.session, cwd: d.cwd, terminal: d.terminal });
    // By name: Dev lists worktrees by their real path, which a project folder saved with ~ does not match.
    if (d.worktree) out.worktree = d.worktree.split('/').pop();
    if (d.branch) out.branch = d.branch;
    if (d.commit) out.commit = d.commitShort || d.commit.slice(0, 7);
    if (d.pr) out.pr = d.pr;
    if (d.files) out.files = d.files.length + (d.moreFiles ?? 0);
  }
  return out;
}

// Runs the steps in order and keeps each step's output, so the editor can show what passed between them.
// The run is saved as it goes, so the Runs tab shows it while it runs, with the terminal it is waiting on.
// A test run (dry) leaves the schedule alone, sends no notification and is not read back as the flow's history; it
// does make its tasks and start its terminals, so the whole flow is tried as it will run. AI steps call the model.
/**
 * @param {DataStore} store
 * @param {string} flowId
 * @param {{ manual?: boolean, dry?: boolean }} [options]
 */
export async function runFlow(store, flowId, { manual = false, dry = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || isRunning(flowId)) return null;
  running.add(flowId);
  /** @type {CronRun} */
  const run = { id: uid(), flowId, at: now(), manual: manual || dry, dry, status: 'running', steps: [], error: '', beat: now() };
  const save = () => store.update(COLLECTION, (d) => {
    const copy = structuredClone(run);
    const i = d.runs.findIndex((r) => r.id === run.id);
    if (i >= 0) d.runs[i] = copy;
    else {
      d.runs.unshift(copy);
      d.runs.length = Math.min(d.runs.length, MAX_RUNS);
    }
    // Marked at its start, so a slow model call is not started twice by the next tick.
    const f = d.flows.find((x) => x.id === flowId);
    if (f && !dry && i < 0) f.lastRun = run.at;
  });
  save();
  /** @type {RunCtx} */
  const ctx = {
    dry,
    live: dry,
    runId: run.id,
    nothing: false,
    stop: false,
    note: '',
    results: [],
    // A run waiting on a terminal says now and then that it is still alive, so one cut short by a reload shows as such.
    beat: () => {
      if (Date.now() - Date.parse(/** @type {string} */ (run.beat)) < MINUTE) return;
      run.beat = now();
      save();
    },
  };
  // A test run of the whole flow also fills the step tests, so its data can be looked at and picked from.
  if (dry) clearTests(store, flowId);
  /**
   * @param {CronStep} step
   * @param {RunCtx} c
   */
  const prepare = (step, c) => {
    c.started = (info) => {
      run.current = { stepId: step.id, ...info };
      run.beat = now();
      save();
      // A test run shows the terminal in the step's test data too, while it waits for it.
      if (dry) saveTest(store, flowId, step.id, { ok: true, pending: true, output: '', data: info, note: `Started in Dev terminal ${info.terminal}; waiting for it to finish.`, ms: 0, at: now() });
    };
  };
  try {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i];
      const span = loopSpan(flow, i);
      prepare(step, ctx);
      // A loop gives its own result and one for each step it repeats.
      const results = step.type === 'loop' ? await runLoop(store, flow, i, ctx, { prepare }) : [await stepOnce(store, flow, step, ctx)];
      delete run.current;
      for (const [k, result] of results.entries()) {
        if (dry) saveTest(store, flowId, flow.steps[i + k].id, result);
        run.steps.push(stepRecord(flow.steps[i + k], result));
      }
      run.beat = now();
      const result = /** @type {StepResult} */ (results.at(-1));
      if (!result.ok) throw new Error(result.output);
      save();
      i += span;
      if (ctx.stop) {
        run.status = 'stopped';
        run.error = ctx.note;
        break;
      }
    }
    if (run.status === 'running') run.status = 'ok';
  } catch (err) {
    run.status = 'error';
    run.error = /** @type {Error} */ (err).message;
    if (!dry) notify(store, { kind: 'cron', text: `Flow “${flow.name}” failed: ${/** @type {Error} */ (err).message}`, href: `#/cron?tab=runs&run=${run.id}` });
  } finally {
    running.delete(flowId);
    delete run.current;
    run.ended = now();
    save();
  }
  return run;
}

// The latest run that started a Dev terminal (`session`) or made a worktree (its `worktree` name), else the run that
// made a task (`runId`, the task's cronRun). Dev shows a button to it on the terminal and the worktree.
/**
 * @param {DataStore} store
 * @param {{ session?: string, worktree?: string, runId?: string }} find
 */
export function cronRunOf(store, { session = '', worktree = '', runId = '' }) {
  const runs = store.get(COLLECTION)?.runs ?? [];
  /** @param {CronRunStep | CronRunCurrent | undefined} x */
  const ran = (x) => x && ((session && x.session === session) || (worktree && x.worktree === worktree));
  return runs.find((r) => [...(r.steps ?? []), r.current].some(ran)) ?? (runId ? runs.find((r) => r.id === runId) : null) ?? null;
}
/** @param {{ id: string }} run */
export const cronRunHref = (run) => `#/cron?run=${encodeURIComponent(run.id)}`;

// How a Dev step starts its terminal. The runners start it on the command runner and add it to its list of open
// terminals; the board's Cron page (a step's test, or a test run) opens it in Dev at once (modules/dev.js).
let devStarter = startRunnerSession;
/** @param {typeof startRunnerSession} fn */
export const useDevStarter = (fn) => {
  devStarter = fn;
};

// A run marked running that nothing has touched for a while was cut short: the runners stopped, or the tab closed.
const STALE_MS = 3 * MINUTE;
/** @param {CronRun} r */
export const runState = (r) => (r.status === 'running' && !running.has(r.flowId) && Date.now() - Date.parse(r.beat || r.at) > STALE_MS ? 'lost' : r.status);

// Due flows are started by the runners only (tools/jobs/cron.js), so a due flow runs once, however many tabs are open.
