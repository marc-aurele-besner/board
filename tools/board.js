#!/usr/bin/env node
// The board from inside a Dev terminal: a claude session lists, reads, adds and edits its own tasks.
// `node "$BOARD_CLI" task <list|show|add|edit> …` (run with --help for the rest). It asks the runners
// (BOARD_API, http://127.0.0.1:8420 by default) with the terminal's BOARD_SESSION_TOKEN, which the command runner
// gives every command it starts; the runners decide what the session reaches (tools/worker/tasks.js).
export {}; // a module, for its top-level await

const HELP = `Usage: node "$BOARD_CLI" task <command> [options]

A Dev session's own tasks on the board: the task(s) it was started for, every task
under them, and every task it made. Nothing else can be read or changed.

Commands:
  task list [--q words] [--json]     The session's tasks as a tree. --q keeps tasks whose
                                     title or description holds every word: check for one
                                     already added (by another subagent too) before adding.
  task show <id> [--json]            One task, with its description.
  task add "title" [options]         A new task, under the session's task unless --parent
                                     names another of its tasks. Prints its id.
  task edit <id> [options]           Changes a task under the session's task, or one it made.
                                     The session's own task is read-only.

Options for add and edit:
  --description <text>   --status <parking|blocked|todo|paused|ondeck|doing|review|done>
  --priority <high|medium|low|none>   --due <YYYY-MM-DD, or "" for none>
  --category <name>      --parent <id>   (edit: --title <text> renames)

A session makes 100 tasks at most. Tasks it makes show a "Dev" badge on the board.`;

/** @param {string} text */
const die = (text) => {
  process.stderr.write(`${text}\n`);
  process.exit(1);
};

const FLAGS = ['description', 'status', 'priority', 'due', 'category', 'parent', 'title', 'q'];

// Positional words and --flag values ("--flag value" or "--flag=value"); --json and --help take none.
/** @param {string[]} argv */
function parse(argv) {
  /** @type {string[]} */
  const words = [];
  /** @type {Record<string, string>} */
  const flags = {};
  let json = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (!FLAGS.includes(name)) die(`Unknown option --${name}. See --help.`);
      const value = inline ?? argv[++i];
      if (value === undefined) die(`--${name} needs a value.`);
      flags[name] = value;
    } else words.push(arg);
  }
  return { words, flags, json, help };
}

/** @param {string} path @param {Record<string, unknown>} body */
async function call(path, body) {
  const token = process.env.BOARD_SESSION_TOKEN;
  if (!token) die('No BOARD_SESSION_TOKEN: this is not a terminal the board opened in Dev, so it has no tasks to reach.');
  const base = (process.env.BOARD_API || 'http://127.0.0.1:8420').replace(/\/+$/, '');
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { origin: 'http://localhost', 'content-type': 'application/json' },
      body: JSON.stringify({ token, ...body }),
    });
  } catch {
    return die(`The board's runners are not answering at ${base}. Is the board running (bun start)?`);
  }
  const text = await res.text();
  /** @type {any} */ // any: the runners' answer, read field by field below
  let answer;
  try {
    answer = JSON.parse(text);
  } catch {
    answer = { ok: false, error: text };
  }
  if (!res.ok || answer?.ok === false) die(`Refused: ${answer?.error || `${res.status} ${res.statusText}`}`);
  return answer;
}

/** @param {{ id: string, text: string, status: string, priority: string, due: string, root?: boolean, mine?: boolean }} t */
const line = (t) => {
  const marks = [t.status, t.priority !== 'none' ? t.priority : '', t.due ? `due ${t.due}` : '', t.root ? 'this session\'s task, read-only' : '', t.mine ? 'made by this session' : ''].filter(Boolean);
  return `${t.id}  ${t.text}  [${marks.join(', ')}]`;
};

/** @param {Record<string, string>} flags */
function fieldsOf(flags) {
  /** @type {Record<string, string>} */
  const fields = {};
  for (const key of ['description', 'status', 'priority', 'due', 'category']) if (key in flags) fields[key] = flags[key];
  if ('parent' in flags) fields.parentId = flags.parent;
  return fields;
}

const { words, flags, json, help } = parse(process.argv.slice(2));
const [scope, command, ...rest] = words;
if (help || !scope) {
  console.log(HELP);
  process.exit(0);
}
if (scope !== 'task') die(`Unknown command "${scope}". See --help.`);

/** @param {unknown} value @param {() => void} print */
const show = (value, print) => (json ? console.log(JSON.stringify(value, null, 2)) : print());

if (command === 'list') {
  const answer = await call('/tasks/list', { q: flags.q ?? '' });
  show(answer, () => {
    if (!answer.roots.length) console.log('This session was not started on a task: what it adds waits in To Organize.');
    if (!answer.tasks.length) console.log(flags.q ? 'No task matches.' : 'No tasks yet.');
    for (const t of answer.tasks) console.log(`${'  '.repeat(t.depth)}${line(t)}`);
    console.log(`\nMade by this session: ${answer.made} of ${answer.limit}.`);
  });
} else if (command === 'show') {
  if (!rest[0]) die('Name the task: task show <id>.');
  const t = await call('/tasks/show', { id: rest[0] });
  show(t, () => {
    console.log(line(t));
    if (t.parentId) console.log(`under ${t.parentId}`);
    if (t.category) console.log(`category ${t.category}`);
    if (t.description) console.log(`\n${t.description}`);
  });
} else if (command === 'add') {
  const text = rest.join(' ').trim();
  if (!text) die('Give the task a title: task add "title".');
  const t = await call('/tasks/add', { text, ...fieldsOf(flags), cwd: process.cwd() });
  show(t, () => console.log(`Added ${line(t)}${t.parentId ? ` under ${t.parentId}` : ' to To Organize'}`));
} else if (command === 'edit') {
  if (!rest[0]) die('Name the task: task edit <id> [options].');
  const t = await call('/tasks/edit', { id: rest[0], ...fieldsOf(flags), ...('title' in flags ? { text: flags.title } : {}) });
  show(t, () => console.log(`Saved ${line(t)}`));
} else die(`Unknown task command "${command ?? ''}". See --help.`);
