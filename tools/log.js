// Terminal lines for each runner, prefixed with its name, so the board and the relays can share one terminal.
// Colours only when the output is a terminal, and never with NO_COLOR set.
/** @import { Logger } from '../types/runner' */
const COLOR = process.stdout.isTTY && !process.env.NO_COLOR;
/** @param {number} code @param {string | number} text */
const paint = (code, text) => (COLOR ? `\x1b[${code}m${text}\x1b[0m` : text);
/** @type {Record<string, number>} */
const TAGS = { board: 36, terminal: 32, worker: 34 };
const WIDTH = Math.max(...Object.keys(TAGS).map((n) => n.length));

const clock = () => new Date().toLocaleTimeString(undefined, { hour12: false });
/** @param {number} status */
const statusColor = (status) => (status >= 500 ? 31 : status >= 400 ? 33 : 32);

/** @param {string} name @returns {Logger} */
export function logger(name) {
  const tag = paint(TAGS[name] ?? 90, name.padEnd(WIDTH));
  /** @param {string | number} text */
  const line = (text) => `${tag} ${paint(90, clock())}  ${text}`;
  return {
    /** @param {string} text */
    info: (text) => console.log(line(text)),
    /** @param {string} text */
    error: (text) => console.error(line(paint(31, text))),
    // Only the path: a query can hold an API key (Bing takes its key there).
    /** @param {string | undefined} method @param {string} path @param {number} status @param {number} ms */
    request: (method, path, status, ms) => console.log(line(`${method} ${path} ${paint(statusColor(status), status)} ${paint(90, `${Math.round(ms)}ms`)}`)),
  };
}
