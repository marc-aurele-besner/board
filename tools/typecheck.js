// @ts-check
// Runs the type check of the browser code (jsconfig.json) and of the runner (tools/jsconfig.json).
// The runner imports modules from js/, so its program also holds them, but without the DOM types they are checked
// against in the browser config. Their errors there belong to the browser check, so only errors in tools/ count here.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsc = createRequire(import.meta.url).resolve('typescript/bin/tsc');

/** @param {string} config @returns {string[]} each error with its continuation lines */
function run(config) {
  const out = spawnSync(process.execPath, [tsc, '-p', config, '--pretty', 'false'], { cwd: root, encoding: 'utf8' });
  if (out.error) throw out.error;
  /** @type {string[]} */
  const errors = [];
  for (const line of `${out.stdout}${out.stderr}`.split('\n')) {
    if (!line.trim()) continue;
    if (/^\s/.test(line) && errors.length) errors[errors.length - 1] += `\n${line}`;
    else errors.push(line);
  }
  return errors;
}

const browser = run('jsconfig.json');
const runner = run('tools/jsconfig.json').filter((e) => e.startsWith('tools/') || !/^[^(\s]+\(\d+,\d+\)/.test(e));
for (const e of [...browser, ...runner]) console.log(e);
const count = browser.length + runner.length;
if (count) {
  console.log(`\n${count} type error${count === 1 ? '' : 's'}.`);
  process.exit(1);
}
console.log('Type check passed.');
