// dev.json: the Dev section's command history and favorites, its command runner and the command presets (js/modules/dev.js).

// A command preset, as saved before agents replaced them: each is read as an agent with no models, under its id
// (agentsOf in js/dev-core.js), until Settings saves it as one.
export interface DevPreset {
  id: string;
  name: string;
  command: string;
}

// An agent in Settings → Dev environment: a coding harness's command, with the variables that connect it to a
// provider before it (its program picks the harness), and the models a task's right-click menu offers (none: the
// harness's default). A project picks one (project.devPreset); a task can pick another's model (task.devProvider).
export interface DevProvider {
  id: string;
  name: string;
  command: string;
  models: string[];
}

// A coding harness in Settings → Dev environment: a CLI that runs an agent in a terminal (Claude Code, Codex CLI…).
// A command runs the harness whose command starts with the same program. Its flags are templates: {{model}},
// {{effort}} and {{prompt}} are replaced by the quoted value; '' means the harness takes no such flag.
export interface DevHarness {
  id: string;
  name: string;
  command: string;
  model: string;
  effort: string;
  prompt: string;
}

export interface DevData {
  // Commands run from Dev, newest first.
  history: string[];
  // Commands kept at hand in the bar's Favorites menu, in the order they were added.
  favorites?: string[];
  // The command runner's address; '' means the default (TERMINAL_RUNNER).
  runner: string;
  // Saved before agents; emptied once Settings saves the agents.
  presets: DevPreset[];
  // The agents. Missing until one is edited: the built-in Claude and MiniMax (DEFAULT_PROVIDERS in js/dev-core.js).
  providers?: DevProvider[];
  // The agent of projects that pick none; '' or missing means Claude.
  defaultAgent?: string;
  // Missing until one is edited: the built-in harnesses (DEFAULT_HARNESSES in js/dev-core.js).
  harnesses?: DevHarness[];
  schemaVersion?: number;
}

// Not in dev.json: an open terminal as the command runner keeps it (GET/POST /sessions, js/terminal.js).
export interface DevSession {
  id: string;
  n: number;
  cwd: string;
  // The tasks the terminal was started for, and the prompt it was given.
  tasks?: string[];
  prompt?: string;
}

// Not in dev.json: the command runner's list of open terminals.
export interface DevSessionList {
  // The id of the terminal shown last.
  active: string;
  sessions: DevSession[];
}
