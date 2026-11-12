// Dev without the DOM: the runner's address, command presets, the command a project's tasks run, and starting a
// terminal through the command runner. The Dev section and the runners (Cron's Run in Dev step) both use it.
import { uid } from './ui.js';
import { TERMINAL_RUNNER, runnerInfo, runCommand, listSessions, saveSessionList } from './terminal.js';

const COLLECTION = 'dev';

export const runnerOf = (store) => store.get(COLLECTION)?.runner || TERMINAL_RUNNER;
export const devPresets = (store) => store.get(COLLECTION)?.presets ?? [];

// A shell word: single quotes keep newlines, quotes and $ in the prompt as typed.
export const shellQuote = (text) => `'${text.replace(/'/g, `'\\''`)}'`;

// The command a task is handed to; a project can set its own in its Dev command field.
export const DEFAULT_DEV_COMMAND = 'claude --dangerously-skip-permissions --worktree';

// The command a project's tasks are handed to: its preset's, else its own Dev command, else the default.
// A preset that was removed is skipped, so the project falls back to its own command.
export function devCommandOf(store, project) {
  const preset = project?.devPreset ? devPresets(store).find((x) => x.id === project.devPreset) : null;
  return preset?.command?.trim() || project?.devCommand?.trim() || DEFAULT_DEV_COMMAND;
}

// A worktree flag with no name: claude would pick a random one, which the tasks could not find again.
const BARE_WORKTREE = /(^|\s)(--worktree|-w)(?=\s+-|\s*$)/;

// A name claude accepts for a worktree (and its branch, worktree-<name>): the task's words, then the session's id,
// so two sessions on one task get two worktrees.
function worktreeName(title, id) {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '');
  return `${slug || 'task'}-${id.replace(/-/g, '').slice(0, 6)}`;
}

// The project's Dev command (or the default), with a name for the worktree it makes. `fallbackCwd` is the folder
// used when the project has none.
export function claudeCommand(store, projectId, title, id, fallbackCwd, override = '') {
  const project = store.get('projects').projects.find((p) => p.id === projectId);
  let command = override.trim() || devCommandOf(store, project);
  let worktree = null;
  if (BARE_WORKTREE.test(command)) {
    worktree = { name: worktreeName(title, id), cwd: project?.localPath || fallbackCwd };
    command = command.replace(BARE_WORKTREE, `$1$2 ${worktree.name}`);
  }
  return { command, worktree };
}

// Starts a command in a new terminal on the command runner and adds it to the runner's list of open terminals, so
// Dev shows it when it opens. For the runners (Cron), which have no Dev page. Resolves to { id, n, worktree }.
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
  const saved = await listSessions(base).catch(() => null);
  const list = { active: saved?.active ?? '', sessions: saved?.sessions ?? [] };
  const n = Math.max(0, ...list.sessions.map((x) => Number(x.n) || 0)) + 1;
  list.sessions.push({ id, n, cwd, ...(taskIds.length ? { tasks: taskIds, prompt: claude ? prompt : '' } : {}) });
  await saveSessionList(base, list).catch(() => {});
  return { id, n, worktree };
}
