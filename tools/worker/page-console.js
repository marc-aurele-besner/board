// A web page's console, read in headless Chrome: the page loads once at the size asked for (a browser's, a tablet's
// or a phone's), and what it logs for a few seconds comes back: console calls, uncaught errors, and the browser's
// own messages (a file that failed to load, a blocked request). Tasks shows it under a PR's preview site, whose
// console another page cannot read. Chrome is found where it installs, or at CHROME_PATH.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** @typedef {{ level: string, text: string, source?: string }} ConsoleEntry */

const ENTRIES_MAX = 300;
const TEXT_MAX = 2000;
const WAIT_MS = { min: 1000, def: 6000, max: 20000 };
const START_MS = 10000;

const CHROMES = {
  darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'],
  linux: ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium'],
  win32: ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe', 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'],
};
const chromePath = () => [process.env.CHROME_PATH ?? '', ...(/** @type {Record<string, string[]>} */ (CHROMES)[process.platform] ?? [])].find((p) => p && existsSync(p)) ?? '';

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));
const clip = (/** @type {string} */ text) => (text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX)}…` : text);

// A console call's arguments as text: strings as they are, other values as Chrome describes them.
/** @param {{ type?: string, value?: unknown, description?: string, unserializableValue?: string }[]} args */
const argsText = (args) => args.map((a) => (a.type === 'string' ? String(a.value) : a.description ?? a.unserializableValue ?? JSON.stringify(a.value))).join(' ');

/**
 * @param {{ url?: unknown, width?: unknown, height?: unknown, mobile?: unknown, colorScheme?: unknown, ms?: unknown }} body
 * @returns {Promise<{ entries: ConsoleEntry[], truncated: boolean, width: number, height: number, ms: number }>}
 */
export async function pageConsole(body) {
  const url = new URL(String(body.url ?? ''));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https pages can be read.');
  const width = Math.min(3840, Math.max(240, Number(body.width) || 1280));
  const height = Math.min(2160, Math.max(240, Number(body.height) || 800));
  const ms = Math.min(WAIT_MS.max, Math.max(WAIT_MS.min, Number(body.ms) || WAIT_MS.def));
  const chrome = chromePath();
  if (!chrome) throw new Error('No Chrome, Chromium or Edge found to read the console with. Install one, or set CHROME_PATH.');
  const dir = await mkdtemp(join(tmpdir(), 'board-console-'));
  const child = spawn(chrome, ['--headless=new', '--remote-debugging-port=0', `--user-data-dir=${dir}`, '--no-first-run', '--no-default-browser-check', '--disable-extensions', `--window-size=${width},${height}`, 'about:blank'], { stdio: 'ignore' });
  /** @type {any} */
  let ws = null;
  try {
    // Chrome writes the port it picked to this file once it listens.
    let port = 0;
    for (let waited = 0; !port && waited < START_MS; waited += 100) {
      await sleep(100);
      port = Number((await readFile(join(dir, 'DevToolsActivePort'), 'utf8').catch(() => '')).split('\n')[0]) || 0;
    }
    if (!port) throw new Error('Chrome did not start.');
    const targets = /** @type {{ type: string, webSocketDebuggerUrl: string }[]} */ (await (await fetch(`http://127.0.0.1:${port}/json`, {})).json());
    const page = targets.find((t) => t.type === 'page');
    if (!page) throw new Error('Chrome opened no page.');
    // Bun's, or Node 22's (Node 20 has none).
    const Socket = /** @type {any} */ (globalThis).WebSocket;
    if (!Socket) throw new Error('Reading a console needs the runners on Bun (bun start) or Node 22.');
    ws = new Socket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error('Could not talk to Chrome.'));
    });
    /** @type {ConsoleEntry[]} */
    const entries = [];
    let truncated = false;
    /** @param {ConsoleEntry} e */
    const add = (e) => {
      if (entries.length >= ENTRIES_MAX) truncated = true;
      else entries.push({ ...e, text: clip(e.text) });
    };
    let id = 0;
    /** @type {Map<number, (value: unknown) => void>} */
    const pending = new Map();
    /** @param {string} method @param {object} [params] */
    const send = (method, params = {}) => new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
    ws.onmessage = (/** @type {{ data: string }} */ m) => {
      const d = JSON.parse(m.data);
      if (d.id && pending.has(d.id)) {
        /** @type {(value: unknown) => void} */ (pending.get(d.id))(d.result);
        pending.delete(d.id);
      } else if (d.method === 'Runtime.consoleAPICalled') {
        const frame = d.params.stackTrace?.callFrames?.[0];
        add({ level: d.params.type, text: argsText(d.params.args ?? []), ...(frame?.url ? { source: `${frame.url}:${frame.lineNumber + 1}` } : {}) });
      } else if (d.method === 'Runtime.exceptionThrown') {
        const x = d.params.exceptionDetails;
        add({ level: 'error', text: x.exception?.description ?? x.text ?? 'Uncaught error', ...(x.url ? { source: `${x.url}:${x.lineNumber + 1}` } : {}) });
      } else if (d.method === 'Log.entryAdded') {
        const e = d.params.entry;
        // Chrome asks for /favicon.ico by itself; a site without one says nothing about the page.
        if (!/\/favicon\.ico(\?|$)/.test(e.url ?? '')) add({ level: e.level === 'verbose' ? 'debug' : e.level, text: e.text, ...(e.url ? { source: e.url } : {}) });
      }
    };
    await send('Runtime.enable');
    await send('Log.enable');
    const mobile = !!body.mobile;
    await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
    if (mobile) await send('Emulation.setTouchEmulationEnabled', { enabled: true });
    if (body.colorScheme === 'light' || body.colorScheme === 'dark') await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: body.colorScheme }] });
    await send('Page.navigate', { url: url.toString() });
    await sleep(ms);
    return { entries, truncated, width, height, ms };
  } finally {
    try {
      ws?.close();
    } catch {}
    child.kill();
    await sleep(300);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
