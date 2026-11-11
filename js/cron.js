// Cron flows: a schedule that starts a chain of steps (gather data → AI → task or notification).
// Each step gets the previous step's output as {{input}}. Flows run only while the board is open.
import { uid, now, todayISO, statusOf } from './ui.js';
import { ask } from './ai.js';
import { makeTask } from './capture.js';
import { notify } from './notifications.js';
import { calendarEvents, calendarAccounts, eventDate } from './gcal.js';
import { sitesOf, siteData } from './automations.js';
import { openPositions } from './modules/positions.js';

export const COLLECTION = 'cron';
export const DEFAULTS = { flows: [], runs: [] };
export const AI_TASK = 'task-cron';
const MAX_RUNS = 60;
const MINUTE = 60000;

// [type, label, icon, short description]
export const STEP_TYPES = [
  ['gather', 'Gather data', 'list', 'Reads tasks, a project or spending from the board.'],
  ['ai', 'AI generate', 'cpu', 'Sends a prompt to a model through OpenRouter.'],
  ['stop', 'Stop if', 'filter', 'Ends the run early, for example when there is nothing to report.'],
  ['task', 'Create task', 'check-square', 'Adds a task with the output as its description.'],
  ['notify', 'Notify', 'bell', 'Posts the output under the bell (and Telegram if enabled).'],
];

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
};

export const SOURCES = [
  ['open', 'Open tasks'],
  ['due', 'Tasks due within 7 days'],
  ['project', 'One project (description and tasks)'],
  ['spending', 'Spending this month'],
  ['calendar', 'Calendar events today'],
  ['inbox', 'Unread emails in the Inbox'],
  ['sites', 'Site check problems (last 24 hours)'],
  ['pools', 'Liquidity pool positions'],
  ['pools-out', 'Pool positions out of range'],
  ['text', 'Fixed text'],
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function makeStep(type) {
  const base = { id: uid(), type };
  if (type === 'gather') return { ...base, source: 'open', projectId: '', text: '' };
  if (type === 'ai') return { ...base, prompt: 'Summarize this in five bullet points:\n\n{{input}}', system: '', model: '' };
  if (type === 'task') return { ...base, title: '{{flow}} · {{date}}', projectId: '', priority: 'none', due: '' };
  if (type === 'stop') return { ...base, when: 'nothing', text: '' };
  return { ...base, text: '{{flow}}: {{input}}' };
}

export function makeFlow(fields = {}) {
  return {
    id: uid(),
    name: 'New flow',
    enabled: false,
    schedule: { every: 'daily', time: '08:00', weekday: 1, days: [1, 2, 3, 4, 5], day: 1, minutes: 60, from: '', to: '' },
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
];

export function flowFromTemplate(t) {
  return makeFlow({ name: t.name, schedule: { ...makeFlow().schedule, ...t.schedule },steps: t.steps.map((s) => ({ ...makeStep(s.type), ...s })) });
}

// --- Schedule ---

const atTime = (d, time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  const x = new Date(d);
  x.setHours(hh || 0, mm || 0, 0, 0);
  return x;
};

export const REPEATS = [
  ['interval', 'Every few minutes or hours'],
  ['daily', 'Every day'],
  ['days', 'On chosen days'],
  ['weekly', 'Every week'],
  ['monthly', 'Every month'],
];

export const SHORT_DAYS = WEEKDAYS.map((d) => d.slice(0, 3));
const validDay = (d) => Number.isInteger(d) && d >= 0 && d <= 6;

// The weekdays a slot may fall on, or null for every day. A bad value falls back, so the day search always ends.
export function daysOf(s) {
  if (s.every === 'weekly') return [validDay(Number(s.weekday)) ? Number(s.weekday) : 1];
  if (s.every !== 'days') return null;
  const days = (Array.isArray(s.days) ? s.days : []).map(Number).filter(validDay);
  return days.length ? days : [1, 2, 3, 4, 5];
}

// A month's slot. A day past the month's end (31 in April) falls on its last day.
const monthDay = (s) => Math.min(31, Math.max(1, Number(s.day) || 1));
function monthSlot(year, month, s) {
  const last = new Date(year, month + 1, 0).getDate();
  return atTime(new Date(year, month, Math.min(monthDay(s), last)), s.time);
}

// The latest slot at or before `at`. For an interval there is no fixed slot, so the next run follows the last one.
function lastSlot(s, at) {
  if (s.every === 'monthly') {
    const t = monthSlot(at.getFullYear(), at.getMonth(), s);
    return t > at ? monthSlot(at.getFullYear(), at.getMonth() - 1, s) : t;
  }
  const days = daysOf(s);
  const t = atTime(at, s.time);
  if (t > at) t.setDate(t.getDate() - 1);
  if (days) while (!days.includes(t.getDay())) t.setDate(t.getDate() - 1);
  return t;
}

// The first slot after `at`.
function nextSlot(s, at) {
  if (s.every === 'monthly') {
    const t = monthSlot(at.getFullYear(), at.getMonth(), s);
    return t > at ? t : monthSlot(at.getFullYear(), at.getMonth() + 1, s);
  }
  const days = daysOf(s);
  const t = atTime(at, s.time);
  if (t <= at) t.setDate(t.getDate() + 1);
  if (days) while (!days.includes(t.getDay())) t.setDate(t.getDate() + 1);
  return t;
}

// An interval flow's active hours. A From later than To wraps past midnight (22:00 to 06:00).
const minutesOf = (time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  return (hh || 0) * 60 + (mm || 0);
};
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
  return lastSlot(s, at).getTime() > since;
}

function daysLabel(days) {
  const key = [...days].sort().join('');
  if (key === '12345') return 'Weekdays';
  if (key === '06') return 'Weekends';
  if (key === '0123456') return 'Every day';
  // Monday first.
  return [...days].sort((a, b) => ((a + 6) % 7) - ((b + 6) % 7)).map((d) => SHORT_DAYS[d]).join(', ');
}

export function scheduleLabel(s) {
  if (s.every === 'interval') {
    const m = Math.max(5, Number(s.minutes) || 60);
    const every = m % 60 === 0 ? `Every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `Every ${m} minutes`;
    return hasWindow(s) ? `${every}, ${s.from}–${s.to}` : every;
  }
  if (s.every === 'weekly') return `${WEEKDAYS[daysOf(s)[0]]}s at ${s.time}`;
  if (s.every === 'days') return `${daysLabel(daysOf(s))} at ${s.time}`;
  if (s.every === 'monthly') return `Monthly on day ${monthDay(s)} at ${s.time}`;
  return `Daily at ${s.time}`;
}

// --- Steps ---

const fill = (template, vars) => String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));

function taskLines(store, list) {
  const projects = store.get('projects').projects;
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';
  return list.map((t) => `- ${t.text} [${nameOf(t.projectId)}${t.priority && t.priority !== 'none' ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''}]`).join('\n');
}

// The source's data as plain text, or '' when it found nothing.
async function gather(store, step) {
  const open = store.get('todos').items.filter((t) => statusOf(t) !== 'done');
  if (step.source === 'open') return taskLines(store, open);
  if (step.source === 'due') {
    const limit = new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    return taskLines(store, open.filter((t) => t.due && t.due <= limit));
  }
  if (step.source === 'project') {
    const p = store.get('projects').projects.find((x) => x.id === step.projectId);
    if (!p) throw new Error('Choose a project for this step.');
    return `Project: ${p.name}\n${p.description || ''}\n\nOpen tasks:\n${taskLines(store, open.filter((t) => t.projectId === p.id)) || 'none'}`;
  }
  if (step.source === 'spending') {
    const month = todayISO().slice(0, 7);
    const totals = {};
    for (const e of store.get('money').entries) {
      if (e.type !== 'expense' || !e.date?.startsWith(month)) continue;
      const key = `${e.category} (${e.currency || 'USD'})`;
      totals[key] = (totals[key] ?? 0) + Number(e.amount || 0);
    }
    const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
    return rows.map(([k, v]) => `- ${k}: ${v.toFixed(2)}`).join('\n');
  }
  if (step.source === 'calendar') return gatherCalendar(store);
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
  return step.text || '';
}

// Today's events of every shown calendar. Calendar sign-ins last one session, so a flow fails until they are renewed.
async function gatherCalendar(store) {
  if (!calendarAccounts(store).length) throw new Error('Connect a Google Calendar in Settings first.');
  const from = new Date();
  from.setHours(0, 0, 0, 0);
  const to = new Date(from);
  to.setDate(to.getDate() + 1);
  const { events, errors, waiting } = await calendarEvents(store, from, to);
  if (!events.length && (waiting.length || errors.length)) {
    throw new Error(waiting.length ? `Sign in again to ${waiting.join(', ')} in Calendar.` : errors.join(' · '));
  }
  const clock = (v) => eventDate(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return events.map((e) => `- ${e.allDay ? 'All day' : `${clock(e.start)}–${clock(e.end)}`}: ${e.title}${e.location ? ` (${e.location})` : ''}`).join('\n');
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

// ctx carries what passes between steps besides the text: whether the last data step found nothing, whether this is
// a test run, and a note a step leaves for the run log (what it would have done, or why the run stopped).
async function runStep(store, flow, step, input, ctx) {
  const vars = { input, date: todayISO(), flow: flow.name };
  if (step.type === 'gather') {
    const text = await gather(store, step);
    ctx.nothing = !text.trim();
    return text || NOTHING[step.source] || '';
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
    if (ctx.dry) {
      ctx.note = `Test run: would create the task “${title}”${due ? ` due ${due}` : ''}.`;
      return input;
    }
    store.update('todos', (d) => d.items.push(makeTask({
      text: title,
      description: input,
      projectId: step.projectId || null,
      priority: step.priority || 'none',
      due,
      auto: 'cron',
      autoRef: flow.id,
    })));
    return input;
  }
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
export const isRunning = (id) => running.has(id);

// Runs the steps in order and keeps each step's output, so the editor can show what passed between them.
// A test run (dry) creates no task and sends no notification, and leaves the schedule alone. AI steps still call the model.
export async function runFlow(store, flowId, { manual = false, dry = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || running.has(flowId)) return null;
  running.add(flowId);
  const run = { id: uid(), flowId, at: now(), manual: manual || dry, dry, status: 'ok', steps: [], error: '' };
  // Mark the run at its start, so a slow model call is not started twice by the next tick.
  if (!dry) {
    store.update(COLLECTION, (d) => {
      const f = d.flows.find((x) => x.id === flowId);
      if (f) f.lastRun = run.at;
    });
  }
  let input = '';
  const ctx = { dry, nothing: false, stop: false, note: '' };
  try {
    for (const step of flow.steps) {
      const started = Date.now();
      ctx.note = '';
      try {
        input = String(await runStep(store, flow, step, input, ctx) ?? '');
        run.steps.push({ stepId: step.id, ok: true, output: input.slice(0, 4000), note: ctx.note, ms: Date.now() - started });
      } catch (err) {
        run.steps.push({ stepId: step.id, ok: false, output: err.message, ms: Date.now() - started });
        throw err;
      }
      if (ctx.stop) {
        run.status = 'stopped';
        run.error = ctx.note;
        break;
      }
    }
  } catch (err) {
    run.status = 'error';
    run.error = err.message;
    if (!dry) notify(store, { kind: 'cron', text: `Flow “${flow.name}” failed: ${err.message}`, href: `#/cron?flow=${flow.id}` });
  } finally {
    running.delete(flowId);
    store.update(COLLECTION, (d) => {
      d.runs.unshift(run);
      d.runs.length = Math.min(d.runs.length, MAX_RUNS);
    });
  }
  return run;
}

export async function runDueFlows(store) {
  const at = new Date();
  for (const f of store.get(COLLECTION).flows) {
    if (isDue(f, at)) await runFlow(store, f.id);
  }
}
