// What Claude Code sessions actually used, read from the transcripts it keeps in ~/.claude/projects: the models,
// their tokens and cost, the effort, and how long the work took. A task's session is found by the name of the
// worktree the board gave it (`claude --worktree <name>`), which every transcript of that session records. Claude
// keeps a session's transcript under the worktree's folder name, and moves it under the repo's once the worktree
// is removed, so both places are read.
// CLAUDE_CONFIG_DIR moves Claude's folder, as it does for Claude itself.
/** @import { DevModelUsage, DevTurn } from '../types/data' */
/** @import { SessionAgent, SessionArtifact, SessionAsk, SessionTurn, WorktreeUsage } from '../types/terminal' */
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
/** @typedef {{ skill?: unknown, file_path?: unknown, notebook_path?: unknown, action?: unknown, asset?: unknown, title?: unknown, type_url?: unknown, from_url?: unknown, questions?: { question?: unknown }[], command?: unknown, plan?: unknown, description?: unknown, pattern?: unknown, path?: unknown, url?: unknown, query?: unknown, prompt?: unknown }} ToolInput */
/** @typedef {{ type?: string, text: string, id?: string, name?: string, input?: ToolInput, tool_use_id?: string, is_error?: boolean, content?: unknown }} ContentBlock */
/** @typedef {{ id?: string, model?: string, usage?: ReplyUsage, stop_reason?: string | null, content?: string | ContentBlock[] }} ReplyMessage */
/** @typedef {{ isUsingOverage?: boolean, resetsAt?: number }} Quota */
/** @typedef {{ startTime?: string, totalCostUSD?: number, totalDuration?: number, totalAPIDuration?: number, totalLinesAdded?: number, totalLinesRemoved?: number, modelUsage?: Record<string, ModelTokens> }} CostState */
/**
 * @typedef {CostState & { type?: string, uuid?: string, timestamp?: string, isSidechain?: boolean, effort?: string,
 *   isMeta?: boolean, isCompactSummary?: boolean, isVisibleInTranscriptOnly?: boolean,
 *   worktreeSession?: { worktreeName?: string }, quotaLimits?: Quota, apiErrorParams?: { rate_limit_info?: Quota },
 *   message?: ReplyMessage, toolUseResult?: { url?: unknown, title?: unknown } }} TranscriptLine
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
  // The first prompt, to find the session a terminal started; the last reply's text; the files claude wrote.
  /** @type {{ text: string, at: number } | null} */
  let prompt = null;
  let reply = '';
  /** @type {string | undefined} */
  let replyId;
  /** @type {Set<string>} */
  const written = new Set();
  // Tool calls still waiting for their result, by id: the last one is what claude waits on when the terminal is quiet.
  /** @type {Map<string, { name: string, input: ToolInput, at: number }>} */
  const pending = new Map();
  // The Artifacts it published (claude.ai links) with their titles, and the publish calls awaiting their result.
  /** @type {Map<string, string>} */
  const artifacts = new Map();
  /** @type {Map<string, ToolInput>} */
  const publishing = new Map();
  // The user's prompts, each a turn: when it was sent, when claude last answered it, and whether it was interrupted.
  /** @type {SessionTurn[]} */
  const turns = [];
  // The skills claude ran and the MCP tools it called, with how many times; and a slash command the user typed,
  // waiting for the skill text that says it was a skill rather than a built-in command such as /clear.
  /** @type {Record<string, number>} */
  const skills = {};
  /** @type {Record<string, number>} */
  const mcp = {};
  let command = '';
  // Its last tool call and how many it made, and the text of its last reply, in any line: what a subagent is doing.
  /** @type {{ name: string, detail: string, at: number } | null} */
  let lastTool = null;
  let toolCalls = 0;
  let said = '';
  let task = '';
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
    if (!open) pending.clear();
    readArtifacts(o, publishing, artifacts);
    command = readTools(o, command, skills, mcp);
    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      for (const b of o.message.content) {
        if (b.type === 'tool_use' && b.name) {
          toolCalls++;
          lastTool = { name: b.name, detail: toolDetail(b.input ?? {}), at: Date.parse(/** @type {string} */ (o.timestamp)) || 0 };
        } else if (b.type === 'text' && b.text?.trim()) said = b.text.trim().slice(0, PROMPT_KEPT);
      }
    } else if (o.type === 'user' && !task && !o.isMeta) task = turnText(o.message?.content).slice(0, PROMPT_KEPT);
    if (!o.isSidechain) {
      const c = o.message?.content;
      const at = Date.parse(/** @type {string} */ (o.timestamp)) || 0;
      if (o.type === 'user' && !o.isMeta && !o.isCompactSummary && !o.isVisibleInTranscriptOnly) {
        const said = turnText(c);
        const last = turns.at(-1);
        if (said === INTERRUPTED) {
          if (last) last.interrupted = true;
        } else if (said) {
          turns.push({ text: said.slice(0, PROMPT_KEPT), at, end: at, interrupted: false, waits: [] });
          if (turns.length > TURNS_KEPT) turns.shift();
        }
      } else if (o.type === 'assistant' && at && turns.length) turns[turns.length - 1].end = at;
      if (o.type === 'user' && !prompt && !o.isMeta) {
        const text = typeof c === 'string' ? c : Array.isArray(c) && c[0]?.type === 'text' ? c[0].text : '';
        if (text) prompt = { text: text.slice(0, PROMPT_KEPT), at: Date.parse(/** @type {string} */ (o.timestamp)) || 0 };
      } else if (o.type === 'assistant' && Array.isArray(c) && o.message?.model !== '<synthetic>') {
        // A reply comes as several lines with one id, a block each: its text blocks make the answer.
        const text = c.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join('\n\n');
        if (text) {
          const id = o.message?.id ?? o.uuid;
          reply = id === replyId ? `${reply}\n\n${text}` : text;
          replyId = id;
        }
        for (const b of c) {
          if (b.type === 'tool_use' && b.id) pending.set(b.id, { name: b.name ?? '', input: b.input ?? {}, at });
          const path = b.type === 'tool_use' && WRITES.includes(b.name ?? '') ? b.input?.file_path ?? b.input?.notebook_path : null;
          if (typeof path === 'string' && path) {
            written.delete(path);
            written.add(path);
          }
        }
      } else if (o.type === 'user' && Array.isArray(c)) {
        for (const b of c) {
          if (b.type !== 'tool_result' || !b.tool_use_id) continue;
          // A question or a plan held the turn until the user answered it: that time was theirs, not claude's.
          const call = pending.get(b.tool_use_id);
          const kind = call ? ASKS[call.name] : undefined;
          const turn = turns.at(-1);
          if (kind && turn && call?.at && at > call.at && call.at >= turn.at) turn.waits.push({ kind, at: call.at, end: at });
          pending.delete(b.tool_use_id);
        }
      }
    }
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
  const last = open ? [...pending.values()].at(-1) : undefined;
  return {
    worktrees: [...worktrees], models, cost, extraCost, billing, duration, apiDuration, linesAdded, linesRemoved, efforts,
    replies: replies.size, start, end, open, prompt, reply, written: [...written], turns,
    ask: last ? askOf(last) : null,
    since: last?.at || 0,
    artifacts: [...artifacts].map(([url, title]) => ({ url, title })),
    skills, mcp,
    lastTool, toolCalls, said, task,
  };
}

// What a tool call works on, in a few words: the command, file, pattern, address or task it was given.
/** @param {ToolInput} input */
function toolDetail(input) {
  for (const k of /** @type {const} */ (['description', 'command', 'file_path', 'notebook_path', 'pattern', 'url', 'query', 'skill', 'path', 'prompt'])) {
    const v = input[k];
    if (typeof v === 'string' && v.trim()) return v.replace(/\s+/g, ' ').trim().slice(0, 200);
  }
  return '';
}

// Counts a line's skills and MCP calls. A skill runs through the Skill tool, or as a slash command the user typed,
// which claude follows with the skill's text ("Base directory for this skill: …"); a built-in command has none.
// Answers the slash command still waiting for that text.
const SKILL_TEXT = /^Base directory for this skill:/;
/** @param {TranscriptLine} o @param {string} command @param {Record<string, number>} skills @param {Record<string, number>} mcp */
function readTools(o, command, skills, mcp) {
  const c = o.message?.content;
  if (o.type === 'assistant') {
    for (const b of Array.isArray(c) ? c : []) {
      if (b.type !== 'tool_use' || !b.name) continue;
      const skill = b.name === 'Skill' && typeof b.input?.skill === 'string' ? b.input.skill.replace(/^\//, '') : '';
      if (skill) skills[skill] = (skills[skill] ?? 0) + 1;
      else if (b.name.startsWith('mcp__')) mcp[b.name] = (mcp[b.name] ?? 0) + 1;
    }
    return '';
  }
  if (o.type !== 'user') return command;
  const text = typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text ?? '' : '';
  const typed = /<command-name>\/?([^<\s]+)<\/command-name>/.exec(text)?.[1];
  if (typed) return typed;
  if (command && SKILL_TEXT.test(text)) {
    skills[command] = (skills[command] ?? 0) + 1;
    return '';
  }
  return command;
}

// The Artifacts a session published: a publish call (no action, or 'publish'; not an asset upload) and the claude.ai
// link its result names. The type it started from, or another artifact it copied from, is not one of them.
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/g;
/** @param {TranscriptLine} o @param {Map<string, ToolInput>} publishing @param {Map<string, string>} artifacts */
function readArtifacts(o, publishing, artifacts) {
  const c = o.message?.content;
  if (!Array.isArray(c)) return;
  for (const b of c) {
    if (o.type === 'assistant' && b.type === 'tool_use' && b.name === 'Artifact' && b.id) {
      const action = b.input?.action ?? 'publish';
      if (action === 'publish' && !b.input?.asset) publishing.set(b.id, b.input ?? {});
    } else if (o.type === 'user' && b.type === 'tool_result' && b.tool_use_id && publishing.has(b.tool_use_id)) {
      const input = /** @type {ToolInput} */ (publishing.get(b.tool_use_id));
      publishing.delete(b.tool_use_id);
      if (b.is_error) continue;
      const result = o.toolUseResult;
      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      const url = typeof result?.url === 'string' && result.url
        ? result.url
        : [...text.matchAll(ARTIFACT_URL)].map((m) => m[0]).find((u) => u !== input.type_url && u !== input.from_url);
      if (!url) continue;
      const title = typeof result?.title === 'string' && result.title ? result.title : typeof input.title === 'string' ? input.title : '';
      artifacts.set(url, title || artifacts.get(url) || '');
    }
  }
}

// What claude waits on when its turn stopped at a tool call and the terminal went quiet: a question it asked, its
// plan to approve, or a tool to allow.
/** @param {{ name: string, input: ToolInput }} call @returns {SessionAsk} */
function askOf({ name, input }) {
  if (name === 'AskUserQuestion') {
    const questions = (Array.isArray(input.questions) ? input.questions : []).map((q) => String(q?.question ?? '')).filter(Boolean);
    return { kind: 'question', text: questions.length > 1 ? `${questions[0]} (+${questions.length - 1} more)` : questions[0] ?? '' };
  }
  if (name === 'ExitPlanMode') return { kind: 'plan', text: 'Approve the plan' };
  const detail = typeof input.command === 'string' ? input.command : typeof input.file_path === 'string' ? input.file_path : '';
  return { kind: 'permission', text: detail ? `${name}: ${detail.slice(0, 200)}` : name };
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

// The tools whose call waits on the user's answer, and what that wait is.
const ASKS = /** @type {Record<string, string>} */ ({ AskUserQuestion: 'question', ExitPlanMode: 'plan' });
const PROMPT_KEPT = 400;
const TURNS_KEPT = 200;
const INTERRUPTED = '\0interrupted';

// What the user said in a prompt line, as a turn reads: the text, a slash command as typed (`/name args`), a shell
// command as `! command`. Tool results, the board's notes and claude's own (a task notification, a local command's
// output) are no turn, so ''. An interruption answers INTERRUPTED.
/** @param {ReplyMessage['content']} c */
function turnText(c) {
  const text = (typeof c === 'string' ? c : Array.isArray(c) ? c.find((b) => b.type === 'text')?.text ?? '' : '').trim();
  if (!text) return '';
  if (/^\[Request interrupted/.test(text)) return INTERRUPTED;
  const name = /<command-name>([^<]*)<\/command-name>/.exec(text)?.[1];
  if (name) return `${name.trim()} ${/<command-args>([^<]*)<\/command-args>/.exec(text)?.[1] ?? ''}`.trim();
  const bash = /^<bash-input>([\s\S]*)<\/bash-input>/.exec(text)?.[1];
  if (bash) return `! ${bash.trim()}`;
  return text.startsWith('<') ? '' : text;
}
// The tools that write a file, and where they name it.
const WRITES = ['Write', 'Edit', 'MultiEdit', 'NotebookEdit'];

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
  const sum = { sessions: 0, billing, models: {}, cost: null, extraCost: null, duration: 0, apiDuration: 0, linesAdded: 0, linesRemoved: 0, efforts: {}, replies: 0, start: null, end: null, skills: {}, mcp: {}, turns: [] };
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
    for (const [k, n] of Object.entries(t.skills)) sum.skills[k] = (sum.skills[k] ?? 0) + n;
    for (const [k, n] of Object.entries(t.mcp)) sum.mcp[k] = (sum.mcp[k] ?? 0) + n;
    if (t.start !== null) sum.start = sum.start === null ? t.start : Math.min(sum.start, t.start);
    if (t.end !== null) sum.end = sum.end === null ? t.end : Math.max(sum.end, t.end);
    sum.turns.push(...turnLog(t.turns));
  }
  sum.turns = sum.turns.sort((a, b) => a.at - b.at).slice(-TURNS_LOGGED);
  return sum.sessions ? sum : null;
}

// A session's turns as usage.json keeps them: the prompt cut short, the time waiting on the user within the turn, and
// the time the user took since the previous turn ended (reading claude's answer, reviewing, writing the next prompt).
/** @param {SessionTurn[]} turns @returns {DevTurn[]} */
function turnLog(turns) {
  return turns.map((t, i) => {
    const end = Math.max(t.at, t.end);
    const wait = t.waits.reduce((s, w) => s + Math.max(0, Math.min(w.end || end, end) - w.at), 0);
    const prev = turns[i - 1];
    /** @type {DevTurn} */
    const out = { text: t.text.replace(/\s+/g, ' ').trim().slice(0, TURN_TEXT), at: t.at, end, wait, review: prev ? Math.max(0, t.at - prev.end) : 0 };
    if (t.interrupted) out.interrupted = true;
    return out;
  });
}
const TURNS_LOGGED = 200;
const TURN_TEXT = 120;

// [{ name, cwd }] → { [name]: usage }; worktrees with no transcript are left out.
/** @param {unknown} list [{ name, cwd }], checked here: it comes from a request @returns {Promise<Record<string, WorktreeUsage>>} */
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
  const agents = (await agentsOf(latest.file, billing)).running;
  return { busy: latest.t.open || agents > 0, agents, ask: latest.t.ask, artifacts: latest.t.artifacts };
}

// A session's subagents, newest first, and how many are still working. Claude keeps them beside it, in
// <session>/subagents: a transcript each, and a .meta.json with its type and the task it was given.
const AGENTS_KEPT = 30;
/** @param {string} file @param {string} billing @returns {Promise<{ running: number, list: SessionAgent[] }>} */
async function agentsOf(file, billing) {
  const folder = join(file.slice(0, -'.jsonl'.length), 'subagents');
  /** @type {SessionAgent[]} */
  const list = [];
  for (const n of await readdir(folder).catch(() => [])) {
    if (!n.endsWith('.jsonl')) continue;
    const path = join(folder, n);
    const info = await stat(path).catch(() => null);
    const t = info ? await readTranscript(path, billing) : null;
    if (!info || !t) continue;
    const meta = await readMeta(join(folder, `${n.slice(0, -'.jsonl'.length)}.meta.json`));
    const running = t.open && !meta.finished && Date.now() - info.mtimeMs <= STALE_MS;
    list.push({
      id: n.slice(0, -'.jsonl'.length).replace(/^agent-/, ''),
      type: typeof meta.agentType === 'string' ? meta.agentType : '',
      description: typeof meta.description === 'string' ? meta.description : '',
      background: meta.requestShape === 'background',
      state: running ? 'working' : t.open && !meta.finished ? 'stopped' : 'done',
      start: t.start ?? Math.round(info.birthtimeMs),
      end: Math.round(Math.max(t.end ?? 0, info.mtimeMs)),
      tool: t.lastTool,
      tools: t.toolCalls,
      said: t.said,
      task: t.task,
    });
  }
  list.sort((a, b) => b.start - a.start);
  return { running: list.filter((a) => a.state === 'working').length, list: list.slice(0, AGENTS_KEPT) };
}

// A subagent's .meta.json, cached by its time; {} when there is none (an older claude).
/** @type {Map<string, { mtime: number, data: Record<string, unknown> }>} */
const metas = new Map();
/** @param {string} path @returns {Promise<Record<string, unknown>>} */
async function readMeta(path) {
  const info = await stat(path).catch(() => null);
  if (!info) return {};
  const hit = metas.get(path);
  if (hit?.mtime === info.mtimeMs) return hit.data;
  /** @type {Record<string, unknown>} */
  let data = {};
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    if (parsed && typeof parsed === 'object') data = parsed;
  } catch {}
  metas.set(path, { mtime: info.mtimeMs, data });
  return data;
}

// [{ name, cwd }] → { [name]: { busy, agents } }; worktrees with no transcript are left out.
/** @param {unknown} list [{ name, cwd }], checked here */
export async function worktreeActivity(list) {
  /** @type {Record<string, { busy: boolean, agents: number, ask: SessionAsk | null, artifacts: SessionArtifact[] }>} */
  const out = {};
  for (const w of Array.isArray(list) ? list.slice(0, 50) : []) {
    if (!WORKTREE_NAME.test(w?.name ?? '') || typeof w.cwd !== 'string' || !w.cwd) continue;
    const activity = await activityOf(w);
    if (activity) out[w.name] = activity;
  }
  return out;
}

// The transcript of the claude a terminal started at `at` in `cwd` (in worktree `worktree` of it, when named): the
// one in that folder whose first prompt is `prompt` (any prompt when none is known), the earliest begun after `at`.
// { file, busy, agents, reply, written }, or null before claude wrote one. `file` is passed back as `known` to skip
// the search next time.
/** @param {{ cwd: string, at: number, prompt?: string, worktree?: string, known?: string }} where */
export async function sessionTranscript({ cwd, at, prompt = '', worktree = '', known = '' }) {
  const billing = await loginBilling();
  let file = known;
  if (!file) {
    const repo = resolve(expand(cwd));
    const folders = worktree && WORKTREE_NAME.test(worktree) ? [join(repo, '.claude', 'worktrees', worktree), repo] : [repo];
    const want = prompt.replace(/\s+/g, ' ').trim().slice(0, 200);
    let best = Infinity;
    for (const folder of folders) {
      for (const f of await transcriptsIn(folderKey(folder))) {
        const info = await stat(f).catch(() => null);
        if (!info || info.mtimeMs < at) continue;
        const first = (await readTranscript(f, billing))?.prompt;
        // Claude notes the prompt a moment after the terminal started it.
        if (!first || first.at < at - 5000 || first.at >= best) continue;
        if (want && !first.text.replace(/\s+/g, ' ').trim().startsWith(want.slice(0, first.text.length))) continue;
        best = first.at;
        file = f;
      }
    }
  }
  const t = file ? await readTranscript(file, billing) : null;
  if (!t) return null;
  const { running: agents, list: subagents } = await agentsOf(file, billing);
  return { file, busy: t.open || agents > 0, agents, subagents, reply: t.reply, written: t.written, ask: t.ask, since: t.since, artifacts: t.artifacts, turns: t.turns, skills: t.skills, mcp: t.mcp };
}
