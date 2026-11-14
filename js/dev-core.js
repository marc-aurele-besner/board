// Dev without the DOM: the runner's address, command presets, the command a project's tasks run, and starting a
// terminal through the command runner. The Dev section and the runners (Cron's Run in Dev step) both use it.
/** @import { DataStore, Project, DevProvider, DevHarness } from '../types/data' */
import { uid } from './ui.js';
import { TERMINAL_RUNNER, runnerInfo, runCommand, listSession } from './terminal.js';

const COLLECTION = 'dev';

export const runnerOf = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.runner || TERMINAL_RUNNER;
export const devPresets = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.presets ?? [];

// A shell word: single quotes keep newlines, quotes and $ in the prompt as typed.
export const shellQuote = (/** @type {string} */ text) => `'${text.replace(/'/g, `'\\''`)}'`;

// The command a task is handed to; a project can set its own in its Dev command field.
export const DEFAULT_DEV_COMMAND = 'claude --dangerously-skip-permissions --worktree';

// The models and efforts a task can pick for its Dev session (claude's --model aliases and --effort levels).
export const DEV_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
export const DEV_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The AI providers until Settings → Dev environment edits them. MiniMax runs claude itself with MiniMax's
// Anthropic-compatible API in its place; the key comes from MINIMAX_API_KEY in the runner's environment, and
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
export const devProviders = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.providers ?? DEFAULT_PROVIDERS;

// The provider whose command a task's session runs instead of its project's: one other than Claude it picked a
// model of. A provider that was removed is skipped, so the task falls back to its project's command.
/** @param {DataStore} store @param {string | undefined} id */
export function taskProvider(store, id) {
  if (!id || id === CLAUDE_PROVIDER) return null;
  return devProviders(store).find((p) => p.id === id && p.command.trim()) ?? null;
}

// The command a project's tasks are handed to: its preset's, else its own Dev command, else Claude's provider
// command, else the default. A preset that was removed is skipped, so the project falls back to its own command.
/** @param {DataStore} store @param {Project | null | undefined} project */
export function devCommandOf(store, project) {
  const preset = project?.devPreset ? devPresets(store).find((x) => x.id === project.devPreset) : null;
  const claude = devProviders(store).find((p) => p.id === CLAUDE_PROVIDER);
  return preset?.command?.trim() || project?.devCommand?.trim() || claude?.command?.trim() || DEFAULT_DEV_COMMAND;
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
// how a task's model, effort and prompt reach it; {model}, {effort} and {prompt} are replaced by the quoted value.
// A command runs the harness whose own command starts with the same program, after any variables set before it.
/** @type {DevHarness[]} */
export const DEFAULT_HARNESSES = [
  { id: CLAUDE_PROVIDER, name: 'Claude Code', command: DEFAULT_DEV_COMMAND, model: '--model {model}', effort: '--effort {effort}', prompt: '-- {prompt}' },
  { id: 'codex', name: 'Codex CLI', command: 'codex --dangerously-bypass-approvals-and-sandbox', model: '--model {model}', effort: '-c model_reasoning_effort={effort}', prompt: '-- {prompt}' },
  { id: 'gemini', name: 'Gemini CLI', command: 'gemini --yolo', model: '--model {model}', effort: '', prompt: '--prompt-interactive {prompt}' },
  { id: 'opencode', name: 'OpenCode', command: 'opencode', model: '--model {model}', effort: '', prompt: '--prompt {prompt}' },
];
export const devHarnesses = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.harnesses ?? DEFAULT_HARNESSES;

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

// A harness's flag with its value filled in, quoted as one shell word; '' when either is empty.
/** @param {string | undefined} template @param {string} key @param {string} value */
function fill(template, key, value) {
  if (!template?.trim() || !value) return '';
  const word = shellQuote(value);
  return template.includes(`{${key}}`) ? template.split(`{${key}}`).join(word) : `${template} ${word}`;
}

// The command with a task's model and effort added in its harness's way; unset ones keep the command's own (or the
// harness's default). Added last, they win over the same flags in the project's command. Another program is left as is.
/** @param {DevHarness[]} harnesses @param {string} command @param {{ model?: string, effort?: string }} options */
export function withDevOptions(harnesses, command, { model = '', effort = '' } = {}) {
  const harness = harnessOf(harnesses, command);
  if (!harness) return command;
  const flags = [fill(harness.model, 'model', model), fill(harness.effort, 'effort', effort)].filter(Boolean);
  return flags.length ? `${command} ${flags.join(' ')}` : command;
}

// The command with the prompt handed over as its harness takes it; claude's way (after --) for another program.
/** @param {DevHarness[]} harnesses @param {string} command @param {string} prompt */
export function withPrompt(harnesses, command, prompt) {
  const template = harnessOf(harnesses, command)?.prompt?.trim() || '-- {prompt}';
  return `${command} ${fill(template, 'prompt', prompt)}`;
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
