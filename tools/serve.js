// Static server for the board, with no dependencies: `bun run serve` (or `node tools/serve.js`). PORT changes the port.
// Every response says `no-cache`, so the browser revalidates each module on reload and runs the code just edited.
/** @import { IncomingMessage, ServerResponse } from 'node:http' */
import { createServer } from 'node:http';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { extname, join, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from './log.js';

const PORT = Number(process.env.PORT) || 8000;
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const log = logger('board');
/** @type {Record<string, string>} */
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

// What a tab runs: the page, its styles and its modules. Their sizes and change times make one fingerprint, so an
// edit or a pull changes it, and an open tab (js/app-version.js) learns that it runs older code.
const APP_FILES = ['index.html', 'oauth.html', 'css', 'js'];
const VERSION_CACHE_MS = 2000;
/** @type {{ at: number, body: string } | null} */
let versionCache = null;

/** @param {string} path @param {string[]} out @returns {Promise<number>} the latest change time under path */
async function fingerprint(path, out) {
  const info = await stat(path).catch(() => null);
  if (!info) return 0;
  // A folder's own time changes when a file is added to it or removed from it.
  out.push(`${path.slice(ROOT.length)}:${info.size}:${info.mtimeMs}`);
  let latest = info.mtimeMs;
  if (info.isDirectory()) {
    for (const name of (await readdir(path)).sort()) latest = Math.max(latest, await fingerprint(join(path, name), out));
  }
  return latest;
}

async function versionBody() {
  if (versionCache && Date.now() - versionCache.at < VERSION_CACHE_MS) return versionCache.body;
  /** @type {string[]} */
  const parts = [];
  let builtAt = 0;
  for (const name of APP_FILES) builtAt = Math.max(builtAt, await fingerprint(join(ROOT, name), parts));
  // Read as text on every check: an import would keep the epoch this server started with.
  const core = await readFile(join(ROOT, 'js', 'app-version-core.js'), 'utf8').catch(() => '');
  const epoch = Number(/APP_EPOCH = (\d+)/.exec(core)?.[1] ?? 0);
  const version = createHash('sha1').update(parts.join('\n')).digest('hex').slice(0, 16);
  const body = JSON.stringify({ version, epoch, builtAt: Math.round(builtAt) });
  versionCache = { at: Date.now(), body };
  return body;
}

// req.url is set on every request a server receives, hence the casts.
/** @param {IncomingMessage} req @param {ServerResponse} res */
async function serve(req, res) {
  // A reload fetches every module, so only page loads and failures are logged.
  const started = performance.now();
  res.on('finish', () => {
    const page = /^\/(index\.html)?$/.test(new URL(/** @type {string} */ (req.url), 'http://board').pathname);
    if (page || res.statusCode >= 400) log.request(req.method, new URL(/** @type {string} */ (req.url), 'http://board').pathname, res.statusCode, performance.now() - started);
  });
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  if (new URL(/** @type {string} */ (req.url), 'http://board').pathname === '/version') {
    res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : await versionBody());
    return;
  }
  let path = normalize(join(ROOT, decodeURIComponent(new URL(/** @type {string} */ (req.url), 'http://board').pathname)));
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
}

// "localhost" can mean either address, and the browser tries IPv6 first. Binding only one of them let another
// server on the other one answer the board's address unnoticed, so both are bound and a clash on either stops here.
const ADDRESSES = ['127.0.0.1', '::1'];
// Said once every address is bound, so a clash is never preceded by a ready line.
let waiting = ADDRESSES.length;
const ready = () => --waiting === 0 && log.info(`Board at http://localhost:${PORT}`);
for (const address of ADDRESSES) {
  createServer(serve)
    .on('error', (/** @type {NodeJS.ErrnoException} */ err) => {
      // A machine without IPv6 has no ::1; IPv4 alone is then the whole of localhost.
      if (address === '::1' && err.code === 'EADDRNOTAVAIL') return ready();
      log.error(err.code === 'EADDRINUSE' ? `Port ${PORT} is in use on ${address}. Stop the other server or pick another port with PORT=<port>.` : err.message);
      process.exit(1);
    })
    .listen(PORT, address, ready);
}
