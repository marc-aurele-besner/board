// Reads the follower counts of the X, LinkedIn, GitHub and Instagram accounts in socials.json. Neither X nor LinkedIn needs a
// key for a public profile: X's profile page and a LinkedIn person's page carry the counts for anyone. LinkedIn shows
// company pages only when signed in, so those go through the session saved in Settings → LinkedIn, as the site's own
// pages do. GitHub's API gives a user's or organization's followers and its repos' stars, with the token of
// Settings → GitHub when there is one. Instagram gives a profile's counts only in the page it shows link previews,
// rounded above 10,000 as the site writes them (12.3K). Settings and Monitoring ask for accounts at once (POST /run/socials with ids).
/** @import { Job } from '../../types/runner' */
/** @import { LinkedinSettings, GithubSettings, SocialAccount } from '../../types/data' */
import { SOCIALS, recordRead, isOrganization } from '../../js/socials.js';

// The sites answer a browser's page, not a script's.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
// A pause between two reads of one site, so a long list does not look like a crawl.
const PAUSE_MS = 2000;

/** @typedef {{ followers: number, following?: number, stars?: number, name?: string, image?: string }} Read */

/** @param {string} url @param {AbortSignal} signal @param {Record<string, string>} [headers] */
async function page(url, signal, headers = {}) {
  const res = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', accept: 'text/html', ...headers }, signal });
  return { status: res.status, text: await res.text() };
}

/** @param {string} html @param {string} prop */
const meta = (html, prop) => html.match(new RegExp(`<meta[^>]+property="${prop}"[^>]+content="([^"]*)"`))?.[1]
  ?.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'");

// X's profile page holds the profile as JSON. The counts are taken from the object of this screen name, since the
// page also holds other accounts (the ones it suggests).
/** @param {string} handle @param {AbortSignal} signal @returns {Promise<Read>} */
async function readX(handle, signal) {
  const { status, text } = await page(`https://x.com/${encodeURIComponent(handle)}`, signal);
  if (status === 404) throw new Error(`X has no account @${handle}.`);
  if (status !== 200) throw new Error(`X answered ${status}.`);
  const json = text.replace(/\\"/g, '"');
  const names = [...json.matchAll(/"screen_name":"(\w+)"/g)];
  for (const m of json.matchAll(/"relationship_counts":\{"followers":(\d+),"following":(\d+)/g)) {
    const owner = names.filter((n) => /** @type {number} */ (n.index) < /** @type {number} */ (m.index)).pop();
    if (owner?.[1].toLowerCase() !== handle.toLowerCase()) continue;
    const title = meta(text, 'og:title') ?? '';
    return {
      followers: Number(m[1]),
      following: Number(m[2]),
      name: title.replace(/\s*\(@\w+\).*$/, '') || undefined,
      image: meta(text, 'og:image'),
    };
  }
  throw new Error('X’s page did not show the counts. The account may be protected or suspended.');
}

// A LinkedIn person's public page describes them in JSON-LD, with their follower count.
/** @param {string} handle @param {AbortSignal} signal @returns {Promise<Read | null>} */
async function readLinkedinPerson(handle, signal) {
  const { status, text } = await page(`https://www.linkedin.com/${handle}/`, signal);
  if (status !== 200) return null;
  for (const m of text.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) {
    let data;
    try {
      data = JSON.parse(m[1]);
    } catch {
      continue;
    }
    /** @type {Record<string, any>[]} */ // any: JSON-LD as LinkedIn writes it
    const nodes = Array.isArray(data['@graph']) ? data['@graph'] : [data];
    const person = nodes.find((n) => n?.['@type'] === 'Person');
    const stats = [person?.interactionStatistic].flat();
    const follows = stats.find((s) => /FollowAction/.test(String(s?.interactionType ?? '')));
    if (follows) return { followers: Number(follows.userInteractionCount), name: person?.name, image: meta(text, 'og:image') };
  }
  return null;
}

/** @param {LinkedinSettings | undefined} session */
const sessionHeaders = (session) => {
  const liAt = String(session?.liAt ?? '').trim().replace(/^li_at=/, '');
  const jsession = String(session?.jsessionid ?? '').trim().replace(/^JSESSIONID=/, '').replace(/"/g, '');
  if (!liAt || !jsession) return null;
  return {
    cookie: `li_at=${liAt}; JSESSIONID="${jsession}"`,
    'csrf-token': jsession,
    'x-restli-protocol-version': '2.0.0',
    accept: 'application/json',
  };
};

// The first value of `key` anywhere in a JSON answer.
/** @param {unknown} node @param {string} key @returns {unknown} */
function find(node, key) {
  if (!node || typeof node !== 'object') return undefined;
  if (key in node) return /** @type {Record<string, unknown>} */ (node)[key];
  for (const v of Object.values(node)) {
    const hit = find(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

// LinkedIn's own API, the one its pages call, with the signed-in session.
/** @param {SocialAccount} a @param {LinkedinSettings | undefined} session @param {AbortSignal} signal @returns {Promise<Read>} */
async function readLinkedinSignedIn(a, session, signal) {
  const headers = sessionHeaders(session);
  if (!headers) {
    throw new Error(isOrganization(a)
      ? 'LinkedIn shows company pages only when signed in. Add the session in Settings → LinkedIn.'
      : 'LinkedIn did not show this profile’s public page. Add the session in Settings → LinkedIn to read it signed in.');
  }
  const name = a.handle.replace(/^[a-z]+\//, '');
  /** @param {string} path @returns {Promise<unknown>} */
  const get = async (path) => {
    const res = await fetch(`https://www.linkedin.com/voyager/api/${path}`, { headers: { 'user-agent': UA, ...headers }, signal, redirect: 'manual' });
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) {
      throw new Error('LinkedIn did not accept the session. Copy li_at and JSESSIONID again in Settings → LinkedIn.');
    }
    if (res.status === 404) throw new Error(`LinkedIn has no page ${a.handle}.`);
    if (!res.ok) throw new Error(`LinkedIn answered ${res.status}.`);
    return res.json();
  };
  if (isOrganization(a)) {
    const data = await get(`organization/companies?decorationId=com.linkedin.voyager.deco.organization.web.WebFullCompanyMain-12&q=universalName&universalName=${encodeURIComponent(name)}`);
    const followers = Number(find(data, 'followerCount'));
    if (!Number.isFinite(followers)) throw new Error('LinkedIn’s answer had no follower count.');
    const title = find(data, 'name');
    return { followers, name: typeof title === 'string' ? title : undefined };
  }
  // A person: their profile's id from the profile, then its following state, which holds the follower count.
  // (identity/profiles/…/networkinfo, read before, now answers 410 Gone.)
  const profile = await get(`identity/dash/profiles?q=memberIdentity&memberIdentity=${encodeURIComponent(name)}`);
  const urn = find(profile, 'entityUrn');
  if (typeof urn !== 'string' || !urn.startsWith('urn:li:fsd_profile:')) throw new Error(`LinkedIn has no profile ${a.handle}.`);
  const state = await get(`feed/dash/followingStates/${encodeURIComponent(`urn:li:fsd_followingState:${urn}`)}`);
  const followers = Number(find(state, 'followerCount') ?? find(profile, 'followerCount'));
  if (!Number.isFinite(followers)) throw new Error('LinkedIn’s answer had no follower count.');
  const first = find(profile, 'firstName');
  const last = find(profile, 'lastName');
  const full = [first, last].filter((s) => typeof s === 'string' && s).join(' ');
  return { followers, name: full || undefined };
}

// GitHub caps a list at 100 per page; 10 pages covers 1,000 repos.
const GITHUB_PAGES = 10;

// A user's or organization's followers from its profile, and the stars of its public repos that are not forks.
/** @param {string} login @param {GithubSettings | undefined} github @param {AbortSignal} signal @returns {Promise<Read>} */
async function readGithub(login, github, signal) {
  const token = github?.orgs?.find((o) => o.org?.toLowerCase() === login.toLowerCase() && o.token)?.token || github?.token || '';
  const headers = { accept: 'application/vnd.github+json', 'user-agent': 'board', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  /** @param {string} path @returns {Promise<any>} */ // any: GitHub's JSON, read field by field below
  const get = async (path) => {
    const res = await fetch(`https://api.github.com${path}`, { headers, signal });
    if (res.status === 404) throw new Error(`GitHub has no user or organization ${login}.`);
    if (res.status === 401) throw new Error('GitHub rejected the token in Settings → GitHub.');
    if (res.status === 403 || res.status === 429) throw new Error('GitHub’s rate limit was reached. A token in Settings → GitHub raises it.');
    if (!res.ok) throw new Error(`GitHub answered ${res.status}.`);
    return res.json();
  };
  const user = await get(`/users/${encodeURIComponent(login)}`);
  let stars = 0;
  for (let p = 1; p <= GITHUB_PAGES; p++) {
    /** @type {{ stargazers_count?: number, fork?: boolean }[]} */
    const repos = await get(`/users/${encodeURIComponent(login)}/repos?per_page=100&type=owner&page=${p}`);
    for (const r of repos) if (!r.fork) stars += r.stargazers_count ?? 0;
    if (repos.length < 100) break;
  }
  return { followers: user.followers ?? 0, following: user.following, stars, name: user.name || undefined, image: user.avatar_url || undefined };
}

// "1,234", "12.3K", "104M": Instagram's way of writing a count.
/** @param {string} text */
const igCount = (text) => {
  const m = text.replace(/,/g, '').match(/^([\d.]+)([KMB])?$/i);
  return m ? Math.round(Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]?.toLowerCase() ?? ''] ?? 1)) : NaN;
};

// Instagram shows a profile only to a signed-in browser, but answers a link preview's crawler with the counts in
// the page's description: "1,234 Followers, 56 Following, 78 Posts - See Instagram photos and videos from Name (@name)".
/** @param {string} handle @param {AbortSignal} signal @returns {Promise<Read>} */
async function readInstagram(handle, signal) {
  const { status, text } = await page(`https://www.instagram.com/${encodeURIComponent(handle)}/`, signal, { 'user-agent': 'facebookexternalhit/1.1' });
  if (status === 404) throw new Error(`Instagram has no account @${handle}.`);
  if (status === 429) throw new Error('Instagram asked to slow down. The next read tries again.');
  if (status !== 200) throw new Error(`Instagram answered ${status}.`);
  const desc = (meta(text, 'og:description') ?? '').replace(/&#064;/g, '@');
  const m = desc.match(/^([\d.,]+[KMB]?) Followers, ([\d.,]+[KMB]?) Following/i);
  if (!m) throw new Error(`Instagram did not show the counts of @${handle}. Check the username.`);
  const title = (meta(text, 'og:title') ?? '').replace(/&#064;/g, '@').replace(/&#x2022;/g, '•');
  return {
    followers: igCount(m[1]),
    following: igCount(m[2]),
    name: title.replace(/\s*\(@[\w.]+\).*$/, '') || undefined,
    image: meta(text, 'og:image'),
  };
}

/** @param {SocialAccount} a @param {LinkedinSettings | undefined} session @param {AbortSignal} signal */
async function readLinkedin(a, session, signal) {
  if (!isOrganization(a)) {
    const read = await readLinkedinPerson(a.handle, signal);
    if (read) return read;
  }
  return readLinkedinSignedIn(a, session, signal);
}

export default /** @satisfies {Job} */ ({
  id: 'socials',
  delay: 12000,
  timeout: 5 * 60000,
  async run({ store, params, signal }) {
    const all = store.get(SOCIALS).accounts ?? [];
    const accounts = params.ids?.length ? all.filter((a) => params.ids?.includes(a.id)) : all;
    if (!accounts.length) return { waiting: 'No X, LinkedIn, GitHub or Instagram account is added in Settings.' };
    const { linkedin: session, github } = store.get('settings');
    /** @type {{ text: string }[]} */
    const errors = [];
    /** @type {Record<string, number>} */
    const last = {};
    for (const a of accounts) {
      const since = Date.now() - (last[a.network] ?? 0);
      if (since < PAUSE_MS) await new Promise((r) => setTimeout(r, PAUSE_MS - since));
      last[a.network] = Date.now();
      try {
        const read = a.network === 'x' ? await readX(a.handle, signal)
          : a.network === 'github' ? await readGithub(a.handle, github, signal)
            : a.network === 'instagram' ? await readInstagram(a.handle, signal)
              : await readLinkedin(a, session, signal);
        recordRead(store, a.id, read);
      } catch (err) {
        if (signal.aborted) throw err;
        const text = /** @type {Error} */ (err).message;
        recordRead(store, a.id, { error: text });
        errors.push({ text: `${a.handle}: ${text}` });
      }
    }
    if (errors.length === accounts.length) throw new Error(errors.slice(0, 3).map((e) => e.text).join('; '));
    return { accounts: accounts.length - errors.length, errors };
  },
});
