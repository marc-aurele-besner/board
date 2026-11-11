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

// A folder's entries ({ name, dir }), folders first.
export const listFolder = async (base, path) => (await call(base, `/files?path=${encodeURIComponent(path)}`)).json();

// One file: { path, size, text }, or { binary } / { tooLarge } instead of text.
export const readFile = async (base, path) => (await call(base, `/file?path=${encodeURIComponent(path)}`)).json();

// Runs one command in a terminal of `cols` × `rows`, telling it the theme ('light' or 'dark'), and calls onEvent for each line the runner streams: start,
// out, err, cwd and exit. Aborting `signal` closes the stream, and the runner then stops the command.
export async function runCommand(base, { command, cwd, cols, rows, theme, signal, onEvent }) {
  const res = await call(base, '/run', post({ command, cwd, cols, rows, theme }, signal));
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

// Keys for a running command, or its terminal's new size. Calls for one command are sent one after another,
// so fast typing arrives in order.
const queues = new Map();
export function sendInput(base, pid, body) {
  const next = (queues.get(pid) ?? Promise.resolve()).then(() => call(base, '/input', post({ pid, ...body }))).catch(() => {});
  queues.set(pid, next);
  next.then(() => queues.get(pid) === next && queues.delete(pid));
  return next;
}
