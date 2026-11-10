// Local relay for the Bing Webmaster API, which sends no CORS header, so a web page cannot read its answers.
// Run it next to the board: `bun tools/bing-relay.js` (or `node tools/bing-relay.js`). PORT changes the port.
// It forwards GET requests to Bing's JSON API only, and answers only pages served from this machine.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8787;
const BING = 'https://ssl.bing.com';
const PATH = '/webmaster/api.svc/json/';
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  // Without this check any website open in the browser could use the relay.
  if (origin && !LOCAL.test(origin)) {
    res.writeHead(403).end('Only pages served from this machine may use the relay.');
    return;
  }
  const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET' }).end();
    return;
  }
  const url = new URL(req.url, 'http://relay');
  if (req.method !== 'GET' || !url.pathname.startsWith(PATH)) {
    res.writeHead(404, cors).end('Not a Bing Webmaster API request.');
    return;
  }
  try {
    const upstream = await fetch(BING + url.pathname + url.search);
    res.writeHead(upstream.status, { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, cors).end(`Could not reach Bing: ${err.message}`);
  }
}).listen(PORT, '127.0.0.1', () => console.log(`Bing relay on http://localhost:${PORT}`));
