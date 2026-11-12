// @ts-check
// What Claude Code sessions actually used, read from the transcripts it keeps in ~/.claude/projects: the models,
// their tokens and cost, the effort, and how long the work took. A task's session is found by the name of the
// worktree the board gave it (`claude --worktree <name>`), which every transcript of that session records. Claude
// keeps a session's transcript under the worktree's folder name, and moves it under the repo's once the worktree
// is removed, so both places are read.
// CLAUDE_CONFIG_DIR moves Claude's folder, as it does for Claude itself.
/** @import { DevModelUsage } from '../types/data' */
/** @import { WorktreeUsage } from '../types/terminal' */
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const WORKTREE_NAME = /^[\w.-]{1,64}$/;
// Transcripts already read, by path: re-read only when they changed.
/** @type {Map<string, { mtime: number, size: number, billing: string, data: Transcript }>} */
const cache = new Map();

// The parts of a transcript line that are read. Lines are Claude's JSON, so every field may be missing.
/** @typedef {{ input_tokens?: number, output_tokens?: number, cache_read_input_tokens?: number, cache_creation_input_tokens?: number, output_tokens_details?: { thinking_tokens?: number } }} ReplyUsage */
/** @typedef {ReplyUsage & { inputTokens?: number, outputTokens?: number, thinkingTokens?: number, cacheReadInputTokens?: number, cacheCreationInputTokens?: number, costUSD?: number }} ModelTokens */
/** @typedef {{ id?: string, model?: string, usage?: ReplyUsage, stop_reason?: string | null, content?: string | { type?: string, text: string }[] }} ReplyMessage */
/** @typedef {{ isUsingOverage?: boolean, resetsAt?: number }} Quota */
/** @typedef {{ startTime?: string, totalCostUSD?: number, totalDuration?: number, totalAPIDuration?: number, totalLinesAdded?: number, totalLinesRemoved?: number, modelUsage?: Record<string, ModelTokens> }} CostState */
/**
 * @typedef {CostState & { type?: string, uuid?: string, timestamp?: string, isSidechain?: boolean, effort?: string,
 *   isMeta?: boolean, isCompactSummary?: boolean, isVisibleInTranscriptOnly?: boolean,
 *   worktreeSession?: { worktreeName?: string }, quotaLimits?: Quota, apiErrorParams?: { rate_limit_info?: Quota },
 *   message?: ReplyMessage }} TranscriptLine
 */
/** @typedef {ReturnType<typeof parse>} Transcript */
/** @typedef {{ all: number, extra: number }} ReplyWeights */

// Claude names a folder's transcripts after its path, every character but letters and digits made a dash.
/** @param {string} path */
const folderKey = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');
// Projects keep their folder as typed, often under ~, which resolve() would read as a folder named "~".
/** @param {string} path */
const expand = (path) => (path === '~' ? homedir() : path.startsWith('~/') ? homedir() + path.slice(1) : path);

// Where the model ran, from how its id is written: Bedrock prefixes `anthropic.`, Vertex adds `@<date>`.
/** @param {string} model */
export function providerOf(model) {
  if (/(^|\.)anthropic\./.test(model)) return 'Amazon Bedrock';
  if (/^claude-.*@/.test(model)) return 'Google Vertex AI';
  if (/^claude-/.test(model)) return 'Anthropic';
  return 'Other';
}

// How the machine's Claude login is billed, from ~/.claude.json: a Claude plan (Pro, Max, Team, Enterprise) includes
// usage up to its limits; without one (an API key or a Console login) every token is paid for.
const CONFIG = process.env.CLAUDE_CONFIG_DIR ? join(process.env.CLAUDE_CONFIG_DIR, '.claude.json') : join(homedir(), '.claude.json');
let login = { mtime: -1, billing: 'api' };
/** @returns {Promise<string>} */
async function loginBilling() {
  const info = await stat(CONFIG).catch(() => null);
  if (!info) return 'api';
  if (login.mtime === info.mtimeMs) return login.billing;
  /** @type {{ organizationType?: string, billingType?: string } | null} */
  let account = null;
  try {
    account = JSON.parse(await readFile(CONFIG, 'utf8')).oauthAccount ?? null;
  } catch {
    // Claude may be writing the file: keep what was read before.
    return login.billing;
  }
  const plan = account && (/^claude_/.test(account.organizationType ?? '') || account.billingType === 'stripe_subscription');
  login = { mtime: info.mtimeMs, billing: plan ? 'plan' : 'api' };
  return login.billing;
}

// A reply's share of its model's cost, in input-token prices (output 5x, cache reads 0.1x, cache writes 1.25x),
// so the extra replies can take their part of a total that Claude only gives by model.
/** @param {ReplyUsage} [u] */
const weightOf = (u = {}) => (u.input_tokens || 0) + 5 * (u.output_tokens || 0) + 0.1 * (u.cache_read_input_tokens || 0) + 1.25 * (u.cache_creation_input_tokens || 0);

/** @param {ModelTokens} [u] */
const tokensOf = (u = {}) => ({
  input: Number(u.inputTokens ?? u.input_tokens) || 0,
  output: Number(u.outputTokens ?? u.output_tokens) || 0,
  thinking: Number(u.thinkingTokens ?? u.output_tokens_details?.thinking_tokens) || 0,
  cacheRead: Number(u.cacheReadInputTokens ?? u.cache_read_input_tokens) || 0,
  cacheWrite: Number(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens) || 0,
});

/**
 * @param {Record<string, DevModelUsage>} models
 * @param {string} id
 * @param {ReturnType<typeof tokensOf>} tokens
 * @param {number | null} cost
 * @param {number | null} [extraCost]
 */
function addModel(models, id, tokens, cost, extraCost = null) {
  const m = (models[id] ??= { provider: providerOf(id), input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, cost: null, extraCost: null });
  for (const k of /** @type {const} */ (['input', 'output', 'thinking', 'cacheRead', 'cacheWrite'])) m[k] += tokens[k];
  if (cost !== null) m.cost = (m.cost ?? 0) + cost;
  if (extraCost !== null) m.extraCost = (m.extraCost ?? 0) + extraCost;
}

// One transcript: the worktrees it ran in, and what it used.
// Claude writes a running total (cost-state) after each turn, by model and with the cost, counting subagents too.
// A resumed session starts a new total (a new startTime); each total's last value is added up, unless the new one
// carried the old one on. Without any total (an older Claude), the replies' own token counts are added up instead.
// Extra usage: on a plan, Claude notes the plan's limits when they change (`quotaLimits`, also on the error of a limit
// reached); while `isUsingOverage` holds, until the limit resets, replies are billed as extra usage. Bedrock and
// Vertex models are always billed by the cloud, and without a plan every reply is paid for.
/** @param {string} text @param {string} billing */
function parse(text, billing) {
  /** @type {Set<string>} */
  const worktrees = new Set();
  /** @type {Map<string | undefined, ReplyMessage & { model: string }>} */
  const replies = new Map();
  /** @type {Record<string, number>} */
  const efforts = {};
  /** @type {CostState[]} */
  const totals = [];
  /** @type {number | null} */
  let start = null;
  /** @type {number | null} */
  let end = null;
  let overageUntil = 0;
  // By model: the weight of every reply, and of those billed as extra.
  /** @type {Record<string, ReplyWeights>} */
  const weights = {};
  // Whether claude is in the middle of a turn, rather than waiting for the user (see turnOpen).
  let open = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    /** @type {TranscriptLine} */
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    open = turnOpen(o, open);
    const quota = o.quotaLimits ?? o.apiErrorParams?.rate_limit_info;
    if (quota && typeof quota.isUsingOverage === 'boolean') overageUntil = quota.isUsingOverage ? (Number(quota.resetsAt) * 1000 || Infinity) : 0;
    if (o.type === 'worktree-state' && o.worktreeSession?.worktreeName) worktrees.add(o.worktreeSession.worktreeName);
    else if (o.type === 'cost-state') {
      const last = totals[totals.length - 1];
      if (last && last.startTime === o.startTime) totals[totals.length - 1] = o;
      else totals.push(o);
    } else if (o.type === 'assistant' && o.message?.model && o.message.model !== '<synthetic>') {
      // A reply split into several lines repeats its id and usage.
      const id = o.message.id ?? o.uuid;
      const at = Date.parse(/** @type {string} */ (o.timestamp)); // NaN without one, which the checks below skip
      if (!o.isSidechain && !replies.has(id)) {
        replies.set(id, /** @type {ReplyMessage & { model: string }} */ (o.message));
        if (o.effort) efforts[o.effort] = (efforts[o.effort] ?? 0) + 1;
        const w = (weights[o.message.model] ??= { all: 0, extra: 0 });
        const weight = weightOf(o.message.usage);
        w.all += weight;
        if (at && at < overageUntil) w.extra += weight;
      }
      if (at) {
        start = start === null ? at : Math.min(start, at);
        end = end === null ? at : Math.max(end, at);
      }
    }
  }
  /** @type {Record<string, DevModelUsage>} */
  const models = {};
  /** @type {number | null} */
  let cost = null;
  let duration = 0;
  let apiDuration = 0;
  let linesAdded = 0;
  let linesRemoved = 0;
  // A total that carried the previous one on replaces it rather than adding to it.
  const counted = totals.filter((t, i) => !(totals[i + 1] && carries(totals[i + 1], t)));
  for (const t of counted) {
    cost = (cost ?? 0) + (Number(t.totalCostUSD) || 0);
    duration += Number(t.totalDuration) || 0;
    apiDuration += Number(t.totalAPIDuration) || 0;
    linesAdded += Number(t.totalLinesAdded) || 0;
    linesRemoved += Number(t.totalLinesRemoved) || 0;
    for (const [id, u] of Object.entries(t.modelUsage ?? {})) {
      const c = Number.isFinite(Number(u.costUSD)) ? Number(u.costUSD) : null;
      addModel(models, id, tokensOf(u), c, c === null ? null : c * extraShare(id, weights[id], billing));
    }
  }
  if (!counted.length) for (const m of replies.values()) addModel(models, m.model, tokensOf(m.usage), null);
  const extraCost = cost === null ? null : Object.values(models).reduce((s, m) => s + (m.extraCost ?? 0), 0);
  return { worktrees: [...worktrees], models, cost, extraCost, billing, duration, apiDuration, linesAdded, linesRemoved, efforts, replies: replies.size, start, end, open };
}

// Whether a turn is still going after transcript line `o`. A reply that stopped for anything but a tool call ends
// the turn (Claude's own error replies too); the user's message, a tool's result or a finished background task's
// notification starts one again. Lines only shown to the user (a summary after compacting, a skill's text, a local
// command and its output) and an interruption leave claude waiting.
/** @param {TranscriptLine} o @param {boolean} open */
function turnOpen(o, open) {
  if (o.type === 'assistant') {
    if (o.message?.model === '<synthetic>') return false;
    const stop = o.message?.stop_reason;
    return !stop || stop === 'tool_use';
  }
  if (o.type !== 'user' || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) return open;
  const c = o.message?.content;
  const text = typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : '';
  if (/^\[Request interrupted/.test(text)) return false;
  if (/^<(command-name|local-command-)/.test(text)) return open;
  return true;
}

// The part of a model's cost billed beyond the plan: all of it off the plan or off Anthropic, else its extra replies'.
/** @param {string} model @param {ReplyWeights | undefined} w @param {string} billing */
function extraShare(model, w, billing) {
  if (billing !== 'plan' || providerOf(model) !== 'Anthropic') return 1;
  return w?.all ? w.extra / w.all : 0;
}

// A later total carried an earlier one on when it is as large: in cost, and in every model's output.
/** @param {CostState} next @param {CostState} prev */
function carries(next, prev) {
  if (!(Number(next.totalCostUSD) >= Number(prev.totalCostUSD))) return false;
  return Object.entries(prev.modelUsage ?? {}).every(([id, u]) => Number(next.modelUsage?.[id]?.outputTokens) >= Number(u.outputTokens));
}

/** @param {string} path @param {string} billing */
async function readTranscript(path, billing) {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  const hit = cache.get(path);
  if (hit && hit.mtime === info.mtimeMs && hit.size === info.size && hit.billing === billing) return hit.data;
  const data = parse(await readFile(path, 'utf8'), billing);
  cache.set(path, { mtime: info.mtimeMs, size: info.size, billing, data });
  return data;
}

/** @param {string} folder */
async function transcriptsIn(folder) {
  const names = await readdir(join(PROJECTS, folder)).catch(() => []);
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(PROJECTS, folder, n));
}

// The usage of the sessions that ran in worktree `name` of the repo at `cwd`, added up; null when none is found.
/** @param {{ name: string, cwd: string }} worktree */
async function usageOf({ name, cwd }) {
  const repo = resolve(expand(cwd));
  const files = new Set([
    ...(await transcriptsIn(folderKey(join(repo, '.claude', 'worktrees', name)))),
    ...(await transcriptsIn(folderKey(repo))),
  ]);
  const billing = await loginBilling();
  /** @type {Required<WorktreeUsage>} */
  const sum = { sessions: 0, billing, models: {}, cost: null, extraCost: null, duration: 0, apiDuration: 0, linesAdded: 0, linesRemoved: 0, efforts: {}, replies: 0, start: null, end: null };
  const seen = new Set();
  for (const file of files) {
    // The same session may sit in both folders while Claude moves it.
    const id = file.slice(file.lastIndexOf('/') + 1);
    if (seen.has(id)) continue;
    const t = await readTranscript(file, billing);
    if (!t?.worktrees.includes(name) || !t.replies) continue;
    seen.add(id);
    sum.sessions++;
    for (const [model, m] of Object.entries(t.models)) addModel(sum.models, model, m, m.cost, m.extraCost);
    if (t.cost !== null) sum.cost = (sum.cost ?? 0) + t.cost;
    if (t.extraCost !== null) sum.extraCost = (sum.extraCost ?? 0) + t.extraCost;
    for (const k of /** @type {const} */ (['duration', 'apiDuration', 'linesAdded', 'linesRemoved', 'replies'])) sum[k] += t[k];
    for (const [e, n] of Object.entries(t.efforts)) sum.efforts[e] = (sum.efforts[e] ?? 0) + n;
    if (t.start !== null) sum.start = sum.start === null ? t.start : Math.min(sum.start, t.start);
    if (t.end !== null) sum.end = sum.end === null ? t.end : Math.max(sum.end, t.end);
  }
  return sum.sessions ? sum : null;
}

// [{ name, cwd }] → { [name]: usage }; worktrees with no transcript are left out.
/** @param {{ name: string, cwd: string }[]} list @returns {Promise<Record<string, WorktreeUsage>>} */
export async function worktreeUsage(list) {
  /** @type {Record<string, WorktreeUsage>} */
  const out = {};
  for (const w of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!WORKTREE_NAME.test(w?.name ?? '') || typeof w.cwd !== 'string' || !w.cwd) continue;
    const usage = await usageOf(w);
    if (usage) out[w.name] = usage;
  }
  return out;
}

// A subagent whose transcript has not changed for this long died with its session rather than still working.
const STALE_MS = 30 * 60 * 1000;

// Whether the claude session in worktree `name` of the repo at `cwd` is working: { busy, agents }. Busy while its
// latest transcript is in the middle of a turn, or while one of its subagents is (a background agent works on
// while claude waits for the user). Null when no transcript of that worktree is found.
/** @param {{ name: string, cwd: string }} worktree */
async function activityOf({ name, cwd }) {
  const repo = resolve(expand(cwd));
  const files = new Set([
    ...(await transcriptsIn(folderKey(join(repo, '.claude', 'worktrees', name)))),
    ...(await transcriptsIn(folderKey(repo))),
  ]);
  const billing = await loginBilling();
  /** @type {{ file: string, t: Transcript, mtime: number } | null} */
  let latest = null;
  for (const file of files) {
    const info = await stat(file).catch(() => null);
    if (!info || (latest && info.mtimeMs <= latest.mtime)) continue;
    const t = await readTranscript(file, billing);
    if (t?.worktrees.includes(name)) latest = { file, t, mtime: info.mtimeMs };
  }
  if (!latest) return null;
  // Claude keeps a session's subagents beside it, in <session>/subagents.
  const folder = join(latest.file.slice(0, -'.jsonl'.length), 'subagents');
  let agents = 0;
  for (const n of await readdir(folder).catch(() => [])) {
    if (!n.endsWith('.jsonl')) continue;
    const info = await stat(join(folder, n)).catch(() => null);
    if (!info || Date.now() - info.mtimeMs > STALE_MS) continue;
    if ((await readTranscript(join(folder, n), billing))?.open) agents++;
  }
  return { busy: latest.t.open || agents > 0, agents };
}

// [{ name, cwd }] → { [name]: { busy, agents } }; worktrees with no transcript are left out.
/** @param {{ name: string, cwd: string }[]} list */
export async function worktreeActivity(list) {
  /** @type {Record<string, { busy: boolean, agents: number }>} */
  const out = {};
  for (const w of Array.isArray(list) ? list.slice(0, 50) : []) {
    if (!WORKTREE_NAME.test(w?.name ?? '') || typeof w.cwd !== 'string' || !w.cwd) continue;
    const activity = await activityOf(w);
    if (activity) out[w.name] = activity;
  }
  return out;
}
