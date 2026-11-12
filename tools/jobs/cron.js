// @ts-check
// Starts the Cron flows that are due, every minute. isDue() runs one missed slot once, not every missed slot, so a Mac
// waking after a night runs a daily flow once. Only this job runs flows on schedule, so two open tabs and the runners
// run a due flow once, not three times. The board's Run now asks it for one flow (POST /run/cron { flowId }).
// Flows are started, not awaited: a Run in Dev step can wait an hour for its terminal, and the next due flow should not
// wait for it. runFlow() marks a flow's lastRun before its first step, so the next tick does not start it again.
/** @import { CronFlow } from '../../types/data' */
/** @import { Job, Logger, NodeStore } from '../../types/runner' */
import { isDue, runFlow, isRunning, COLLECTION } from '../../js/cron.js';
import { useRunnerOrigin } from '../../js/terminal.js';

/** @param {NodeStore} store @param {Logger} log @param {CronFlow} flow */
function start(store, log, flow, manual = false) {
  runFlow(store, flow.id, { manual })
    .then((run) => {
      if (run) log[run.status === 'error' ? 'error' : 'info'](`cron flow “${flow.name}”: ${run.status}${run.error ? ` (${run.error})` : ''}`);
    })
    .catch((err) => log.error(`cron flow “${flow.name}” failed: ${err.message}`));
}

export default /** @satisfies {Job} */ ({
  id: 'cron',
  delay: 4000,
  timeout: 60000,
  setup() {
    // Run in Dev asks the command runner, which answers only requests with a local Origin.
    useRunnerOrigin('http://localhost');
  },
  async run({ store, params, log }) {
    const flows = store.get(COLLECTION).flows;
    if (params.flowId) {
      const flow = flows.find((f) => f.id === params.flowId);
      if (!flow) throw new Error('That flow does not exist any more.');
      if (isRunning(flow.id)) throw new Error('That flow is running already.');
      start(store, log, flow, true);
      return { started: 1 };
    }
    const at = new Date();
    const due = flows.filter((f) => isDue(f, at) && !isRunning(f.id));
    for (const flow of due) start(store, log, flow);
    return due.length ? { started: due.length } : {};
  },
});
