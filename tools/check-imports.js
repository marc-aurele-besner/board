// @ts-check
// Loads every module the worker runs under plain Node, with no browser globals. `node --check` does not catch a
// missing import, or a module that touches document, window or localStorage when it loads; this does.
// `node tools/check-imports.js`: prints each failure and exits 1 when there is one.
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const files = [
  ...readdirSync(join(ROOT, 'tools/jobs')).filter((f) => f.endsWith('.js')).map((f) => `tools/jobs/${f}`),
  ...readdirSync(join(ROOT, 'tools/worker')).filter((f) => f.endsWith('.js')).map((f) => `tools/worker/${f}`),
  'js/runner-jobs.js',
];

for (const name of ['window', 'document', 'localStorage', 'location']) {
  if (name in globalThis) console.warn(`${name} is defined here, so a module that reads it at load time is not caught.`);
}

let failed = 0;
for (const file of files) {
  try {
    await import(pathToFileURL(join(ROOT, file)).href);
  } catch (err) {
    failed += 1;
    console.error(`FAIL ${file}: ${/** @type {Error} */ (err).message.split('\n')[0]}`);
  }
}
console.log(`${files.length - failed} of ${files.length} worker modules load under Node.`);
process.exit(failed ? 1 : 0);
