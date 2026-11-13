// The X, LinkedIn, GitHub and Instagram accounts added in Settings, and their follower counts (and a GitHub account's stars) over time: the runners read them
// (tools/jobs/socials.js) into socials.json, and Monitoring → Socials draws them. No DOM: the runners import this file.
/** @import { DataStore, SocialAccount, SocialsData, IconName } from '../types/data' */

export const SOCIALS = 'socials';
/** @type {SocialsData} */
export const SOCIALS_DEFAULTS = { accounts: [], history: {}, stars: {} };

/** @type {Record<string, string>} */
export const NETWORKS = { x: 'X', linkedin: 'LinkedIn', github: 'GitHub', instagram: 'Instagram' };

/** @param {string} network @returns {IconName} */
export const networkIcon = (network) => (network === 'x' ? 'x-mark' : network === 'github' ? 'github' : network === 'instagram' ? 'instagram' : 'linkedin');

// A local day as YYYY-MM-DD, the key of an account's history.
/** @param {number | Date} [t] */
export const dayKey = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// The handle from what was typed: "@name", "name" or a profile link. LinkedIn keeps the kind of page:
// "in/<name>" for a person, "company/<name>" (or school, showcase) for a page. Empty when it cannot be one.
/** @param {string} network @param {string} text */
export function parseHandle(network, text) {
  const raw = String(text ?? '').trim().replace(/[?#].*$/, '').replace(/\/+$/, '');
  if (network === 'x') {
    const name = raw.replace(/^https?:\/\//i, '').replace(/^(www\.|mobile\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').split('/')[0];
    return /^\w{1,15}$/.test(name) ? name : '';
  }
  if (network === 'github') {
    // A user or an organization: its stars are those of all its public repos.
    const name = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?github\.com\//i, '').replace(/^@/, '').split('/')[0];
    return /^[a-z\d][a-z\d-]{0,38}$/i.test(name) ? name : '';
  }
  if (network === 'instagram') {
    const name = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?instagram\.com\//i, '').replace(/^@/, '').split('/')[0];
    return /^[\w.]{1,30}$/.test(name) ? name.toLowerCase() : '';
  }
  const path = raw.replace(/^https?:\/\//i, '').replace(/^([a-z]{2,3}\.)?(www\.)?linkedin\.com\//i, '');
  const m = path.match(/^(in|company|school|showcase)\/([^/]+)/i);
  if (m) return `${m[1].toLowerCase()}/${decodeURIComponent(m[2])}`;
  // A bare name is a person's.
  return /^[\w.-]{3,100}$/.test(path) ? `in/${path}` : '';
}

/** @param {SocialAccount} a */
export const profileUrl = (a) => (a.network === 'x' ? `https://x.com/${a.handle}`
  : a.network === 'github' ? `https://github.com/${a.handle}`
    : a.network === 'instagram' ? `https://www.instagram.com/${a.handle}/`
      : `https://www.linkedin.com/${a.handle}/`);

/** @param {SocialAccount} a */
export const handleLabel = (a) => (a.network === 'x' || a.network === 'instagram' ? `@${a.handle}` : a.network === 'github' ? a.handle : a.handle.replace(/^[a-z]+\//, ''));

// A LinkedIn page that is not a person's: LinkedIn shows those only to a signed-in session.
/** @param {SocialAccount} a */
export const isOrganization = (a) => a.network === 'linkedin' && !a.handle.startsWith('in/');

// Saves a read: the account's counts, and the day's point of its history (and of its stars, for GitHub).
/**
 * @param {DataStore} store @param {string} id
 * @param {{ followers?: number, following?: number, stars?: number, name?: string, image?: string, error?: string | null }} read
 */
export function recordRead(store, id, read) {
  const at = Date.now();
  store.save(SOCIALS, (d) => {
    const a = d.accounts.find((x) => x.id === id);
    if (!a) return;
    if (read.error) {
      a.error = read.error;
      a.at = at;
      return;
    }
    Object.assign(a, { followers: read.followers, following: read.following, at, error: null });
    if (read.name) a.name = read.name;
    if (read.image) a.image = read.image;
    if (typeof read.stars === 'number') {
      a.stars = read.stars;
      ((d.stars ??= {})[id] ??= {})[dayKey(at)] = read.stars;
    }
    if (typeof read.followers === 'number') (d.history[id] ??= {})[dayKey(at)] = read.followers;
  });
}
