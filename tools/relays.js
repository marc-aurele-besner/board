// Local relays for the APIs that send no CORS header, so a web page cannot read their answers: Bing Webmaster
// (search data) and Resend (Inbox). Both run in this one process: `bun run relays` (or `node tools/relays.js`),
// or with the board through `bun start`. BING_PORT and RESEND_PORT change their ports.
// Each forwards read-only GET requests to its API only, and answers only pages served from this machine.
import { createServer } from 'node:http';
import { logger } from './log.js';

const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

const RELAYS = [
  {
    name: 'Bing',
    port: Number(process.env.BING_PORT) || 8417,
    upstream: 'https://ssl.bing.com',
    allowed: (path) => path.startsWith('/webmaster/api.svc/json/'),
    refused: 'Not a Bing Webmaster API request.',
    headers: () => ({}),
  },
  {
    name: 'Resend',
    port: Number(process.env.RESEND_PORT) || 8418,
    upstream: 'https://api.resend.com',
    // Sent and received emails, as a list or one by id. Nothing that sends or changes anything.
    allowed: (path) => /^\/emails(\/receiving)?(\/[\w-]+)?$/.test(path),
    refused: 'Not a Resend email read.',
    allowHeaders: 'authorization',
    headers: (req) => ({ authorization: req.headers.authorization ?? '', 'user-agent': 'board-resend-relay' }),
  },
];

function start(relay) {
  const log = logger(relay.name.toLowerCase());
  createServer(async (req, res) => {
    const started = performance.now();
    // Preflights would double every line, so they are left out.
    res.on('finish', () => req.method !== 'OPTIONS' && log.request(req.method, new URL(req.url, 'http://relay').pathname, res.statusCode, performance.now() - started));
    const origin = req.headers.origin ?? '';
    // Without this check any website open in the browser could use the relay, and the keys it is sent.
    if (origin && !LOCAL.test(origin)) {
      res.writeHead(403).end('Only pages served from this machine may use the relay.');
      return;
    }
    const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
    if (req.method === 'OPTIONS') {
      const allow = relay.allowHeaders ? { 'access-control-allow-headers': relay.allowHeaders } : {};
      res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', ...allow }).end();
      return;
    }
    const url = new URL(req.url, 'http://relay');
    if (req.method !== 'GET' || !relay.allowed(url.pathname)) {
      res.writeHead(404, cors).end(relay.refused);
      return;
    }
    try {
      const upstream = await fetch(relay.upstream + url.pathname + url.search, { headers: relay.headers(req) });
      res.writeHead(upstream.status, { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
      res.end(Buffer.from(await upstream.arrayBuffer()));
    } catch (err) {
      res.writeHead(502, cors).end(`Could not reach ${relay.name}: ${err.message}`);
    }
  })
    .on('error', (err) => {
      const env = `${relay.name.toUpperCase()}_PORT`;
      log.error(err.code === 'EADDRINUSE' ? `Port ${relay.port} (${relay.name} relay) is in use. Pick another with ${env}=<port> and set the same address in Settings.` : err.message);
      process.exit(1);
    })
    .listen(relay.port, '127.0.0.1', () => log.info(`${relay.name} relay on http://127.0.0.1:${relay.port}`));
}

RELAYS.forEach(start);
