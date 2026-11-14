// Tools → Requests without the DOM: a saved request turned into a fetch, its answer read back, and cURL both ways.
// The runners send it (tools/worker.js POST /http), as Node is not bound by CORS; the board sends it itself when they
// are off.
/** @import { ApiRequest, RequestPair } from '../types/data' */

export const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
// The most of an answer's body kept as text. Past it the body is cut, and says so.
const BODY_MAX = 2 * 1024 * 1024;
const TIMEOUT_MS = 60000;

/** A request ready to send; `headersOnly` stops at the headers, its body left unread. @typedef {{ method: string, url: string, headers: [string, string][], body?: string, headersOnly?: boolean }} Wire */
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

// A GraphQL request's variables, parsed. Empty text sends none; text that is not a JSON object throws.
/** @param {ApiRequest} req @returns {Record<string, unknown> | undefined} */
export function variablesOf(req) {
  const text = (req.variables ?? '').trim();
  if (!text) return undefined;
  let value;
  try {
    value = JSON.parse(text);
  } catch (err) {
    throw new Error(`The variables are not valid JSON: ${/** @type {Error} */ (err).message}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The variables must be a JSON object.');
  return value;
}

// The name after `query`, `mutation` or `subscription`, sent as operationName so a document with several
// operations runs the first named one.
const operationOf = (/** @type {string} */ query) => /^\s*(?:query|mutation|subscription)\s+([_A-Za-z][_0-9A-Za-z]*)/m.exec(query)?.[1];

// The URL with the params table added to the query it may already have. A URL without a scheme gets https://.
/** @param {ApiRequest} req */
export function urlOf(req) {
  const raw = req.url.trim();
  if (!raw) throw new Error('Type a URL first.');
  const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  for (const p of on(req.params)) url.searchParams.append(p.key.trim(), p.value);
  // GraphQL over GET puts the query and its variables in the address.
  if (req.bodyType === 'graphql' && req.method === 'GET' && req.body.trim()) {
    url.searchParams.set('query', req.body);
    const variables = variablesOf(req);
    if (variables) url.searchParams.set('variables', JSON.stringify(variables));
    const name = operationOf(req.body);
    if (name) url.searchParams.set('operationName', name);
  }
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
    } else if (req.bodyType === 'graphql') {
      const variables = variablesOf(req);
      const name = operationOf(req.body);
      body = JSON.stringify({ query: req.body, ...(variables ? { variables } : {}), ...(name ? { operationName: name } : {}) });
      if (!hasHeader(headers, 'content-type')) headers.push(['Content-Type', 'application/json']);
      if (!hasHeader(headers, 'accept')) headers.push(['Accept', 'application/graphql-response+json, application/json']);
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
  let res;
  try {
    res = await fetch(url, {
      method: String(wire.method || 'GET').toUpperCase(),
      headers: (wire.headers ?? []).map(([k, v]) => /** @type {[string, string]} */ ([String(k), String(v)])),
      body: wire.body ?? undefined,
      redirect: 'follow',
      cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (err) {
    // Node says only "fetch failed"; the reason (an unknown host, a refused connection) is its cause.
    const cause = /** @type {{ cause?: { message?: string } }} */ (err).cause?.message;
    if (/** @type {Error} */ (err).name === 'TimeoutError') throw new Error(`No answer after ${TIMEOUT_MS / 1000} seconds.`);
    throw cause ? new Error(`Could not reach ${url.host}: ${cause}`) : err;
  }
  if (wire.headersOnly) await res.body?.cancel().catch(() => {});
  const bytes = wire.headersOnly ? new Uint8Array() : new Uint8Array(await res.arrayBuffer());
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
      // A JSON body with a query string is a GraphQL request: it opens in the GraphQL editor.
      if (json) {
        try {
          const parsed = JSON.parse(body);
          if (parsed && typeof parsed.query === 'string') {
            req.bodyType = 'graphql';
            req.body = parsed.query;
            req.variables = parsed.variables ? JSON.stringify(parsed.variables, null, 2) : '';
          }
        } catch {
          // Not parseable after all: kept as JSON text.
        }
      }
    }
    // A header the body type sets by itself is not kept twice.
    if (req.bodyType !== 'text') req.headers = req.headers.filter((p) => !(p.key.toLowerCase() === 'content-type' && /json|x-www-form-urlencoded/i.test(p.value)));
    if (req.bodyType === 'graphql') req.headers = req.headers.filter((p) => !(p.key.toLowerCase() === 'accept' && /graphql-response/i.test(p.value)));
  }
  req.method = method && METHODS.includes(method) ? method : (data.length || form.length) && !get ? 'POST' : 'GET';
  return req;
}

// --- GraphQL schema ---

/** A type as introspection writes it: a name, or a list or non-null wrapper around one. @typedef {{ kind: string, name: string | null, ofType?: TypeRef | null }} TypeRef */
/**
 * A root field of the schema, ready to list and to turn into a query.
 * @typedef {{ op: 'query' | 'mutation', name: string, description: string, args: { name: string, type: string }[], type: string, leaf: boolean }} SchemaField
 */

// Only the root fields, their arguments and return types: enough to list what the API offers and start a query.
const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } }';
export const INTROSPECTION = `query Introspection { __schema { queryType { fields { ...F } } mutationType { fields { ...F } } } }
fragment F on __Field { name description args { name type { ${TYPE_REF} } } type { ${TYPE_REF} } }`;

// `[Item!]!` from the nested wrappers.
/** @param {TypeRef | null | undefined} t @returns {string} */
const typeName = (t) => (!t ? '?' : t.kind === 'NON_NULL' ? `${typeName(t.ofType)}!` : t.kind === 'LIST' ? `[${typeName(t.ofType)}]` : t.name ?? '?');
/** @param {TypeRef | null | undefined} t @returns {string} */
const baseKind = (t) => (!t ? '' : t.ofType ? baseKind(t.ofType) : t.kind);

// The root fields from an introspection answer's body. Throws when the body is not one.
/** @param {string} body @returns {SchemaField[]} */
export function schemaFields(body) {
  let json;
  try {
    json = JSON.parse(body);
  } catch {
    throw new Error('The answer is not JSON, so the server does not look like a GraphQL API.');
  }
  const schema = json?.data?.__schema;
  if (!schema) throw new Error(json?.errors?.[0]?.message ? `The schema could not be read: ${json.errors[0].message}` : 'The answer has no schema. Introspection may be turned off on this server.');
  /** @type {SchemaField[]} */
  const out = [];
  for (const op of /** @type {const} */ (['query', 'mutation'])) {
    /** @type {{ name: string, description?: string | null, args?: { name: string, type: TypeRef }[], type: TypeRef }[]} */
    const fields = schema[`${op}Type`]?.fields ?? [];
    for (const f of fields) {
      const kind = baseKind(f.type);
      out.push({
        op,
        name: f.name,
        description: f.description ?? '',
        args: (f.args ?? []).map((a) => ({ name: a.name, type: typeName(a.type) })),
        type: typeName(f.type),
        leaf: kind === 'SCALAR' || kind === 'ENUM',
      });
    }
  }
  return out;
}

// A starting query for one root field: its arguments become variables, and an object result asks for __typename,
// the one field every object has.
/** @param {SchemaField} f */
export function templateOf(f) {
  const name = f.name.charAt(0).toUpperCase() + f.name.slice(1);
  const vars = f.args.length ? `(${f.args.map((a) => `$${a.name}: ${a.type}`).join(', ')})` : '';
  const args = f.args.length ? `(${f.args.map((a) => `${a.name}: $${a.name}`).join(', ')})` : '';
  return `${f.op} ${name}${vars} {\n  ${f.name}${args}${f.leaf ? '' : ' {\n    __typename\n  }'}\n}\n`;
}
