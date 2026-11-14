// A project's pill in Tasks' header, made like a task's work pill (js/task-work.js) and opening the same popover:
// an overview of its tasks first (hovering it shows a summary), then its website, its GitHub repos, its local folder
// and the Dev sessions of its tasks. The website shows in a frame with its device sizes and console; the repos and the
// folder are browsed in place, a file opening with Dev's syntax colours; a session's terminal takes keys as in Dev.
/** @import { Store, Task, Project, IconName } from '../types/data' */
/** @import { WorkOptions, WorkParts, WorkSession, WorkTabSpec } from './task-work.js' */
/** @import { Child } from '../types/ui' */
import { h, icon, patch, statusOf } from './ui.js';
import { toast } from './toast.js';
import { toggleWork, closeWork, workTabOf, workHead, showSite, clearSlot, showInSlot, dropTerm, showTerm, sessionList, workSession, pickWorkTab } from './task-work.js';
import { repoStats, repoContents } from './github.js';
import { listFolder, readFile } from './terminal.js';
import { runnerOf } from './modules/dev.js';
import { joinPath, baseName } from './modules/dev-files.js';
import { highlight, languageOf, languageLabel } from './highlight.js';
import { taskStatuses, statusLook } from './task-labels.js';
import { claudeState } from './dev-core.js';

/**
 * What Tasks gives the pill: what each Dev session is doing, and how to show only the tasks of one status.
 * @typedef {{ status: WorkOptions['status'], onFilter: (status: string) => void }} ProjectWorkOptions
 * @typedef {{ issues: number, prs: number, items?: { number: number, title: string, pr: boolean }[] }} RepoCounts
 */

const TIP_DELAY = 250;
// The sessions the Dev tab lists, newest first.
const SESSIONS_MAX = 12;
// A look's urgency, for the dot of the Dev part: what waits on the user first.
const LOOK_ORDER = ['asks', 'waiting', 'failed', 'stalled', 'working', 'done', 'idle'];

const workId = (/** @type {Project} */ p) => `project:${p.id}`;
const reposOf = (/** @type {Project} */ p) => p.github.repos;

// The project's open tasks by status, in Settings → Labels' order, with the status's colour.
/** @param {Store} store @param {Project} p */
function tasksOf(store, p) {
  const items = store.get('todos').items.filter((t) => t.projectId === p.id);
  const open = items.filter((t) => statusOf(t) !== 'done');
  const byStatus = taskStatuses(store).filter((s) => s.key !== 'done').map((s) => ({ ...s, look: statusLook(s), n: open.filter((t) => statusOf(t) === s.key).length })).filter((s) => s.n);
  return { open: open.length, done: items.length - open.length, byStatus };
}

// The Dev sessions of the project's tasks: open tasks first, the newest first.
/** @param {Store} store @param {Project} p @returns {{ sessions: WorkSession[], tasks: Map<string, Task> }} */
function sessionsOf(store, p) {
  const items = [...store.get('todos').items].reverse().filter((t) => t.projectId === p.id && t.devSession);
  const ordered = [...items.filter((t) => statusOf(t) !== 'done'), ...items.filter((t) => statusOf(t) === 'done')].slice(0, SESSIONS_MAX);
  /** @type {Map<string, Task>} */
  const tasks = new Map();
  for (const t of ordered) if (!tasks.has(/** @type {string} */ (t.devSession))) tasks.set(/** @type {string} */ (t.devSession), t);
  const sessions = [...tasks].map(([id, t]) => ({ id, cwd: t.worktrees?.find((w) => w.session === id)?.cwd ?? '', name: t.text }));
  return { sessions, tasks };
}

// The repos' counts read so far; a repo not read yet is asked of the runners and the page draws again once read.
/** @param {Store} store @param {Project} p */
function repoCounts(store, p) {
  return reposOf(p).map((repo) => {
    const s = /** @type {{ status: string } & Partial<RepoCounts>} */ (repoStats(repo, () => store.refresh()));
    return { repo, ok: s.status === 'ok', issues: s.issues ?? 0, prs: s.prs ?? 0, items: s.items ?? [] };
  });
}

/** @param {{ color?: string, tone?: string }} look */
const toneAttrs = (look) => (look.color ? { class: 'tone-c', style: { '--c': look.color } } : { class: `tone-c tone-${look.tone}` });

// ---------- The pill ----------

/** @param {Store} store @param {Project} p @param {ProjectWorkOptions} options */
export function projectPill(store, p, options) {
  const id = workId(p);
  const open = workTabOf(id);
  const t = tasksOf(store, p);
  const { sessions } = sessionsOf(store, p);
  const counts = repoCounts(store, p);
  /** @type {WorkOptions} */
  const work = { status: options.status, kind: { paint: (parts) => paintProject(parts, p, options) } };
  /** @param {string} tab @param {string} cls @param {string} label @param {...(Node | string | null)} body */
  const seg = (tab, cls, label, ...body) => h('button', {
    type: 'button',
    class: `work-seg ${cls}${open === tab ? ' on' : ''}`,
    title: tab === 'overview' ? undefined : label,
    'aria-label': label,
    'aria-expanded': String(open === tab),
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      hideTip();
      // Each opening reads the folders and files again.
      if (!open) {
        browse.folders.clear();
        browse.files.clear();
      }
      toggleWork(store, id, tab, work);
    },
  }, ...body);

  const overview = seg('overview', 'proj-overview', `Overview: ${t.open} open, ${t.done} done`,
    h('span', { class: 'work-bar proj-bar', 'aria-hidden': 'true' }, t.byStatus.map((s) => h('i', { ...toneAttrs(s.look), style: { ...toneAttrs(s.look).style, flexGrow: String(s.n) } }))),
    String(t.open));
  overview.addEventListener('mouseenter', () => scheduleTip(store, p, overview, options));
  overview.addEventListener('mouseleave', hideTip);

  const prs = counts.reduce((n, c) => n + c.prs, 0);
  const looks = sessions.map((s) => claudeState(options.status(s.id) ?? /** @type {any} any: a session the runner has not answered for looks idle */ ({ state: 'idle' })));
  const worst = LOOK_ORDER.find((k) => looks.some((l) => l.key === k)) ?? 'idle';
  const waiting = looks.filter((l) => l.key === 'asks' || l.key === 'waiting').length;
  const parts = [
    overview,
    p.website ? seg('site', '', `Website: ${p.website}`, icon('globe')) : null,
    counts.length ? seg('repo', prs ? 'gh-open' : '', `${counts.length > 1 ? `${counts.length} repos` : counts[0].repo}${counts.some((c) => c.ok) ? `: ${prs} open PR${prs === 1 ? '' : 's'}` : ''}`, icon('github'), prs ? String(prs) : null) : null,
    p.localPath ? seg('files', '', `Files in ${p.localPath}`, icon('folder')) : null,
    sessions.length ? seg('dev', `work-dev is-${worst}`, `${sessions.length} Dev session${sessions.length > 1 ? 's' : ''}${waiting ? `, ${waiting} waiting on you` : ''}`,
      icon('terminal'), h('span', { class: `work-dot is-${worst}`, 'aria-hidden': 'true' }), sessions.length > 1 ? String(sessions.length) : null) : null,
  ];
  return h('span', { class: `work-pill project-pill${open ? ' open' : ''}`, 'data-work': id, role: 'group', 'aria-label': `${p.name}: overview and links` }, parts);
}

// ---------- The hover summary ----------

/** @type {{ timer: number, el: HTMLElement | null }} */
const tip = { timer: 0, el: null };

/** @param {Store} store @param {Project} p @param {HTMLElement} anchor @param {ProjectWorkOptions} options */
function scheduleTip(store, p, anchor, options) {
  hideTip();
  if (workTabOf(workId(p)) === 'overview') return;
  tip.timer = window.setTimeout(() => {
    if (!anchor.isConnected) return;
    const t = tasksOf(store, p);
    const repos = repoCounts(store, p).filter((c) => c.ok);
    const { sessions } = sessionsOf(store, p);
    const waiting = sessions.filter((s) => ['asks', 'waiting'].includes(claudeState(options.status(s.id) ?? /** @type {any} any: unanswered */ ({ state: 'idle' })).key)).length;
    tip.el = h('div', { class: 'proj-tip', role: 'tooltip' },
      h('strong', null, `${t.open} open · ${t.done} done`),
      t.byStatus.length ? h('div', { class: 'proj-tip-st' }, t.byStatus.map((s) => h('span', null, h('i', toneAttrs(s.look)), `${s.n} ${s.name.toLowerCase()}`))) : null,
      repos.map((c) => h('div', null, icon('github'), `${c.repo.split('/').pop()}: ${c.prs} open PR${c.prs === 1 ? '' : 's'}, ${c.issues} issue${c.issues === 1 ? '' : 's'}`)),
      sessions.length ? h('div', null, icon('terminal'), `${sessions.length} Dev session${sessions.length > 1 ? 's' : ''}${waiting ? `, ${waiting} waiting on you` : ''}`) : null,
      h('div', { class: 'muted' }, 'Click for the overview'));
    document.body.append(tip.el);
    const r = anchor.getBoundingClientRect();
    tip.el.style.left = `${Math.max(8, Math.min(r.left, document.documentElement.clientWidth - tip.el.offsetWidth - 8)) + scrollX}px`;
    tip.el.style.top = `${r.bottom + scrollY + 6}px`;
  }, TIP_DELAY);
}

function hideTip() {
  clearTimeout(tip.timer);
  tip.timer = 0;
  tip.el?.remove();
  tip.el = null;
}
window.addEventListener('hashchange', hideTip);

// ---------- The popover ----------

/** @param {WorkParts} parts @param {Project} p @param {ProjectWorkOptions} options */
function paintProject(parts, p, options) {
  const { store } = parts;
  const project = store.get('projects').projects.find((x) => x.id === p.id);
  if (!project) return closeWork();
  p = project;
  if (browse.project !== p.id) Object.assign(browse, { project: p.id, local: { path: '', file: '' }, repo: { name: reposOf(p)[0] ?? '', path: '', file: '' } });
  browse.repaint = parts.repaint;
  const { sessions, tasks } = sessionsOf(store, p);
  /** @type {WorkTabSpec[]} */
  const tabs = [
    { key: 'overview', icon: 'list', label: 'Overview' },
    ...(p.website ? [{ key: 'site', icon: /** @type {IconName} */ ('globe'), label: 'Site' }] : []),
    ...(reposOf(p).length ? [{ key: 'repo', icon: /** @type {IconName} */ ('github'), label: reposOf(p).length > 1 ? 'Repos' : 'Repo' }] : []),
    ...(p.localPath ? [{ key: 'files', icon: /** @type {IconName} */ ('folder'), label: 'Files' }] : []),
    ...(sessions.length ? [{ key: 'dev', icon: /** @type {IconName} */ ('terminal'), label: 'Dev', count: sessions.length }] : []),
  ];
  const tab = tabs.some((t) => t.key === parts.tab) ? parts.tab : 'overview';
  if (tab !== parts.tab) pickWorkTab(tab, '', false);
  workHead(tabs);

  /** @type {(Node | null)[]} */
  let body = [];
  if (tab === 'overview') {
    dropTerm();
    clearSlot();
    body = [overview(store, p, options, sessions, tasks)];
  } else if (tab === 'site') {
    dropTerm();
    showSite(p.website, [icon('globe')]);
  } else if (tab === 'repo') {
    body = [repoHead(store, p), ...explorer(store, p, 'repo')];
  } else if (tab === 'files') {
    body = explorer(store, p, 'local');
  } else {
    const list = sessionList(sessions, { status: options.status });
    const task = tasks.get(workSession());
    // With one session the list is left out, so its task is named instead.
    body = [list ?? (task ? h('div', { class: 'work-lines' }, h('div', { class: 'work-line' }, icon('terminal'), h('span', { class: 'work-title', title: task.text }, task.text))) : null)];
    if (task) showTerm(store, task, sessions, { status: options.status });
  }
  patch(parts.body, h('div', null, body));

  const urls = [p.website, ...reposOf(p).map((r) => `https://github.com/${r}`)].filter(Boolean);
  patch(parts.foot, h('div', null,
    h('span', { class: 'muted small grow' }, [p.website ? '1 site' : '', reposOf(p).length ? `${reposOf(p).length} repo${reposOf(p).length > 1 ? 's' : ''}` : '', sessions.length ? `${sessions.length} Dev session${sessions.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(' · ') || p.name),
    urls.length ? h('button', { type: 'button', class: 'btn-small', onclick: () => navigator.clipboard.writeText(urls.join('\n')).then(() => toast(`${urls.length} link${urls.length > 1 ? 's' : ''} copied`), () => toast('Could not copy')) }, icon('copy'), 'Copy links') : null,
    h('a', { class: 'btn-small', href: `#/projects?project=${p.id}` }, icon('pencil'), 'Edit project')));
}

// The overview: tasks by status (a click shows only those), the repos' open PRs and issues, the Dev sessions and the
// website.
/** @param {Store} store @param {Project} p @param {ProjectWorkOptions} options @param {WorkSession[]} sessions @param {Map<string, Task>} tasks */
function overview(store, p, options, sessions, tasks) {
  const t = tasksOf(store, p);
  const repos = repoCounts(store, p);
  const card = (/** @type {string} */ title, /** @type {Node | null} */ action, /** @type {Child[]} */ ...rest) => h('section', { class: 'proj-card' }, h('h4', null, title, action), ...rest);
  return h('div', { class: 'proj-overview-body' },
    p.description ? h('p', { class: 'proj-desc muted small' }, p.description) : null,
    h('div', { class: 'proj-cards' },
      card('Tasks', null,
        h('div', { class: 'proj-big' }, h('strong', null, String(t.open)), h('span', { class: 'muted small' }, `open · ${t.done} done`)),
        t.byStatus.length ? h('div', { class: 'work-bar proj-bar wide', 'aria-hidden': 'true' }, t.byStatus.map((s) => h('i', { ...toneAttrs(s.look), style: { ...toneAttrs(s.look).style, flexGrow: String(s.n) } }))) : null,
        h('div', { class: 'proj-legend' }, t.byStatus.map((s) => h('button', {
          type: 'button',
          title: `Show only the tasks ${s.name.toLowerCase()}`,
          onclick: () => {
            closeWork();
            options.onFilter(s.key);
          },
        }, h('i', toneAttrs(s.look)), `${s.name} ${s.n}`)))),
      repos.length ? card(repos.length > 1 ? 'Repos' : 'Repo', h('button', { type: 'button', class: 'linkish', onclick: () => pickWorkTab('repo') }, 'Browse'),
        repos.map((c) => h('div', { class: 'proj-lines' },
          h('a', { class: 'work-title', href: `https://github.com/${c.repo}`, target: '_blank', rel: 'noopener' }, c.repo),
          h('span', { class: 'muted small' }, c.ok ? `${c.prs} open PR${c.prs === 1 ? '' : 's'} · ${c.issues} issue${c.issues === 1 ? '' : 's'}` : 'Reading…'),
          c.items.slice(0, 3).map((i) => h('a', { class: 'proj-item', href: `https://github.com/${c.repo}/${i.pr ? 'pull' : 'issues'}/${i.number}`, target: '_blank', rel: 'noopener', title: i.title },
            h('span', { class: 'gh-open' }, icon(i.pr ? 'pull-request' : 'repo')), h('span', { class: 'work-num' }, `#${i.number}`), h('span', { class: 'work-title' }, i.title)))))) : null,
      sessions.length ? card('Dev', h('button', { type: 'button', class: 'linkish', onclick: () => pickWorkTab('dev') }, 'Terminals'),
        h('div', { class: 'proj-lines' }, sessions.slice(0, 5).map((s) => {
          const look = claudeState(options.status(s.id) ?? /** @type {any} any: unanswered */ ({ state: 'idle' }));
          return h('button', { type: 'button', class: 'proj-item', title: `${tasks.get(s.id)?.text ?? s.name}\n${look.label}`, onclick: () => pickWorkTab('dev', s.id) },
            h('span', { class: `work-dot is-${look.key}`, 'aria-hidden': 'true' }), h('span', { class: 'work-title' }, tasks.get(s.id)?.text ?? s.name));
        }))) : null,
      p.website || p.localPath ? card('Links', null,
        h('div', { class: 'proj-lines' },
          p.website ? h('button', { type: 'button', class: 'proj-item', title: `Show ${p.website} here`, onclick: () => pickWorkTab('site') }, icon('globe'), h('span', { class: 'work-title' }, p.website)) : null,
          p.localPath ? h('button', { type: 'button', class: 'proj-item', title: `Browse ${p.localPath}`, onclick: () => pickWorkTab('files') }, icon('folder'), h('span', { class: 'work-title' }, p.localPath)) : null)) : null));
}

// The repo tab's head: which repo (when there are several), its counts and a link to GitHub.
/** @param {Store} store @param {Project} p */
function repoHead(store, p) {
  const repos = reposOf(p);
  if (!repos.includes(browse.repo.name)) Object.assign(browse.repo, { name: repos[0] ?? '', path: '', file: '' });
  const c = repoCounts(store, p).find((x) => x.repo === browse.repo.name);
  return h('div', { class: 'work-filters proj-repo-head' },
    repos.length > 1 ? repos.map((r) => h('button', {
      type: 'button',
      class: `work-filter${r === browse.repo.name ? ' on' : ''}`,
      'aria-pressed': String(r === browse.repo.name),
      onclick: () => {
        Object.assign(browse.repo, { name: r, path: '', file: '' });
        browse.repaint();
      },
    }, icon('github'), r.split('/').pop())) : h('span', { class: 'proj-repo-name' }, icon('github'), browse.repo.name),
    h('span', { class: 'muted small grow' }, c?.ok ? `${c.prs} open PR${c.prs === 1 ? '' : 's'} · ${c.issues} issue${c.issues === 1 ? '' : 's'}` : ''),
    h('a', { class: 'btn-small', href: `https://github.com/${browse.repo.name}`, target: '_blank', rel: 'noopener' }, icon('github'), 'GitHub'));
}

// ---------- Browsing files ----------

/**
 * Where each source is: a folder, and the file open in it ('' for none). Folders and files read are kept by source
 * and path while the popover shows the same project.
 * @typedef {{ path: string, file: string }} Place
 * @typedef {{ loading?: boolean, error?: string, entries?: { name: string, dir: boolean }[] }} FolderRead
 * @typedef {{ loading?: boolean, error?: string, text?: string, note?: string, el?: HTMLElement }} FileRead
 */
const browse = {
  project: '',
  local: /** @type {Place} */ ({ path: '', file: '' }),
  repo: /** @type {Place & { name: string }} */ ({ name: '', path: '', file: '' }),
  /** @type {Map<string, FolderRead>} */
  folders: new Map(),
  /** @type {Map<string, FileRead>} */
  files: new Map(),
  repaint: () => {},
};

/** @param {'local' | 'repo'} source */
const placeOf = (source) => (source === 'local' ? browse.local : browse.repo);
/** @param {'local' | 'repo'} source @param {string} path */
const keyOf = (source, path) => (source === 'local' ? `local:${browse.project}:${path}` : `gh:${browse.repo.name}:${path}`);
const relJoin = (/** @type {string} */ dir, /** @type {string} */ name) => (dir ? `${dir}/${name}` : name);

/** @param {Store} store @param {Project} p @param {'local' | 'repo'} source @param {string} path */
function readFolder(store, p, source, path) {
  const key = keyOf(source, path);
  const had = browse.folders.get(key);
  if (had) return had;
  /** @type {FolderRead} */
  const entry = { loading: true };
  browse.folders.set(key, entry);
  const read = source === 'local'
    ? listFolder(runnerOf(store), path ? joinPath(/** @type {string} */ (p.localPath), path) : /** @type {string} */ (p.localPath)).then((f) => ({ entries: [...f.entries].sort((a, b) => Number(b.dir) - Number(a.dir) || a.name.localeCompare(b.name)) }))
    : repoContents(browse.repo.name, path).then((r) => {
      if (!('entries' in r)) throw new Error('Not a folder');
      return r;
    });
  read.then((r) => Object.assign(entry, { loading: false, entries: r.entries }), (err) => Object.assign(entry, { loading: false, error: readError(source, err) }))
    .then(() => browse.repaint());
  return entry;
}

/** @param {Store} store @param {Project} p @param {'local' | 'repo'} source @param {string} path */
function readOne(store, p, source, path) {
  const key = keyOf(source, path);
  const had = browse.files.get(key);
  if (had) return had;
  /** @type {FileRead} */
  const entry = { loading: true };
  browse.files.set(key, entry);
  /** @type {Promise<{ text?: string, binary?: boolean, tooLarge?: boolean }>} */
  const read = source === 'local' ? readFile(runnerOf(store), joinPath(/** @type {string} */ (p.localPath), path)) : repoContents(browse.repo.name, path).then((r) => ('entries' in r ? { binary: true } : r));
  read.then((f) => Object.assign(entry, { loading: false, text: f.text, note: typeof f.text === 'string' ? '' : f.tooLarge ? 'This file is too large to show here.' : 'This file is not text.' }),
    (err) => Object.assign(entry, { loading: false, error: readError(source, err) }))
    .then(() => browse.repaint());
  return entry;
}

/** @param {'local' | 'repo'} source @param {unknown} err */
const readError = (source, err) => (source === 'local'
  ? `Could not read the folder: ${/** @type {Error} */ (err).message}. The runners read it: start them with bun start.`
  : `Could not read the repo: ${/** @type {Error} */ (err).message}.`);

// The path as links back up, then the folder's entries; with a file open, the path alone and the file below.
/** @param {Store} store @param {Project} p @param {'local' | 'repo'} source @returns {(Node | null)[]} */
function explorer(store, p, source) {
  const place = placeOf(source);
  const rootName = source === 'local' ? baseName(/** @type {string} */ (p.localPath)) : browse.repo.name.split('/').pop() ?? '';
  const go = (/** @type {string} */ path) => {
    Object.assign(place, { path, file: '' });
    browse.repaint();
  };
  const parts = (place.file || place.path).split('/').filter(Boolean);
  const crumbs = h('nav', { class: 'proj-crumbs', 'aria-label': 'Path' },
    h('button', { type: 'button', onclick: () => go('') }, icon(source === 'local' ? 'folder' : 'github'), rootName),
    parts.map((name, i) => [h('span', { class: 'muted' }, '/'), i === parts.length - 1 && place.file
      ? h('strong', null, name)
      : h('button', { type: 'button', onclick: () => go(parts.slice(0, i + 1).join('/')) }, name)]));

  if (place.file) {
    showInSlot(fileView(store, p, source, place.file));
    return [crumbs];
  }
  dropTerm();
  clearSlot();
  const folder = readFolder(store, p, source, place.path);
  const up = place.path ? place.path.split('/').slice(0, -1).join('/') : null;
  return [crumbs, h('div', { class: 'work-lines proj-files' },
    up === null ? null : h('button', { type: 'button', class: 'work-line proj-entry', onclick: () => go(up) }, icon('arrow-up'), h('span', { class: 'work-title muted' }, '..')),
    folder.loading ? h('p', { class: 'muted small work-empty' }, 'Reading…')
      : folder.error ? h('p', { class: 'small work-empty proj-error' }, folder.error)
        : !folder.entries?.length ? h('p', { class: 'muted small work-empty' }, 'Empty folder')
          : folder.entries.map((e) => h('button', {
            type: 'button',
            class: `work-line proj-entry${e.dir ? ' dir' : ''}`,
            'data-key': e.name,
            title: relJoin(place.path, e.name),
            onclick: () => {
              if (e.dir) return go(relJoin(place.path, e.name));
              place.file = relJoin(place.path, e.name);
              browse.repaint();
            },
          }, icon(e.dir ? 'folder' : 'file'), h('span', { class: 'work-title' }, e.name), e.dir ? icon('chevron-right') : null)))];
}

// A file below the path, coloured as Dev colours it. It is drawn once per read and kept.
/** @param {Store} store @param {Project} p @param {'local' | 'repo'} source @param {string} path */
function fileView(store, p, source, path) {
  const f = readOne(store, p, source, path);
  if (f.el) return f.el;
  const name = baseName(path);
  const full = source === 'local' ? joinPath(/** @type {string} */ (p.localPath), path) : `${browse.repo.name}/${path}`;
  const lang = languageOf(name);
  const lines = typeof f.text === 'string' ? highlight(f.text, lang) : null;
  const close = () => {
    placeOf(source).file = '';
    browse.repaint();
  };
  const el = h('div', { class: 'work-preview proj-file' },
    h('div', { class: 'work-preview-head' },
      icon('file'),
      h('span', { class: 'work-title', title: full }, name),
      h('span', { class: 'muted small work-preview-note' }, lines ? `${languageLabel(lang, name)} · ${lines.length} line${lines.length === 1 ? '' : 's'}` : ''),
      h('button', { type: 'button', class: 'icon-btn', title: 'Copy the path', 'aria-label': 'Copy the path', onclick: () => navigator.clipboard.writeText(full).then(() => toast('Path copied'), () => toast('Could not copy')) }, icon('copy')),
      source === 'repo'
        ? h('a', { class: 'icon-btn', href: `https://github.com/${browse.repo.name}/blob/HEAD/${path}`, target: '_blank', rel: 'noopener', title: 'Open on GitHub', 'aria-label': 'Open on GitHub' }, icon('github'))
        : h('a', { class: 'icon-btn', href: `#/dev?project=${p.id}&side=files`, title: 'Open the folder in Dev', 'aria-label': 'Open the folder in Dev' }, icon('terminal')),
      h('button', { type: 'button', class: 'icon-btn', title: 'Back to the folder', 'aria-label': 'Back to the folder', onclick: close }, icon('x'))),
    f.loading ? h('p', { class: 'muted small work-empty' }, 'Reading…')
      : f.error ? h('p', { class: 'small work-empty proj-error' }, f.error)
        : !lines ? h('p', { class: 'muted small work-empty' }, f.note)
          : h('div', { class: 'code-view', tabindex: '0' }, h('div', { class: 'code', style: { '--gutter': `${String(lines.length).length + 1}ch` } },
            lines.map((runs, i) => h('div', { class: 'code-line' },
              h('span', { class: 'ln', 'aria-hidden': 'true' }, i + 1),
              h('span', { class: 'lc' }, runs.map(([cls, text]) => (cls ? h('span', { class: `tok-${cls}` }, text) : text))))))));
  // Kept once read; while reading, the next paint draws it again.
  if (!f.loading) f.el = el;
  return el;
}
