// The worker's localhost API: its status, Run now, and where the data folder is. It answers only the board's pages,
// with the same checks as the terminal runner: the Origin check keeps other websites out, the Host check keeps out
// DNS rebinding.
/** @import { IncomingMessage } from 'node:http' */
/** @import { Logger, RequestBody, Route } from '../../types/runner' */
import { createServer } from 'node:http';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
const MAX_BODY = 64 * 1024;

/** @param {IncomingMessage} req @returns {Promise<RequestBody>} */
async function readJSON(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error('Request too large.');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text.trim() ? JSON.parse(text) : {};
}

// `routes` maps "METHOD /path" (a trailing "*" takes the rest of the path) to async (body, rest) => answer.
/** @param {{ port: number, log: Logger, routes: Record<string, Route> }} options */
export function serve({ port, log, routes }) {
  const server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? '';
    if (!LOCAL_ORIGIN.test(origin) || !LOCAL_HOST.test(req.headers.host ?? '')) {
      res.writeHead(403).end('Only the board’s pages may use the runners.');
      return;
    }
    const cors = { 'access-control-allow-origin': origin, vary: 'origin' };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET, POST', 'access-control-allow-headers': 'content-type' }).end();
      return;
    }
    const path = new URL(/** @type {string} */ (req.url), 'http://worker').pathname; // a server's request always has one
    const key = Object.keys(routes).find((k) => {
      const [method, pattern] = k.split(' ');
      return method === req.method && (pattern.endsWith('*') ? path.startsWith(pattern.slice(0, -1)) : path === pattern);
    });
    if (!key) {
      res.writeHead(404, cors).end('Not found.');
      return;
    }
    try {
      const body = req.method === 'POST' ? await readJSON(req) : {};
      const pattern = key.split(' ')[1];
      const rest = pattern.endsWith('*') ? decodeURIComponent(path.slice(pattern.length - 1)) : '';
      const answer = await routes[key](body, rest);
      res.writeHead(200, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify(answer ?? {}));
    } catch (err) {
      res.writeHead(/** @type {{ status?: number }} */ (err).status ?? 500, { ...cors, 'content-type': 'application/json' }).end(JSON.stringify({ ok: false, error: /** @type {Error} */ (err).message }));
    }
  });
  server.on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${port} (worker) is in use. Pick another with WORKER_PORT=<port>.` : err.message);
  });
  server.listen(port, '127.0.0.1', () => log.info(`Runners on http://127.0.0.1:${port}`));
  return server;
}
