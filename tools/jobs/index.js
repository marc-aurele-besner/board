// Every job the worker runs. Each file in this folder exports one job: { id, timeout, delay, setup(store), run(ctx) }.
// Its label and default interval are in js/runner-jobs.js, which Settings → Runners reads too.
import google from './google.js';
import gmail from './gmail.js';
import resend from './resend.js';

export const jobs = [google, gmail, resend];
