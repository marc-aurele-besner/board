// Starts everything the board runs on this machine, side by side in one process: the static server, the Dev
// section's command runner and the runners (the worker that does the background work). Each prints its own lines, prefixed with its name.
// `bun start` (or `node tools/start.js`).
// PORT, TERMINAL_PORT and WORKER_PORT change the ports; BOARD_DATA sets the runners' data folder. Ctrl+C stops them all.
// With --no-terminal it leaves the command runner out: `bun dev` (tools/dev.js) runs that one apart, unwatched.
import './serve.js';
import './worker.js';

if (!process.argv.includes('--no-terminal')) await import('./terminal.js');
