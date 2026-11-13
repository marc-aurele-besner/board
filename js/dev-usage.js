// What the claude sessions Dev ran for tasks actually used: models, provider, effort, tokens, cost and time, read by
// the command runner from Claude Code's transcripts (tools/usage.js). Each session's worktree gets a record in
// usage.json (`dev`, by worktree name) that names its tasks, so the record outlives the task's worktree entry,
// which goes once the worktree is removed. Records are read again while their tasks are open, and for a day after.
/** @import { DataStore, DevUsage, DevModelUsage, TaskWorktree } from '../types/data' */
/** @import { WorktreeUsage } from '../types/terminal' */
import { worktreeUsage, TERMINAL_RUNNER } from './terminal.js';
import { statusOf } from './ui.js';

const COLLECTION = 'usage';
const DAY = 86400000;
// Records read in one call to the runner, the most recent first; the runner reads up to 200 (tools/usage.js), and
// caches each transcript until it changes.
const BATCH = 200;
/** @type {(keyof WorktreeUsage)[]} */
const FIELDS = ['sessions', 'billing', 'models', 'cost', 'extraCost', 'duration', 'apiDuration', 'linesAdded', 'linesRemoved', 'efforts', 'replies', 'start', 'end', 'skills', 'mcp', 'turns'];

const runnerOf = (/** @type {DataStore} */ store) => store.get('dev')?.runner || TERMINAL_RUNNER;
export const devUsage = (/** @type {DataStore} */ store) => store.get(COLLECTION).dev ?? {};
/** @type {(r: DevUsage | undefined) => r is DevUsage & { sessions: number }} */
const hasUsage = (r) => !!r?.sessions;

// Keeps a record for each worktree a task holds, so it is read again after the worktree and its entry are gone.
/** @param {DataStore} store @param {{ worktree: TaskWorktree, taskIds: string[] }[]} list */
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
/** @param {DataStore} store */
function heldWorktrees(store) {
  /** @type {Map<string, { worktree: TaskWorktree, taskIds: string[] }>} */
  const all = new Map();
  for (const task of store.get('todos').items) {
    for (const w of task.worktrees ?? []) {
      if (!all.has(w.name)) all.set(w.name, { worktree: w, taskIds: [] });
      /** @type {{ taskIds: string[] }} */ (all.get(w.name)).taskIds.push(task.id);
    }
  }
  return [...all.values()];
}

// A record still changes while a task of it is open, and shortly after its last activity (claude writes its final
// totals as it quits, which can follow the task being completed).
/** @param {DataStore} store @param {DevUsage} r */
function live(store, r) {
  const tasks = store.get('todos').items.filter((t) => r.taskIds?.includes(t.id));
  if (tasks.some((t) => statusOf(t) !== 'done')) return true;
  const last = Math.max(r.end ?? 0, Date.parse(r.added ?? '') || 0);
  return Date.now() - last < DAY;
}

let busy = false;
// Reads the usage of the live records and saves what changed. `read` takes [{ name, cwd }] and answers by name; the
// runners read the transcripts themselves (tools/usage.js), without asking the command runner.
/**
 * @param {DataStore} store
 * @param {(list: { name: string, cwd: string }[]) => Promise<Record<string, WorktreeUsage>>} [read]
 */
export async function refreshDevUsage(store, read = (list) => worktreeUsage(runnerOf(store), list)) {
  if (busy) return;
  rememberWorktrees(store, heldWorktrees(store));
  // Records saved before the cost was split into included and extra, before skills and MCP calls were counted,
  // before turns were kept, or before the turns kept their tools, are read once more.
  const stale = (/** @type {DevUsage} */ r) => r.billing === undefined || (!!r.sessions && (!r.skills || r.turns === undefined || r.turns.some((t) => t.tools === undefined)));
  const records = Object.values(devUsage(store)).filter((r) => r.cwd && (live(store, r) || stale(r)));
  if (!records.length) return;
  // A record not read yet has no `end`: its `added` stands in, so a new session is read first rather than never.
  const recent = (/** @type {DevUsage} */ r) => Math.max(r.end ?? 0, Date.parse(r.added ?? '') || 0);
  records.sort((a, b) => recent(b) - recent(a));
  busy = true;
  try {
    const asked = records.slice(0, BATCH);
    const found = await read(asked.map(({ name, cwd }) => ({ name, cwd })));
    const changed = Object.entries(found).filter(([name, u]) => FIELDS.some((k) => JSON.stringify(u[k]) !== JSON.stringify(devUsage(store)[name]?.[k])));
    // Transcripts Claude has since deleted can't be read again: marked, so they are not asked for again.
    const gone = asked.filter((r) => stale(r) && !found[r.name] && !live(store, r)).map((r) => r.name);
    if (!changed.length && !gone.length) return;
    store.update(COLLECTION, (d) => {
      for (const [name, u] of changed) {
        if (!d.dev?.[name]) continue;
        for (const k of FIELDS) /** @type {Partial<Record<keyof WorktreeUsage, unknown>>} */ (d.dev[name])[k] = u[k];
      }
      for (const name of gone) {
        const r = d.dev?.[name];
        if (!r) continue;
        if (r.billing === undefined) r.billing = null;
        if (r.sessions && !r.skills) Object.assign(r, { skills: {}, mcp: {} });
        if (r.sessions && r.turns === undefined) r.turns = [];
        for (const t of r.turns ?? []) if (t.tools === undefined) t.tools = null;
      }
    });
  } finally {
    busy = false;
  }
}

// --- Reading the records ---

export const tokensOf = (/** @type {DevModelUsage} */ m) => m.input + m.output + m.cacheRead + m.cacheWrite;

// Records added up: { records, sessions, cost (null when no session reported one yet), costPartial, extraCost (the
// part billed beyond the Claude plan: extra usage, an API key, Bedrock or Vertex), included (cost - extraCost),
// billing ('plan', 'api', or '' when unknown or mixed), tokens, models
// (by id, with provider), providers, effort (the one used most), duration (ms of work), linesAdded, linesRemoved,
// start, end }.
/**
 * @typedef {{ records: number, sessions: number, cost: number | null, costPartial: boolean, extraCost: number | null,
 *   included: number | null, billing: string, tokens: number, models: Record<string, DevModelUsage>, providers: string[],
 *   efforts: Record<string, number>, effort: string, duration: number, linesAdded: number, linesRemoved: number,
 *   start: number | null, end: number | null }} UsageSum
 */
/** @param {DevUsage[]} records @returns {UsageSum} */
export function sumUsage(records) {
  /** @type {UsageSum} */
  const out = { records: 0, sessions: 0, cost: null, costPartial: false, extraCost: null, included: null, billing: '', tokens: 0, models: {}, providers: [], efforts: {}, effort: '', duration: 0, linesAdded: 0, linesRemoved: 0, start: null, end: null };
  const billings = new Set();
  for (const r of records) {
    if (!hasUsage(r)) continue;
    out.records++;
    out.sessions += r.sessions;
    billings.add(r.billing ?? '');
    if (r.cost === null || r.cost === undefined) out.costPartial = true;
    else {
      out.cost = (out.cost ?? 0) + r.cost;
      // A record saved before the split counts as included.
      out.extraCost = (out.extraCost ?? 0) + (r.extraCost ?? 0);
    }
    for (const [id, m] of Object.entries(r.models ?? {})) {
      const t = (out.models[id] ??= { provider: m.provider, input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, cost: null, extraCost: null });
      for (const k of /** @type {const} */ (['input', 'output', 'thinking', 'cacheRead', 'cacheWrite'])) t[k] += m[k] ?? 0;
      if (m.cost !== null && m.cost !== undefined) {
        t.cost = (t.cost ?? 0) + m.cost;
        t.extraCost = (t.extraCost ?? 0) + (m.extraCost ?? 0);
      }
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
  // extraCost is set with cost, so it is a number here.
  if (out.cost !== null) out.included = Math.max(0, out.cost - /** @type {number} */ (out.extraCost));
  out.billing = billings.size === 1 ? [...billings][0] : '';
  out.providers = [...new Set(Object.values(out.models).map((m) => m.provider))];
  out.effort = Object.entries(out.efforts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
  return out;
}

export const recordsOfTask = (/** @type {DataStore} */ store, /** @type {string} */ taskId) => Object.values(devUsage(store)).filter((r) => r.taskIds?.includes(taskId) && hasUsage(r));
export const recordOfSession = (/** @type {DataStore} */ store, /** @type {string} */ sessionId) => Object.values(devUsage(store)).find((r) => r.session === sessionId && hasUsage(r)) ?? null;
export const usageRecords = (/** @type {DataStore} */ store) => Object.values(devUsage(store)).filter(hasUsage);

// An MCP tool's server and tool from its name, `mcp__<server>__<tool>`; claude.ai's connectors drop their prefix.
/** @param {string} name */
export function mcpTool(name) {
  const rest = name.replace(/^mcp__/, '');
  const at = rest.indexOf('__');
  const server = at < 0 ? rest : rest.slice(0, at);
  return { server: server.replace(/^claude_ai_/, '').replace(/_/g, ' '), tool: at < 0 ? '' : rest.slice(at + 2) };
}
// Counts by name, the most used first.
export const byUse = (/** @type {Record<string, number> | undefined} */ counts) => Object.entries(counts ?? {}).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));

// The models by name, the one with the most output first: "claude-opus-5-5" reads "Opus 5.5".
/** @param {string} id */
export function modelName(id) {
  const m = /claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?![\d])/.exec(id);
  if (!m) return id;
  return `${m[1][0].toUpperCase()}${m[1].slice(1)} ${m[2]}${m[3] ? `.${m[3]}` : ''}`;
}
export const modelsByUse = (/** @type {UsageSum} */ sum) => Object.entries(sum.models).sort((a, b) => b[1].output - a[1].output).map(([id]) => id);

export const fmtTokens = (/** @type {number} */ n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}k` : String(n));
export const fmtCost = (/** @type {number | null} */ n) => (n === null ? '' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
/** @param {number} ms */
export function fmtDuration(ms) {
  const min = Math.round(ms / 60000);
  if (min < 1) return '< 1 min';
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

// One line for a task or a terminal: "Opus 5.5 · medium · 2.1M tokens · $4.56 · 9 min".
/** @param {UsageSum} sum */
export function usageLine(sum) {
  const models = modelsByUse(sum).map(modelName);
  return [
    models.slice(0, 2).join(' + ') + (models.length > 2 ? ` +${models.length - 2}` : ''),
    sum.effort ? `${sum.effort} effort` : '',
    `${fmtTokens(sum.tokens)} tokens`,
    sum.cost !== null ? `${sum.costPartial ? '≥ ' : ''}${fmtCost(sum.cost)}${/** @type {number} */ (sum.extraCost) >= 0.005 ? ` (${fmtCost(sum.extraCost)} extra)` : ''}` : '',
    sum.duration ? fmtDuration(sum.duration) : '',
  ].filter(Boolean).join(' · ');
}

// The details behind the line, for a tooltip.
/** @param {UsageSum} sum */
export function usageTitle(sum) {
  const lines = modelsByUse(sum).map((id) => {
    const m = sum.models[id];
    return `${modelName(id)} (${m.provider}): ${fmtTokens(m.input + m.cacheRead + m.cacheWrite)} in (${fmtTokens(m.cacheRead)} cached), ${fmtTokens(m.output)} out${m.cost !== null ? `, ${fmtCost(m.cost)}` : ''}`;
  });
  if (sum.cost !== null) lines.push(`Included in the Claude plan: ${fmtCost(sum.included)} · Extra, billed: ${fmtCost(sum.extraCost)}`);
  if (sum.costPartial) lines.push('Cost is known once claude quits; tokens are counted as it works.');
  if (sum.linesAdded || sum.linesRemoved) lines.push(`Lines: +${sum.linesAdded} −${sum.linesRemoved}`);
  if (sum.sessions > 1) lines.push(`${sum.sessions} sessions`);
  return lines.join('\n');
}
