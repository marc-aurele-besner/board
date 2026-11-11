// The Dev section's calls to the command runner on this machine (tools/terminal.js, started by `bun start`).
export const TERMINAL_RUNNER = 'http://127.0.0.1:8419';

const unreachable = (base) => new Error(`Could not reach the terminal runner at ${base}. In the board folder, run bun start (or bun dev) and keep it open.`);

// The board's folder, the home folder, the shell, and how many commands may run at once.
export async function runnerInfo(base) {
  let res;
  try {
    res = await fetch(`${base}/info`);
  } catch {
    throw unreachable(base);
  }
  if (!res.ok) throw new Error((await res.text()) || `The runner answered ${res.status}.`);
  return res.json();
}

// Runs one command and calls onEvent for each line the runner streams: start, out, err, cwd and exit.
// Aborting `signal` closes the stream, and the runner then stops the command.
export async function runCommand(base, { command, cwd, signal, onEvent }) {
  let res;
  try {
    res = await fetch(`${base}/run`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, cwd }), signal });
  } catch (err) {
    throw err.name === 'AbortError' ? err : unreachable(base);
  }
  if (!res.ok) throw new Error((await res.text()) || `The runner answered ${res.status}.`);
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
