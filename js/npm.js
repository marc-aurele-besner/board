// npm packages tied to projects: an npm organization (or user) and/or single packages. The runners
// (tools/jobs/npm.js) read them every hour into npm.json:
// { orgs: { name: { at, packages: [name], error } }, packages: { name: { at, version, modified, deprecated, weekly, error } } }.
// The board reads that file and asks the runners for an org or package it lacks. The registry's org listing sends
// no CORS header, so the browser could not read it itself. No token: only public packages are read.

import { h } from './ui.js';
import { runJob } from './runners.js';

export const NPM = 'npm';
export const NPM_DEFAULTS = { orgs: {}, packages: {} };
const REGISTRY = 'https://registry.npmjs.org';
const DOWNLOADS = 'https://api.npmjs.org/downloads/point/last-week';
// An org can own hundreds of packages; past this many only the listed ones are read in detail.
export const ORG_PACKAGES_READ = 60;

let store = null;
export const useNpmStore = (next) => {
  store = next;
};
const file = () => store?.get(NPM) ?? NPM_DEFAULTS;

// A project's npm links. Projects made before npm was added have no `npm` field.
export const npmOf = (p) => ({ org: '', packages: [], ...(p?.npm ?? {}) });

const NAME = /^[a-z0-9][a-z0-9._~-]*$/i;
const NPM_PREFIX = /^(?:https?:\/\/)?(?:www\.)?npmjs\.(?:com|org)\//i;

// Accepts "my-org", "@my-org", npmjs.com/org/my-org or npmjs.com/~my-user. Returns the name, '' for empty, or null.
export function normalizeNpmOrg(text) {
  const raw = text.trim().replace(NPM_PREFIX, '').replace(/^(?:org\/|~)/, '').replace(/^@/, '').replace(/\/+$/, '');
  if (!raw) return '';
  return NAME.test(raw) ? raw.toLowerCase() : null;
}

// Accepts "pkg", "@scope/pkg" or an npmjs.com/package/... URL. Returns the package name or null.
export function normalizePackage(text) {
  const raw = text.trim().replace(NPM_PREFIX, '').replace(/^package\//, '').replace(/\/v\/.*$/, '').replace(/\/+$/, '');
  const [first, second, extra] = raw.split('/');
  if (extra !== undefined) return null;
  if (first.startsWith('@')) {
    return second && NAME.test(first.slice(1)) && NAME.test(second) ? `${first}/${second}`.toLowerCase() : null;
  }
  return !second && NAME.test(first) ? first.toLowerCase() : null;
}

export const packageUrl = (name) => `https://www.npmjs.com/package/${name}`;
export const orgUrl = (org) => `https://www.npmjs.com/~${org}`;

export function packageLink(name) {
  return h('a', { href: packageUrl(name), target: '_blank', rel: 'noopener' }, name);
}

// The packages a project covers: those it lists, then its org's (from npm.json), without repeats.
export function projectPackages(p) {
  const { org, packages } = npmOf(p);
  const fromOrg = org ? file().orgs?.[org]?.packages ?? [] : [];
  return [...new Set([...packages, ...fromOrg])];
}

// --- Reading the registry (runners only) ---

const encode = (name) => name.replace('/', '%2f');

async function getJson(url, headers = {}) {
  const res = await fetch(url, { headers });
  if (res.status === 404) throw new Error('Not found on npm.');
  if (!res.ok) throw new Error(`npm answered ${res.status}.`);
  return res.json();
}

// Every package an org or user can publish to, sorted by name.
async function fetchOrgPackages(org) {
  const list = await getJson(`${REGISTRY}/-/org/${encodeURIComponent(org)}/package`);
  return Object.keys(list).sort();
}

async function fetchPackage(name) {
  const [doc, downloads] = await Promise.all([
    // The abbreviated document: dist-tags and versions without readmes, far smaller than the full one.
    getJson(`${REGISTRY}/${encode(name)}`, { Accept: 'application/vnd.npm.install-v1+json' }),
    getJson(`${DOWNLOADS}/${name}`).catch(() => null),
  ]);
  const version = doc['dist-tags']?.latest ?? '';
  return {
    version,
    modified: doc.modified ?? '',
    deprecated: Boolean(doc.versions?.[version]?.deprecated),
    weekly: downloads?.downloads ?? null,
  };
}

// A few at a time, so an org with many packages does not send them all at once.
async function eachLimited(items, limit, fn) {
  const out = [];
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const index = i++;
      out[index] = await fn(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

// Reads orgs and packages into npm.json. A failed read keeps the last values. Returns the error lines.
export async function readNpm(target, { orgs = [], packages = [] }) {
  const orgFound = await eachLimited(orgs, 3, async (org) => {
    try {
      return [org, { at: Date.now(), packages: await fetchOrgPackages(org), error: null }];
    } catch (err) {
      return [org, { error: err.message, failedAt: Date.now() }];
    }
  });
  const fromOrgs = orgFound.flatMap(([, e]) => (e.packages ?? []).slice(0, ORG_PACKAGES_READ));
  const names = [...new Set([...packages, ...fromOrgs])];
  const pkgFound = await eachLimited(names, 6, async (name) => {
    try {
      return [name, { at: Date.now(), ...(await fetchPackage(name)), error: null }];
    } catch (err) {
      return [name, { error: err.message, failedAt: Date.now() }];
    }
  });
  target.save(NPM, (d) => {
    d.orgs ??= {};
    d.packages ??= {};
    for (const [org, entry] of orgFound) d.orgs[org] = { ...d.orgs[org], ...entry };
    for (const [name, entry] of pkgFound) d.packages[name] = { ...d.packages[name], ...entry };
  });
  return [...orgFound, ...pkgFound].filter(([, e]) => e.error).map(([name, e]) => `${name}: ${e.error}`);
}

// --- The board's side ---

// Keys are 'org:<name>' or a package name. A render asks for each row, so the asks of one render go as one run.
const asking = new Set();
const queued = new Set();
// When the runners could not be asked: the error, kept a minute so a re-render does not ask again at once.
const failed = new Map();
const FAILED_MS = 60000;
let flushing = null;

function ask(keys, onChange) {
  for (const k of keys) if (!asking.has(k)) queued.add(k);
  if (!queued.size || flushing) return;
  flushing = Promise.resolve().then(() => {
    const batch = [...queued];
    queued.clear();
    flushing = null;
    batch.forEach((k) => asking.add(k));
    const orgs = batch.filter((k) => k.startsWith('org:')).map((k) => k.slice(4));
    const packages = batch.filter((k) => !k.startsWith('org:'));
    runJob('npm', { orgs, packages })
      .then(() => store?.sync())
      .catch((err) => batch.forEach((k) => failed.set(k, { error: err.message, at: Date.now() })))
      .finally(() => {
        batch.forEach((k) => asking.delete(k));
        onChange?.();
      });
  });
}

// An entry is { status: 'ok' | 'loading' | 'error', ... }, from npm.json. One the file lacks is asked of the runners.
function statsOf(entry, key, onChange) {
  if (entry?.at) return { status: 'ok', ...entry };
  if (entry?.error) return { status: 'error', error: entry.error };
  const miss = failed.get(key);
  if (miss && Date.now() - miss.at < FAILED_MS) return { status: 'error', error: miss.error };
  ask([key], onChange);
  return { status: 'loading' };
}

export const packageStats = (name, onChange) => statsOf(file().packages?.[name], name, onChange);
export const orgStats = (org, onChange) => statsOf(file().orgs?.[org], `org:${org}`, onChange);

const keysOf = (p) => {
  const { org, packages } = npmOf(p);
  return [...(org ? [`org:${org}`] : []), ...packages];
};

// True while the runners read any of the project's org and packages.
export const npmBusy = (p) => keysOf(p).some((k) => asking.has(k) || queued.has(k));

// Reads a project's org and packages again now.
export function refreshNpm(p, onChange) {
  const keys = keysOf(p);
  keys.forEach((k) => failed.delete(k));
  ask(keys, onChange);
}
