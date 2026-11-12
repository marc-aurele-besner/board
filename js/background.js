// Work that runs by itself while the board is open: Cron flows.
// Nothing here runs when the board is closed. The runners (tools/worker.js) do the rest of the background work.
import { runDueFlows } from './cron.js';

const MINUTE = 60000;
let started = false;

export function startBackground(store) {
  if (started) return;
  started = true;
  const cron = () => Promise.resolve().then(() => runDueFlows(store)).catch((err) => console.warn('Background work failed', err));
  // Start after the first paint, so opening the board is never held up by the network.
  setTimeout(cron, 4000);
  setInterval(cron, MINUTE);
}
