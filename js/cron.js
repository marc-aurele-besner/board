// Cron flows: a schedule that starts a chain of steps (gather data → AI → task or notification).
// Each step gets the previous step's output as {{input}}. Flows run only while the board is open.
import { uid, now, todayISO, statusOf } from './ui.js';
import { ask } from './ai.js';
import { makeTask } from './capture.js';
import { notify } from './notifications.js';

export const COLLECTION = 'cron';
export const DEFAULTS = { flows: [], runs: [] };
export const AI_TASK = 'task-cron';
const MAX_RUNS = 60;
const MINUTE = 60000;

// [type, label, icon, short description]
export const STEP_TYPES = [
  ['gather', 'Gather data', 'list', 'Reads tasks, a project or spending from the board.'],
  ['ai', 'AI generate', 'cpu', 'Sends a prompt to a model through OpenRouter.'],
  ['task', 'Create task', 'check-square', 'Adds a task with the output as its description.'],
  ['notify', 'Notify', 'bell', 'Posts the output under the bell (and Telegram if enabled).'],
];

export const SOURCES = [
  ['open', 'Open tasks'],
  ['due', 'Tasks due within 7 days'],
  ['project', 'One project (description and tasks)'],
  ['spending', 'Spending this month'],
  ['text', 'Fixed text'],
];

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function makeStep(type) {
  const base = { id: uid(), type };
  if (type === 'gather') return { ...base, source: 'open', projectId: '', text: '' };
  if (type === 'ai') return { ...base, prompt: 'Summarize this in five bullet points:\n\n{{input}}', system: '', model: '' };
  if (type === 'task') return { ...base, title: '{{flow}} · {{date}}', projectId: '', priority: 'none', due: '' };
  return { ...base, text: '{{flow}}: {{input}}' };
}

export function makeFlow(fields = {}) {
  return {
    id: uid(),
    name: 'New flow',
    enabled: false,
    schedule: { every: 'daily', time: '08:00', weekday: 1, minutes: 60 },
    steps: [],
    lastRun: '',
    created: now(),
    ...fields,
  };
}

// Starting points for the "New flow" menu.
export const TEMPLATES = [
  {
    name: 'Morning plan',
    schedule: { every: 'daily', time: '08:00', weekday: 1, minutes: 60 },
    steps: [
      { type: 'gather', source: 'open' },
      { type: 'ai', prompt: 'Here are my open tasks:\n\n{{input}}\n\nPick the five that matter most today and give one line on why for each.' },
      { type: 'notify', text: 'Plan for {{date}}:\n{{input}}' },
    ],
  },
  {
    name: 'Weekly spending review',
    schedule: { every: 'weekly', time: '09:00', weekday: 1, minutes: 60 },
    steps: [
      { type: 'gather', source: 'spending' },
      { type: 'ai', prompt: 'These are my expenses this month:\n\n{{input}}\n\nExplain where the money went and flag anything unusual. Keep it under 150 words.' },
      { type: 'task', title: 'Read the spending review ({{date}})', priority: 'low' },
    ],
  },
  {
    name: 'Daily writing prompt',
    schedule: { every: 'daily', time: '07:30', weekday: 1, minutes: 60 },
    steps: [
      { type: 'ai', prompt: 'Write one short, specific writing prompt for today ({{date}}). Reply with the prompt only.' },
      { type: 'task', title: 'Write: {{input}}', priority: 'none', due: 'today' },
    ],
  },
];

export function flowFromTemplate(t) {
  return makeFlow({ name: t.name, schedule: { ...t.schedule }, steps: t.steps.map((s) => ({ ...makeStep(s.type), ...s })) });
}

// --- Schedule ---

const atTime = (d, time) => {
  const [hh, mm] = String(time || '00:00').split(':').map(Number);
  const x = new Date(d);
  x.setHours(hh || 0, mm || 0, 0, 0);
  return x;
};

// The latest slot at or before `at`. For an interval there is no fixed slot, so the next run follows the last one.
function lastSlot(s, at) {
  if (s.every === 'daily') {
    const t = atTime(at, s.time);
    if (t > at) t.setDate(t.getDate() - 1);
    return t;
  }
  if (s.every === 'weekly') {
    const t = atTime(at, s.time);
    t.setDate(t.getDate() - ((t.getDay() - Number(s.weekday) + 7) % 7));
    if (t > at) t.setDate(t.getDate() - 7);
    return t;
  }
  return null;
}

// The later of the last run and the moment the flow was switched on, so switching a flow on never replays a past slot.
const sinceOf = (f) => Math.max(Date.parse(f.lastRun) || 0, Date.parse(f.enabledAt || f.created) || 0);

const intervalMs = (s) => Math.max(5, Number(s.minutes) || 60) * MINUTE;

export function nextRun(flow, at = new Date()) {
  const s = flow.schedule;
  if (s.every === 'interval') {
    const since = sinceOf(flow) || at.getTime();
    return new Date(Math.max(at.getTime(), since + intervalMs(s)));
  }
  const t = lastSlot(s, at);
  t.setDate(t.getDate() + (s.every === 'weekly' ? 7 : 1));
  return t;
}

// Due when a slot has passed since the last run, or since the flow was switched on. A missed slot runs once, not once per slot.
export function isDue(flow, at = new Date()) {
  if (!flow.enabled || !flow.steps.length) return false;
  const since = sinceOf(flow);
  const s = flow.schedule;
  if (s.every === 'interval') return at.getTime() - since >= intervalMs(s);
  return lastSlot(s, at).getTime() > since;
}

export function scheduleLabel(s) {
  if (s.every === 'interval') {
    const m = Math.max(5, Number(s.minutes) || 60);
    return m % 60 === 0 ? `Every ${m / 60 === 1 ? 'hour' : `${m / 60} hours`}` : `Every ${m} minutes`;
  }
  if (s.every === 'weekly') return `${WEEKDAYS[Number(s.weekday)] ?? 'Monday'}s at ${s.time}`;
  return `Daily at ${s.time}`;
}

// --- Steps ---

const fill = (template, vars) => String(template ?? '').replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));

function taskLines(store, list) {
  const projects = store.get('projects').projects;
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? 'Personal';
  return list.map((t) => `- ${t.text} [${nameOf(t.projectId)}${t.priority && t.priority !== 'none' ? `, ${t.priority}` : ''}${t.due ? `, due ${t.due}` : ''}]`).join('\n');
}

function gather(store, step) {
  const open = store.get('todos').items.filter((t) => statusOf(t) !== 'done');
  if (step.source === 'open') return taskLines(store, open) || 'No open tasks.';
  if (step.source === 'due') {
    const limit = new Date(Date.now() + 7 * 24 * 60 * MINUTE).toISOString().slice(0, 10);
    return taskLines(store, open.filter((t) => t.due && t.due <= limit)) || 'Nothing is due within 7 days.';
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
    return rows.length ? rows.map(([k, v]) => `- ${k}: ${v.toFixed(2)}`).join('\n') : 'No expenses this month yet.';
  }
  return step.text || '';
}

async function runStep(store, flow, step, input) {
  const vars = { input, date: todayISO(), flow: flow.name };
  if (step.type === 'gather') return gather(store, step);
  if (step.type === 'ai') {
    const messages = [];
    if (step.system?.trim()) messages.push({ role: 'system', content: fill(step.system, vars) });
    messages.push({ role: 'user', content: fill(step.prompt, vars) });
    return (await ask(store, AI_TASK, messages, { model: step.model || '' })).trim();
  }
  if (step.type === 'task') {
    const title = fill(step.title || '{{input}}', vars).split('\n')[0].slice(0, 200).trim() || flow.name;
    const due = step.due === 'today' ? todayISO() : step.due === 'tomorrow' ? new Date(Date.now() + 24 * 60 * MINUTE).toISOString().slice(0, 10) : '';
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
    notify(store, { kind: 'cron', text: fill(step.text, vars).slice(0, 1200), href: `#/cron?flow=${flow.id}` });
    return input;
  }
  throw new Error(`Unknown step “${step.type}”.`);
}

const running = new Set();
export const isRunning = (id) => running.has(id);

// Runs the steps in order and keeps each step's output, so the editor can show what passed between them.
export async function runFlow(store, flowId, { manual = false } = {}) {
  const flow = store.get(COLLECTION).flows.find((f) => f.id === flowId);
  if (!flow || running.has(flowId)) return null;
  running.add(flowId);
  const run = { id: uid(), flowId, at: now(), manual, status: 'ok', steps: [], error: '' };
  // Mark the run at its start, so a slow model call is not started twice by the next tick.
  store.update(COLLECTION, (d) => {
    const f = d.flows.find((x) => x.id === flowId);
    if (f) f.lastRun = run.at;
  });
  let input = '';
  try {
    for (const step of flow.steps) {
      const started = Date.now();
      try {
        input = String(await runStep(store, flow, step, input) ?? '');
        run.steps.push({ stepId: step.id, ok: true, output: input.slice(0, 4000), ms: Date.now() - started });
      } catch (err) {
        run.steps.push({ stepId: step.id, ok: false, output: err.message, ms: Date.now() - started });
        throw err;
      }
    }
  } catch (err) {
    run.status = 'error';
    run.error = err.message;
    notify(store, { kind: 'cron', text: `Flow “${flow.name}” failed: ${err.message}`, href: `#/cron?flow=${flow.id}` });
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
