// What Claude Code sessions actually used, read from the transcripts it keeps in ~/.claude/projects: the models,
// their tokens and cost, the effort, and how long the work took. A task's session is found by the name of the
// worktree the board gave it (`claude --worktree <name>`), which every transcript of that session records. Claude
// keeps a session's transcript under the worktree's folder name, and moves it under the repo's once the worktree
// is removed, so both places are read.
// CLAUDE_CONFIG_DIR moves Claude's folder, as it does for Claude itself.
import { readdir, readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const PROJECTS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'projects');
const WORKTREE_NAME = /^[\w.-]{1,64}$/;
// Transcripts already read, by path: re-read only when they changed.
const cache = new Map();

// Claude names a folder's transcripts after its path, every character but letters and digits made a dash.
const folderKey = (path) => path.replace(/[^a-zA-Z0-9]/g, '-');

// Where the model ran, from how its id is written: Bedrock prefixes `anthropic.`, Vertex adds `@<date>`.
export function providerOf(model) {
  if (/(^|\.)anthropic\./.test(model)) return 'Amazon Bedrock';
  if (/^claude-.*@/.test(model)) return 'Google Vertex AI';
  if (/^claude-/.test(model)) return 'Anthropic';
  return 'Other';
}

const tokensOf = (u = {}) => ({
  input: Number(u.inputTokens ?? u.input_tokens) || 0,
  output: Number(u.outputTokens ?? u.output_tokens) || 0,
  thinking: Number(u.thinkingTokens ?? u.output_tokens_details?.thinking_tokens) || 0,
  cacheRead: Number(u.cacheReadInputTokens ?? u.cache_read_input_tokens) || 0,
  cacheWrite: Number(u.cacheCreationInputTokens ?? u.cache_creation_input_tokens) || 0,
});

function addModel(models, id, tokens, cost) {
  const m = (models[id] ??= { provider: providerOf(id), input: 0, output: 0, thinking: 0, cacheRead: 0, cacheWrite: 0, cost: null });
  for (const k of ['input', 'output', 'thinking', 'cacheRead', 'cacheWrite']) m[k] += tokens[k];
  if (cost !== null) m.cost = (m.cost ?? 0) + cost;
}

// One transcript: the worktrees it ran in, and what it used.
// Claude writes a running total (cost-state) after each turn, by model and with the cost, counting subagents too.
// A resumed session starts a new total (a new startTime); each total's last value is added up, unless the new one
// carried the old one on. Without any total (an older Claude), the replies' own token counts are added up instead.
function parse(text) {
  const worktrees = new Set();
  const replies = new Map();
  const efforts = {};
  const totals = [];
  let start = null;
  let end = null;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let o;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === 'worktree-state' && o.worktreeSession?.worktreeName) worktrees.add(o.worktreeSession.worktreeName);
    else if (o.type === 'cost-state') {
      const last = totals[totals.length - 1];
      if (last && last.startTime === o.startTime) totals[totals.length - 1] = o;
      else totals.push(o);
    } else if (o.type === 'assistant' && o.message?.model && o.message.model !== '<synthetic>') {
      // A reply split into several lines repeats its id and usage.
      const id = o.message.id ?? o.uuid;
      if (!o.isSidechain && !replies.has(id)) {
        replies.set(id, o.message);
        if (o.effort) efforts[o.effort] = (efforts[o.effort] ?? 0) + 1;
      }
      const at = Date.parse(o.timestamp);
      if (at) {
        start = start === null ? at : Math.min(start, at);
        end = end === null ? at : Math.max(end, at);
      }
    }
  }
  const models = {};
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
    for (const [id, u] of Object.entries(t.modelUsage ?? {})) addModel(models, id, tokensOf(u), Number.isFinite(Number(u.costUSD)) ? Number(u.costUSD) : null);
  }
  if (!counted.length) for (const m of replies.values()) addModel(models, m.model, tokensOf(m.usage), null);
  return { worktrees: [...worktrees], models, cost, duration, apiDuration, linesAdded, linesRemoved, efforts, replies: replies.size, start, end };
}

// A later total carried an earlier one on when it is as large: in cost, and in every model's output.
function carries(next, prev) {
  if (!(Number(next.totalCostUSD) >= Number(prev.totalCostUSD))) return false;
  return Object.entries(prev.modelUsage ?? {}).every(([id, u]) => Number(next.modelUsage?.[id]?.outputTokens) >= Number(u.outputTokens));
}

async function readTranscript(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return null;
  const hit = cache.get(path);
  if (hit && hit.mtime === info.mtimeMs && hit.size === info.size) return hit.data;
  const data = parse(await readFile(path, 'utf8'));
  cache.set(path, { mtime: info.mtimeMs, size: info.size, data });
  return data;
}

async function transcriptsIn(folder) {
  const names = await readdir(join(PROJECTS, folder)).catch(() => []);
  return names.filter((n) => n.endsWith('.jsonl')).map((n) => join(PROJECTS, folder, n));
}

// The usage of the sessions that ran in worktree `name` of the repo at `cwd`, added up; null when none is found.
async function usageOf({ name, cwd }) {
  const repo = resolve(cwd);
  const files = new Set([
    ...(await transcriptsIn(folderKey(join(repo, '.claude', 'worktrees', name)))),
    ...(await transcriptsIn(folderKey(repo))),
  ]);
  const sum = { sessions: 0, models: {}, cost: null, duration: 0, apiDuration: 0, linesAdded: 0, linesRemoved: 0, efforts: {}, replies: 0, start: null, end: null };
  const seen = new Set();
  for (const file of files) {
    // The same session may sit in both folders while Claude moves it.
    const id = file.slice(file.lastIndexOf('/') + 1);
    if (seen.has(id)) continue;
    const t = await readTranscript(file);
    if (!t?.worktrees.includes(name) || !t.replies) continue;
    seen.add(id);
    sum.sessions++;
    for (const [model, m] of Object.entries(t.models)) addModel(sum.models, model, m, m.cost);
    if (t.cost !== null) sum.cost = (sum.cost ?? 0) + t.cost;
    for (const k of ['duration', 'apiDuration', 'linesAdded', 'linesRemoved', 'replies']) sum[k] += t[k];
    for (const [e, n] of Object.entries(t.efforts)) sum.efforts[e] = (sum.efforts[e] ?? 0) + n;
    if (t.start !== null) sum.start = sum.start === null ? t.start : Math.min(sum.start, t.start);
    if (t.end !== null) sum.end = sum.end === null ? t.end : Math.max(sum.end, t.end);
  }
  return sum.sessions ? sum : null;
}

// [{ name, cwd }] → { [name]: usage }; worktrees with no transcript are left out.
export async function worktreeUsage(list) {
  const out = {};
  for (const w of Array.isArray(list) ? list.slice(0, 200) : []) {
    if (!WORKTREE_NAME.test(w?.name ?? '') || typeof w.cwd !== 'string' || !w.cwd) continue;
    const usage = await usageOf(w);
    if (usage) out[w.name] = usage;
  }
  return out;
}
