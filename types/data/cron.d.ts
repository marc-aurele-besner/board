// cron.json: Cron flows, their runs, saved templates and step tests (js/cron.js).

// When a flow runs. every: 'interval', 'daily', 'weekly' (old), 'days', 'monthly' or 'custom'. makeFlow() writes
// every field; older or template schedules carry only some.
export interface CronSchedule {
  every: string;
  // HH:MM. `times` holds several; flows saved with one keep `time`.
  time?: string;
  times?: string[];
  // 0 (Sunday) to 6, for the old 'weekly'.
  weekday?: number;
  days?: number[];
  // Day of the month, 1 to 31. `monthDays` holds several.
  day?: number;
  monthDays?: number[];
  // 0 to 11; empty means every month.
  months?: number[];
  // 'interval': every so many minutes, between `from` and `to` (HH:MM) when both are set.
  minutes?: number;
  from?: string;
  to?: string;
  // 'custom': a five-field cron expression.
  cron?: string;
}

// One source of a 'gather' step (makeSource()).
export interface CronSource {
  id: string;
  // A key from SOURCES in js/cron.js ('open', 'page', 'flow', ...).
  source: string;
  label: string;
  projectId: string;
  url: string;
  text: string;
  // Runs for 'history', days for 'linkedin', hours ahead for 'meetings'.
  count: number;
  // How many linked pages a 'page' source follows.
  follow: number;
  flowId: string;
}

// One named field of a 'format' step in 'fields' mode (makeField()). value takes variables; a single {{name.path}}
// keeps the value whole.
export interface CronFormatField {
  id: string;
  name: string;
  value: string;
}

// A step (makeStep()). type: 'gather', 'ai', 'stop', 'format', 'parse', 'dedupe', 'ai-filter', 'loop', 'task', 'update', 'notify',
// 'profile', 'dev', 'linkedin-company', 'linkedin-people', 'linkedin-profile' or 'save-contacts'; each type uses some fields.
export interface CronStep {
  id: string;
  type: string;
  // The step whose output is its input; missing means the step before.
  from?: string;
  // gather
  sources?: CronSource[];
  append?: boolean;
  // Old gather steps held one source on the step itself.
  source?: string;
  url?: string;
  count?: number;
  follow?: number;
  flowId?: string;
  // ai
  prompt?: string;
  system?: string;
  // A prompt of js/prompts.js used as the system instructions while `system` is empty (a template's AI step).
  promptId?: string;
  model?: string;
  // task; a missing description is the input, as before it could be written.
  title?: string;
  description?: string;
  priority?: string;
  // A status key (missing means 'todo') and a task category's name ('' for none).
  status?: string;
  category?: string;
  due?: string;
  // The task to put it under: a task id, usually a variable such as {{step2}}; '' for none.
  parent?: string;
  // update: the task to change, a template such as {{step2}}. Its note is `description` (added below the task's own,
  // or in its place with mode 'replace'); an empty title, status, priority or due keeps the task's, and due 'clear'
  // removes it.
  taskId?: string;
  // task, profile, dev, old gather; '' follows the flow's project.
  projectId?: string;
  // stop ('nothing', 'empty', 'contains', 'lacks'); `text` is what contains/lacks look for. notify and old gather use
  // `text` too, and parse reads the JSON out of it.
  when?: string;
  text?: string;
  // profile: 'merge', 'replace' or 'keep'. Older steps have keepEdited instead.
  onEdited?: string;
  keepEdited?: boolean;
  // dev: 'claude', 'preset', 'custom' or 'command'. update: 'append' or 'replace'. format: 'text' (uses `text`), 'list'
  // or 'fields'. parse: which JSON value of several it keeps, 'largest', 'last', 'first' or 'all'.
  mode?: string;
  // dedupe: `items` is the list, `text` each item's key ('{{item.url}}'). match: 'title' (a task's title is the key) or
  // 'text' (its title or description holds it); scope: 'flow', 'project' or 'all', the tasks it compares with.
  match?: string;
  scope?: string;
  // format 'list', dedupe, ai-filter and loop: the list to read, as a variable ('{{input}}', '{{step2.items}}').
  items?: string;
  // ai-filter: which items to keep, in words (takes variables). mode 'keep' (the matching items) or 'rank' (the `top`
  // best by score). `text` is each item as the model reads it ('' for the item as JSON); `model` '' is Cron's default.
  criterion?: string;
  top?: number;
  // linkedin-company: `text` is the company's name, mode 'best' (one item with its page's details) or 'top' (the
  // `top` first matches). linkedin-people: `company` (an id, urn, page link or name; takes variables), title
  // `keywords`, `location` text matched on each result, `count` (at most 100) and `skipHidden` (missing means true).
  // linkedin-profile: `text` is the handle or link. save-contacts: `items`, `company` (each contact's company, a
  // template such as '{{item.company}}') and `projectId` ('' for the flow's).
  company?: string;
  keywords?: string;
  location?: string;
  skipHidden?: boolean;
  // format 'list': each item's text, and what goes between them ('line', 'blank', 'comma' or 'space').
  itemText?: string;
  separator?: string;
  // format 'fields'
  fields?: CronFormatField[];
  // loop: how many steps after it run once per item, and the most items it runs.
  span?: number;
  max?: number;
  preset?: string;
  devCommand?: string;
  // dev: claude's --model alias and --effort level; missing keeps the command's own.
  model?: string;
  effort?: string;
  command?: string;
  waitMinutes?: number;
  // Whether the run waits for the terminal; missing means wait unless it is the last step.
  wait?: boolean;
  // Ask claude to end with JSON the next steps can read.
  json?: boolean;
}

export interface CronFlow {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  // Flows saved before flows had a project lack it.
  projectId?: string;
  steps: CronStep[];
  // When it last started on schedule; '' for never.
  lastRun: string;
  created: string;
  // When it was last switched on.
  enabledAt?: string;
}

// A flow saved as a template: steps without ids.
export interface CronTemplate {
  id: string;
  name: string;
  about: string;
  schedule: CronSchedule;
  projectId: string;
  steps: Array<Omit<CronStep, 'id'>>;
  created: string;
}

export interface CronPr {
  repo: string;
  number: number;
  url: string;
}

// One Dev terminal a step started; a step in a loop starts one per item.
export interface CronRunTerminal {
  session: string;
  cwd: string;
  terminal: number;
  taskId?: string;
  worktree?: string;
  branch?: string;
}

// The Dev terminal a run is waiting on.
export interface CronRunCurrent {
  stepId: string;
  session: string;
  cwd: string;
  terminal: number;
  worktree?: string;
  taskId?: string;
  // The folder it works in (its worktree's, when it has one), and that folder as the step names it.
  work?: string;
  where?: string;
}

// What a run keeps of one step (stepRecord()).
export interface CronRunStep {
  stepId: string;
  type: string;
  ok: boolean;
  output: string;
  note: string;
  ms: number;
  // task: the task it made, the last one in a loop; taskIds has every one when it made more.
  // dev: the task the terminal worked on.
  taskId?: string;
  taskIds?: string[];
  // dev: the terminal, and what the session left.
  session?: string;
  cwd?: string;
  terminal?: number;
  worktree?: string;
  branch?: string;
  commit?: string;
  pr?: CronPr;
  // Number of changed files.
  files?: number;
  // Every terminal, when a loop started more than one.
  terminals?: CronRunTerminal[];
  // Every PR and issue the step's terminals printed.
  prs?: CronPr[];
  issues?: CronPr[];
}

export interface CronRun {
  id: string;
  flowId: string;
  at: string;
  manual: boolean;
  // A test run.
  dry: boolean;
  // 'running', 'ok', 'stopped' or 'error'.
  status: string;
  steps: CronRunStep[];
  error: string;
  // Last sign of life while running.
  beat?: string;
  current?: CronRunCurrent;
  ended?: string;
}

// A step's saved test result. `data` is kept only when it cannot be rebuilt from `output`.
export interface CronTest {
  ok: boolean;
  stepId?: string;
  output: string;
  note: string;
  ms: number;
  at: string;
  nothing?: boolean;
  // Waiting on a Dev terminal.
  pending?: boolean;
  data?: unknown;
}

export interface CronData {
  flows: CronFlow[];
  // Newest first.
  runs: CronRun[];
  templates: CronTemplate[];
  // The names of the built-in templates removed from the Templates tab.
  hiddenTemplates?: string[];
  // By flow id, then step id.
  tests: Record<string, Record<string, CronTest>>;
  schemaVersion?: number;
}
