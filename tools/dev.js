// `bun dev`: the board for working on the board itself. The static server and the worker run under `bun --watch`,
// which restarts them when a file they import changes. The command runner runs apart and is never restarted:
// restarting it stops every command in Dev's terminals, and a pull that changes `tools/` would end every claude
// session at once. After changing tools/terminal.js, restart `bun dev` to run the new code.
// Ctrl+C stops both.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const bun = process.execPath;
const file = (/** @type {string} */ name) => fileURLToPath(new URL(name, import.meta.url));
const children = [
  spawn(bun, [file('terminal.js')], { stdio: 'inherit' }),
  spawn(bun, ['--watch', '--no-clear-screen', file('start.js'), '--no-terminal'], { stdio: 'inherit' }),
];

// One ending (a port in use, a crash) ends the other, so `bun dev` never runs half the board.
let ending = false;
/** @param {number} code */
function end(code) {
  if (ending) return;
  ending = true;
  for (const child of children) if (child.exitCode === null) child.kill('SIGTERM');
  process.exitCode = code;
}
for (const child of children) child.on('exit', (code) => end(code ?? 0));
for (const signal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) process.on(signal, () => end(0));
