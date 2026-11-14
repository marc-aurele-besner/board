// A project's brand: its images (logo, favicon, share image), colours, fonts, links (stylesheets, guidelines) and
// notes. Find with AI reads the local folder through the runner and the website's head tags, asks the model once,
// and adds what is new to what the project already has; nothing the user wrote is changed or removed.
/** @import { DataStore, Project, ProjectBrand, BrandItem } from '../types/data' */
import { ask, parseJson } from './ai.js';
import { systemPrompt } from './prompts.js';
import { uid, now } from './ui.js';
import { listFolder, readFile } from './terminal.js';
import { readBrandTags } from './sitecheck.js';
import { runnerOf } from './dev-core.js';
import { clipWords } from './profile.js';

/** @typedef {'images' | 'colors' | 'fonts' | 'links'} BrandList */
/** @type {BrandList[]} */
export const BRAND_LISTS = ['images', 'colors', 'fonts', 'links'];
// Caps on each list, so a reply listing every colour of a large stylesheet stays readable.
const LIST_MAX = { images: 24, colors: 32, fonts: 8, links: 16 };

// Folders where projects usually keep their images and styles, read besides the top level.
const ASSET_DIRS = ['public', 'static', 'assets', 'images', 'img', 'icons', 'brand', 'branding', 'css', 'styles', 'style', 'app', 'www', 'site', 'src', 'src/assets', 'src/styles', 'src/app', 'public/images', 'public/img', 'public/icons', 'static/images', 'assets/images'];
const MAX_FOLDERS = 14;
const IMAGE_FILE = /\.(svg|png|ico|jpe?g|webp|gif|avif)$/i;
const BRAND_NAME = /logo|icon|favicon|brand|mark|og[-_.]|social|banner|apple-touch|wordmark|cover|splash|android-chrome|mstile/i;
const MANIFEST = /^(manifest\.json|site\.webmanifest|manifest\.webmanifest)$/i;
const THEME_FILE = /^(tailwind\.config\.(js|cjs|mjs|ts)|theme\.(js|ts|json)|tokens\.json|design-tokens\.json|brand\.json)$/i;
const STYLE_FILE = /\.(css|scss|sass|less)$/i;
// Stylesheets most likely to hold the tokens are read first.
const STYLE_RANK = /^(_?variables|_?tokens|theme|globals?|style|styles|index|main|app|base)\./i;
const MAX_STYLES = 4;
const STYLE_LINES = 160;

export const emptyBrand = () => ({ images: [], colors: [], fonts: [], links: [], notes: '', updated: '', usageId: '' });

// Projects saved before brands existed have none; they read as empty.
/** @param {Project | null | undefined} project @returns {ProjectBrand} */
export const brandOf = (project) => ({ ...emptyBrand(), ...(project?.brand ?? {}) });

/** @param {ProjectBrand} brand */
export const hasBrand = (brand) => Boolean(BRAND_LISTS.some((k) => brand[k].length) || brand.notes.trim());

/** @param {Project} project */
export const hasBrandSources = (project) => Boolean(project.localPath || project.website);

// A CSS colour as written in a stylesheet: hex, a colour function or a name. Anything else is not shown as a swatch.
const COLOR = /^(#[0-9a-f]{3,8}|(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color)\(.+\)|[a-z]{3,20})$/i;
/** @param {string} value */
export const isColor = (value) => COLOR.test(value.trim()) && !/^(inherit|initial|unset|revert|currentcolor|transparent|none)$/i.test(value.trim());

/** @param {string} value */
export const isUrl = (value) => /^https?:\/\//i.test(value);

// The key two items are the same by: images and links by address, colours and fonts by value.
/** @param {string} value */
const keyOf = (value) => value.trim().replace(/\/+$/, '').toLowerCase();

// A file's name without folders and extension, as a label when none is given.
/** @param {string} value */
export const nameOf = (value) => (value.split(/[?#]/)[0].split('/').filter(Boolean).pop() ?? value).replace(/\.[a-z0-9]+$/i, '');

// One list's items, cleaned: both fields strings, the value set, no repeated value, and at most the list's cap.
/** @param {BrandList} list @param {unknown} items @returns {BrandItem[]} */
export function cleanItems(list, items) {
  if (!Array.isArray(items)) return [];
  /** @type {BrandItem[]} */
  const out = [];
  const seen = new Set();
  for (const raw of items) {
    const item = /** @type {Partial<BrandItem> | null} */ (raw && typeof raw === 'object' ? raw : null);
    const value = typeof item?.value === 'string' ? item.value.trim() : '';
    const label = typeof item?.label === 'string' ? item.label.trim() : '';
    if (!value || seen.has(keyOf(value))) continue;
    if (list === 'colors' && !isColor(value)) continue;
    seen.add(keyOf(value));
    out.push({ label, value });
  }
  return out.slice(0, LIST_MAX[list]);
}

// What was found is added after what the project has; an item whose value is already there is skipped, so labels
// and order set by hand stay. Notes are only filled when empty.
/** @param {ProjectBrand} current @param {Partial<Record<BrandList, unknown>> & { notes?: unknown }} found */
export function mergeBrand(current, found) {
  const next = { ...current };
  for (const list of BRAND_LISTS) {
    const have = new Set(current[list].map((i) => keyOf(i.value)));
    const added = cleanItems(list, found[list]).filter((i) => !have.has(keyOf(i.value)));
    next[list] = [...current[list], ...added].slice(0, Math.max(LIST_MAX[list], current[list].length));
  }
  if (!current.notes.trim() && typeof found.notes === 'string') next.notes = found.notes.trim();
  return next;
}

// --- Reading the sources ---

// The lines of a stylesheet that carry the brand: custom properties, font families and faces, imports.
/** @param {string} text */
function styleLines(text) {
  return text.split(/\n|;(?=\s*--)/)
    .map((l) => l.trim())
    .filter((l) => /^--[\w-]+\s*:|font-family|@font-face|@import|@theme|src:\s*url/.test(l))
    .slice(0, STYLE_LINES)
    .join('\n');
}

// The <link> and <meta> tags of an HTML file that name icons, colours, stylesheets and fonts.
/** @param {string} text */
function headTags(text) {
  const head = text.split(/<\/head>/i)[0];
  return (head.match(/<(link|meta)\b[^>]*>/gi) ?? [])
    .filter((t) => /icon|manifest|theme-color|stylesheet|font|og:image|twitter:image|mask/i.test(t))
    .slice(0, 40)
    .join('\n');
}

// A web manifest says the most through its name, colours and icons.
/** @param {string} text */
function manifestSummary(text) {
  try {
    const m = JSON.parse(text);
    return JSON.stringify({ name: m.name, short_name: m.short_name, theme_color: m.theme_color, background_color: m.background_color, icons: m.icons }, null, 1);
  } catch {
    return clipWords(text, 300);
  }
}

// The project's folder through the runner: image files named like a logo or icon, the web manifest, theme and
// Tailwind configs, the main stylesheets' tokens, and the icon tags of index.html.
/** @param {DataStore} store @param {Project} project @param {[string, string][]} read @param {string[]} gaps */
async function readLocal(store, project, read, gaps) {
  const base = runnerOf(store);
  // Only called when the project has a local folder.
  const root = /** @type {string} */ (project.localPath).replace(/\/+$/, '');
  const top = await listFolder(base, root).catch((/** @type {Error} */ err) => {
    gaps.push(`The local folder ${root} (${err.message})`);
    return null;
  });
  if (!top) return;
  /** @type {{ name: string, dir?: boolean }[]} */
  const topEntries = top.entries ?? [];
  const topDirs = new Set(topEntries.filter((e) => e.dir).map((e) => e.name));
  const dirs = ASSET_DIRS.filter((d) => topDirs.has(d.split('/')[0])).slice(0, MAX_FOLDERS);
  const listings = await Promise.allSettled(dirs.map((d) => listFolder(base, `${root}/${d}`)));
  /** @type {string[]} */
  const files = topEntries.filter((e) => !e.dir).map((e) => e.name);
  listings.forEach((r, i) => {
    if (r.status === 'fulfilled') for (const e of r.value.entries ?? []) if (!e.dir) files.push(`${dirs[i]}/${e.name}`);
  });
  /** @param {string} path */
  const fileName = (path) => path.split('/').pop() ?? path;

  const images = files.filter((f) => IMAGE_FILE.test(f) && (BRAND_NAME.test(fileName(f)) || /(^|\/)(brand|branding|icons|logos?)\//i.test(f)));
  read.push(['Image files in the local folder', images.slice(0, 60).map((f) => `${root}/${f}`).join('\n') || '(none named like a logo or icon)']);

  const styles = files.filter((f) => STYLE_FILE.test(f) && !/\.min\./.test(f))
    .sort((a, b) => Number(STYLE_RANK.test(fileName(b))) - Number(STYLE_RANK.test(fileName(a))))
    .slice(0, MAX_STYLES);
  /** @type {[string, (text: string) => string][]} */
  const wanted = [
    ...files.filter((f) => MANIFEST.test(fileName(f))).slice(0, 2).map((f) => /** @type {[string, (text: string) => string]} */ ([f, manifestSummary])),
    ...files.filter((f) => THEME_FILE.test(fileName(f))).slice(0, 3).map((f) => /** @type {[string, (text: string) => string]} */ ([f, (t) => clipWords(t, 600)])),
    ...styles.map((f) => /** @type {[string, (text: string) => string]} */ ([f, styleLines])),
    ...files.filter((f) => /^((public|src|app|static)\/)?index\.html?$/i.test(f)).slice(0, 2).map((f) => /** @type {[string, (text: string) => string]} */ ([f, headTags])),
  ];
  const texts = await Promise.allSettled(wanted.map(([f]) => readFile(base, `${root}/${f}`)));
  texts.forEach((r, i) => {
    const [path, pick] = wanted[i];
    if (r.status === 'rejected' || typeof r.value.text !== 'string') {
      gaps.push(`${path} in the local folder (${r.status === 'rejected' ? r.reason.message : 'too large or not text'})`);
      return;
    }
    const text = pick(r.value.text).trim();
    if (text) read.push([`Local ${root}/${path}`, text]);
  });
}

// Reads the local folder and the website's head tags. One failing source never stops the other; it is listed in gaps.
/** @param {DataStore} store @param {Project} project */
export async function readBrandSources(store, project) {
  /** @type {[string, string][]} */
  const read = [];
  /** @type {string[]} */
  const gaps = [];
  if (!project.localPath) gaps.push('No local folder is set');
  if (!project.website) gaps.push('No website is set');
  const local = project.localPath ? readLocal(store, project, read, gaps).catch((err) => gaps.push(`The local folder (${err.message})`)) : null;
  const site = project.website
    ? readBrandTags(project.website).then(
        (lines) => read.push([`Head tags of ${project.website}`, lines.join('\n') || '(none found)']),
        (err) => gaps.push(`The website ${project.website} (${err.message})`))
    : null;
  await Promise.allSettled([local, site]);
  return { read, gaps };
}

/** @param {Project} project @param {{ read: [string, string][], gaps: string[] }} sources @param {ProjectBrand} current */
function brandInput(project, { read, gaps }, current) {
  return [
    `# ${project.name}`,
    project.website ? `Website: ${project.website}` : '',
    project.localPath ? `Local folder: ${project.localPath}` : '',
    ...read.map(([title, text]) => `<source name="${title}">\n${text}\n</source>`),
    `Sources that could not be read:\n${gaps.length ? gaps.map((g) => `- ${g}`).join('\n') : '(none)'}`,
    hasBrand(current) ? `<current-brand>\n${JSON.stringify({ ...current, updated: undefined, usageId: undefined })}\n</current-brand>` : '',
  ].filter(Boolean).join('\n\n');
}

// Reads the sources, asks the model once, and adds what it found to the project's brand. Returns the saved brand
// and how many items were added. onStep(text) tells the caller what is being done.
/** @param {DataStore} store @param {Project} project @param {{ onStep?: (text: string) => void }} [options] */
export async function findBrand(store, project, { onStep = () => {} } = {}) {
  if (!hasBrandSources(project)) throw new Error('Add a local folder or a website to the project first.');
  onStep('Reading the folder and the website…');
  const sources = await readBrandSources(store, project);
  if (!sources.read.length) throw new Error(`None of the sources could be read: ${sources.gaps.join('; ')}.`);
  onStep('Picking the brand…');
  const usageId = uid();
  const reply = await ask(store, 'task-summary', [
    { role: 'system', content: systemPrompt(store, 'project-brand', { project: project.name, website: project.website ?? '' }) },
    { role: 'user', content: brandInput(project, sources, brandOf(project)) },
  ], { usageId, projectId: project.id });
  const found = parseJson(reply);
  if (!found || typeof found !== 'object' || Array.isArray(found)) throw new Error('The model did not return the brand as a JSON object.');
  let added = 0;
  let saved = brandOf(project);
  store.update('projects', (d) => {
    const p = d.projects.find((x) => x.id === project.id);
    if (!p) return;
    const current = brandOf(p);
    const next = mergeBrand(current, found);
    added = BRAND_LISTS.reduce((n, k) => n + next[k].length - current[k].length, 0) + (next.notes !== current.notes ? 1 : 0);
    saved = { ...next, updated: now(), usageId };
    p.brand = saved;
  });
  return { brand: saved, added };
}
