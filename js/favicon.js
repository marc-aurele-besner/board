// Finds a project's icon from its website. The site's own icon files are checked first, largest image wins.
// If the site has none, a public favicon service is asked. Results are cached per site.
import { h } from './ui.js';

const PROBE_TIMEOUT_MS = 5000;
const HIT_TTL_MS = 14 * 86400000;
const MISS_TTL_MS = 86400000;
// Icon files a site may publish, in preference order. Larger ones are better, so they are compared by size.
const PATHS = [
  '/apple-touch-icon.png',
  '/apple-touch-icon-precomposed.png',
  '/favicon-196x196.png',
  '/favicon-96x96.png',
  '/favicon-32x32.png',
  '/favicon.png',
  '/favicon.ico',
  '/icon.png',
];
const SERVICE = (host) => `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host)}&sz=64`;

const memory = new Map(); // site -> { url: string|null, at: number }
const pending = new Map(); // site -> Promise, so one site is searched once at a time
const storageKey = (site) => `board:favicon:${site}`;

function readCache(site) {
  try {
    return JSON.parse(localStorage.getItem(storageKey(site)) ?? 'null');
  } catch {
    return null;
  }
}

function writeCache(site, entry) {
  try {
    localStorage.setItem(storageKey(site), JSON.stringify(entry));
  } catch {
    /* storage blocked: the result is kept for this page only */
  }
}

// What is known about a site's icon: undefined when unknown or stale, null when none was found, or the URL.
export function cachedFavicon(site) {
  const entry = memory.get(site) ?? readCache(site);
  if (!entry) return undefined;
  if (Date.now() - entry.at > (entry.url ? HIT_TTL_MS : MISS_TTL_MS)) return undefined;
  memory.set(site, entry);
  return entry.url;
}

// Loads an image and reports its width; 0 when it fails or times out. Cross-origin images can be measured this way.
function probe(url) {
  return new Promise((resolve) => {
    const img = new Image();
    const timer = setTimeout(() => {
      img.src = '';
      resolve(0);
    }, PROBE_TIMEOUT_MS);
    img.onload = () => {
      clearTimeout(timer);
      resolve(img.naturalWidth || 0);
    };
    img.onerror = () => {
      clearTimeout(timer);
      resolve(0);
    };
    img.src = url;
  });
}

// The site and its other common spelling (with or without www.).
function hostVariants(site) {
  const u = new URL(site);
  const variants = [u.origin];
  const other = u.host.startsWith('www.') ? u.host.slice(4) : `www.${u.host}`;
  variants.push(`${u.protocol}//${other}`);
  return variants;
}

// The largest icon file the site publishes, or null.
async function findOwnIcon(site) {
  const candidates = hostVariants(site).flatMap((origin) => PATHS.map((path) => `${origin}${path}`));
  const widths = await Promise.all(candidates.map((url) => probe(url)));
  let best = null;
  let bestScore = 15; // anything 16px or smaller is not worth showing
  widths.forEach((width, i) => {
    const score = Math.min(width, 256);
    if (width > 0 && score > bestScore) {
      best = candidates[i];
      bestScore = score;
    }
  });
  return best;
}

// Swaps every placeholder for this site for the found icon (or the colored dot when none was found).
function swapPlaceholders(site, url) {
  for (const el of document.querySelectorAll('[data-favicon-site]')) {
    if (el.getAttribute('data-favicon-site') !== site) continue;
    el.replaceWith(url ? iconImage(url, el.getAttribute('data-class') ?? 'project-icon', el.getAttribute('data-color')) : dot(el.getAttribute('data-color')));
  }
}

// Searches a site once: its own icon files first, then the public service. The result is cached and the page is updated.
export function resolveFavicon(site) {
  if (pending.has(site)) return pending.get(site);
  const search = (async () => {
    let url = await findOwnIcon(site);
    if (!url) {
      const host = new URL(site).host;
      if (await probe(SERVICE(host))) url = SERVICE(host);
    }
    const entry = { url: url ?? null, at: Date.now() };
    memory.set(site, entry);
    writeCache(site, entry);
    swapPlaceholders(site, entry.url);
    return entry.url;
  })().finally(() => pending.delete(site));
  pending.set(site, search);
  return search;
}

// Forgets the cached results, so the next render searches again. Used by "Re-run icons".
export function clearFaviconCache(sites) {
  for (const site of sites) {
    memory.delete(site);
    try {
      localStorage.removeItem(storageKey(site));
    } catch {
      /* storage blocked */
    }
  }
}

const dot = (color) => h('span', { class: 'dot', style: { background: color } });

export function iconImage(url, className, color) {
  return h('img', {
    class: className,
    src: url,
    alt: '',
    loading: 'lazy',
    referrerpolicy: 'no-referrer',
    'data-color': color,
    onerror: (e) => e.currentTarget.replaceWith(dot(color)),
  });
}

// The icon of a project: its own image URL if set, else the site's icon, else the colored dot.
export function siteIcon({ iconUrl, website, color }, className = 'project-icon') {
  if (iconUrl) return iconImage(iconUrl, className, color);
  if (!website) return dot(color);
  const known = cachedFavicon(website);
  if (known) return iconImage(known, className, color);
  if (known === null) return dot(color);
  resolveFavicon(website);
  // A placeholder that is swapped for the icon when the search finishes.
  return h('span', {
    class: 'dot favicon-pending',
    style: { background: color },
    'data-favicon-site': website,
    'data-class': className,
    'data-color': color,
  });
}
