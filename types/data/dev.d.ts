// dev.json: the Dev section's command history, its command runner and the command presets (js/modules/dev.js).

// A command named in Settings → Dev environment, which projects pick (project.devPreset) instead of typing it.
export interface DevPreset {
  id: string;
  name: string;
  command: string;
}

export interface DevData {
  // Commands run from Dev, newest first.
  history: string[];
  // The command runner's address; '' means the default (TERMINAL_RUNNER).
  runner: string;
  presets: DevPreset[];
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
