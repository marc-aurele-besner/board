// runners.json: the worker's heartbeat (tools/worker/schedule.js), read by the board (js/runners.js). Not a store
// collection: written whole every 30 seconds, without schemaVersion.

export interface RunnerWorker {
  pid: number;
  startedAt: string;
  beatAt: string;
  version: number;
  // settings.json folderId of the data folder the runners use.
  folderId: string;
}

// A problem a job's run reported without failing.
export interface RunnerJobError {
  text: string;
  projectIds?: string[];
  // Resend: 'received' or 'sent'.
  dir?: string;
}

// A job's state. A job that has not run yet has only on, running and nextRunAt. A failed run has lastOkAt, lastRunAt,
// durationMs, ok and error; a good one adds what the job returned (the counts below, waiting, errors, ...).
export interface RunnerJobState {
  on: boolean;
  running: boolean;
  nextRunAt: string | null;
  lastRunAt?: string;
  lastOkAt?: string | null;
  durationMs?: number;
  ok?: boolean;
  error?: string | null;
  // Why the job had nothing to do (nothing set up yet).
  waiting?: string | null;
  // Objects from most jobs; plain strings from the calendar job.
  errors?: (RunnerJobError | string)[];
  warning?: string | null;
  // Counts of things that went wrong, null when none.
  warnings?: number | null;
  failed?: number | null;
  // What a run did, by job.
  renewed?: number;
  added?: number;
  read?: number;
  reads?: number;
  tasks?: number;
  providers?: number;
  repos?: number;
  prs?: number;
  sites?: number;
  records?: number;
  positions?: number;
  collected?: number;
  accounts?: number;
  entries?: number;
  started?: number;
  // Worktrees given back.
  removed?: number;
}

export interface RunnersData {
  worker: RunnerWorker;
  // By job id.
  jobs: Record<string, RunnerJobState>;
}
