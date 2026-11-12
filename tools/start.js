// Starts everything the board runs on this machine, side by side in one process: the static server, the Dev
// section's command runner and the runners (the worker that does the background work). Each prints its own lines, prefixed with its name.
// `bun start` (or `node tools/start.js`).
// PORT, TERMINAL_PORT and WORKER_PORT change the ports; BOARD_DATA sets the runners' data folder. Ctrl+C stops them all.
// `bun dev` runs this file under `bun --watch`, which restarts it when any file it imports changes.
import './serve.js';
import './terminal.js';
import './worker.js';
