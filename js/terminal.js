// The Dev section's calls to the command runner on this machine (tools/terminal.js, started by `bun start`).
export const TERMINAL_RUNNER = 'http://127.0.0.1:8419';

const unreachable = (base) => new Error(`Could not reach the terminal runner at ${base}. In the board folder, run bun start (or bun dev) and keep it open.`);

async function call(base, path, init) {
  let res;
  try {
    res = await fetch(`${base}${path}`, init);
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

// Attaches to a terminal session and calls onEvent for each line the runner streams: `session` (known: whether
// the runner had it), the events so far (start, out, err, size, cwd, exit), `live`, then new events as they come.
// The stream ends when `signal` is aborted, the session is closed, or the runner stops.
export async function attachSession(base, { session, signal, onEvent }) {
  const res = await call(base, `/attach?session=${encodeURIComponent(session)}`, { signal });
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end);
      buffer = buffer.slice(end + 1);
      if (line) onEvent(JSON.parse(line));
    }
  }
}

// Runs one command in a session's terminal of `cols` × `rows`, telling it the theme ('light' or 'dark'). Its output
// reaches the session's attached stream; the command keeps running if the page goes away.
export const runCommand = async (base, { session, command, cwd, cols, rows, theme }) => (await call(base, '/run', post({ session, command, cwd, cols, rows, theme }))).json();

// Stops the session's command; empties its kept output; or stops it and forgets the session.
export const stopCommand = (base, session) => call(base, '/stop', post({ session }));
export const clearSession = (base, session) => call(base, '/clear', post({ session }));
export const closeSession = (base, session) => call(base, '/close', post({ session }));

// Stops the session and removes the worktree `name` that claude made in the repo at `cwd`: { removed } or { missing }.
// Fails when git refuses (changes or untracked files in it) or claude still runs there.
export const removeWorktree = async (base, { cwd, name, session }) => (await call(base, '/worktree/remove', post({ cwd, name, session }))).json();

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
