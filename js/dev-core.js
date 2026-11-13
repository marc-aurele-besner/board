// Dev without the DOM: the runner's address, command presets, the command a project's tasks run, and starting a
// terminal through the command runner. The Dev section and the runners (Cron's Run in Dev step) both use it.
/** @import { DataStore, Project } from '../types/data' */
import { uid } from './ui.js';
import { TERMINAL_RUNNER, runnerInfo, runCommand, listSession } from './terminal.js';

const COLLECTION = 'dev';

export const runnerOf = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.runner || TERMINAL_RUNNER;
export const devPresets = (/** @type {DataStore} */ store) => store.get(COLLECTION)?.presets ?? [];

// A shell word: single quotes keep newlines, quotes and $ in the prompt as typed.
export const shellQuote = (/** @type {string} */ text) => `'${text.replace(/'/g, `'\\''`)}'`;

// The command a task is handed to; a project can set its own in its Dev command field.
export const DEFAULT_DEV_COMMAND = 'claude --dangerously-skip-permissions --worktree';

// The command a project's tasks are handed to: its preset's, else its own Dev command, else the default.
// A preset that was removed is skipped, so the project falls back to its own command.
/** @param {DataStore} store @param {Project | null | undefined} project */
export function devCommandOf(store, project) {
  const preset = project?.devPreset ? devPresets(store).find((x) => x.id === project.devPreset) : null;
  return preset?.command?.trim() || project?.devCommand?.trim() || DEFAULT_DEV_COMMAND;
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

// The models and efforts a task can pick for its Dev session (claude's --model aliases and --effort levels).
export const DEV_MODELS = ['fable', 'opus', 'sonnet', 'haiku'];
export const DEV_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

// The model each alias runs today, named in the menu (claude moves an alias to a new version on its own).
/** @type {Record<string, string>} */
export const DEV_MODEL_NAMES = { fable: 'Fable 5.2', opus: 'Opus 5.5', sonnet: 'Sonnet 5.5', haiku: 'Haiku 5.5' };

// A command that runs claude, so --model and --effort mean something to it; another tool's preset is left as is.
const RUNS_CLAUDE = /^\s*(\S*\/)?claude(\s|$)/;

// The command with a task's model and effort added; unset ones keep the command's own (or claude's default).
// Added last, they win over the same flags in the project's command.
/** @param {string} command @param {{ model?: string, effort?: string }} options */
export function withClaudeOptions(command, { model = '', effort = '' } = {}) {
  if (!RUNS_CLAUDE.test(command)) return command;
  const flags = [model && `--model ${shellQuote(model)}`, effort && `--effort ${shellQuote(effort)}`].filter(Boolean);
  return flags.length ? `${command} ${flags.join(' ')}` : command;
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
  let command = withClaudeOptions(override.trim() || devCommandOf(store, project), options);
  let worktree = null;
  if (BARE_WORKTREE.test(command)) {
    worktree = { name: worktreeName(title, id), cwd: project?.localPath || fallbackCwd };
    command = command.replace(BARE_WORKTREE, `$1$2 ${worktree.name}`);
  }
  return { command, worktree };
}

// Starts a command in a new terminal on the command runner and adds it to the runner's list of open terminals, so
// Dev shows it when it opens. For the runners (Cron), which have no Dev page. Resolves to { id, n, worktree }.
/**
 * @param {{ store: DataStore, claude?: boolean, prompt?: string, command?: string, devCommand?: string, projectId?: string,
 *   taskIds?: string[], title?: string, theme?: string }} options
 */
export async function startRunnerSession({ store, claude = false, prompt = '', command = '', devCommand = '', projectId = '', taskIds = [], title = '', theme = 'light' }) {
  const base = runnerOf(store);
  const info = await runnerInfo(base);
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  const cwd = project?.localPath || info.root || '';
  const id = uid();
  let worktree = null;
  if (claude) {
    ({ command, worktree } = claudeCommand(store, projectId, title, id, cwd, devCommand));
    command = `${command} -- ${shellQuote(prompt)}`;
  }
  // The terminal is not on a page yet: it starts at a usual size and is fitted once shown.
  await runCommand(base, { session: id, command, cwd, cols: 120, rows: 32, theme });
  // The runner numbers it, so the number matches the one every browser shows.
  const entry = await listSession(base, { session: id, cwd, ...(taskIds.length ? { tasks: taskIds, prompt: claude ? prompt : '' } : {}) }).catch(() => null);
  return { id, n: entry?.n ?? 0, worktree };
}
