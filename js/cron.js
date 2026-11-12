// Cron flows: a schedule that starts a chain of steps (gather data → AI → task or notification).
// Each step gets the previous step's output as {{input}}. Flows run only while the board is open.
import { uid, now, todayISO, statusOf } from './ui.js';
import { ask } from './ai.js';
import { makeTask } from './capture.js';
import { notify } from './notifications.js';
import { calendarEvents, calendarAccounts, eventDate } from './gcal.js';
import { sitesOf, siteData } from './automations.js';
import { readPageText } from './sitecheck.js';
import { openPositions } from './modules/positions.js';
import { startDevSession, devPresets, devCommandOf, runnerOf } from './modules/dev.js';
import { sessionStatus, sessionOutcome } from './terminal.js';
import { findGithubLinks, plainOutput, addTaskLinks, prsOf } from './task-links.js';
import { buildProfile, profileOf, hasProfileSources } from './profile.js';

export const COLLECTION = 'cron';
// templates: flows saved as templates. tests: each flow's step test results, by flow id then step id.
export const DEFAULTS = { flows: [], runs: [], templates: [], tests: {} };
export const AI_TASK = 'task-cron';
const MAX_RUNS = 60;
const MINUTE = 60000;

// [type, label, icon, short description]
export const STEP_TYPES = [
  ['gather', 'Gather data', 'list', 'Reads tasks, projects, money, calendar, web pages and more; several sources at once.'],
  ['ai', 'AI generate', 'cpu', 'Sends a prompt to a model through OpenRouter.'],
  ['stop', 'Stop if', 'filter', 'Ends the run early, for example when there is nothing to report.'],
  ['task', 'Create task', 'check-square', 'Adds a task with the output as its description.'],
  ['notify', 'Notify', 'bell', 'Posts the output under the bell (and Telegram if enabled).'],
  ['profile', 'Refresh project profile', 'refresh', 'Rebuilds a project’s profile from its folder, repos and website, as Projects does.'],
  ['dev', 'Run in Dev', 'terminal', 'Hands a prompt to the project’s Dev command, a preset or your own, in a new Dev terminal.'],
];

// What a "Run in Dev" step starts: the project's Dev command ('claude'), a preset from Settings → Dev environment
// ('preset', step.preset), a Dev command typed on the step ('custom', step.devCommand), each with the Dev prompt,
// or a plain shell command with no prompt ('command').
export function devRunOptions(store) {
  return [
    ['claude', 'Project’s Dev command'],
    ...devPresets(store).map((p) => [`preset:${p.id}`, `Preset: ${p.name}`]),
    ['custom', 'Custom Dev command'],
    ['command', 'Shell command (no prompt)'],
  ];
}
export const devRunValue = (step) => (step.mode === 'preset' ? `preset:${step.preset}` : step.mode || 'claude');

// The Dev command a step starts with its prompt, or '' for the project's own.
function stepDevCommand(store, step) {
  if (step.mode === 'custom') {
    if (!String(step.devCommand ?? '').trim()) throw new Error('Enter the Dev command to run.');
    return step.devCommand;
  }
  if (step.mode !== 'preset') return '';
  const preset = devPresets(store).find((p) => p.id === step.preset);
  if (!preset?.command?.trim()) throw new Error('The preset of this step was removed. Choose another in Settings → Dev environment.');
  return preset.command;
}

// The command a Dev step runs before its prompt, to show it in the editor.
export function devCommandPreview(store, flow, step) {
  if (step.mode === 'command') return '';
  try {
    return stepDevCommand(store, step) || devCommandOf(store, store.get('projects').projects.find((p) => p.id === withFlowProject(flow, step).projectId));
  } catch (err) {
    return err.message;
  }
}

export const STOP_WHEN = [
  ['nothing', 'The data step found nothing'],
  ['empty', 'The input is empty'],
  ['contains', 'The input contains'],
  ['lacks', 'The input does not contain'],
];

// What a source gives when it finds nothing. Later steps still get it, and "Stop if" can end the run on it.
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

export const makeSource = (source = 'open', fields = {}) => ({ id: uid(), source, label: '', projectId: '', url: '', text: '', count: 5, follow: 3, flowId: '', ...fields });

// A data step's sources. Steps saved before a step could hold several kept one source in the step itself.
export function sourcesOf(step) {
  if (Array.isArray(step.sources)) return step.sources;
  return [makeSource(step.source || 'open', { id: step.id, projectId: step.projectId ?? '', url: step.url ?? '', text: step.text ?? '', count: step.count ?? 5 })];
}

// The flow's project: data, task and Dev steps use it unless they choose another. A flow saved before flows had a
// project takes the one project its steps share, if they share one.
export function flowProjectId(flow) {
  if (typeof flow?.projectId === 'string') return flow.projectId;
  const ids = new Set();
  for (const s of flow?.steps ?? []) {
    if (s.type === 'gather') sourcesOf(s).forEach((x) => x.projectId && ids.add(x.projectId));
    else if (s.projectId) ids.add(s.projectId);
  }
  return ids.size === 1 ? [...ids][0] : '';
}

// A step or source with its project filled in from the flow when it has none of its own.
export const withFlowProject = (flow, item) => ({ ...item, projectId: item.projectId || flowProjectId(flow) });

// The heading a source's data gets when it sits next to other data: its own label, else what it reads.
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

const cutPage = (text, max) => (text.length > max ? `${text.slice(0, max)}\n\n[The rest of the page was cut.]` : text);
// Images the reader still leaves in, as ![alt](src) or a link around one, only take room.
const dropImages = (text) => text.replace(/\[!\[[^\]]*\]\([^)]*\)\]\([^)]*\)/g, '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\n{3,}/g, '\n\n');

// The pages of the same site a page links to, best first: a page under this one (a post under /blog) before one
// elsewhere, a link with a title or a summary before a one-word menu entry, and an article before a section.
// Files, sign-in and legal pages are left out.
export function pageLinks(markdown, pageUrl) {
  let base;
  try { base = new URL(pageUrl); } catch { return []; }
  const own = base.pathname.replace(/\/+$/, '');
  const skip = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|xml|json|css|js|mp4|mp3)$|\/(login|log-in|signin|sign-in|signup|sign-up|register|account|cart|checkout|privacy|terms|cookies?|legal)(\/|$)|\/(cdn-cgi|wp-admin|wp-json)\//i;
  const host = (u) => u.hostname.replace(/^www\./, '');
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
  const section = (l) => new URL(l.url).pathname.slice(own.length).split('/').filter(Boolean)[0] ?? '';
  const groups = new Map();
  for (const l of ranked) groups.set(section(l), [...(groups.get(section(l)) ?? []), l]);
  const spread = [];
  for (let i = 0; spread.length < ranked.length; i++) for (const g of groups.values()) if (g[i]) spread.push(g[i]);
  return spread;
}

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function makeStep(type) {
  const base = { id: uid(), type };
  if (type === 'gather') return { ...base, sources: [makeSource()], append: false };
  if (type === 'ai') return { ...base, prompt: 'Summarize this in five bullet points:\n\n{{input}}', system: '', model: '' };
  if (type === 'task') return { ...base, title: '{{flow}} · {{date}}', projectId: '', priority: 'none', due: '' };
  if (type === 'stop') return { ...base, when: 'nothing', text: '' };
  if (type === 'profile') return { ...base, projectId: '', keepEdited: true };
  if (type === 'dev') return { ...base, mode: 'claude', preset: '', devCommand: '', projectId: '', prompt: '{{input}}', command: '', waitMinutes: DEV_WAIT_MINUTES };
  return { ...base, text: '{{flow}}: {{input}}' };
}

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
    about: 'Rebuilds a project’s profile every week from its folder, commits, repos and website, so AI features read it up to date. A profile you edited by hand is kept. Choose the flow’s project first.',
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
function templateStep(s) {
  if (s.type !== 'gather') return { ...makeStep(s.type), ...s };
  if (s.sources) return { ...makeStep(s.type), ...s, sources: s.sources.map((x) => ({ ...makeSource(x.source), ...x, id: uid() })) };
  const { type, source, append, ...fields } = s;
  return { ...makeStep(type), sources: [makeSource(source, fields)], append: Boolean(append) };
}

export function flowFromTemplate(t) {
  return makeFlow({ name: t.name, schedule: { ...makeFlow().schedule, ...t.schedule }, projectId: t.projectId ?? '', steps: t.steps.map(templateStep) });
}

// A flow saved as a template: its schedule, project and steps. {{stepN}} still points at the right step, since the
// steps keep their order.
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
const validDay = (d) => Number.isInteger(d) && d >= 0 && d <= 6;
export const validTime = (t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(String(t ?? ''));
const uniqueSorted = (list) => [...new Set(list)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

// The weekdays a slot may fall on, or null for every day. A bad value falls back, so the day search always ends.
export function daysOf(s) {
  if (s.every === 'weekly') return [validDay(Number(s.weekday)) ? Number(s.weekday) : 1];
  if (s.every !== 'days') return null;
  const days = (Array.isArray(s.days) ? s.days : []).map(Number).filter(validDay);
  return days.length ? uniqueSorted(days) : [1, 2, 3, 4, 5];
}

// The times of day a slot falls at. Flows saved with a single `time` keep it.
export function timesOf(s) {
  const list = (Array.isArray(s.times) && s.times.length ? s.times : [s.time]).filter(validTime);
  return list.length ? uniqueSorted(list) : ['08:00'];
}

// The days of the month a monthly flow runs on. Flows saved with a single `day` keep it.
export function monthDaysOf(s) {
  const list = (Array.isArray(s.monthDays) && s.monthDays.length ? s.monthDays : [s.day])
    .map(Number).filter((d) => Number.isInteger(d) && d >= 1 && d <= 31);
  return list.length ? uniqueSorted(list) : [1];
}

// The months (0 to 11) a monthly flow runs in. Empty means all of them.
export function monthsOf(s) {
  const list = (Array.isArray(s.months) ? s.months : []).map(Number).filter((m) => Number.isInteger(m) && m >= 0 && m <= 11);
  return list.length ? uniqueSorted(list) : MONTHS.map((_, i) => i);
}

// --- Cron expressions: minute, hour, day of the month, month, day of the week ---

const CRON_FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of the month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] },
  { name: 'day of the week', min: 0, max: 7, names: ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] },
];
const CRON_MACROS = {
  '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *', '@monthly': '0 0 1 * *', '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@hourly': '0 * * * *',
};

function cronField(text, { name, min, max, names }) {
  const values = new Set();
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
export function parseCron(expr) {
  const text = String(expr ?? '').trim().toLowerCase();
  const parts = (CRON_MACROS[text] ?? text).split(/\s+/).filter(Boolean);
  if (parts.length !== 5) throw new Error('A cron expression has five fields: minute, hour, day of the month, month and day of the week.');
  const [minutes, hours, dom, months, dow] = parts.map((p, i) => cronField(p, CRON_FIELDS[i]));
  if (dow.has(7)) dow.add(0);
  // As in classic cron: when both day fields are restricted, a day matching either one runs.
  return { minutes, hours, dom, months, dow, either: !parts[2].startsWith('*') && !parts[4].startsWith('*') };
}

export function cronError(expr) {
  try {
    parseCron(expr);
    return '';
  } catch (err) {
    return err.message;
  }
}

// A cron expression for the schedule as it is, so switching to Custom starts from what the flow already does.
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

const minutesOf = (time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};

// A fixed schedule as the days it runs on and the minutes of the day it runs at, or null when it has none.
function planOf(s) {
  if (s.every === 'custom') {
    let c;
    try {
      c = parseCron(s.cron);
    } catch {
      return null;
    }
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
const withMinutes = (d, m) => {
  const x = new Date(d);
  x.setHours(Math.floor(m / 60), m % 60, 0, 0);
  return x;
};

// The latest slot at or before `at`, or null. An interval has no fixed slot, so its next run follows the last one.
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
export function upcomingSlots(s, count = 3, at = new Date()) {
  const out = [];
  let t = at;
  while (out.length < count && (t = nextSlot(s, t))) out.push(t);
  return out;
}

// An interval flow's active hours. A From later than To wraps past midnight (22:00 to 06:00).
const hasWindow = (s) => Boolean(s.from && s.to && s.from !== s.to);
function inWindow(s, at) {
  if (!hasWindow(s)) return true;
  const m = at.getHours() * 60 + at.getMinutes();
  const a = minutesOf(s.from);
  const b = minutesOf(s.to);
  return a < b ? m >= a && m < b : m >= a || m < b;
}
function intoWindow(s, t) {
  if (inWindow(s, t)) return t;
  const x = atTime(t, s.from);
  if (x < t) x.setDate(x.getDate() + 1);
  return x;
}

// The later of the last run and the moment the flow was switched on, so switching a flow on never replays a past slot.
const sinceOf = (f) => Math.max(Date.parse(f.lastRun) || 0, Date.parse(f.enabledAt || f.created) || 0);

const intervalMs = (s) => Math.max(5, Number(s.minutes) || 60) * MINUTE;

// The next run, or null when the schedule never matches (an invalid or impossible cron expression).
export function nextRun(flow, at = new Date()) {
  const s = flow.schedule;
  if (s.every === 'interval') {
    const since = sinceOf(flow) || at.getTime();
    return intoWindow(s, new Date(Math.max(at.getTime(), since + intervalMs(s))));
  }
  return nextSlot(s, at);
}

// Due when a slot has passed since the last run, or since the flow was switched on. A missed slot runs once, not once per slot.
export function isDue(flow, at = new Date()) {
  if (!flow.enabled || !flow.steps.length) return false;
  const since = sinceOf(flow);
  const s = flow.schedule;
  if (s.every === 'interval') return at.getTime() - since >= intervalMs(s) && inWindow(s, at);
  const last = lastSlot(s, at);
  return Boolean(last) && last.getTime() > since;
}

const listLabel = (items) => (items.length <= 1 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);

function daysLabel(days) {
  const key = days.join('');
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  if (key === '0123456') return 'Every day';
  if (days.length === 1) return `${WEEKDAYS[days[0]]}s`;
  // Monday first.
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => SHORT_DAYS[d]).join(', ');
}

export function scheduleLabel(s) {
  if (s.every === 'interval') {
    const m = Math.max(5, Number(s.minutes) || 60);
    const every = m % 60 === 0 ? `Every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `Every ${m} minutes`;
    return hasWindow(s) ? `${every}, ${s.from}–${s.to}` : every;
  }
  if (s.every === 'custom') return `Cron ${String(s.cron ?? '').trim() || '(empty)'}`;
  const at = `at ${listLabel(timesOf(s))}`;
  if (s.every === 'weekly' || s.every === 'days') return `${daysLabel(daysOf(s))} ${at}`;
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
export function parseData(text) {
  const t = String(text ?? '').trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/, '$1').trim();
  if (!/^[[{]/.test(t)) return null;
  try {
    return JSON.parse(t);
  } catch {
    return null;
  }
}

const asText = (v) => (v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v, null, 2));

function walk(value, path) {
  let v = value;
  for (const [, key, index, quoted] of path.matchAll(/\.([\w-]+)|\[(\d+)\]|\["([^"\]]*)"\]/g)) {
    if (v == null || typeof v !== 'object') return undefined;
    v = v[key ?? quoted ?? Number(index)];
  }
  return v;
}

// The value of one {{name.path}}, or undefined when there is none, so the placeholder stays as written.
function lookup(vars, name, path) {
  if (!(name in vars) || name === '$data') return undefined;
  if (!path) return asText(vars[name]);
  const v = walk(vars.$data?.[name], path);
  return v === undefined ? undefined : asText(v);
}

const fill = (template, vars, quote = (x) => x) =>
  String(template ?? '').replace(VAR, (m, name, path) => {
    const v = lookup(vars, name, path);
    return v === undefined ? m : quote(v);
  });

// A project as {{project}} reads it: its name as text, and with a path its parts ({{project.website}},
// {{project.repo}}, {{project.directory}}). Empty fields stay as '' so a template reads the same for every project.
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
  };
}

// The variables a step sees: its input, the run's date and flow, the project, and every earlier step's output by
// number. $data holds what each name reads into with a path: parsed JSON, or what the step made.
// The project is the step's or source's own when it has one, else the flow's. A data step's sources each choose theirs.
function varsFor(flow, ctx, step = null, store = ctx.store) {
  const results = ctx.results ?? [];
  const prev = results.at(-1);
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
  return vars;
}

// The path to one key, in the form a variable reads it.
export const pathTo = (path, key) =>
  (typeof key === 'number' ? `${path}[${key}]` : /^[\w-]+$/.test(key) ? `${path}.${key}` : /^[^"\]]*$/.test(key) ? `${path}["${key}"]` : null);

// The variables as one JSON tree for the editor: a key's path is what a click on it puts in a field.
export function varsTree(vars) {
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
export function remapStepRefs(steps, map) {
  const fix = (text) => text.replace(/(\{\{\s*)step(\d+)(?=[.[\s}])/g, (m, open, n) => {
    const to = map(Number(n));
    return to == null ? `${open}removedStep` : `${open}step${to}`;
  });
  const visit = (o) => {
    for (const [k, v] of Object.entries(o)) {
      if (typeof v === 'string' && v.includes('{{')) o[k] = fix(v);
      else if (Array.isArray(v)) v.forEach((x) => x && typeof x === 'object' && visit(x));
    }
  };
  steps.forEach(visit);
}

function taskLines(store, list) {
  const projects = store.get('projects').projects;
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';
  return list.map((t) => `- ${t.text} [${nameOf(t.projectId)}${t.priority && t.priority !== 'none' ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''}]`).join('\n');
}

// The page a web page step reads: a project's website, a path on it (/blog), or any address.
// With a project, a full link (with or without https://) is read as it is, so a project can point at its docs or repo.
const looksLikeLink = (raw) => /^https?:\/\//i.test(raw) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/|$)/.test(raw);
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

function moneyTotals(store, type, month) {
  const totals = {};
  for (const e of store.get('money').entries) {
    if (e.type !== type || !e.date?.startsWith(month)) continue;
    const key = `${e.category || 'Other'} (${e.currency || 'USD'})`;
    totals[key] = (totals[key] ?? 0) + Number(e.amount || 0);
  }
  return Object.entries(totals).sort((a, b) => b[1] - a[1]).map(([k, v]) => `- ${k}: ${v.toFixed(2)}`).join('\n');
}

// One source's data as plain text, or '' when it found nothing. A page address and fixed text take variables, so
// a source can read {{project.repoUrl}} or quote {{project.description}}.
async function gather(store, step, flow, vars = {}) {
  if (step.source === 'page') {
    const url = pageUrl(store, { ...step, url: fill(step.url, vars) });
    const { title, text: raw } = await readPageText(url);
    const text = dropImages(raw);
    const main = text ? `Page: ${title || url} (${url})\n\n${cutPage(text, PAGE_CHARS)}` : '';
    const follow = Math.min(MAX_FOLLOW, Math.max(0, Number(step.follow) || 0));
    if (!follow || !text) return main;
    // A page that fails to read is skipped, so one dead link does not fail the step.
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
    const lines = sitesOf(store).flatMap((p) => {
      const s = siteData(store, p.id);
      const log = (s.log ?? []).filter((e) => e.level !== 'info' && Date.parse(e.at) >= since);
      const down = s.health?.status === 'down' ? [`- ${p.name}: down as of the last check`] : [];
      return [...down, ...log.map((e) => `- ${p.name} (${e.level === 'error' ? 'error' : 'warning'}): ${e.text}`)];
    });
    return lines.join('\n');
  }
  if (step.source === 'pools' || step.source === 'pools-out') {
    const usd = (n) => (n == null ? 'unknown' : `$${n.toFixed(2)}`);
    const rows = openPositions(store).filter((r) => step.source === 'pools' || !r.inRange);
    return rows.map((r) => `- ${r.pair} on ${r.chain} #${r.tokenId}: ${r.inRange ? 'in range' : 'out of range'}, value ${usd(r.value)}, unclaimed fees ${usd(r.fees)}`).join('\n');
  }
  return fill(step.text, vars);
}

function projectsOverview(store, open) {
  return store.get('projects').projects.map((p) => {
    const count = open.filter((t) => t.projectId === p.id).length;
    const about = String(p.description ?? '').split('\n')[0].trim();
    return `- ${p.name}${p.website ? ` (${p.website})` : ''}: ${count} open task${count === 1 ? '' : 's'}${about ? `. ${about}` : ''}`;
  }).join('\n');
}

// The events of every shown calendar from today on, for `days` days. Calendar sign-ins last one session,
// so a flow fails until they are renewed.
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
  const clock = (v) => eventDate(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  // Over several days each event says its day.
  const day = (v) => (days > 1 ? `${eventDate(v).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' })} ` : '');
  return events.map((e) => `- ${day(e.start)}${e.allDay ? 'All day' : `${clock(e.start)}–${clock(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n');
}

// Whether a "Stop if" step ends the run, given its input and whether the last data step found nothing.
function stopsOn(step, input, nothing) {
  const text = String(step.text ?? '').trim().toLowerCase();
  if (step.when === 'empty') return !input.trim();
  if (step.when === 'contains') return Boolean(text) && input.toLowerCase().includes(text);
  if (step.when === 'lacks') return Boolean(text) && !input.toLowerCase().includes(text);
  return nothing;
}

export function stopLabel(step) {
  const label = STOP_WHEN.find(([k]) => k === step.when)?.[1] ?? STOP_WHEN[0][1];
  return step.when === 'contains' || step.when === 'lacks' ? `${label} “${step.text || '…'}”` : label;
}

// A shell word: single quotes keep newlines, quotes and $ as they are. A leading ~/ (a project's folder) stays
// outside them, so the shell still expands it.
const quoteWord = (text) => `'${String(text).replace(/'/g, `'\\''`)}'`;
const shellQuote = (text) => (/^~\//.test(text) ? `~/${quoteWord(text.slice(2))}` : quoteWord(text));

// The task a "Create task" step made in this run, as claude gets a task from its Dev button: a checklist line,
// then its description indented. In a test run no task is made, so it is the title the step would give it.
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether a Dev step waits for its terminal: as the step says, else when a step follows it.
export const devWaits = (flow, step) => step.wait ?? flow.steps.findIndex((s) => s.id === step.id) < flow.steps.length - 1;

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
      if (err.final || ++misses >= 6) throw err.final ? err : new Error(`Lost the terminal runner: ${err.message}`);
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

const STATE_TEXT = { waiting: 'finished, waiting for input', done: 'finished', failed: 'ended with an error', stopped: 'was stopped', idle: 'ended' };
const FILE_STATUS = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed', '?': 'untracked' };
const OUTPUT_KEPT = 4000;

// What the terminal left: the runner's git view of the folder it worked in, and the links in its output. A PR the
// prompt already named is not counted as one it opened.
async function devOutcome(store, { session, path, prompt, task }) {
  let raw = { output: '', repo: false };
  try {
    raw = await sessionOutcome(runnerOf(store), { session, path });
  } catch (err) {
    raw.error = err.message;
  }
  const text = plainOutput(raw.output ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  const known = new Set(findGithubLinks(prompt).map((l) => l.url.toLowerCase()));
  const links = findGithubLinks(text).filter((l) => !known.has(l.url.toLowerCase()));
  // A PR Dev already added to the task (its link watcher reads the terminal while Dev shows it) counts too.
  const saved = task ? prsOf(store.get('todos').items.find((t) => t.id === task.id) ?? {}) : [];
  const fresh = links.filter((l) => l.kind === 'pr');
  const prs = [...saved.filter((p) => !fresh.some((l) => l.url.toLowerCase() === p.url.toLowerCase())), ...fresh];
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
      pr: prs.length ? pick(prs.at(-1)) : null,
      prs: prs.map(pick),
      issues: links.filter((l) => l.kind === 'issue').map(pick),
      output: text.slice(-OUTPUT_KEPT),
      ...(raw.error ? { error: raw.error } : {}),
    },
  };
}

// The outcome as text, for {{input}}: what a model or the next Dev prompt reads first.
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
  if (o.error) lines.push(`Could not read the outcome: ${o.error}`);
  if (o.output) lines.push('', 'End of the terminal output:', o.output.split('\n').slice(-40).join('\n'));
  return lines.join('\n');
}

// What a Dev step gives in a test that starts no terminal, so later steps can pick its keys already.
const OUTCOME_SHAPE = { terminal: 0, session: '', branch: '', base: '', commit: '', commitShort: '', commitSubject: '', commits: [], files: [], pr: null, prs: [], issues: [], output: '' };

// Starts claude (or a command) in a new Dev terminal. With steps after it, the run waits for the terminal and passes
// on what it did; otherwise it moves on at once. The task made earlier in the run goes with it, as when it is handed
// over from Tasks: it moves to In progress, keeps the terminal and its worktree, and gets the issues and PRs claude prints.
async function runDev(store, flow, step, input, vars, ctx) {
  const claude = step.mode !== 'command';
  const task = ctx.task ?? null;
  const projectId = withFlowProject(flow, step).projectId || task?.projectId || '';
  const project = projectId ? store.get('projects').projects.find((p) => p.id === projectId) : null;
  if (projectId && !project) throw new Error('The project of this step was removed. Choose another.');
  if (project && !project.localPath) throw new Error(`${project.name} has no local folder. Add one in Projects.`);
  const v = { ...vars, task: taskText(task, input) };
  const prompt = claude ? fill(step.prompt || '{{input}}', v).trim() : '';
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
    ctx.data = { ...(claude ? { devCommand: devCommand || null, prompt } : { command }), folder: where, ...(waits ? OUTCOME_SHAPE : {}) };
    return claude ? prompt : command;
  }
  const { id, n, worktree } = await startDevSession({ store, claude, prompt, command, devCommand, projectId, taskIds: task ? [task.id] : [], title: task?.text || flow.name });
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
  ctx.started?.({ session: id, cwd, terminal: n, ...(task ? { taskId: task.id } : {}) });
  if (!waits) {
    ctx.note = `${ctx.dry ? 'Test: started' : 'Started'} in ${on}.`;
    return input;
  }
  const status = await waitForSession(store, id, step.waitMinutes ?? DEV_WAIT_MINUTES, ctx.beat);
  if (status.state === 'failed') throw new Error(`${on} ended with exit ${status.code ?? 'an error'}.`);
  if (status.state === 'stopped') throw new Error(`${on} was stopped.`);
  const { links, data } = await devOutcome(store, { session: id, path: workPath || cwd, prompt: claude ? prompt : command, task });
  // The PR and issues go to the task even when Dev was not open to see them printed.
  if (task && links.length) addTaskLinks(store, [task.id], links);
  ctx.data = { ...ctx.data, ...data };
  ctx.note = `${ctx.dry ? 'Test: ran' : 'Ran'} in ${on}; it ${STATE_TEXT[status.state] ?? 'ended'}${data.pr ? `, PR #${data.pr.number}` : ''}.`;
  return outcomeText(data, { terminal: n, where, state: status.state });
}

// Rebuilds the project's profile through the same call as Projects → Profile. A profile edited by hand is kept unless
// the step says otherwise; the run then stops quietly, so a notification after it does not claim a refresh.
async function runProfile(store, flow, step, ctx) {
  const projectId = withFlowProject(flow, step).projectId;
  if (!projectId) throw new Error('Choose the project whose profile to refresh.');
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  if (!project) throw new Error('The project of this step was removed. Choose another.');
  if (!hasProfileSources(project)) throw new Error(`${project.name} has no local folder, repository or website to read. Add one in Projects.`);
  const current = profileOf(project);
  if (step.keepEdited !== false && current.edited) {
    ctx.stop = true;
    ctx.note = `Stopped: the profile of ${project.name} was edited by hand, so it was kept.`;
    ctx.data = { project: project.name, text: current.text, updated: current.updated, edited: true };
    return current.text;
  }
  if (ctx.dry && !ctx.live) {
    ctx.note = `Test run: would rebuild the profile of ${project.name}.`;
    ctx.data = { project: project.name, text: current.text, updated: current.updated, edited: current.edited };
    return current.text;
  }
  const profile = await buildProfile(store, project);
  ctx.data = { project: project.name, text: profile.text, updated: profile.updated, edited: false };
  ctx.note = `${ctx.dry ? 'Test: rebuilt' : 'Rebuilt'} the profile of ${project.name}.`;
  return profile.text;
}

// ctx carries what passes between steps besides the text: whether the last data step found nothing, whether this is
// a test run, and a note a step leaves for the run log (what it would have done, or why the run stopped).
// A step may set ctx.data to what it made, for paths such as {{step3.title}}; by default its output is read as JSON.
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
    ctx.data = { title, description: input, projectId, priority: step.priority || 'none', due };
    // A test of the whole flow makes the task for real, so the Dev step after it can work on it.
    if (ctx.dry && !ctx.live) {
      ctx.note = `Test run: would create the task “${title}”${due ? ` due ${due}` : ''}.`;
      return input;
    }
    const task = makeTask({
      text: title,
      description: input,
      projectId,
      priority: step.priority || 'none',
      due,
      auto: 'cron',
      autoRef: flow.id,
    });
    // The run that made it, so the task can open it (Tasks shows a Cron button).
    if (ctx.runId) task.cronRun = ctx.runId;
    store.update('todos', (d) => d.items.push(task));
    ctx.data.id = task.id;
    if (ctx.dry) ctx.note = `Test run: created the task “${title}”${due ? ` due ${due}` : ''}.`;
    // A "Run in Dev" step later in the run works on this task.
    ctx.task = task;
    return input;
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

const running = new Set();
export const isRunning = (id) => running.has(id) || testing.has(id);

// Runs one step on what ctx holds from the steps before it, and adds its result to ctx.results.
async function stepOnce(store, flow, step, ctx) {
  const started = Date.now();
  ctx.note = '';
  ctx.data = undefined;
  const input = ctx.results.at(-1)?.output ?? '';
  const vars = varsFor(flow, ctx, step, store);
  try {
    const output = String(await runStep(store, flow, step, input, ctx) ?? '');
    const data = ctx.data !== undefined ? ctx.data : parseData(output) ?? output;
    const result = { ok: true, vars, output, data, note: ctx.note, ms: Date.now() - started, at: now(), nothing: ctx.nothing };
    ctx.results.push(result);
    return result;
  } catch (err) {
    return { ok: false, vars, output: err.message, data: null, note: '', ms: Date.now() - started, at: now() };
  }
}

// --- Step by step tests ---
// As in n8n, a step can run on its own, as a test (no task, no notification, no terminal), on the results the steps
// before it left. The results are kept in cron.json, so they are there after a reload and in another browser on the
// same folder. Only what cannot be rebuilt is saved: a step's variables come from the results before it, and its
// data from its output when it was read from the output.
const testing = new Set();
export const isTesting = (flowId) => testing.has(flowId);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

function packTest(r) {
  const { vars, data, ...rest } = r;
  return r.ok && same(data, parseData(r.output) ?? r.output) ? rest : { ...rest, data };
}

function saveTest(store, flowId, stepId, result) {
  store.update(COLLECTION, (d) => {
    d.tests ??= {};
    d.tests[flowId] ??= {};
    d.tests[flowId][stepId] = packTest(result);
  });
}

// flowId's test results as stepId → result, each with the variables and data the editor shows.
export function testsOf(store, flowId) {
  const map = new Map();
  const { flows, tests } = store.get(COLLECTION);
  const saved = tests?.[flowId];
  const flow = flows.find((f) => f.id === flowId);
  if (!saved || !flow) return map;
  const results = [];
  for (const step of flow.steps) {
    const r = saved[step.id];
    if (!r) continue;
    const result = { ...r, data: 'data' in r ? r.data : parseData(r.output) ?? r.output, vars: varsFor(flow, { results }, step, store) };
    map.set(step.id, result);
    if (result.ok) results.push(result);
  }
  return map;
}

export function clearTests(store, flowId) {
  if (!store.get(COLLECTION).tests?.[flowId]) return;
  store.update(COLLECTION, (d) => {
    delete d.tests?.[flowId];
  });
}

// Tests one step: earlier steps with no result yet run first, then this one runs again. A "Stop if" that would stop
// does not keep the next step from being tested, since testing it is the point.
// With `live`, a Run in Dev step starts its terminal (the steps before it stay tests). While it waits for the
// terminal, its test shows the terminal already.
export async function testStep(store, flowId, stepId, { live = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || running.has(flowId) || testing.has(flowId)) return null;
  const end = flow.steps.findIndex((s) => s.id === stepId);
  if (end < 0) return null;
  testing.add(flowId);
  store.refresh();
  const saved = testsOf(store, flowId);
  const ctx = { dry: true, nothing: false, stop: false, note: '', results: [] };
  let last = null;
  try {
    for (const step of flow.steps.slice(0, end + 1)) {
      const kept = saved.get(step.id);
      if (kept?.ok && step.id !== stepId) {
        ctx.results.push(kept);
        ctx.nothing = kept.nothing;
        continue;
      }
      ctx.live = live && step.id === stepId;
      ctx.started = (info) => saveTest(store, flowId, step.id, {
        ok: true, pending: true, output: '', data: info, note: `Started in Dev terminal ${info.terminal}; waiting for it to finish.`, ms: 0, at: now(),
      });
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

// What a run keeps of a step besides its output, so the Runs tab can link to what it made: the task, the terminal,
// and a Dev step's branch, commit and PR.
function stepRecord(step, result) {
  const d = result.ok && result.data && typeof result.data === 'object' ? result.data : null;
  const out = { stepId: step.id, type: step.type, ok: result.ok, output: result.output.slice(0, 4000), note: result.note, ms: result.ms };
  if (step.type === 'task' && d?.id) out.taskId = d.id;
  if (step.type === 'dev' && d?.session) {
    Object.assign(out, { session: d.session, cwd: d.cwd, terminal: d.terminal });
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
export async function runFlow(store, flowId, { manual = false, dry = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || isRunning(flowId)) return null;
  running.add(flowId);
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
      if (Date.now() - Date.parse(run.beat) < MINUTE) return;
      run.beat = now();
      save();
    },
  };
  // A test run of the whole flow also fills the step tests, so its data can be looked at and picked from.
  if (dry) clearTests(store, flowId);
  try {
    for (const step of flow.steps) {
      ctx.started = (info) => {
        run.current = { stepId: step.id, ...info };
        run.beat = now();
        save();
      };
      const result = await stepOnce(store, flow, step, ctx);
      if (dry) saveTest(store, flowId, step.id, result);
      delete run.current;
      run.steps.push(stepRecord(step, result));
      run.beat = now();
      if (!result.ok) throw new Error(result.output);
      save();
      if (ctx.stop) {
        run.status = 'stopped';
        run.error = ctx.note;
        break;
      }
    }
    if (run.status === 'running') run.status = 'ok';
  } catch (err) {
    run.status = 'error';
    run.error = err.message;
    if (!dry) notify(store, { kind: 'cron', text: `Flow “${flow.name}” failed: ${err.message}`, href: `#/cron?tab=runs&run=${run.id}` });
  } finally {
    running.delete(flowId);
    delete run.current;
    run.ended = now();
    save();
  }
  return run;
}

// A run marked running that no page has touched for a while was cut short: the board was closed or reloaded.
const STALE_MS = 3 * MINUTE;
export const runState = (r) => (r.status === 'running' && !running.has(r.flowId) && Date.now() - Date.parse(r.beat || r.at) > STALE_MS ? 'lost' : r.status);

export async function runDueFlows(store) {
  const at = new Date();
  for (const f of store.get(COLLECTION).flows) {
    if (isDue(f, at)) await runFlow(store, f.id);
  }
}
