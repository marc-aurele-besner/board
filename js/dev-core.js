// Dev without the DOM: the runner's address, the agents, the command a project's tasks run, and starting a
// terminal through the command runner. The Dev section and the runners (Cron's Run in Dev step) both use it.
/** @import { DataStore, Project, DevProvider, DevHarness, DevData } from '../types/data' */
import { uid } from './ui.js';
import { TERMINAL_RUNNER, runnerInfo, runCommand, listSession } from './terminal.js';

const COLLECTION = 'dev';

export const runnerOf = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.runner || TERMINAL_RUNNER;

// A shell word: single quotes keep newlines, quotes and $ in the prompt as typed.
export const shellQuote = (/** @type {string} */ text) => `'${text.replace(/'/g, `'\\''`)}'`;

// The command a task is handed to; a project can set its own in its Dev command field.
export const DEFAULT_DEV_COMMAND = 'claude --dangerously-skip-permissions --worktree';

// The models and efforts a task can pick for its Dev session (claude's --model aliases and --effort levels).
export const DEV_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
export const DEV_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The agents until Settings → Dev environment edits them. An agent is a coding harness's command, with the
// variables that connect it to a provider before it, and the models a task can pick. MiniMax runs claude itself with
// MiniMax's Anthropic-compatible API in its place; the key comes from MINIMAX_API_KEY in the runner's environment, and
// claude's own aliases (opus, sonnet, haiku, which subagents use) point at MiniMax's model too.
export const CLAUDE_PROVIDER = 'claude';
const MINIMAX_MODEL = 'MiniMax-M3';
/** @type {DevProvider[]} */
export const DEFAULT_PROVIDERS = [
  { id: CLAUDE_PROVIDER, name: 'Claude', command: DEFAULT_DEV_COMMAND, models: DEV_MODELS },
  {
    id: 'minimax',
    name: 'MiniMax',
    command: [
      'ANTHROPIC_BASE_URL=https://api.minimax.io/anthropic',
      'ANTHROPIC_AUTH_TOKEN="$MINIMAX_API_KEY"',
      'API_TIMEOUT_MS=3000000',
      'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1',
      ...['OPUS', 'SONNET', 'HAIKU'].map((m) => `ANTHROPIC_DEFAULT_${m}_MODEL=${MINIMAX_MODEL}`),
      DEFAULT_DEV_COMMAND,
    ].join(' '),
    models: [MINIMAX_MODEL, 'MiniMax-M2.7'],
  },
];

// The agents of dev.json: its providers (the built-in ones until edited), then the command presets saved before
// agents replaced them, as agents with no models under the same id, so projects and Cron steps that picked one
// still find it. Settings' first change saves them as agents.
/** @param {Partial<DevData> | undefined} data @returns {DevProvider[]} */
export function agentsOf(data) {
  const agents = data?.providers ?? DEFAULT_PROVIDERS;
  const legacy = (data?.presets ?? []).filter((p) => !agents.some((a) => a.id === p.id));
  return legacy.length ? [...agents, ...legacy.map((p) => ({ id: p.id, name: p.name, command: p.command, models: [] }))] : agents;
}
export const devAgents = (/** @type {DataStore} */ store) => agentsOf(store.get(COLLECTION));

// The agent of projects that pick none: the one chosen in Settings, else Claude, else the first.
/** @param {DataStore} store @returns {DevProvider} */
export function defaultAgent(store) {
  const agents = devAgents(store);
  const id = store.get(COLLECTION)?.defaultAgent || CLAUDE_PROVIDER;
  return agents.find((a) => a.id === id) ?? agents.find((a) => a.id === CLAUDE_PROVIDER) ?? agents[0] ?? DEFAULT_PROVIDERS[0];
}

// The agent a project runs: the one it picked, else none when it has a command of its own, else the default. An
// agent that was removed is skipped.
/** @param {DataStore} store @param {Project | null | undefined} project @returns {DevProvider | null} */
export function projectAgent(store, project) {
  const picked = project?.devPreset ? devAgents(store).find((a) => a.id === project.devPreset) : null;
  if (picked) return picked;
  return project?.devCommand?.trim() ? null : defaultAgent(store);
}

// The command a project's tasks are handed to: its agent's, else its own Dev command, else the default agent's.
/** @param {DataStore} store @param {Project | null | undefined} project */
export function devCommandOf(store, project) {
  return projectAgent(store, project)?.command.trim() || project?.devCommand?.trim() || defaultAgent(store).command.trim() || DEFAULT_DEV_COMMAND;
}

// The agent a task picked in its right-click menu: devProvider, or Claude for a model picked before agents named
// theirs. null for its project's own; an agent that was removed is skipped too.
/** @param {DataStore} store @param {{ devProvider?: string, devModel?: string } | null | undefined} task */
export function taskAgent(store, task) {
  const id = task?.devProvider || (task?.devModel ? CLAUDE_PROVIDER : '');
  return id ? devAgents(store).find((a) => a.id === id && a.command.trim()) ?? null : null;
}

// The command a task's session runs in place of its project's, or '' to keep the project's. The project's is kept
// when it already runs the picked agent's harness through the same connection (same variables before it): it keeps
// its own flags and worktree, and only the model is added. Otherwise the agent's own command runs, so a model never
// goes to a program that does not know it (a Claude model to a project that runs Codex).
/** @param {DataStore} store @param {Project | null | undefined} project @param {DevProvider | null} agent */
export function taskAgentCommand(store, project, agent) {
  if (!agent) return '';
  const own = devCommandOf(store, project);
  const harnesses = devHarnesses(store);
  const ownHarness = harnessOf(harnesses, own);
  const same = ownHarness && ownHarness.id === harnessOf(harnesses, agent.command)?.id && splitEnv(own).env === splitEnv(agent.command).env;
  return same ? '' : agent.command;
}

// A worktree flag with no name: claude would pick a random one, which the tasks could not find again.
const BARE_WORKTREE = /(^|\s)(--worktree|-w)(?=\s+-|\s*$)/;

// A name claude accepts for a worktree (and its branch, worktree-<name>): the task's words, then the session's id,
// so two sessions on one task get two worktrees.
/** @param {string} title @param {string} id */
function worktreeName(title, id) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return `${slug || 'task'}-${id.replace(/-/g, '').slice(0, 6)}`;
}

// The model each alias runs today, named in the menu (claude moves an alias to a new version on its own).
/** @type {Record<string, string>} */
export const DEV_MODEL_NAMES = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' };

// The coding harnesses (CLIs that run an agent in a terminal) until Settings → Dev environment edits them. Each says
// how a task's model, effort and prompt reach it; {{model}}, {{effort}} and {{prompt}} are replaced by the quoted
// value. A command runs the harness whose own command starts with the same program, after any variables set before it.
/** @type {DevHarness[]} */
export const DEFAULT_HARNESSES = [
  { id: CLAUDE_PROVIDER, name: 'Claude Code', command: DEFAULT_DEV_COMMAND, model: '--model {{model}}', effort: '--effort {{effort}}', prompt: '-- {{prompt}}' },
  { id: 'codex', name: 'Codex CLI', command: 'codex --dangerously-bypass-approvals-and-sandbox', model: '--model {{model}}', effort: '-c model_reasoning_effort={{effort}}', prompt: '-- {{prompt}}' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini --yolo', model: '--model {{model}}', effort: '', prompt: '--prompt-interactive {{prompt}}' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', model: '--model {{model}}', effort: '', prompt: '--prompt {{prompt}}' },
];
export const devHarnesses = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.harnesses ?? DEFAULT_HARNESSES;

// The variables a harness flag or a Dev command can hold.
export const DEV_VARS = ['model', 'effort', 'prompt'];

// The variables set before a command's program (a provider's API override), and the rest of it.
const ENV_PREFIX = /^\s*((?:\w+=(?:"[^"]*"|'[^']*'|\S*)\s+)*)/;
/** @param {string} command @returns {{ env: string, rest: string }} */
export function splitEnv(command) {
  const env = ENV_PREFIX.exec(command)?.[1] ?? '';
  return { env: env.trim(), rest: command.slice(env.length).trim() };
}
const programOf = (/** @type {string} */ command) => (splitEnv(command).rest.split(/\s+/)[0] ?? '').split('/').pop() ?? '';

// The harness a command runs, or null for another program (a shell, a script).
/** @param {DevHarness[]} harnesses @param {string} command */
export function harnessOf(harnesses, command) {
  const program = programOf(command);
  return program ? harnesses.find((x) => programOf(x.command) === program) ?? null : null;
}

// {{key}}, or {key} as the first harnesses were saved.
const token = (/** @type {string} */ key) => new RegExp(`\\{\\{?${key}\\}\\}?`, 'g');
const holds = (/** @type {string} */ text, /** @type {string} */ key) => token(key).test(text);

// A harness's flag with its value filled in, quoted as one shell word; '' when either is empty.
/** @param {string | undefined} template @param {string} key @param {string} value */
function fill(template, key, value) {
  if (!template?.trim() || !value) return '';
  const word = shellQuote(value);
  return holds(template, key) ? template.replace(token(key), () => word) : `${template} ${word}`;
}

// A command that holds {{key}} itself gets the value there; with no value, the variable goes, and the flag just
// before it (`-m {{model}}`, `--model={{model}}`) with it.
/** @param {string} command @param {string} key @param {string} value */
function fillInPlace(command, key, value) {
  if (value) return command.replace(token(key), () => shellQuote(value));
  return command.replace(new RegExp(`(\\s+--?[\\w-]+(?:=|\\s+))?${token(key).source}`, 'g'), '').trim();
}

// The command with a task's model and effort added in its harness's way; unset ones keep the command's own (or the
// harness's default). Added last, they win over the same flags in the project's command. Another program is left as
// is, unless the command places {{model}} or {{effort}} itself.
/** @param {DevHarness[]} harnesses @param {string} command @param {{ model?: string, effort?: string }} options */
export function withDevOptions(harnesses, command, { model = '', effort = '' } = {}) {
  const harness = harnessOf(harnesses, command);
  /** @type {string[]} */
  const flags = [];
  for (const [key, value, template] of /** @type {[string, string, string | undefined][]} */ ([['model', model, harness?.model], ['effort', effort, harness?.effort]])) {
    if (holds(command, key)) command = fillInPlace(command, key, value);
    else if (harness) flags.push(fill(template, key, value));
  }
  const added = flags.filter(Boolean);
  return added.length ? `${command} ${added.join(' ')}` : command;
}

// The command with the prompt handed over as its harness takes it, or where the command places {{prompt}};
// claude's way (after --) for another program.
/** @param {DevHarness[]} harnesses @param {string} command @param {string} prompt */
export function withPrompt(harnesses, command, prompt) {
  if (holds(command, 'prompt')) return command.replace(token('prompt'), () => shellQuote(prompt));
  const template = harnessOf(harnesses, command)?.prompt?.trim() || '-- {{prompt}}';
  return `${command} ${fill(template, 'prompt', prompt)}`;
}

// The command as a task would run it, with the variables still in: the harness's flags for those the command does
// not place itself, then its prompt. For Settings' previews.
/** @param {DevHarness[]} harnesses @param {string} command */
export function devTemplate(harnesses, command) {
  const harness = harnessOf(harnesses, command);
  const parts = [command];
  for (const key of DEV_VARS) {
    if (holds(command, key)) continue;
    const template = key === 'prompt' ? harness?.prompt?.trim() || '-- {{prompt}}' : harness?.[/** @type {'model' | 'effort'} */ (key)]?.trim();
    if (template) parts.push(holds(template, key) ? template : `${template} {{${key}}}`);
  }
  return parts.join(' ').replace(/\{\{?(\w+)\}\}?/g, '{{$1}}');
}

// The logo of a provider or harness, by the brand its name, id or command names; '' when none matches.
const BRANDS = [
  ['ai-claude', /claude|anthropic/i],
  ['ai-openai', /codex|openai|\bgpt/i],
  ['ai-gemini', /gemini|google/i],
  ['ai-minimax', /minimax/i],
  ['ai-qwen', /qwen|dashscope|alibaba/i],
  ['ai-deepseek', /deepseek/i],
  ['ai-openrouter', /openrouter/i],
  ['ai-mistral', /mistral/i],
];
/** @param {...string} texts the most telling first: a name before a command */
export function brandOf(...texts) {
  for (const text of texts) {
    const found = BRANDS.find(([, re]) => /** @type {RegExp} */ (re).test(text ?? ''));
    if (found) return /** @type {string} */ (found[0]);
  }
  return '';
}

// The project's Dev command (or the default), with a name for the worktree it makes. `fallbackCwd` is the folder
// used when the project has none. `options` adds a task's model and effort.
/**
 * @param {DataStore} store
 * @param {string} projectId
 * @param {string} title
 * @param {string} id
 * @param {string} fallbackCwd
 * @param {{ model?: string, effort?: string }} [options]
 */
export function claudeCommand(store, projectId, title, id, fallbackCwd, override = '', options = {}) {
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  const harnesses = devHarnesses(store);
  let command = withDevOptions(harnesses, override.trim() || devCommandOf(store, project), options);
  let worktree = null;
  // Only claude names its worktree from this flag; another harness's -w means something else.
  if (harnessOf(harnesses, command)?.id === CLAUDE_PROVIDER && BARE_WORKTREE.test(command)) {
    worktree = { name: worktreeName(title, id), cwd: project?.localPath || fallbackCwd };
    command = command.replace(BARE_WORKTREE, `$1$2 ${worktree.name}`);
  }
  return { command, worktree };
}

// Starts a command in a new terminal on the command runner and adds it to the runner's list of open terminals, so
// Dev shows it when it opens. For the runners (Cron), which have no Dev page. Resolves to { id, n, worktree }.
/**
 * @param {{ store: DataStore, claude?: boolean, prompt?: string, command?: string, devCommand?: string, projectId?: string,
 *   taskIds?: string[], title?: string, theme?: string, model?: string, effort?: string }} options
 */
export async function startRunnerSession({ store, claude = false, prompt = '', command = '', devCommand = '', projectId = '', taskIds = [], title = '', theme = 'light', model = '', effort = '' }) {
  const base = runnerOf(store);
  const info = await runnerInfo(base);
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  const cwd = project?.localPath || info.root || '';
  const id = uid();
  let worktree = null;
  if (claude) {
    ({ command, worktree } = claudeCommand(store, projectId, title, id, cwd, devCommand, { model, effort }));
    command = withPrompt(devHarnesses(store), command, prompt);
  }
  // The terminal is not on a page yet: it starts at a usual size and is fitted once shown.
  await runCommand(base, { session: id, command, cwd, cols: 120, rows: 32, theme });
  // The runner numbers it, so the number matches the one every browser shows.
  const entry = await listSession(base, { session: id, cwd, ...(taskIds.length ? { tasks: taskIds, prompt: claude ? prompt : '' } : {}) }).catch(() => null);
  return { id, n: entry?.n ?? 0, worktree };
}

// Where the claude of a terminal stands, from the runner's status of it, as a key (the class of its dot in Dev and
// of a task's Dev button) and the words for it: working, asks (a question, a plan, a permission), waiting after its
// turn, done, failed, stalled (not responding), stopped or idle.
// A working claude that neither printed nor wrote to its transcript for this long is taken as not responding.
export const STALL_MS = 5 * 60000;
/** @type {Record<string, string>} */
export const ASK_LABELS = { question: 'claude asks you', plan: 'claude waits for its plan to be approved', permission: 'claude waits for your permission' };
/** @param {import('../types/terminal').RunnerStatus} st @returns {{ key: string, label: string }} */
export function claudeState(st) {
  if (st.state === 'working') {
    return (st.quiet ?? 0) >= STALL_MS
      ? { key: 'stalled', label: `Not responding: claude gave no sign for ${Math.round(/** @type {number} */ (st.quiet) / 60000)} min` }
      : { key: 'working', label: 'claude is working' };
  }
  if (st.state === 'waiting') {
    if (st.ask) return { key: 'asks', label: `${ASK_LABELS[st.ask.kind] ?? ASK_LABELS.permission}${st.ask.text ? `: ${st.ask.text}` : ''}` };
    return st.signalled ? { key: 'done', label: 'Done: claude gave the done signal' } : { key: 'waiting', label: 'claude finished its turn and waits for you' };
  }
  if (st.state === 'done') return { key: 'done', label: 'Finished' };
  if (st.state === 'failed') return { key: 'failed', label: `Ended with an error${st.code != null ? ` (exit ${st.code})` : ''}` };
  return st.state === 'stopped' ? { key: 'stopped', label: 'Stopped' } : { key: 'idle', label: 'Nothing running' };
}
