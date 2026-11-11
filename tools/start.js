// Starts everything the board runs on this machine, side by side in one process: the static server and the API
// relays. `bun tools/start.js` (or `node tools/start.js`). PORT, BING_PORT and RESEND_PORT change the ports.
// Ctrl+C stops them all.
import './serve.js';
import './relays.js';
