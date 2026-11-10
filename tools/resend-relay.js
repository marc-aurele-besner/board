// Local relay for the Resend API, which sends no CORS header, so a web page cannot read its answers.
// Run it next to the board: `bun tools/resend-relay.js` (or `node tools/resend-relay.js`). PORT changes the port.
// It forwards read-only requests for emails to Resend only, and answers only pages served from this machine.
import { createServer } from 'node:http';

const PORT = Number(process.env.PORT) || 8418;
const RESEND = 'https://api.resend.com';
// Sent and received emails, as a list or one by id. Nothing that sends or changes anything.
const ALLOWED = /^\/emails(\/receiving)?(\/[\w-]+)?$/;
const LOCAL = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;

createServer(async (req, res) => {
  const origin = req.headers.origin ?? '';
  // Without this check any website open in the browser could use the relay, and the keys it is sent.
  if (origin && !LOCAL.test(origin)) {
    res.writeHead(403).end('Only pages served from this machine may use the relay.');
    return;
  }
  const cors = origin ? { 'access-control-allow-origin': origin, vary: 'origin' } : {};
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'access-control-allow-methods': 'GET', 'access-control-allow-headers': 'authorization' }).end();
    return;
  }
  const url = new URL(req.url, 'http://relay');
  if (req.method !== 'GET' || !ALLOWED.test(url.pathname)) {
    res.writeHead(404, cors).end('Not a Resend email read.');
    return;
  }
  try {
    const upstream = await fetch(RESEND + url.pathname + url.search, {
      headers: { authorization: req.headers.authorization ?? '', 'user-agent': 'board-resend-relay' },
    });
    res.writeHead(upstream.status, { ...cors, 'content-type': upstream.headers.get('content-type') ?? 'application/json' });
    res.end(Buffer.from(await upstream.arrayBuffer()));
  } catch (err) {
    res.writeHead(502, cors).end(`Could not reach Resend: ${err.message}`);
  }
})
  .on('error', (err) => {
    console.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Pick another with PORT=<port> and set the same address in Settings.` : err.message);
    process.exit(1);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`Resend relay on http://127.0.0.1:${PORT}`));
