// What a Dev session may read besides its tasks, for tools/board.js: the other sessions on its tasks, its tasks'
// project (profile, repos, folder, links) and brand, and its tasks' images, which it may also add to. Scoped like
// tools/worker/tasks.js: by the terminal's token, to the session's own tasks and their projects. Nothing else.
/** @import { DataStore, Project, Task, TaskImage } from '../../types/data' */
/** @import { NodeStore, RequestBody } from '../../types/runner' */
import { randomBytes } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { scopeFromToken, reachOf, projectOfFolder, expand } from './tasks.js';
import { runnerOf } from '../../js/dev-core.js';
import { profileOf } from '../../js/profile.js';
import { brandOf, isUrl } from '../../js/brand.js';
import { imageExt } from '../../js/images.js';
/** @typedef {import('./tasks.js').SessionScope} SessionScope */

// An image a session adds: one of the types claude reads, at most this large, and at most this many on a task.
export const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
export const TASK_IMAGES_MAX = 30;

/** @param {string} message @param {number} status */
const fail = (message, status = 400) => Object.assign(new Error(message), { status });

/** @param {DataStore} store @param {SessionScope} scope @param {string} id */
function reachedTask(store, scope, id) {
  const items = store.get('todos').items;
  const task = items.find((t) => t.id === id);
  if (!task || !reachOf(items, scope).all.has(id)) throw fail(`Task ${id} is not one of this session's tasks.`, 403);
  return task;
}

// --- Other sessions on the same tasks ---

/** @typedef {{ session: string, n: number, tasks: string[], cwd: string, worktree: string, dir: string, branch: string, commit: string, changes: number | null, claude: boolean, state: string, started: number }} Peer */

// The other open terminals started for one of the session's tasks (or `taskId` alone, when given), asked of the
// command runner, which knows where each works.
/** @param {DataStore} store @param {SessionScope} scope @param {string} token @param {string} [taskId] */
export async function sessionPeers(store, scope, token, taskId = '') {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  if (taskId) reachedTask(store, scope, taskId);
  const tasks = taskId ? [taskId] : [...reach.all];
  const base = runnerOf(store).replace(/\/+$/, '');
  /** @type {Response} */
  let res;
  try {
    res = await fetch(`${base}/scope/peers`, { method: 'POST', headers: { origin: 'http://localhost', 'content-type': 'application/json' }, body: JSON.stringify({ token, tasks }) });
  } catch {
    throw fail(`The command runner at ${base} is not answering.`, 503);
  }
  if (res.status === 404) throw fail('This terminal is not open on the board any more.', 401);
  if (!res.ok) throw fail(`The command runner answered ${res.status}: ${await res.text()}`, 502);
  const answer = /** @type {{ peers?: Peer[] }} */ (await res.json());
  const title = (/** @type {string} */ id) => items.find((t) => t.id === id)?.text ?? '';
  const peers = (answer.peers ?? []).map((p) => ({ ...p, tasks: p.tasks.map((id) => ({ id, text: title(id) })) }));
  return { session: scope.session, roots: [...reach.roots], peers };
}

// --- The project ---

// The projects of the session's tasks, or, with no task, the one whose folder holds `cwd`.
/** @param {DataStore} store @param {SessionScope} scope @param {string} cwd @returns {Project[]} */
export function projectsOf(store, scope, cwd) {
  const items = store.get('todos').items;
  const reach = reachOf(items, scope);
  const ids = new Set([...reach.roots].map((id) => items.find((t) => t.id === id)?.projectId).filter((id) => typeof id === 'string' && id));
  if (!ids.size) {
    const id = projectOfFolder(store, cwd);
    if (id) ids.add(id);
  }
  const projects = store.get('projects').projects;
  return [...ids].map((id) => projects.find((p) => p.id === id)).filter((p) => !!p);
}

// The one project a command reads: `pick` (an id or a name) among the session's projects, else its only one.
/** @param {DataStore} store @param {SessionScope} scope @param {RequestBody} body */
function projectFor(store, scope, body) {
  const all = projectsOf(store, scope, String(body.cwd ?? ''));
  const pick = String(body.project ?? '').trim().toLowerCase();
  if (pick) {
    const found = all.find((p) => p.id.toLowerCase() === pick || p.name.toLowerCase() === pick);
    if (!found) throw fail(`Project ${body.project} is not one of this session's tasks' projects.`, 403);
    return found;
  }
  if (!all.length) throw fail('This session\'s task has no project, and its folder is no project\'s.', 404);
  if (all.length > 1) throw fail(`This session's tasks are in ${all.length} projects (${all.map((p) => `${p.id} ${p.name}`).join(', ')}): name one with --project.`);
  return all[0];
}

/** @param {DataStore} store @param {SessionScope} scope @param {RequestBody} body */
export function projectInfo(store, scope, body) {
  const project = projectFor(store, scope, body);
  const { projects, categories } = store.get('projects');
  const profile = profileOf(project);
  const labels = (project.labels ?? (project.categoryId ? [project.categoryId] : [])).map((id) => categories.find((c) => c.id === id)?.name).filter(Boolean);
  const repos = project.github?.repos ?? [];
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    website: project.website,
    folder: project.localPath ?? '',
    labels,
    parent: project.parentId ? projects.find((p) => p.id === project.parentId)?.name ?? '' : '',
    subprojects: projects.filter((p) => p.parentId === project.id).map((p) => p.name),
    github: { org: project.github?.org ?? '', repos: repos.map((r) => ({ repo: r, url: `https://github.com/${r}` })) },
    npm: project.npm ?? { org: '', packages: [] },
    links: [project.website, ...profile.sources, ...brandOf(project).links.map((l) => l.value).filter(isUrl)].filter((v, i, all) => v && all.indexOf(v) === i),
    profile: { text: profile.text, sources: profile.sources, updated: profile.updated, edited: profile.edited },
  };
}

// --- The brand ---

// A label as part of a custom property's name.
/** @param {string} text */
const slug = (text) => text.toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-') || 'item';

// A brand item's value, with a path in the project's folder made absolute so a reader finds the file.
/** @param {Project} project @param {string} value */
const fileOf = (project, value) => (!value || isUrl(value) || value.startsWith('data:') || !project.localPath ? '' : isAbsolute(expand(value)) ? expand(value) : join(expand(project.localPath), value.replace(/^\.?\/+/, '')));

/** @param {DataStore} store @param {SessionScope} scope @param {RequestBody} body */
export function projectBrand(store, scope, body) {
  const project = projectFor(store, scope, body);
  const brand = brandOf(project);
  /** @param {import('../../types/data').BrandItem[]} items @returns {{ label: string, value: string, file?: string }[]} */
  const withFiles = (items) => items.map((item) => {
    const file = fileOf(project, item.value);
    return { label: item.label, value: item.value, ...(file ? { file } : {}) };
  });
  const lists = { colors: brand.colors, fonts: brand.fonts, images: withFiles(brand.images), links: withFiles(brand.links) };
  return { project: { id: project.id, name: project.name }, ...lists, notes: brand.notes, updated: brand.updated, css: brandCss(project.name, lists, brand.notes) };
}

// The brand as CSS custom properties: --brand-color-*, --brand-font-*, --brand-image-*; links and notes as comments.
/** @param {string} name @param {Record<string, { label: string, value: string, file?: string }[]>} lists @param {string} notes */
export function brandCss(name, lists, notes) {
  /** @param {string} prefix @param {{ label: string, value: string }[]} items @param {(value: string) => string} format */
  const props = (prefix, items, format) => {
    /** @type {Set<string>} */
    const seen = new Set();
    return items.map((item) => {
      let key = `--brand-${prefix}-${slug(item.label || item.value)}`;
      for (let n = 2; seen.has(key); n++) key = `--brand-${prefix}-${slug(item.label || item.value)}-${n}`;
      seen.add(key);
      return `  ${key}: ${format(item.value)};`;
    });
  };
  const comment = (/** @type {string} */ text) => text.replace(/\*\//g, '* /');
  const font = (/** @type {string} */ v) => (/[,"']/.test(v) ? v : `"${v}"`);
  const lines = [
    `/* ${comment(name)}'s brand, from the board. */`,
    ':root {',
    ...props('color', lists.colors, (v) => v),
    ...props('font', lists.fonts, font),
    ...props('image', lists.images, (v) => `url("${v.replace(/["\\]/g, '\\$&')}")`),
    '}',
  ];
  if (lists.links.length) lines.push('', '/* Links:', ...lists.links.map((l) => ` * ${comment(l.label)}: ${comment(l.value)}`), ' */');
  if (notes.trim()) lines.push('', `/* Notes:\n${comment(notes.trim())}\n */`);
  return `${lines.join('\n')}\n`;
}

// --- A task's images ---

/** @param {DataStore} store @param {Task} task */
const imagesOf = (store, task) => (task.images ?? []).map((img, i) => ({ n: i + 1, name: img.name, type: img.type, path: img.path, file: join(/** @type {NodeStore} */ (store).dir, img.path) }));

/** @param {DataStore} store @param {SessionScope} scope @param {string} id */
export function listImages(store, scope, id) {
  const task = reachedTask(store, scope, id);
  return { task: { id: task.id, text: task.text }, images: imagesOf(store, task) };
}

// The image's type from its first bytes, so a file named .png that is not one is refused.
/** @param {Buffer} head */
export function sniffImage(head) {
  if (head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(head.subarray(0, 6).toString('latin1'))) return 'image/gif';
  if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return '';
}

// Copies a file on this machine into the data folder as one of the task's images, as the board does with an
// image pasted on the task (js/task-images.js). The root task takes images too: adding one moves nothing.
/** @param {DataStore} store @param {SessionScope} scope @param {string} id @param {RequestBody} body */
export function addImage(store, scope, id, body) {
  const task = reachedTask(store, scope, id);
  if ((task.images ?? []).length >= TASK_IMAGES_MAX) throw fail(`Task ${id} already has ${TASK_IMAGES_MAX} images, the limit.`, 429);
  const source = resolve(String(body.cwd ?? '/'), expand(String(body.file ?? '')));
  if (!body.file) throw fail('Name the image file.');
  let size = 0;
  try {
    const info = statSync(source);
    if (!info.isFile()) throw fail(`${source} is not a file.`);
    size = info.size;
  } catch (err) {
    if (/** @type {{ status?: number }} */ (err).status) throw err;
    throw fail(`Cannot read ${source}.`, 404);
  }
  if (size > IMAGE_MAX_BYTES) throw fail(`${basename(source)} is ${(size / 1048576).toFixed(1)} MB; an image is at most ${IMAGE_MAX_BYTES / 1048576} MB.`, 413);
  const bytes = Buffer.alloc(size);
  const fd = openSync(source, 'r');
  try {
    readSync(fd, bytes, 0, size, 0);
  } finally {
    closeSync(fd);
  }
  const type = sniffImage(bytes);
  if (!type) throw fail('Only PNG, JPEG, GIF and WebP images can be added.', 415);
  const path = `tasks/${id}-${randomBytes(6).toString('hex')}.${imageExt(type)}`;
  const dir = /** @type {NodeStore} */ (store).dir;
  mkdirSync(join(dir, 'tasks'), { recursive: true });
  writeFileSync(join(dir, path), bytes);
  /** @type {TaskImage} */
  const image = { path, name: String(body.name ?? '').trim().slice(0, 200) || basename(source), type };
  store.update('todos', (d) => {
    const item = d.items.find((t) => t.id === id);
    if (item) item.images = [...(item.images ?? []), image];
  });
  return listImages(store, scope, id);
}

// The runners' routes, as tools/worker/tasks.js taskRoutes().
/** @param {() => NodeStore | null} storeOf @returns {Record<string, (body: RequestBody, rest: string) => Promise<unknown>>} */
export function contextRoutes(storeOf) {
  /** @param {(store: DataStore, scope: SessionScope, body: RequestBody) => unknown} fn */
  const route = (fn) => async (/** @type {RequestBody} */ body) => {
    const store = storeOf();
    if (!store) throw fail('The runners have no data folder. Set it in Settings → Runners.', 503);
    const scope = await scopeFromToken(store, body);
    const answer = await fn(store, scope, body);
    store.flush();
    return answer;
  };
  return {
    'POST /sessions/peers': route((store, scope, body) => sessionPeers(store, scope, String(body.token ?? ''), String(body.task ?? ''))),
    'POST /project': route((store, scope, body) => projectInfo(store, scope, body)),
    'POST /project/brand': route((store, scope, body) => projectBrand(store, scope, body)),
    'POST /images/list': route((store, scope, body) => listImages(store, scope, String(body.id ?? ''))),
    'POST /images/add': route((store, scope, body) => addImage(store, scope, String(body.id ?? ''), body)),
  };
}
