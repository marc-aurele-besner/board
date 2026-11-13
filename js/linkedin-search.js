// LinkedIn searches through the saved session, for Cron's LinkedIn steps: a company by name, the people who work
// there, and one member's profile. Every call goes through linkedinCall() (js/linkedin-session.js), so the queue keeps
// its pace, the daily limit and the cache. No DOM; the runners import this file.
//
// UNVERIFIED: LinkedIn's voyager API is undocumented. The paths and answer shapes below are a best guess from what its
// pages call, never checked against a live session (the board never tests with a real one). Each endpoint has one
// function that builds its path and one that reads its answer, so a fix touches one place:
//   companySearchPath / parseCompanySearch   typeahead of companies by name
//   companyPath / parseCompany               a company page's details by its universal name (the same read as Socials)
//   peopleSearchPath / parsePeople           people search filtered by current company, one page of 10
//   profilePath / parseProfile               a member's profile with positions
// The parsers walk every object in the answer (normalized answers list them in `included[]`, tagged with `$type`)
// and pick what they know by its fields, so a reshaped answer still reads, or fails with a readable error.
/** @import { DataStore } from '../types/data' */
import { linkedinCall, LinkedinSessionError, DEFAULT_MAX_AGE } from './linkedin-session.js';
import { LINKEDIN } from './linkedin-core.js';
import { linkedinHandle, linkedinUrl } from './contacts-core.js';

// Search answers change slowly; a week of reuse keeps a re-run or a re-test free.
export const SEARCH_MAX_AGE = DEFAULT_MAX_AGE;
export const PEOPLE_PAGE = 10;
export const PEOPLE_MAX = 100;
export const COMPANY_TOP_MAX = 10;
// LinkedIn's own pages ask for this shape: entities in `included[]`, each with its `$type`.
const NORMALIZED = { accept: 'application/vnd.linkedin.normalized+json+2.1' };
// How LinkedIn names a member it does not show to this account.
const HIDDEN_NAME = /^linkedin member$/i;

/**
 * @typedef {{ name: string, handle: string, url: string, urn: string, id: string, industry: string, size: string, followers: number | null, website: string, headquarters: string }} LinkedinCompany
 * @typedef {{ name: string, headline: string, location: string, url: string, handle: string, degree: string, image: string, hidden: boolean, company?: string }} LinkedinPerson
 * @typedef {{ name: string, headline: string, location: string, about: string, currentTitle: string, currentCompany: string, experience: string[], url: string, handle: string }} LinkedinProfile
 * @typedef {{ calls: number, cached: number }} CallTally
 * @typedef {Record<string, any>} Obj any: one entity of LinkedIn's JSON, read field by field
 */

// --- Reading LinkedIn's JSON ---

/** @param {unknown} v @returns {v is Obj} */
const isObj = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

// Every object in the answer, depth first: included[] entries, elements, nested parts.
/** @param {unknown} answer @returns {Obj[]} */
export function objectsIn(answer) {
  /** @type {Obj[]} */
  const out = [];
  /** @param {unknown} node @param {number} depth */
  const visit = (node, depth) => {
    if (depth > 40 || !node || typeof node !== 'object') return;
    if (Array.isArray(node)) return node.forEach((x) => visit(x, depth + 1));
    out.push(/** @type {Obj} */ (node));
    for (const v of Object.values(node)) visit(v, depth + 1);
  };
  visit(answer, 0);
  return out;
}

// Whether the answer looks like voyager JSON at all: an empty search still has these.
/** @param {unknown} answer */
const looksLikeVoyager = (answer) => isObj(answer) && ['included', 'data', 'elements', 'paging', 'metadata'].some((k) => k in answer);

/** @param {Obj} o @param {RegExp} re */
const typeIs = (o, re) => typeof o.$type === 'string' && re.test(o.$type);

// Text that LinkedIn sends as a string or as { text }.
/** @param {unknown} v @returns {string} */
const textOf = (v) => (typeof v === 'string' ? v.trim() : isObj(v) && typeof v.text === 'string' ? v.text.trim() : '');

// The number at the end of an urn: 'urn:li:fs_normalized_company:1234' gives '1234'.
/** @param {unknown} urn */
export const idOfUrn = (urn) => String(urn ?? '').match(/:(\d+)\)?$/)?.[1] ?? '';

// The largest picture of a vector image ({ rootUrl, artifacts: [{ width, fileIdentifyingUrlPathSegment }] }) found
// under `node`, or ''.
/** @param {unknown} node @returns {string} */
function imageIn(node) {
  for (const o of objectsIn(node)) {
    if (typeof o.rootUrl !== 'string' || !Array.isArray(o.artifacts) || !o.artifacts.length) continue;
    const best = [...o.artifacts].sort((a, b) => (Number(b?.width) || 0) - (Number(a?.width) || 0))[0];
    const seg = best?.fileIdentifyingUrlPathSegment;
    if (typeof seg === 'string') return o.rootUrl + seg;
  }
  return '';
}

// --- Calls ---

/** @param {DataStore} store @param {string} key */
const isCached = (store, key) => {
  const hit = store.get(LINKEDIN)?.cache?.[key];
  return Boolean(hit && Date.now() - hit.at < SEARCH_MAX_AGE);
};

// One read through the queue. `tally` counts the calls made and those answered from the cache, for the step's note.
/**
 * @param {DataStore} store
 * @param {{ path: string, cacheKey: string, normalized?: boolean, what: string, signal?: AbortSignal }} req
 * @param {CallTally} [tally]
 */
async function read(store, { path, cacheKey, normalized = true, what, signal }, tally) {
  const hit = isCached(store, cacheKey);
  try {
    const answer = await linkedinCall(store, { path, cacheKey, maxAge: SEARCH_MAX_AGE, ...(normalized ? { headers: NORMALIZED } : {}), signal });
    if (tally) tally[hit ? 'cached' : 'calls'] += 1;
    return answer;
  } catch (err) {
    throw new Error(sessionErrorText(err, what));
  }
}

// A session error in words a step can show, each saying what to do next.
/** @param {unknown} err @param {string} [what] What was asked, for a 404 ("the company acme"). */
export function sessionErrorText(err, what = 'that page') {
  if (!(err instanceof LinkedinSessionError) && !(isObj(err) && typeof err.code === 'string' && err.name === 'LinkedinSessionError')) {
    return /** @type {Error} */ (err)?.message ?? String(err);
  }
  const e = /** @type {LinkedinSessionError} */ (err);
  if (e.code === 'no-session') return 'No LinkedIn session is saved. Add li_at and JSESSIONID in Settings → LinkedIn.';
  if (e.code === 'limit') return 'Today’s limit of LinkedIn session calls is reached; a scheduled run tries again tomorrow. The limit is in Settings → LinkedIn.';
  if (e.code === 'signed-out') return 'LinkedIn signed the session out. Save li_at and JSESSIONID again in Settings → LinkedIn.';
  if (e.code === 'runners') return `The runners did not answer (${e.message}). LinkedIn calls go through them: start the board with bun start.`;
  if (e.status === 404) return `LinkedIn has no ${what} (404).`;
  if (e.status === 429) return 'LinkedIn asked to slow down (429). Try again later.';
  return e.message || 'LinkedIn failed.';
}

// --- A company by name ---

// UNVERIFIED path: the search box's typeahead, companies only.
/** @param {string} name */
export const companySearchPath = (name) => `typeahead/hitsV2?keywords=${encodeURIComponent(name)}&origin=OTHER&q=type&type=COMPANY`;

// UNVERIFIED path: a company page by its universal name (the slug after /company/). Socials reads the same, so they
// share the cache.
/** @param {string} universalName */
export const companyPath = (universalName) =>
  `organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(universalName)}`;

/** @param {Obj} o @returns {LinkedinCompany} */
function companyOf(o) {
  const universalName = String(o.universalName ?? '');
  const handle = universalName ? `company/${universalName}` : '';
  return {
    name: textOf(o.name) || universalName,
    handle,
    url: handle ? linkedinUrl(handle) : '',
    urn: String(o.entityUrn ?? o.objectUrn ?? ''),
    id: idOfUrn(o.entityUrn) || idOfUrn(o.objectUrn),
    industry: '',
    size: '',
    followers: null,
    website: '',
    headquarters: '',
  };
}

// The companies in a typeahead answer, best first. Companies are the entities with a universal name; a hit without
// its entity (an older answer shape) gives what its own text and urn hold.
/** @param {unknown} answer @returns {LinkedinCompany[]} */
export function parseCompanySearch(answer) {
  if (!looksLikeVoyager(answer)) throw new Error('LinkedIn’s company search answered in a shape the board does not know (see companySearchPath in js/linkedin-search.js).');
  /** @type {LinkedinCompany[]} */
  const found = [];
  /** @param {LinkedinCompany} c */
  const add = (c) => {
    if (c.id && !found.some((x) => x.id === c.id)) found.push(c);
  };
  const all = objectsIn(answer);
  /** @type {Map<string, Obj>} */
  const byUrn = new Map(all.filter((o) => typeof o.entityUrn === 'string').map((o) => [o.entityUrn, o]));
  // Hits keep LinkedIn's order; each points at its company entity.
  for (const hit of all.filter((o) => typeIs(o, /TypeaheadHit/i) || (isObj(o.hitInfo) && 'text' in o))) {
    const ref = objectsIn(hit.hitInfo ?? hit).map((x) => x.company ?? x['*company'] ?? x.entityUrn).find((u) => typeof u === 'string' && /company/i.test(u));
    const entity = ref ? byUrn.get(ref) : undefined;
    if (entity?.universalName) add(companyOf(entity));
    else if (ref) add({ ...companyOf({ entityUrn: ref }), name: textOf(hit.text) });
  }
  for (const o of all) if (typeof o.universalName === 'string' && (typeIs(o, /Company/i) || o.entityUrn)) add(companyOf(o));
  return found;
}

// A company's details from its page's answer, or null when the answer holds no company.
/** @param {unknown} answer @param {string} [universalName] @returns {LinkedinCompany | null} */
export function parseCompany(answer, universalName = '') {
  const all = objectsIn(answer);
  const want = universalName.toLowerCase();
  const o = all.find((x) => typeof x.universalName === 'string' && (!want || x.universalName.toLowerCase() === want) && (x.name || x.staffCount != null))
    ?? all.find((x) => typeof x.universalName === 'string');
  if (!o) return null;
  const c = companyOf(o);
  // Industries come inline or as urns of Industry entities.
  const industries = [
    ...(Array.isArray(o.companyIndustries) ? o.companyIndustries : []),
    ...(Array.isArray(o['*companyIndustries']) ? o['*companyIndustries'].map((/** @type {string} */ u) => all.find((x) => x.entityUrn === u)) : []),
  ].map((x) => textOf(x?.localizedName)).filter(Boolean);
  c.industry = industries[0] ?? textOf(o.industry);
  const range = o.staffCountRange;
  c.size = isObj(range) && range.start != null ? `${range.start}${range.end ? `–${range.end}` : '+'}` : o.staffCount != null ? String(o.staffCount) : '';
  const followers = Number(o.followingInfo?.followerCount ?? all.find((x) => typeof x.followerCount === 'number')?.followerCount);
  c.followers = Number.isFinite(followers) ? followers : null;
  c.website = String(o.companyPageUrl ?? o.websiteUrl ?? '');
  const hq = isObj(o.headquarter) ? o.headquarter : isObj(o.headquarters) ? o.headquarters : null;
  c.headquarters = hq ? [hq.city, hq.geographicArea, hq.country].filter(Boolean).join(', ') : '';
  return c;
}

/**
 * Companies by name: 'best' gives the first match with its page's details (2 calls), 'top' the first `top` matches as
 * the search gives them (1 call). Throws when LinkedIn finds none.
 * @param {DataStore} store
 * @param {string} name
 * @param {{ mode?: string, top?: number, tally?: CallTally, signal?: AbortSignal }} [opts]
 * @returns {Promise<LinkedinCompany[]>}
 */
export async function findCompanies(store, name, { mode = 'best', top = 5, tally, signal } = {}) {
  const q = String(name ?? '').trim();
  if (!q) throw new Error('Enter the company’s name.');
  const answer = await read(store, { path: companySearchPath(q), cacheKey: `company-search:${q.toLowerCase()}`, what: 'company search', signal }, tally);
  const hits = parseCompanySearch(answer);
  if (!hits.length) throw new Error(`LinkedIn found no company named “${q}”.`);
  if (mode !== 'best') return hits.slice(0, Math.min(COMPANY_TOP_MAX, Math.max(1, top)));
  const best = hits[0];
  if (!best.handle) return [best];
  const universalName = best.handle.slice('company/'.length);
  const page = await read(store, { path: companyPath(universalName), cacheKey: `company:${universalName.toLowerCase()}`, normalized: false, what: `company ${best.handle}`, signal }, tally);
  const details = parseCompany(page, universalName);
  return [details ? { ...best, ...Object.fromEntries(Object.entries(details).filter(([, v]) => v !== '' && v != null)) } : best];
}

/**
 * A company page by its link or 'company/<name>' handle (1 call), or null for an unknown page.
 * @param {DataStore} store
 * @param {string} handle
 * @param {{ tally?: CallTally, signal?: AbortSignal }} [opts]
 */
export async function companyByHandle(store, handle, { tally, signal } = {}) {
  const universalName = handle.replace(/^company\//, '');
  const page = await read(store, { path: companyPath(universalName), cacheKey: `company:${universalName.toLowerCase()}`, normalized: false, what: `company ${handle}`, signal }, tally);
  return parseCompany(page, universalName);
}

// --- People at a company ---

// Rest.li query values cannot hold its own separators.
/** @param {string} text */
const restliText = (text) => encodeURIComponent(text.replace(/[(),:]/g, ' ').replace(/\s+/g, ' ').trim());

// UNVERIFIED path: people search (the "People" tab of LinkedIn's search) filtered by current company, 10 per page.
/** @param {{ companyId: string, keywords?: string, start?: number }} q */
export function peopleSearchPath({ companyId, keywords = '', start = 0 }) {
  const kw = keywords.trim() ? `keywords:${restliText(keywords)},` : '';
  const query = `(${kw}flagshipSearchIntent:SEARCH_SRP,queryParameters:(currentCompany:List(${encodeURIComponent(companyId)}),resultType:List(PEOPLE)),includeFiltersInResponse:false)`;
  return `search/dash/clusters?decorationId=com.linkedin.voyager.dash.deco.search.SearchClusterCollection-175&origin=FACETED_SEARCH&q=all&query=${query}&start=${start}&count=${PEOPLE_PAGE}`;
}

// '2nd' from LinkedIn's distance ('DISTANCE_2') or badge ('• 2nd').
/** @param {Obj} o */
function degreeOf(o) {
  const d = String(o.entityCustomTrackingInfo?.memberDistance ?? o.memberDistance?.value ?? o.memberDistance ?? '');
  const n = d.match(/DISTANCE_(\d)/)?.[1];
  if (n) return ({ 1: '1st', 2: '2nd', 3: '3rd' })[/** @type {'1' | '2' | '3'} */ (n)] ?? `${n}th`;
  if (/OUT_OF_NETWORK/.test(d)) return 'out of network';
  return textOf(o.badgeText).replace(/^[•·\s]+/, '');
}

// The people of one search page, in LinkedIn's order. Out-of-network members come back as "LinkedIn Member" with no
// profile link: they are kept with `hidden: true`.
/** @param {unknown} answer @returns {LinkedinPerson[]} */
export function parsePeople(answer) {
  if (!looksLikeVoyager(answer)) throw new Error('LinkedIn’s people search answered in a shape the board does not know (see peopleSearchPath in js/linkedin-search.js).');
  /** @type {LinkedinPerson[]} */
  const people = [];
  /** @type {Set<string>} */
  const seen = new Set();
  for (const o of objectsIn(answer)) {
    const isResult = typeIs(o, /EntityResultViewModel/) || (isObj(o.title) && 'primarySubtitle' in o && 'navigationUrl' in o);
    if (!isResult) continue;
    const name = textOf(o.title);
    const nav = String(o.navigationUrl ?? '');
    const handle = /linkedin\.com\/in\//.test(nav) ? linkedinHandle(nav.split('?')[0]) : '';
    const key = handle || String(o.entityUrn ?? o.trackingUrn ?? `${name}:${people.length}`);
    if (seen.has(key)) continue;
    seen.add(key);
    people.push({
      name,
      headline: textOf(o.primarySubtitle),
      location: textOf(o.secondarySubtitle),
      url: handle ? linkedinUrl(handle) : '',
      handle,
      degree: degreeOf(o),
      image: imageIn(o.image),
      hidden: !handle || HIDDEN_NAME.test(name),
    });
  }
  return people;
}

// What the people step was given as its company, as a numeric id, a page handle or a name.
/** @param {unknown} value @returns {{ id: string, handle: string, name: string }} */
export function companyRef(value) {
  let v = value;
  if (Array.isArray(v)) v = v[0];
  if (isObj(v)) {
    const id = String(v.id ?? '').trim() || idOfUrn(v.urn) || idOfUrn(v.entityUrn);
    const handle = linkedinHandle(v.handle ?? v.url ?? '');
    return { id: /^\d+$/.test(id) ? id : '', handle: handle.startsWith('company/') ? handle : '', name: String(v.name ?? v.company ?? '').trim() };
  }
  const text = String(v ?? '').trim();
  if (/^\d+$/.test(text)) return { id: text, handle: '', name: '' };
  if (/^urn:li:/.test(text)) return { id: idOfUrn(text), handle: '', name: '' };
  const handle = /linkedin\.com\/company\/|^company\//i.test(text) ? linkedinHandle(text) : '';
  return { id: '', handle, name: handle ? '' : text };
}

/**
 * The people who work at a company, page by page (10 a page, one call each) until `count` or a short page.
 * @param {DataStore} store
 * @param {{ companyId: string, keywords?: string, location?: string, count?: number, skipHidden?: boolean, company?: string, tally?: CallTally, signal?: AbortSignal }} q
 * @returns {Promise<{ people: LinkedinPerson[], hidden: number, elsewhere: number, pages: number }>}
 */
export async function companyPeople(store, { companyId, keywords = '', location = '', count = 20, skipHidden = true, company = '', tally, signal }) {
  const want = Math.min(PEOPLE_MAX, Math.max(1, Math.round(count)));
  const place = location.trim().toLowerCase();
  /** @type {LinkedinPerson[]} */
  const people = [];
  let hidden = 0;
  let elsewhere = 0;
  let pages = 0;
  for (let start = 0; start < want; start += PEOPLE_PAGE) {
    const kw = keywords.trim().toLowerCase();
    const answer = await read(store, {
      path: peopleSearchPath({ companyId, keywords, start }),
      cacheKey: `company-people:${companyId}:${kw}:${start / PEOPLE_PAGE}`,
      what: 'such company',
      signal,
    }, tally);
    pages += 1;
    const page = parsePeople(answer);
    for (const p of page) {
      if (p.hidden && skipHidden) { hidden += 1; continue; }
      if (place && !p.location.toLowerCase().includes(place)) { elsewhere += 1; continue; }
      if (people.length < want) people.push(company ? { ...p, company } : p);
    }
    if (page.length < PEOPLE_PAGE) break;
  }
  return { people, hidden, elsewhere, pages };
}

// --- A member's profile ---

// UNVERIFIED path: a member's profile with its positions, by the slug after /in/.
/** @param {string} slug */
export const profilePath = (slug) =>
  `identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(slug)}&decorationId=com.linkedin.voyager.dash.deco.identity.profile.FullProfileWithEntities-93`;

/** @param {unknown} d */
const yearOf = (d) => (isObj(d) && d.year ? String(d.year) : '');

// The profile in a profile answer, or null when it holds none.
/** @param {unknown} answer @param {string} handle @returns {LinkedinProfile | null} */
export function parseProfile(answer, handle) {
  const all = objectsIn(answer);
  const slug = handle.replace(/^in\//, '').toLowerCase();
  const people = all.filter((o) => typeof o.firstName === 'string' && (typeIs(o, /Profile/i) || 'publicIdentifier' in o));
  const p = people.find((o) => String(o.publicIdentifier ?? '').toLowerCase() === slug) ?? people.find((o) => 'headline' in o) ?? people[0];
  if (!p) return null;
  const name = [p.firstName, p.lastName].filter((s) => typeof s === 'string' && s.trim()).join(' ').trim();
  const geo = isObj(p.geoLocation) ? p.geoLocation : null;
  const geoEntity = geo && typeof geo['*geo'] === 'string' ? all.find((o) => o.entityUrn === geo['*geo']) : isObj(geo?.geo) ? geo.geo : null;
  const location = textOf(geoEntity?.defaultLocalizedName) || textOf(p.locationName) || textOf(p.geoLocationName) || '';
  // Positions: current ones (no end) first, then the latest.
  const positions = all
    .filter((o) => (typeIs(o, /Position$/) || (typeof o.title === 'string' && 'companyName' in o)) && (o.title || o.companyName))
    .map((o) => {
      const companyEntity = typeof o['*company'] === 'string' ? all.find((x) => x.entityUrn === o['*company']) : isObj(o.company) ? o.company : null;
      const start = o.dateRange?.start ?? o.timePeriod?.startDate;
      const end = o.dateRange?.end ?? o.timePeriod?.endDate;
      return { title: textOf(o.title), company: textOf(o.companyName) || textOf(companyEntity?.name), from: yearOf(start), to: yearOf(end), current: !end };
    });
  /** @type {Set<string>} */
  const seen = new Set();
  const unique = positions.filter((x) => {
    const k = `${x.title}|${x.company}|${x.from}`;
    return seen.has(k) ? false : (seen.add(k), true);
  }).sort((a, b) => Number(b.current) - Number(a.current) || Number(b.to || 9999) - Number(a.to || 9999) || Number(b.from) - Number(a.from));
  const now = unique.find((x) => x.current);
  const headline = textOf(p.headline);
  const at = headline.match(/^(.+?)\s+(?:at|@)\s+(.+)$/i);
  const own = linkedinHandle(p.publicIdentifier ? `in/${p.publicIdentifier}` : handle) || handle;
  return {
    name,
    headline,
    location,
    about: textOf(p.summary),
    currentTitle: now?.title || at?.[1]?.trim() || '',
    currentCompany: now?.company || at?.[2]?.trim() || '',
    experience: unique.slice(0, 5).map((x) => `${x.title}${x.company ? ` at ${x.company}` : ''}${x.from ? ` (${x.from}–${x.current ? 'now' : x.to || '?'})` : ''}`),
    url: linkedinUrl(own),
    handle: own,
  };
}

/**
 * One member's profile by handle or link (1 call).
 * @param {DataStore} store
 * @param {string} text
 * @param {{ tally?: CallTally, signal?: AbortSignal }} [opts]
 */
export async function readProfile(store, text, { tally, signal } = {}) {
  const handle = linkedinHandle(text);
  if (!handle.startsWith('in/')) throw new Error(`“${String(text).slice(0, 80)}” is not a LinkedIn profile handle or link (in/<name>).`);
  const slug = handle.slice(3);
  const answer = await read(store, { path: profilePath(slug), cacheKey: `profile-full:${slug.toLowerCase()}`, what: `profile ${handle}`, signal }, tally);
  const profile = parseProfile(answer, handle);
  if (!profile) throw new Error('LinkedIn’s profile answer held no profile in a shape the board knows (see profilePath in js/linkedin-search.js).');
  return profile;
}
