// Every job the worker runs. Each file in this folder exports one job: { id, every, timeout, delay, run(ctx) }.
// Its label and default interval are in js/runner-jobs.js, which Settings → Runners reads too.
export const jobs = [];
