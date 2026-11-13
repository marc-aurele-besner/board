// Tools → Requests without the DOM: a saved request turned into a fetch, its answer read back, and cURL both ways.
// The runners send it (tools/worker.js POST /http), as Node is not bound by CORS; the board sends it itself when they
// are off.
/** @import { ApiRequest, RequestPair } from '../types/data' */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// The most of an answer's body kept as text. Past it the body is cut, and says so.
const BODY_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 60000;

/** A request ready to send. @typedef {{ method: string, url: string, headers: [string, string][], body?: string }} Wire */
/**
 * What came back.
 * @typedef {{ status: number, statusText: string, url: string, redirected: boolean, ms: number, size: number,
 *   headers: [string, string][], body: string, truncated: boolean, binary: boolean, contentType: string }} WireAnswer
 */

/** @returns {ApiRequest} */
export const blankRequest = (/** @type {string} */ id) => ({
  id, name: '', projectId: null, method: 'GET', url: '', params: [], headers: [], bodyType: 'none', body: '', form: [], auth: { type: 'none' },
});

const on = (/** @type {RequestPair[]} */ pairs) => pairs.filter((p) => p.on !== false && p.key.trim());
const hasHeader = (/** @type {[string, string][]} */ headers, /** @type {string} */ name) => headers.some(([k]) => k.toLowerCase() === name);
/** @param {string} text */
const base64 = (text) => btoa(String.fromCharCode(...new TextEncoder().encode(text)));

// The URL with the params table added to the query it may already have. A URL without a scheme gets https://.
/** @param {ApiRequest} req */
export function urlOf(req) {
  const raw = req.url.trim();
  if (!raw) throw new Error('Type a URL first.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  for (const p of on(req.params)) url.searchParams.append(p.key.trim(), p.value);
  return url.toString();
}

// The request as it goes out: auth and the body's content type become headers, unless a header already sets them.
/** @param {ApiRequest} req @returns {Wire} */
export function wireOf(req) {
  const method = METHODS.includes(req.method) ? req.method : 'GET';
  /** @type {[string, string][]} */
  const headers = on(req.headers).map((p) => [p.key.trim(), p.value]);
  const auth = req.auth ?? { type: 'none' };
  if (auth.type === 'bearer' && auth.token && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Bearer ${auth.token}`]);
  if (auth.type === 'basic' && (auth.user || auth.pass) && !hasHeader(headers, 'authorization')) headers.push(['Authorization', `Basic ${base64(`${auth.user ?? ''}:${auth.pass ?? ''}`)}`]);
  /** @type {string | undefined} */
  let body;
  if (method !== 'GET' && method !== 'HEAD') {
    if (req.bodyType === 'json' || req.bodyType === 'text') {
      body = req.body;
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', req.bodyType === 'json' ? 'application/json' : 'text/plain']);
    } else if (req.bodyType === 'form') {
      body = new URLSearchParams(on(req.form).map((p) => [p.key.trim(), p.value])).toString();
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/x-www-form-urlencoded']);
    }
  }
  return { method, url: urlOf(req), headers, ...(body === undefined ? {} : { body }) };
}

// Whether a content type is text worth showing.
const textual = (/** @type {string} */ type) => !type || /^text\/|json|xml|javascript|ecmascript|yaml|toml|csv|html|svg|x-www-form-urlencoded|graphql/i.test(type);

// Sends a request and reads its answer. Throws when nothing came back (a bad host, a refused connection, CORS).
/** @param {Wire} wire @param {AbortSignal} [signal] @returns {Promise<WireAnswer>} */
export async function sendWire(wire, signal) {
  const url = new URL(String(wire.url));
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be sent.');
  const started = performance.now();
  const res = await fetch(url, {
    method: String(wire.method || 'GET').toUpperCase(),
    headers: (wire.headers ?? []).map(([k, v]) => [String(k), String(v)]),
    body: wire.body ?? undefined,
    redirect: 'follow',
    cache: 'no-store',
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
  });
  const bytes = new Uint8Array(await res.arrayBuffer());
  const ms = Math.round(performance.now() - started);
  const contentType = res.headers.get('content-type') ?? '';
  const binary = !textual(contentType);
  const truncated = !binary && bytes.length > BODY_MAX;
  return {
    status: res.status,
    statusText: res.statusText,
    url: res.url || url.toString(),
    redirected: res.redirected,
    ms,
    size: bytes.length,
    headers: [...res.headers.entries()],
    body: binary ? '' : new TextDecoder().decode(truncated ? bytes.slice(0, BODY_MAX) : bytes),
    truncated,
    binary,
    contentType,
  };
}

// Shell quoting for cURL: single quotes, with any single quote closed, escaped and reopened.
const quote = (/** @type {string} */ s) => (/^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`);

/** @param {ApiRequest} req */
export function toCurl(req) {
  const wire = wireOf(req);
  // One flag and its value per line. curl sends GET, or POST with a body, without -X.
  const implied = wire.body === undefined ? 'GET' : 'POST';
  const parts = [wire.method === implied ? `curl ${quote(wire.url)}` : `curl -X ${wire.method} ${quote(wire.url)}`];
  for (const [k, v] of wire.headers) parts.push(`-H ${quote(`${k}: ${v}`)}`);
  if (wire.body !== undefined) parts.push(`--data-raw ${quote(wire.body)}`);
  return parts.join(' \\\n  ');
}

// Splits a shell command into words: quotes, backslash escapes and line continuations, as a shell reads them.
/** @param {string} text */
function words(text) {
  /** @type {string[]} */
  const out = [];
  let word = '';
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\' && text[i + 1] === '\n') { i++; continue; }
    if (/\s/.test(c)) {
      if (started) out.push(word);
      word = '';
      started = false;
    } else if (c === "'") {
      const end = text.indexOf("'", i + 1);
      word += text.slice(i + 1, end < 0 ? undefined : end);
      i = end < 0 ? text.length : end;
      started = true;
    } else if (c === '"') {
      i++;
      for (; i < text.length && text[i] !== '"'; i++) {
        if (text[i] === '\\' && '"\\$`\n'.includes(text[i + 1])) i++;
        word += text[i];
      }
      started = true;
    } else if (c === '$' && text[i + 1] === "'") {
      // ANSI-C quoting: $'…' with \n, \t and escaped quotes.
      i += 2;
      for (; i < text.length && text[i] !== "'"; i++) {
        if (text[i] === '\\') {
          const n = text[++i];
          word += n === 'n' ? '\n' : n === 't' ? '\t' : n === 'r' ? '\r' : n;
        } else word += text[i];
      }
      started = true;
    } else {
      if (c === '\\') i++;
      word += text[i] ?? '';
      started = true;
    }
  }
  if (started) out.push(word);
  return out;
}

// A request from a pasted cURL command: method, URL, headers, user, and the body (JSON when it parses as JSON).
// Throws when the text is not a curl command with a URL.
/** @param {string} text @param {string} id @returns {ApiRequest} */
export function fromCurl(text, id) {
  const args = words(text.trim());
  if (args[0] !== 'curl') throw new Error('Paste a command that starts with curl.');
  const req = blankRequest(id);
  /** @type {string[]} */
  const data = [];
  /** @type {string[]} */
  const form = [];
  let method = '';
  let get = false;
  const takesValue = new Set(['-o', '--output', '-m', '--max-time', '--connect-timeout', '-w', '--write-out', '-e', '--referer', '-x', '--proxy', '--cacert', '--cert', '--key', '-T', '--upload-file', '--retry', '-c', '--cookie-jar', '-r', '--range', '--resolve']);
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i] ?? '';
    if (a === '-X' || a === '--request') method = next().toUpperCase();
    else if (a.startsWith('-X') && a.length > 2) method = a.slice(2).toUpperCase();
    else if (a === '-H' || a === '--header') {
      const line = next();
      const at = line.indexOf(':');
      if (at > 0) req.headers.push({ key: line.slice(0, at).trim(), value: line.slice(at + 1).trim(), on: true });
    } else if (['-d', '--data', '--data-raw', '--data-binary', '--data-ascii', '--json'].includes(a)) {
      const value = next();
      data.push(value);
      if (a === '--json' && !req.headers.some((h) => h.key.toLowerCase() === 'content-type')) req.headers.push({ key: 'Content-Type', value: 'application/json', on: true });
    } else if (a === '--data-urlencode') data.push(next());
    else if (a === '-F' || a === '--form') form.push(next());
    else if (a === '-u' || a === '--user') {
      const [user, ...pass] = next().split(':');
      req.auth = { type: 'basic', user, pass: pass.join(':') };
    } else if (a === '-A' || a === '--user-agent') req.headers.push({ key: 'User-Agent', value: next(), on: true });
    else if (a === '-b' || a === '--cookie') req.headers.push({ key: 'Cookie', value: next(), on: true });
    else if (a === '-G' || a === '--get') get = true;
    else if (a === '-I' || a === '--head') method = 'HEAD';
    else if (a === '--url') req.url = next();
    else if (takesValue.has(a)) i++;
    else if (!a.startsWith('-') && !req.url) req.url = a;
  }
  if (!req.url) throw new Error('No URL found in that command.');
  // A Bearer header becomes the auth field, so the token is in one place.
  const bearer = req.headers.findIndex((p) => p.key.toLowerCase() === 'authorization' && /^bearer\s+/i.test(p.value));
  if (bearer >= 0 && req.auth.type === 'none') {
    req.auth = { type: 'bearer', token: req.headers[bearer].value.replace(/^bearer\s+/i, '') };
    req.headers.splice(bearer, 1);
  }
  const body = data.join('&');
  if (get && body) req.url += (req.url.includes('?') ? '&' : '?') + body;
  else if (form.length) {
    req.bodyType = 'form';
    req.form = form.map((f) => {
      const at = f.indexOf('=');
      return { key: at < 0 ? f : f.slice(0, at), value: at < 0 ? '' : f.slice(at + 1), on: true };
    });
  } else if (data.length) {
    const type = req.headers.find((p) => p.key.toLowerCase() === 'content-type')?.value ?? '';
    let json = /json/i.test(type);
    if (!type) {
      try {
        JSON.parse(body);
        json = true;
      } catch {
        // Not JSON: sent as typed.
      }
    }
    if (/x-www-form-urlencoded/i.test(type) || (!type && !json)) {
      req.bodyType = 'form';
      req.form = [...new URLSearchParams(body)].map(([key, value]) => ({ key, value, on: true }));
    } else {
      req.bodyType = json ? 'json' : 'text';
      req.body = body;
    }
    // A header the body type sets by itself is not kept twice.
    if (req.bodyType !== 'text') req.headers = req.headers.filter((p) => !(p.key.toLowerCase() === 'content-type' && /json|x-www-form-urlencoded/i.test(p.value)));
  }
  req.method = method && METHODS.includes(method) ? method : (data.length || form.length) && !get ? 'POST' : 'GET';
  return req;
}
