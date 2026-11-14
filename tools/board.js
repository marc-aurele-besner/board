#!/usr/bin/env node
// The board from inside a Dev terminal: a claude session lists, reads, adds and edits its own tasks, sees the other
// sessions on them, reads their project and brand, and reads and adds their images.
// `node "$BOARD_CLI" task <list|show|add|edit|sessions> …`, `session`, `project`, `brand`, `image` (see --help). It asks the runners
// (BOARD_API, http://127.0.0.1:8420 by default) with the terminal's BOARD_SESSION_TOKEN, which the command runner
// gives every command it starts; the runners decide what the session reaches (tools/worker/tasks.js).
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, extname, join, resolve } from 'node:path';

const HELP = `Usage: node "$BOARD_CLI" <task|session|project|brand|image> [options]

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
  task sessions [id]                 Same as session, for one task (default: all of them).

  session                            The other open Dev terminals on this session's tasks:
                                     their worktree or folder, branch, last commit and
                                     uncommitted files. Check it before coding, so work
                                     done elsewhere is not done twice.
  project [--project id]             The project of the session's task: description, folder,
                                     repos, links and its saved profile.
  brand [--css|--json] [--project id]  The project's saved brand (colours, fonts, images,
                                     links). --css prints CSS custom properties.
  image list <task>                  The task's images, numbered.
  image get <task> [n] [--out path]  Saves image n (default: all) to a local file and prints
                                     its path, to read it. --out names a file or a folder.
  image add <task> <file> [--name t] Attaches a PNG, JPEG, GIF or WebP file (5 MB at most)
                                     to the task, e.g. a screenshot proving a change works.

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

const FLAGS = ['description', 'status', 'priority', 'due', 'category', 'parent', 'title', 'q', 'project', 'out', 'name'];

// Positional words and --flag values ("--flag value" or "--flag=value"); --json and --help take none.
/** @param {string[]} argv */
function parse(argv) {
  /** @type {string[]} */
  const words = [];
  /** @type {Record<string, string>} */
  const flags = {};
  let json = false;
  let css = false;
  let help = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') json = true;
    else if (arg === '--css') css = true;
    else if (arg === '--help' || arg === '-h') help = true;
    else if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split(/=(.*)/s);
      if (!FLAGS.includes(name)) die(`Unknown option --${name}. See --help.`);
      const value = inline ?? argv[++i];
      if (value === undefined) die(`--${name} needs a value.`);
      flags[name] = value;
    } else words.push(arg);
  }
  return { words, flags, json, css, help };
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

const { words, flags, json, css, help } = parse(process.argv.slice(2));
const [scope, command, ...rest] = words;
if (help || !scope) {
  console.log(HELP);
  process.exit(0);
}
if (!['task', 'session', 'sessions', 'project', 'brand', 'image'].includes(scope)) die(`Unknown command "${scope}". See --help.`);

/** @param {unknown} value @param {() => void} print */
const show = (value, print) => (json ? console.log(JSON.stringify(value, null, 2)) : print());

/** @param {number} ms */
const ago = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  return min < 60 ? `${min} min ago` : min < 2880 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
};

/** @param {string} [task] */
async function sessions(task) {
  const answer = await call('/sessions/peers', { task: task ?? '' });
  show(answer, () => {
    if (!answer.peers.length) return console.log(task ? `No other open terminal works on ${task}.` : 'No other open terminal works on this session\'s tasks.');
    for (const p of answer.peers) {
      console.log(`Terminal ${p.n} (${p.state}${p.claude ? ', claude' : ''}${p.started ? `, started ${ago(p.started)}` : ''})`);
      const row = (/** @type {string} */ label, /** @type {string} */ value) => console.log(`  ${label.padEnd(9)}${value}`);
      for (const t of p.tasks) row('task', `${t.id}  ${t.text}`);
      row(p.worktree ? 'worktree' : 'folder', p.dir || '(unknown)');
      if (p.branch) row('branch', p.branch);
      if (p.commit) row('commit', p.commit);
      if (p.changes !== null) row('changes', p.changes ? `${p.changes} uncommitted file(s)` : 'none uncommitted');
    }
  });
}

if (scope === 'session' || scope === 'sessions') {
  await sessions(command === 'list' ? '' : command);
  process.exit(0);
}

if (scope === 'project') {
  const p = await call('/project', { project: flags.project ?? '', cwd: process.cwd() });
  show(p, () => {
    console.log(`${p.name}  (${p.id})`);
    if (p.description) console.log(p.description);
    const rows = [['folder', p.folder], ['website', p.website], ['labels', p.labels.join(', ')], ['parent', p.parent], ['subprojects', p.subprojects.join(', ')],
      ['github', [p.github.org, ...p.github.repos.map((/** @type {{ url: string }} */ r) => r.url)].filter(Boolean).join('  ')], ['npm', [p.npm.org, ...p.npm.packages].filter(Boolean).join('  ')]];
    console.log('');
    for (const [key, value] of rows) if (value) console.log(`${key.padEnd(12)}${value}`);
    if (p.links.length) console.log(`\nLinks:\n${p.links.map((/** @type {string} */ l) => `  ${l}`).join('\n')}`);
    console.log(p.profile.text ? `\nProfile${p.profile.updated ? ` (${p.profile.updated.slice(0, 10)})` : ''}:\n${p.profile.text}` : '\nNo saved profile yet (the project\'s page on the board builds one).');
  });
  process.exit(0);
}

if (scope === 'brand') {
  const b = await call('/project/brand', { project: flags.project ?? '' });
  if (css) process.stdout.write(b.css);
  else show(b, () => {
    console.log(`${b.project.name}'s brand${b.updated ? ` (${b.updated.slice(0, 10)})` : ''}`);
    const empty = !['colors', 'fonts', 'images', 'links'].some((k) => b[k].length) && !b.notes.trim();
    if (empty) return console.log('Nothing saved yet (the project\'s page on the board has Find with AI).');
    for (const k of ['colors', 'fonts', 'images', 'links']) {
      if (!b[k].length) continue;
      console.log(`\n${k[0].toUpperCase()}${k.slice(1)}:`);
      for (const item of b[k]) console.log(`  ${item.label ? `${item.label}: ` : ''}${item.value}${item.file ? `  (${item.file})` : ''}`);
    }
    if (b.notes.trim()) console.log(`\nNotes:\n${b.notes.trim()}`);
  });
  process.exit(0);
}

if (scope === 'image') {
  const id = rest[0];
  if (!id) die(`Name the task: image ${command ?? 'list'} <task>.`);
  /** @param {{ n: number, name: string, type: string, file: string }} img */
  const imageLine = (img) => `${String(img.n).padStart(2)}  ${img.name}  [${img.type}]`;
  if (command === 'list') {
    const answer = await call('/images/list', { id });
    show(answer, () => {
      if (!answer.images.length) return console.log(`Task ${id} has no images.`);
      for (const img of answer.images) console.log(imageLine(img));
    });
  } else if (command === 'get') {
    const answer = await call('/images/list', { id });
    const n = rest[1] ? Number(rest[1]) : 0;
    if (rest[1] && !answer.images.some((/** @type {{ n: number }} */ img) => img.n === n)) die(`Task ${id} has no image ${rest[1]}; it has ${answer.images.length}.`);
    const picked = answer.images.filter((/** @type {{ n: number }} */ img) => !n || img.n === n);
    if (!picked.length) die(`Task ${id} has no images.`);
    // --out: a file for one image, else a folder; by default a folder of its own in the system's temp folder.
    const out = flags.out ? resolve(flags.out) : join(tmpdir(), 'board-images', id);
    const isDir = !flags.out || picked.length > 1 || (statSync(out, { throwIfNoEntry: false })?.isDirectory() ?? !extname(out));
    mkdirSync(isDir ? out : resolve(out, '..'), { recursive: true });
    /** @type {string[]} */
    const saved = [];
    for (const img of picked) {
      const target = isDir ? join(out, `${img.n}-${basename(img.file)}`) : out;
      try {
        copyFileSync(img.file, target);
      } catch {
        die(`Image ${img.n} (${img.name}) is no longer in the data folder.`);
      }
      saved.push(target);
    }
    show({ saved }, () => saved.forEach((path) => console.log(path)));
  } else if (command === 'add') {
    if (!rest[1]) die('Name the file: image add <task> <file>.');
    const answer = await call('/images/add', { id, file: resolve(rest[1]), name: flags.name ?? '' });
    show(answer, () => console.log(`Added ${imageLine(answer.images.at(-1))} to ${id}; it has ${answer.images.length} image(s).`));
  } else die(`Unknown image command "${command ?? ''}". See --help.`);
  process.exit(0);
}

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
} else if (command === 'sessions') {
  await sessions(rest[0]);
} else die(`Unknown task command "${command ?? ''}". See --help.`);
