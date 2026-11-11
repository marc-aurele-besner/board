// Static server for the board, with no dependencies: `bun run serve` (or `node tools/serve.js`). PORT changes the port.
// Every response says `no-cache`, so the browser revalidates each module on reload and runs the code just edited.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.js';

const PORT = Number(process.env.PORT) || 8000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const log = logger('board');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

createServer(async (req, res) => {
  // A reload fetches every module, so only page loads and failures are logged.
  const started = performance.now();
  res.on('finish', () => {
    const page = /^\/(index\.html)?$/.test(new URL(req.url, 'http://board').pathname);
    if (page || res.statusCode >= 400) log.request(req.method, new URL(req.url, 'http://board').pathname, res.statusCode, performance.now() - started);
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let path = normalize(join(ROOT, decodeURIComponent(new URL(req.url, 'http://board').pathname)));
  // Never serve anything outside the repo folder, or its git data.
  if (!(path + sep).startsWith(ROOT) || path.split(sep).includes('.git')) {
    res.writeHead(404).end('Not found');
    return;
  }
  try {
    if ((await stat(path)).isDirectory()) path = join(path, 'index.html');
    const body = await readFile(path);
    res.writeHead(200, {
      'content-type': TYPES[extname(path)] ?? 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(req.method === 'HEAD' ? undefined : body);
  } catch {
    res.writeHead(404).end('Not found');
  }
})
  .on('error', (err) => {
    log.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use. Pick another with PORT=<port>.` : err.message);
    process.exit(1);
  })
  .listen(PORT, 'localhost', () => log.info(`Board at http://localhost:${PORT}`));
