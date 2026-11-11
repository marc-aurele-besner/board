// Starts everything the board runs on this machine, side by side in one process: the static server and the API
// relays. Each prints its own lines, prefixed with its name. `bun start` (or `node tools/start.js`).
// PORT, BING_PORT and RESEND_PORT change the ports. Ctrl+C stops them all.
// `bun dev` runs this file under `bun --watch`, which restarts it when any file it imports changes.
import './serve.js';
import './relays.js';
