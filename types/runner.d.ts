// The runners (tools/worker.js): the store they use, and the jobs they run (tools/jobs/*.js).
// Written out rather than taken from tools/, so the browser check (which includes types/) does not pull in Node code.

import type { WorkerCollections } from './data';
import type { RunnerJobState } from './data/runners';

// A runner's terminal lines: tools/log.js logger().
export interface Logger {
  info(text: string): void;
  error(text: string): void;
  request(method: string | undefined, path: string, status: number, ms: number): void;
}

// The runners' store: tools/worker/store.js createNodeStore(). It satisfies DataStore, over every file the runners
// write.
export interface NodeStore {
  // The data folder's path.
  dir: string;
  get<K extends keyof WorkerCollections>(name: K): WorkerCollections[K];
  update<K extends keyof WorkerCollections>(name: K, mutate: (data: WorkerCollections[K]) => void): void;
  save<K extends keyof WorkerCollections>(name: K, mutate: (data: WorkerCollections[K]) => void): void;
  refresh(): void;
  subscribe(): () => void;
  // Writes every changed file now.
  flush(): void;
  // Files kept beside the JSON files, relative to the data folder.
  files: {
    read(path: string): Promise<{ text(): Promise<string> }>;
    write(path: string, blob: string | Blob): Promise<string>;
  };
  folderName: string | undefined;
  status: string;
  pending: boolean;
}

// What a job's run() gets.
export interface JobContext {
  store: NodeStore;
  log: Logger;
  // Aborted when the run times out.
  signal: AbortSignal;
  // A Run now, not a scheduled run.
  force: boolean;
  // From a Run now request; {} for a scheduled run.
  params: JobParams;
}

// What the board's Run now requests send (js/runners.js runJob()); each job reads its own fields.
export interface JobParams {
  // google: the sign-in to renew.
  key?: string;
  // calendar, fx: a range of ISO dates.
  from?: string;
  to?: string;
  // cron: the flow to run.
  flowId?: string;
  // defi-positions: the APR window the page shows, and whether to read only its APR.
  window?: string;
  aprOnly?: boolean;
  // defi-history: the one chain to read.
  chainId?: number;
  // socials: the accounts to read now (just added).
  ids?: string[];
  // linkedin-metrics: the posts (linkedin.json ids) to read now.
  posts?: string[];
  // github, npm, previews, webstats: what to read when the board lacks it.
  repos?: string[];
  orgs?: string[];
  packages?: string[];
  prs?: { repo: string; number: number }[];
  // link-states: the task issues and PRs never read.
  links?: { repo: string; number: number }[];
  websites?: string[];
  // monitoring: the site checks to run, or the status pages.
  parts?: string[];
  providers?: boolean;
}

// What a run reports: shown in runners.json beside the job's state.
export type JobResult = Omit<Partial<RunnerJobState>, 'on' | 'running' | 'nextRunAt'>;

// A route of the worker's localhost API (tools/worker/http.js): (the JSON body, the rest of a "*" path).
export type RequestBody = Record<string, unknown>;
export type Route = (body: RequestBody, rest: string) => unknown;

// A route a job adds to the worker's localhost API: (body, rest of the path, store).
export type JobRoute = (body: RequestBody, rest: string, store: NodeStore) => unknown;

// One job: tools/jobs/<name>.js. Its label and default interval are in js/runner-jobs.js.
export interface Job {
  id: string;
  // How long a run may take, in ms (5 minutes by default).
  timeout?: number;
  // How long after the start the first run waits, in ms (2 s by default).
  delay?: number;
  // Starts again as soon as a run ends (a long poll).
  loop?: boolean;
  // No log line for a run that added nothing.
  quiet?: boolean;
  // kick(): run the job at its next tick.
  setup?(store: NodeStore, tools: { kick: () => void }): void;
  run(ctx: JobContext): Promise<JobResult> | JobResult;
  routes?: Record<string, JobRoute>;
}
