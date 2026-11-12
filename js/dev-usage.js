// What the claude sessions Dev ran for tasks actually used: models, provider, effort, tokens, cost and time, read by
// the command runner from Claude Code's transcripts (tools/usage.js). Each session's worktree gets a record in
// usage.json (`dev`, by worktree name) that names its tasks, so the record outlives the task's worktree entry,
// which goes once the worktree is removed. Records are read again while their tasks are open, and for a day after.
import { worktreeUsage, TERMINAL_RUNNER } from './terminal.js';
import { statusOf } from './ui.js';

const COLLECTION = 'usage';
const DAY = 86400000;
// Records read in one call to the runner, the most recent first.
const BATCH = 40;
const FIELDS = ['sessions', 'models', 'cost', 'duration', 'apiDuration', 'linesAdded', 'linesRemoved', 'efforts', 'replies', 'start', 'end'];

const runnerOf = (store) => store.get('dev')?.runner || TERMINAL_RUNNER;
export const devUsage = (store) => store.get(COLLECTION).dev ?? {};
const hasUsage = (r) => !!r?.sessions;

// Keeps a record for each worktree a task holds, so it is read again after the worktree and its entry are gone.
export function rememberWorktrees(store, list) {
  const known = devUsage(store);
  const missing = list.filter(({ worktree, taskIds }) => {
    const r = known[worktree.name];
    return !r || taskIds.some((id) => !r.taskIds?.includes(id)) || (worktree.session && r.session !== worktree.session);
  });
  if (!missing.length) return;
  store.update(COLLECTION, (d) => {
    d.dev ??= {};
    for (const { worktree, taskIds } of missing) {
      const r = (d.dev[worktree.name] ??= { name: worktree.name, cwd: worktree.cwd, added: new Date().toISOString(), taskIds: [] });
      r.taskIds = [...new Set([...r.taskIds, ...taskIds])];
      if (worktree.session) r.session = worktree.session;
    }
  });
}

// Each worktree the tasks hold, with the tasks.
function heldWorktrees(store) {
  const all = new Map();
  for (const task of store.get('todos').items) {
    for (const w of task.worktrees ?? []) {
      if (!all.has(w.name)) all.set(w.name, { worktree: w, taskIds: [] });
      all.get(w.name).taskIds.push(task.id);
    }
  }
  return [...all.values()];
}

// A record still changes while a task of it is open, and shortly after its last activity (claude writes its final
// totals as it quits, which can follow the task being completed).
function live(store, r) {
  const tasks = store.get('todos').items.filter((t) => r.taskIds?.includes(t.id));
  if (tasks.some((t) => statusOf(t) !== 'done')) return true;
  const last = Math.max(r.end ?? 0, Date.parse(r.added ?? '') || 0);
  return Date.now() - last < DAY;
}

let busy = false;
// Reads the usage of the live records from the runner and saves what changed. Quiet when the runner is down.
export async function refreshDevUsage(store) {
  if (busy) return;
  rememberWorktrees(store, heldWorktrees(store));
  const records = Object.values(devUsage(store)).filter((r) => r.cwd && live(store, r));
  if (!records.length) return;
  records.sort((a, b) => (b.end ?? 0) - (a.end ?? 0));
  busy = true;
  try {
    const found = await worktreeUsage(runnerOf(store), records.slice(0, BATCH).map(({ name, cwd }) => ({ name, cwd })));
    const changed = Object.entries(found).filter(([name, u]) => FIELDS.some((k) => JSON.stringify(u[k]) !== JSON.stringify(devUsage(store)[name]?.[k])));
    if (!changed.length) return;
    store.update(COLLECTION, (d) => {
      for (const [name, u] of changed) {
        if (!d.dev?.[name]) continue;
        for (const k of FIELDS) d.dev[name][k] = u[k];
      }
    });
  } catch {
    // The runner is not running: the next round asks again.
  } finally {
    busy = false;
  }
}

// --- Reading the records ---

export const tokensOf = (m) => m.input + m.output + m.cacheRead + m.cacheWrite;

// Records added up: { records, sessions, cost (null when no session reported one yet), costPartial, tokens, models
// (by id, with provider), providers, effort (the one used most), duration (ms of work), linesAdded, linesRemoved,
// start, end }.
export function sumUsage(records) {
  const out = { records: 0, sessions: 0, cost: null, costPartial: false, tokens: 0, models: {}, providers: [], efforts: {}, effort: '', duration: 0, linesAdded: 0, linesRemoved: 0, start: null, end: null };
  for (const r of records) {
    if (!hasUsage(r)) continue;
    out.records++;
    out.sessions += r.sessions;
    if (r.cost === null || r.cost === undefined) out.costPartial = true;
    else out.cost = (out.cost ?? 0) + r.cost;
    for (const [id, m] of Object.entries(r.models ?? {})) {
      const t = (out.models[id] ??= { provider: m.provider, input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, cost: null });
      for (const k of ['input', 'output', 'thinking', 'cacheRead', 'cacheWrite']) t[k] += m[k] ?? 0;
      if (m.cost !== null && m.cost !== undefined) t.cost = (t.cost ?? 0) + m.cost;
      out.tokens += tokensOf(m);
    }
    for (const [e, n] of Object.entries(r.efforts ?? {})) out.efforts[e] = (out.efforts[e] ?? 0) + n;
    // Before claude wrote its totals, the time between the first and last reply stands in for the time worked.
    out.duration += r.duration || (r.end && r.start ? r.end - r.start : 0);
    out.linesAdded += r.linesAdded ?? 0;
    out.linesRemoved += r.linesRemoved ?? 0;
    if (r.start) out.start = out.start === null ? r.start : Math.min(out.start, r.start);
    if (r.end) out.end = out.end === null ? r.end : Math.max(out.end, r.end);
  }
  out.providers = [...new Set(Object.values(out.models).map((m) => m.provider))];
  out.effort = Object.entries(out.efforts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return out;
}

export const recordsOfTask = (store, taskId) => Object.values(devUsage(store)).filter((r) => r.taskIds?.includes(taskId) && hasUsage(r));
export const recordOfSession = (store, sessionId) => Object.values(devUsage(store)).find((r) => r.session === sessionId && hasUsage(r)) ?? null;
export const usageRecords = (store) => Object.values(devUsage(store)).filter(hasUsage);

// The models by name, the one with the most output first: "claude-opus-5-5" reads "Opus 5.5".
export function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
export const modelsByUse = (sum) => Object.entries(sum.models).sort((a, b) => b[1].output - a[1].output).map(([id]) => id);

export const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtCost = (n) => (n === null ? '' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// One line for a task or a terminal: "Opus 5.5 · medium · 2.1M tokens · $4.56 · 9 min".
export function usageLine(sum) {
  const models = modelsByUse(sum).map(modelName);
  return [
    models.slice(0, 2).join(' + ') + (models.length > 2 ? ` +${models.length - 2}` : ''),
    sum.effort ? `${sum.effort} effort` : '',
    `${fmtTokens(sum.tokens)} tokens`,
    sum.cost !== null ? `${sum.costPartial ? '≥ ' : ''}${fmtCost(sum.cost)}` : '',
    sum.duration ? fmtDuration(sum.duration) : '',
  ].filter(Boolean).join(' · ');
}

// The details behind the line, for a tooltip.
export function usageTitle(sum) {
  const lines = modelsByUse(sum).map((id) => {
    const m = sum.models[id];
    return `${modelName(id)} (${m.provider}): ${fmtTokens(m.input + m.cacheRead + m.cacheWrite)} in (${fmtTokens(m.cacheRead)} cached), ${fmtTokens(m.output)} out${m.cost !== null ? `, ${fmtCost(m.cost)}` : ''}`;
  });
  if (sum.costPartial) lines.push('Cost is known once claude quits; tokens are counted as it works.');
  if (sum.linesAdded || sum.linesRemoved) lines.push(`Lines: +${sum.linesAdded} −${sum.linesRemoved}`);
  if (sum.sessions > 1) lines.push(`${sum.sessions} sessions`);
  return lines.join('\n');
}
