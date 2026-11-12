// The Dev section's calls to the command runner on this machine (tools/terminal.js, started by `bun start`).
export const TERMINAL_RUNNER = 'http://127.0.0.1:8419';

const unreachable = (base) => new Error(`Could not reach the terminal runner at ${base}. In the board folder, run bun start (or bun dev) and keep it open.`);

// The runner answers only requests with a local Origin. A page sends one by itself; the runners (Node) set it here.
let origin = null;
export const useRunnerOrigin = (value) => {
  origin = value;
};

async function call(base, path, init) {
  let res;
  try {
    res = await fetch(`${base}${path}`, origin ? { ...init, headers: { ...init?.headers, origin } } : init);
  } catch (err) {
    throw err.name === 'AbortError' ? err : unreachable(base);
  }
  if (!res.ok) throw new Error((await res.text()) || `The runner answered ${res.status}.`);
  return res;
}
const post = (body, signal) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });

// The board's folder, the home folder, the shell, and how many commands may run at once.
export const runnerInfo = async (base) => (await call(base, '/info')).json();

// The open terminals, kept by the runner so every browser shows the same ones: { active, sessions: [{ id, n, cwd,
// tasks?, prompt? }] }, sessions being null before any were saved.
export const listSessions = async (base) => (await call(base, '/sessions')).json();
export const saveSessionList = (base, list) => call(base, '/sessions', post(list));

// What sessions are doing, by id: { state, code?, cwd }, state being working, waiting (running but quiet: the
// program waits for its user), done, failed, stopped or idle. Sessions the runner no longer has are left out.
export const sessionStatus = async (base, ids) => (ids.length ? (await call(base, `/status?sessions=${ids.map(encodeURIComponent).join(',')}`)).json() : {});

// A folder's entries ({ name, dir }), folders first.
export const listFolder = async (base, path) => (await call(base, `/files?path=${encodeURIComponent(path)}`)).json();

// One file: { path, size, text }, or { binary } / { tooLarge } instead of text.
export const readFile = async (base, path) => (await call(base, `/file?path=${encodeURIComponent(path)}`)).json();

// Every terminal of the page is read through one stream from the runner: a browser opens only six connections to
// a host, and a stream per terminal used them up, so a third or fourth terminal's command never reached the runner.
// The page attaches and detaches sessions on its stream; each event names its session as `s`.
const hubs = new Map();

function hubOf(base) {
  let hub = hubs.get(base);
  if (hub) return hub;
  const ctl = new AbortController();
  hub = { client: crypto.randomUUID(), ctl, subs: new Map(), queue: Promise.resolve() };
  hubs.set(base, hub);
  hub.ready = call(base, `/stream?client=${hub.client}`, { signal: ctl.signal });
  const current = hub;
  hub.ready.then((res) => readStream(current, res)).catch(() => {}).finally(() => endStream(base, current));
  return hub;
}

async function readStream(hub, res) {
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let nl;
    while ((nl = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      const { s: id, ...event } = JSON.parse(line);
      const sub = hub.subs.get(id);
      if (!sub) continue;
      // Events from before this attach (a detach the runner had not read yet) are skipped until its replay starts.
      if (event.t === 'session') sub.started = true;
      if (event.t === 'closed') sub.done();
      else if (sub.started) sub.onEvent(event);
    }
  }
}

// The stream ended (the runner stopped, or no terminal is attached any more): every attach ends with it.
function endStream(base, hub) {
  if (hubs.get(base) === hub) hubs.delete(base);
  hub.ctl.abort();
  for (const sub of [...hub.subs.values()]) sub.done();
}

// Attach and detach calls of one stream are sent one after another, so a quick detach then attach keep their order.
function control(base, hub, path, session) {
  hub.queue = hub.queue
    .then(() => hub.ready)
    .then(() => call(base, path, post({ client: hub.client, session })))
    .catch(() => {});
  return hub.queue;
}

// Attaches to a terminal session and calls onEvent for each of its events: `session` (known: whether the runner had
// it), the events so far (start, out, err, size, cwd, exit), `live`, then new events as they come. Resolves when
// `signal` is aborted, the session is closed, or the runner stops.
export function attachSession(base, { session, signal, onEvent }) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const hub = hubOf(base);
    const sub = { onEvent, started: false };
    const onAbort = () => {
      if (hub.subs.get(session) !== sub) return resolve();
      sub.done();
      if (hub.subs.size) control(base, hub, '/detach', session);
      else endStream(base, hub);
    };
    sub.done = () => {
      if (hub.subs.get(session) === sub) hub.subs.delete(session);
      signal?.removeEventListener('abort', onAbort);
      resolve();
    };
    signal?.addEventListener('abort', onAbort);
    hub.subs.get(session)?.done();
    hub.subs.set(session, sub);
    control(base, hub, '/attach', session);
  });
}

// Runs one command in a session's terminal of `cols` × `rows`, telling it the theme ('light' or 'dark'). Its output
// reaches the session's attached stream; the command keeps running if the page goes away.
export const runCommand = async (base, { session, command, cwd, cols, rows, theme }) => (await call(base, '/run', post({ session, command, cwd, cols, rows, theme }))).json();

// Stops the session's command; empties its kept output; or stops it and forgets the session.
export const stopCommand = (base, session) => call(base, '/stop', post({ session }));
export const clearSession = (base, session) => call(base, '/clear', post({ session }));
export const closeSession = (base, session) => call(base, '/close', post({ session }));

// Stops the session and removes the worktree `name` that claude made in the repo at `cwd`, or the worktree at `path`
// (any but the main checkout): { removed } or { missing }. Fails when git refuses (changes or untracked files in it)
// or claude still runs there.
export const removeWorktree = async (base, { cwd, name, path, session }) => (await call(base, '/worktree/remove', post({ cwd, name, path, session }))).json();

// The worktrees of the repository holding `path`, but its main checkout: { repo: false }, or { root, worktrees:
// [{ path, name, branch, head, claude, locked, prunable, pid, running, commands, changes }] }.
export const listWorktrees = async (base, path) => (await call(base, `/worktrees?path=${encodeURIComponent(path)}`)).json();

// What a terminal left behind, for the Cron step after it: { output } (the end of its raw output), and when `path`
// is in a repository { repo: true, root, branch, upstream, ahead, behind, base, commit, short, subject, commits:
// [{ hash, short, subject }], files: [{ status, path, from? }], more, uncommitted }.
export const sessionOutcome = async (base, { session, path }) => (await call(base, `/outcome?${new URLSearchParams({ session, path })}`)).json();

// What the claude sessions in worktrees [{ name, cwd }] used, from Claude Code's transcripts: { [name]: { sessions,
// models: { [id]: { provider, input, output, thinking, cacheRead, cacheWrite, cost } }, cost, duration, apiDuration,
// linesAdded, linesRemoved, efforts, replies, start, end } }. Worktrees with no transcript are left out.
export const worktreeUsage = async (base, worktrees) => (await call(base, '/usage', post({ worktrees }))).json();

// Saves an image (a Blob of a PNG, JPEG, GIF or WebP) on this machine for claude to read: { path }.
export const saveImage = async (base, blob) => (await call(base, '/image', { method: 'POST', headers: { 'content-type': blob.type }, body: blob })).json();

// Keys for a running command, or its terminal's new size. Calls for one command are sent one after another,
// so fast typing arrives in order.
const queues = new Map();
export function sendInput(base, pid, body) {
  const next = (queues.get(pid) ?? Promise.resolve()).then(() => call(base, '/input', post({ pid, ...body }))).catch(() => {});
  queues.set(pid, next);
  next.then(() => queues.get(pid) === next && queues.delete(pid));
  return next;
}

// Source control. A folder's repository: { repo: false } outside one, else its branch, ahead/behind its upstream,
// changed files ({ path, orig?, index, work, untracked?, conflict? }, git's status letters), branches and recent commits.
export const gitStatus = async (base, path) => (await call(base, `/git?path=${encodeURIComponent(path)}`)).json();

// A file's changes as a unified diff ({ diff }), staged or not; or a commit's, with { commit } describing it.
export const gitDiff = async (base, params) => (await call(base, `/git/diff?${new URLSearchParams(params)}`)).json();

// Changes the repository: stage, unstage, discard, commit, fetch, pull, push, checkout, branch or init.
export const gitAction = async (base, path, action, body = {}) => (await call(base, '/git', post({ path, action, ...body }))).json();

// Search in files: the lines holding `q` under `path` ({ path, matches: [{ path, line, col, text }], more }).
// Options: case, word, regex ('1' to turn on), include and exclude (comma-separated globs).
export const searchFiles = async (base, params) => (await call(base, `/search?${new URLSearchParams(params)}`)).json();
