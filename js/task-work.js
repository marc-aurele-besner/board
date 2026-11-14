// A task's work in one pill beside its title: its PRs (a count and a bar of open, merged and closed), its issues, the
// previews of its PRs (their worst state), its Dev sessions (what claude is doing) and the Artifacts they published.
// Each part opens its tab of one popover under the row: PRs grouped by repo with their previews on the same line,
// previews with their site and build log, the session's live terminal (keys go to it, as in Dev) and the artifacts.
// The popover lives on the page, not in the list, so the list's redraws leave the terminal and its scroll alone.
// Hovering the Dev part shows a peek at the session's terminal.
/** @import { Store, Task, TaskLink, IconName } from '../types/data' */
/** @import { RunnerStatus } from '../types/terminal' */
/** @import { Terminal } from './vt.js' */
/** @import { PrPreview } from './deploy-panel.js' */
import { h, icon, patch } from './ui.js';
import { toast } from './toast.js';
import { issuesOf, prsOf, artifactsOf } from './task-links.js';
import { linkState } from './link-states.js';
import { previewsOf, askMissing } from './previews.js';
import { openDeployPanel, stateDot, PROVIDER_NAMES, STATE_NAMES } from './deploy-panel.js';
import { claudeState } from './dev-core.js';
import { terminalView, liveSession, onSessionPaint, terminalBackground, openSession, exitText, keyData, wheelData, runnerOf, pickUp, resumeSession, followClaude, fitTerminal, imagePaths } from './modules/dev.js';
import { attachSession, sendInput, stopCommand } from './terminal.js';
import { createTerminal } from './vt.js';
import { imageFiles, dragsFiles } from './images.js';

/**
 * What the row knows that this module does not: what each Dev session is doing, and how to link another issue or PR.
 * @typedef {{ status: (session: string) => RunnerStatus | undefined, onLink?: () => void }} WorkOptions
 * @typedef {{ id: string, cwd: string, name: string }} WorkSession
 */

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
const TABS = /** @type {const} */ (['prs', 'issues', 'previews', 'dev', 'artifacts']);
/** @typedef {typeof TABS[number]} WorkTab */
const TAB_NAMES = /** @type {Record<WorkTab, string>} */ ({ prs: 'PRs', issues: 'Issues', previews: 'Previews', dev: 'Dev', artifacts: 'Artifacts' });
// The icons of the pill's parts, on their tabs.
const TAB_ICONS = /** @type {Record<WorkTab, IconName>} */ ({ prs: 'pull-request', issues: 'repo', previews: 'globe', dev: 'terminal', artifacts: 'sparkle' });
/** @type {Record<string, string>} */
const LINK_STATES = { open: 'open', merged: 'merged', closed: 'closed', completed: 'closed as completed', not_planned: 'closed as not planned' };
// The PR state filters' icons, coloured as GitHub colours the states.
const FILTER_ICONS = /** @type {Record<string, IconName>} */ ({ all: 'list', open: 'pull-request', merged: 'pr-merged', closed: 'pr-closed' });
// Above this many PRs, the PRs tab offers its state filters.
const FILTER_FROM = 4;
const PEEK_DELAY = 350;

// The sessions a task had: the one it runs now first, then those of its worktrees.
/** @param {Task} item @returns {WorkSession[]} */
function sessionsOf(item) {
  /** @type {WorkSession[]} */
  const list = [];
  const worktrees = item.worktrees ?? [];
  const add = (/** @type {string} */ id) => {
    if (!id || list.some((s) => s.id === id)) return;
    const w = worktrees.find((x) => x.session === id);
    list.push({ id, cwd: w?.cwd ?? '', name: w?.name ?? '' });
  };
  add(item.devSession ?? '');
  [...worktrees].reverse().forEach((w) => add(w.session));
  return list;
}

// A preview's state, worst first: a failed build matters more than one still building, which matters more than ready.
const PREVIEW_ORDER = ['failed', 'canceled', 'building', 'queued', 'ready'];
/** @param {{ state: string }[]} items */
const worstState = (items) => PREVIEW_ORDER.find((s) => items.some((i) => i.state === s)) ?? (items[0]?.state || '');

/** @param {Store} store @param {TaskLink[]} links */
function stateCounts(store, links) {
  /** @type {Record<string, number>} */
  const n = {};
  for (const l of links) {
    const s = linkState(store, l) || 'unknown';
    n[s] = (n[s] ?? 0) + 1;
  }
  return n;
}
/** @param {Record<string, number>} n */
const countsText = (n) => Object.entries(n).filter(([k]) => k !== 'unknown').map(([k, v]) => `${v} ${LINK_STATES[k] ?? k}`).join(', ');

// What the Dev part says: a word while claude waits on its user, nothing while it works.
/** @param {RunnerStatus | undefined} st */
function devWord(st) {
  if (!st || st.state !== 'waiting') return '';
  if (st.ask) return st.ask.kind === 'question' ? 'Question' : st.ask.kind === 'plan' ? 'Approve plan' : 'Permission';
  return st.signalled ? '' : 'Your turn';
}

/** @param {RunnerStatus | undefined} st */
const devLook = (st) => (st ? claudeState(st) : { key: 'idle', label: 'The runner has not answered for this session' });

// ---------- The pill ----------

/** @param {Store} store @param {Task} item @param {WorkOptions} options */
export function workPill(store, item, options) {
  const prs = prsOf(item);
  const issues = issuesOf(item);
  const artifacts = artifactsOf(item);
  const sessions = sessionsOf(item);
  askMissing(store, prs);
  const previews = previewsOf(store, prs);
  if (!prs.length && !issues.length && !artifacts.length && !sessions.length) return null;
  const open = pop.id === item.id;
  /** @param {WorkTab} tab @param {string} cls @param {string} label @param {...(Node | string | null)} body */
  const seg = (tab, cls, label, ...body) => h('button', {
    type: 'button',
    class: `work-seg ${cls}${open && pop.tab === tab ? ' on' : ''}`,
    title: `${label}. Click for the list.`,
    'aria-label': label,
    'aria-expanded': String(open && pop.tab === tab),
    /** @param {MouseEvent} e */
    onclick: (e) => {
      e.stopPropagation();
      hidePeek();
      toggleWork(store, item.id, tab, options);
    },
  }, ...body);

  const parts = [];
  if (prs.length) {
    const n = stateCounts(store, prs);
    const lead = n.open ? 'open' : n.merged ? 'merged' : n.closed ? 'closed' : '';
    const label = prs.length === 1 ? `Pull request ${prs[0].repo} #${prs[0].number}${lead ? `, ${LINK_STATES[lead]}` : ''}` : `${prs.length} pull requests${countsText(n) ? `: ${countsText(n)}` : ''}`;
    const bar = prs.length > 1
      ? h('span', { class: 'work-bar', 'aria-hidden': 'true' }, ['open', 'merged', 'closed'].map((s) => (n[s] ? h('i', { class: `bar-${s}`, style: { flexGrow: String(n[s]) } }) : null)))
      : null;
    parts.push(seg('prs', lead ? `gh-${lead}` : '', label, icon('pull-request'), prs.length === 1 ? `#${prs[0].number}` : String(prs.length), bar));
  }
  if (issues.length) {
    const n = stateCounts(store, issues);
    const lead = n.open ? 'open' : n.completed || n.closed ? 'completed' : n.not_planned ? 'not_planned' : '';
    const label = issues.length === 1 ? `Issue ${issues[0].repo} #${issues[0].number}${lead ? `, ${LINK_STATES[lead]}` : ''}` : `${issues.length} issues${countsText(n) ? `: ${countsText(n)}` : ''}`;
    parts.push(seg('issues', lead ? `gh-${lead}` : '', label, icon('repo'), issues.length === 1 ? `#${issues[0].number}` : String(issues.length)));
  }
  if (previews.length) {
    const worst = worstState(previews);
    parts.push(seg('previews', '', `${previews.length} preview${previews.length > 1 ? 's' : ''}${worst ? `, ${(STATE_NAMES[worst] ?? worst).toLowerCase()}` : ''}`, stateDot(worst), String(previews.length)));
  }
  if (sessions.length) {
    const st = options.status(sessions[0].id);
    const look = devLook(st);
    const word = devWord(st);
    const dev = seg('dev', `work-dev is-${look.key}${word ? ' asks' : ''}`, `Dev: ${look.label}${sessions.length > 1 ? ` (${sessions.length} sessions)` : ''}`,
      icon('terminal'), h('span', { class: `work-dot is-${look.key}`, 'aria-hidden': 'true' }), word || (sessions.length > 1 ? String(sessions.length) : null));
    dev.addEventListener('mouseenter', () => schedulePeek(store, item, sessions[0], dev, options));
    dev.addEventListener('mouseleave', hidePeek);
    parts.push(dev);
  }
  if (artifacts.length) {
    parts.push(seg('artifacts', 'work-art', `${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''}: ${artifacts.map((a) => a.title || 'Artifact').join(', ')}`, icon('sparkle'), String(artifacts.length)));
  }
  return h('span', { class: `work-pill${open ? ' open' : ''}`, 'data-work': item.id, role: 'group', 'aria-label': 'Work on this task' }, parts);
}

// ---------- The popover ----------

/**
 * @type {{ id: string, tab: WorkTab, filter: string, shut: Set<string>, big: boolean, session: string,
 *   store: Store | null, options: WorkOptions | null, el: HTMLElement | null, head: HTMLElement | null,
 *   body: HTMLElement | null, slot: HTMLElement | null, foot: HTMLElement | null, unsub: (() => void) | null, frame: number,
 *   term: TermView | null }}
 */
const pop = { id: '', tab: 'prs', filter: 'all', shut: new Set(), big: false, session: '', store: null, options: null, el: null, head: null, body: null, slot: null, foot: null, unsub: null, frame: 0, term: null };

/** @param {Store} store @param {string} id @param {WorkTab} tab @param {WorkOptions} options */
function toggleWork(store, id, tab, options) {
  if (pop.id === id && pop.tab === tab) return closeWork();
  if (pop.id !== id) {
    closeWork();
    Object.assign(pop, { id, filter: 'all', shut: new Set(), big: false, session: '' });
  }
  Object.assign(pop, { tab, store, options });
  if (!pop.el) build(store);
  paint();
  store.refresh();
}

export function closeWork() {
  if (!pop.el) return;
  const store = pop.store;
  dropTerm();
  pop.el.remove();
  pop.unsub?.();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', place);
  window.removeEventListener('hashchange', closeWork);
  Object.assign(pop, { id: '', el: null, head: null, body: null, slot: null, foot: null, unsub: null, big: false });
  store?.refresh();
}

/** @param {Store} store */
function build(store) {
  pop.head = h('div', { class: 'work-head' });
  pop.body = h('div', { class: 'work-body' });
  pop.slot = h('div', { class: 'work-term-slot' });
  pop.foot = h('div', { class: 'work-foot' });
  pop.el = h('div', { class: 'work-pop', role: 'dialog', 'aria-label': 'Work on this task' }, pop.head, pop.body, pop.slot, pop.foot);
  document.body.append(pop.el);
  pop.unsub = store.subscribe(() => (pop.frame ||= requestAnimationFrame(() => {
    pop.frame = 0;
    paint();
  })));
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', place);
  window.addEventListener('hashchange', closeWork);
}

/** @param {PointerEvent} e */
function onOutside(e) {
  const t = /** @type {Element} */ (e.target);
  if (pop.el?.contains(t) || t.closest?.(`[data-work="${CSS.escape(pop.id)}"]`) || t.closest?.('.modal-overlay, .popover.menu, .turns-pop, .toast')) return;
  closeWork();
}

/** @param {KeyboardEvent} e */
function onKey(e) {
  if (e.key !== 'Escape' || !pop.el || document.querySelector('.modal-overlay, .turns-pop')) return;
  // Escape in the terminal goes to claude, as in Dev.
  if (pop.term?.view.el.contains(/** @type {Node} */ (e.target))) return;
  e.stopPropagation();
  if (pop.big) {
    pop.big = false;
    paint();
  } else closeWork();
}

// Under the pill and as tall as the window leaves room for, or above it when there is more room there; expanded, it
// fills most of the window.
const MIN_ROOM = 360;
function place() {
  const el = pop.el;
  if (!el) return;
  el.classList.toggle('big', pop.big);
  if (pop.big) {
    el.style.left = el.style.top = el.style.maxHeight = '';
    return;
  }
  const anchor = document.querySelector(`[data-work="${CSS.escape(pop.id)}"]`);
  if (!anchor) return closeWork();
  const r = anchor.getBoundingClientRect();
  const width = el.offsetWidth;
  const left = Math.max(8, Math.min(r.left, document.documentElement.clientWidth - width - 8));
  const below = innerHeight - r.bottom - 12;
  const above = r.top - 12;
  const up = below < MIN_ROOM && above > below;
  el.style.maxHeight = `${Math.max(240, Math.min(up ? above : below, 640))}px`;
  el.style.left = `${left + scrollX}px`;
  el.style.top = up ? `${r.top + scrollY - 4 - el.offsetHeight}px` : `${r.bottom + scrollY + 4}px`;
}

function paint() {
  const { store, options } = pop;
  if (!pop.el || !store || !options || !pop.head || !pop.body || !pop.foot || !pop.slot) return;
  const item = store.get('todos').items.find((t) => t.id === pop.id);
  if (!item) return closeWork();
  const prs = prsOf(item);
  const issues = issuesOf(item);
  const artifacts = artifactsOf(item);
  const sessions = sessionsOf(item);
  const previews = previewsOf(store, prs);
  /** @type {Record<WorkTab, number>} */
  const counts = { prs: prs.length, issues: issues.length, previews: previews.length, dev: sessions.length, artifacts: artifacts.length };
  if (!counts[pop.tab]) pop.tab = TABS.find((t) => counts[t]) ?? 'prs';

  const states = stateCounts(store, prs);
  const filters = prs.length >= FILTER_FROM ? ['all', ...['open', 'merged', 'closed'].filter((s) => states[s])] : [];
  if (!filters.includes(pop.filter)) pop.filter = 'all';
  patch(pop.head, h('div', null,
    h('div', { class: 'work-tabs', role: 'tablist' }, TABS.filter((t) => counts[t]).map((t) => h('button', {
      type: 'button',
      role: 'tab',
      class: `work-tab${pop.tab === t ? ' on' : ''}`,
      'aria-selected': String(pop.tab === t),
      onclick: () => {
        pop.tab = t;
        paint();
        store.refresh();
      },
    }, icon(TAB_ICONS[t]), TAB_NAMES[t], h('b', null, String(counts[t]))))),
    h('button', { type: 'button', class: 'icon-btn', title: pop.big ? 'Back under the row (Esc)' : 'Expand', 'aria-label': pop.big ? 'Back under the row' : 'Expand', onclick: () => {
      pop.big = !pop.big;
      paint();
    } }, icon(pop.big ? 'minimize' : 'maximize')),
    h('button', { type: 'button', class: 'icon-btn', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeWork }, icon('x'))));

  pop.el.setAttribute('aria-label', `Work on “${item.text}”`);
  if (pop.tab === 'dev') {
    patch(pop.body, h('div', null, sessionList(sessions, options)));
    showTerm(store, item, sessions, options);
  } else {
    dropTerm();
    const filterRow = pop.tab === 'prs' && filters.length > 2 ? h('div', { class: 'work-filters', role: 'group', 'aria-label': 'Show' }, filters.map((f) => h('button', {
      type: 'button',
      class: `work-filter${f === 'all' ? '' : ` gh-${f}`}${pop.filter === f ? ' on' : ''}`,
      'aria-pressed': String(pop.filter === f),
      onclick: () => {
        pop.filter = f;
        paint();
      },
    }, icon(FILTER_ICONS[f] ?? 'list'), f === 'all' ? `All ${prs.length}` : `${f[0].toUpperCase()}${f.slice(1)} ${states[f]}`))) : null;
    patch(pop.body, h('div', null, filterRow, pop.tab === 'prs' ? prList(store, prs, previews)
      : pop.tab === 'issues' ? linkLines(store, issues, false, [])
        : pop.tab === 'previews' ? previewList(store, previews)
          : artifactList(artifacts)));
  }

  const summary = [
    prs.length ? `${prs.length} PR${prs.length > 1 ? 's' : ''}${countsText(states) ? ` (${countsText(states)})` : ''}` : '',
    issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''}` : '',
    previews.length ? `${previews.length} preview${previews.length > 1 ? 's' : ''}` : '',
    sessions.length ? `${sessions.length} Dev session${sessions.length > 1 ? 's' : ''}` : '',
    artifacts.length ? `${artifacts.length} artifact${artifacts.length > 1 ? 's' : ''}` : '',
  ].filter(Boolean).join(' · ');
  const urls = [...prs.map((l) => l.url), ...issues.map((l) => l.url), ...previews.map((p) => p.url).filter(Boolean), ...artifacts.map((a) => a.url)];
  patch(pop.foot, h('div', null,
    h('span', { class: 'muted small grow' }, summary),
    urls.length ? h('button', { type: 'button', class: 'btn-small', onclick: () => navigator.clipboard.writeText(urls.join('\n')).then(() => toast(`${urls.length} link${urls.length > 1 ? 's' : ''} copied`), () => toast('Could not copy')) }, icon('copy'), 'Copy links') : null,
    options.onLink ? h('button', { type: 'button', class: 'btn-small', onclick: () => options.onLink?.() }, icon('link'), 'Link an issue or PR') : null));
  place();
}

// ---------- The tabs ----------

/** @param {string} repo */
const shortRepo = (repo) => repo.split('/').pop() ?? repo;

/** @param {Store} store @param {TaskLink[]} prs @param {PrPreview[]} previews */
function prList(store, prs, previews) {
  const shown = prs.filter((l) => pop.filter === 'all' || linkState(store, l) === pop.filter);
  if (!shown.length) return h('p', { class: 'muted small work-empty' }, `No ${pop.filter} PR on this task.`);
  const repos = [...new Set(shown.map((l) => l.repo))];
  // The newest first, as they were added.
  const newest = (/** @type {TaskLink[]} */ list) => [...list].reverse();
  if (repos.length === 1) return linkLines(store, newest(shown), true, previews);
  return repos.map((repo) => {
    const list = shown.filter((l) => l.repo === repo);
    const pv = previews.filter((p) => p.pr.repo === repo && list.some((l) => l.number === p.pr.number)).length;
    const shut = pop.shut.has(repo);
    return [
      h('button', {
        type: 'button',
        class: `work-group${shut ? ' shut' : ''}`,
        'aria-expanded': String(!shut),
        onclick: () => {
          if (shut) pop.shut.delete(repo);
          else pop.shut.add(repo);
          paint();
        },
      }, icon('chevron-down'), h('span', null, shortRepo(repo)), h('span', { class: 'muted' }, `${list.length} PR${list.length > 1 ? 's' : ''}${pv ? ` · ${pv} preview${pv > 1 ? 's' : ''}` : ''}`)),
      shut ? null : linkLines(store, newest(list), true, previews),
    ];
  });
}

/** @param {Store} store @param {TaskLink[]} links @param {boolean} pr @param {PrPreview[]} previews */
function linkLines(store, links, pr, previews) {
  return h('div', { class: 'work-lines' }, links.map((l) => {
    const state = linkState(store, l);
    const own = previews.filter((p) => p.pr.repo.toLowerCase() === l.repo.toLowerCase() && p.pr.number === l.number);
    return h('div', { class: 'work-line', 'data-key': `${l.repo}#${l.number}` },
      h('span', { class: state ? `gh-${state}` : 'muted', title: state ? LINK_STATES[state] ?? state : 'State not read yet' }, icon(pr ? 'pull-request' : 'repo')),
      h('span', { class: 'work-num' }, `#${l.number}`),
      h('a', { class: 'work-title', href: l.url, target: '_blank', rel: 'noopener', title: `${l.repo} #${l.number}${l.title ? `: ${l.title}` : ''}${state ? ` · ${LINK_STATES[state] ?? state}` : ''}` }, l.title || l.repo),
      own.map((p) => previewPill(store, p, own.length > 1)));
  }));
}

// A preview beside its PR: its site opens in a tab; with its id (read from the provider's API) the build log opens too.
/** @param {Store} store @param {PrPreview} p @param {boolean} named */
function previewPill(store, p, named) {
  const label = named && p.name ? p.name : 'Preview';
  return h('span', { class: `work-pv deploy-${p.state || 'unknown'}` },
    p.url
      ? h('a', { href: p.url, target: '_blank', rel: 'noopener noreferrer', title: `Open ${p.url}` }, stateDot(p.state), label)
      : h('span', { title: (STATE_NAMES[p.state] ?? p.state) || 'No link yet' }, stateDot(p.state), label),
    p.id ? h('button', { type: 'button', title: 'Build log and details', 'aria-label': `Build log of ${p.pr.repo} #${p.pr.number}`, onclick: () => openLog(store, p) }, icon('list')) : null);
}

/** @param {Store} store @param {PrPreview} p */
function openLog(store, p) {
  const find = () => previewsOf(store, [p.pr]).find((x) => x.provider === p.provider && (x.id === p.id || x.name === p.name));
  openDeployPanel(store, p, find);
}

/** @param {Store} store @param {PrPreview[]} previews */
function previewList(store, previews) {
  const noLog = previews.some((p) => !p.id);
  return [noLog ? h('p', { class: 'muted small work-note' }, 'Previews read from a PR comment have no build log here: add a token in Settings → Vercel or Netlify to read it.') : null,
    h('div', { class: 'work-lines' }, [...previews].reverse().map((p) => {
    const host = p.url ? p.url.replace(/^https?:\/\//, '').replace(/\/.*$/, '') : '';
    const state = (STATE_NAMES[p.state] ?? p.state ?? '').toLowerCase();
    return h('div', { class: 'work-line', 'data-key': `${p.pr.repo}#${p.pr.number}:${p.provider}:${p.name}` },
      stateDot(p.state),
      h('span', { class: 'work-num' }, `#${p.pr.number}`),
      h('span', { class: 'work-title', title: `${PROVIDER_NAMES[p.provider] ?? 'Preview'}${p.name ? ` · ${p.name}` : ''} · ${p.pr.repo} #${p.pr.number}${p.error ? `\n${p.error}` : ''}` },
        host || p.name || 'Preview', state && p.state !== 'ready' ? h('span', { class: 'muted' }, ` · ${state}`) : null),
      h('span', { class: 'work-actions' },
        p.url ? h('a', { class: 'btn-small', href: p.url, target: '_blank', rel: 'noopener noreferrer' }, icon('globe'), 'Open site') : null,
        p.id ? h('button', { type: 'button', class: 'btn-small', onclick: () => openLog(store, p) }, icon('list'), 'Build log') : null));
    }))];
}

/** @param {ReturnType<typeof artifactsOf>} artifacts */
const artifactList = (artifacts) => h('div', { class: 'work-lines' }, [...artifacts].reverse().map((a) => h('div', { class: 'work-line', 'data-key': a.url },
  h('span', { class: 'work-art' }, icon('sparkle')),
  h('a', { class: 'work-title', href: a.url, target: '_blank', rel: 'noopener', title: a.url }, a.title || 'Artifact'),
  h('span', { class: 'work-actions' }, h('a', { class: 'btn-small', href: a.url, target: '_blank', rel: 'noopener' }, 'Open')))));

// With more than one session, a row each to pick the one the terminal shows.
/** @param {WorkSession[]} sessions @param {WorkOptions} options */
function sessionList(sessions, options) {
  if (!sessions.some((s) => s.id === pop.session)) pop.session = sessions[0]?.id ?? '';
  if (sessions.length < 2) return null;
  return h('div', { class: 'work-lines work-sessions' }, sessions.map((s, i) => {
    const look = devLook(options.status(s.id));
    return h('button', {
      type: 'button',
      class: `work-line work-session${pop.session === s.id ? ' on' : ''}`,
      'data-key': s.id,
      'aria-pressed': String(pop.session === s.id),
      onclick: () => {
        pop.session = s.id;
        paint();
      },
    }, h('span', { class: `work-dot is-${look.key}`, 'aria-hidden': 'true' }),
    h('span', { class: 'work-title' }, s.name || (i ? 'Earlier session' : 'Current session')),
    h('span', { class: 'muted small' }, look.label));
  }));
}

// ---------- The terminal ----------

/**
 * A session's terminal as read for Tasks: Dev's own copy when Dev reads it (one stream per session and page), else
 * a stream of its own. Views draw it: the popover's (which takes keys) and the peek's.
 * @typedef {{ session: string, term: Terminal, state: string, running: boolean, pid: number, exit: import('./modules/dev.js').Exit | null,
 *   command: string, cwd: string, mirror: boolean, frame: number, views: Set<TermView>, stop: () => void }} Reader
 * @typedef {{ view: ReturnType<typeof terminalView>, keys: boolean, el: HTMLElement, reader: Reader, bar: HTMLElement | null, head: HTMLElement | null,
 *   claude: HTMLElement | null, usage: HTMLElement | null, observer: ResizeObserver | null, fitted?: { cols: number, pid: number } }} TermView
 */
/** @type {Map<string, Reader>} */
const readers = new Map();

/** @param {Reader} r */
const current = (r) => {
  const live = r.mirror ? liveSession(r.session) : null;
  return live ?? { term: r.term, running: r.running, exit: r.exit, pid: r.pid, command: r.command, cwd: r.cwd };
};

/** @param {Reader} r */
function drawReader(r) {
  r.frame = 0;
  const c = current(r);
  for (const v of r.views) {
    if (v.keys && c.running && pop.store && (c.term.cols !== v.fitted?.cols || c.pid !== v.fitted?.pid)) {
      v.fitted = { cols: c.term.cols, pid: c.pid };
      fitTerminal(pop.store, v.view.el, c.term, c.pid);
    }
    v.view.paint(c.term, v.keys && c.running);
    if (v.bar) paintBar(v);
  }
}

/** @param {Store} store @param {string} session */
function readerOf(store, session) {
  const had = readers.get(session);
  if (had) return had;
  /** @type {Reader} */
  const r = { session, term: createTerminal({ cols: 120, rows: 32, background: terminalBackground }), state: 'loading', running: false, pid: 0, exit: null, command: '', cwd: '', mirror: false, frame: 0, views: new Set(), stop: () => {} };
  readers.set(session, r);
  const drawSoon = () => (r.frame ||= requestAnimationFrame(() => drawReader(r)));
  if (liveSession(session)) {
    r.mirror = true;
    r.state = 'live';
    r.stop = onSessionPaint(drawSoon);
    drawSoon();
    return r;
  }
  const ctl = new AbortController();
  r.stop = () => ctl.abort();
  const { term } = r;
  attachSession(runnerOf(store), {
    session,
    signal: ctl.signal,
    onEvent: (e) => {
      if (e.t === 'session') {
        r.state = e.known ? 'replay' : 'missing';
        term.reset();
        term.clear();
      } else if (e.t === 'live') r.state = 'live';
      else if (e.t === 'size') term.resize(e.cols, e.rows);
      else if (e.t === 'start') {
        Object.assign(r, { running: true, pid: e.pid, exit: null, command: e.command, cwd: e.cwd });
        if (e.cols) term.resize(e.cols, e.rows);
      } else if (e.t === 'out' || e.t === 'err') term.write(e.d);
      else if (e.t === 'exit') {
        Object.assign(r, { running: false, pid: 0, exit: e.stopped ? { stopped: true, ms: e.ms } : { code: e.code, signal: e.signal, ms: e.ms } });
        term.reset();
        term.note(exitText(r.exit), r.exit?.code === 0 ? 't-meta t-ok' : 't-meta');
      }
      drawSoon();
    },
  }).then(() => {
    if (ctl.signal.aborted) return;
    // The stream ended: the runner stopped, or Dev took the terminal over. Read again on the next open.
    if (r.state === 'loading') r.state = 'offline';
    readers.delete(session);
    drawSoon();
  });
  drawSoon();
  return r;
}

// Starts claude again in a session that ended or that the runner lost (pickUp()), then reads its terminal anew.
/** @param {Store} store @param {Task} item @param {string} session @param {{ command: string, cwd: string }} next */
async function resume(store, item, session, next) {
  const own = store.get('todos').items.filter((t) => t.devSession === session).map((t) => t.id);
  try {
    await resumeSession(store, session, next, own.length ? own : [item.id], pop.term?.reader.session === session ? pop.term.view.el : undefined);
  } catch (err) {
    return toast(/** @type {Error} */ (err).message);
  }
  // A stream that ended (the runner stopped) is read again; one still open shows the new start by itself.
  const r = readers.get(session);
  if (pop.term?.reader.session === session && (!r || r.state === 'offline' || r.state === 'missing')) {
    dropTerm();
    paint();
  }
}

/** @param {TermView} v */
function detach(v) {
  const r = v.reader;
  r.views.delete(v);
  if (r.views.size) return;
  r.stop();
  readers.delete(r.session);
}

/** @param {Store} store @param {Task} item @param {WorkSession[]} sessions @param {WorkOptions} options */
function showTerm(store, item, sessions, options) {
  const s = sessions.find((x) => x.id === pop.session);
  if (!s || !pop.slot) return dropTerm();
  if (pop.term?.reader.session !== s.id) {
    dropTerm();
    pop.term = termView(store, item, s, true);
    pop.slot.replaceChildren(pop.term.el);
  }
  const look = devLook(options.status(s.id));
  const head = pop.term.head;
  const term = pop.term;
  const openDev = () => {
    const taskIds = store.get('todos').items.filter((t) => t.devSession === s.id).map((t) => t.id);
    closeWork();
    openSession({ id: s.id, cwd: s.cwd || options.status(s.id)?.cwd || '', taskIds: taskIds.length ? taskIds : [item.id] });
  };
  if (head) {
    // The head has what Dev's bar shows of claude: its turns, subagents, tools, skills and MCP calls, and on the right
    // its model and cost.
    const claude = term.claude;
    patch(head, h('div', null,
      h('span', { class: `work-dot is-${look.key}`, 'aria-hidden': 'true' }),
      h('span', { class: 'work-term-state' }, look.label),
      s.cwd || options.status(s.id)?.cwd ? h('button', {
        type: 'button',
        class: 'work-cwd',
        title: `${s.cwd || options.status(s.id)?.cwd}\nClick to copy the folder path`,
        onclick: () => navigator.clipboard.writeText(s.cwd || options.status(s.id)?.cwd || '').then(() => toast('Folder path copied'), () => toast('Could not copy')),
      }, (s.cwd || options.status(s.id)?.cwd || '').split('/').pop()) : null,
      claude,
      h('span', { class: 'grow' }),
      claude ? term.usage : null,
      h('button', { type: 'button', class: 'icon-btn', title: 'Copy the output', 'aria-label': 'Copy the output', onclick: () => copyOutput(/** @type {TermView} */ (pop.term)) }, icon('copy')),
      // Under the row, where the head is narrow, Open in Dev is its icon alone.
      pop.big
        ? h('button', { type: 'button', class: 'btn-small', title: 'Open this terminal in Dev', onclick: openDev }, icon('terminal'), 'Open in Dev')
        : h('button', { type: 'button', class: 'icon-btn', title: 'Open this terminal in Dev', 'aria-label': 'Open in Dev', onclick: openDev }, icon('terminal'))));
    if (claude) {
      const c = current(term.reader);
      followClaude(store, claude, /** @type {HTMLElement} */ (term.usage), {
        id: s.id,
        running: c.running,
        cwd: c.cwd || s.cwd,
        type: (text) => {
          const now = current(term.reader);
          if (!now.running || !now.pid) return toast('Nothing runs in this terminal.');
          sendInput(runnerOf(store), now.pid, { data: text });
          term.view.el.focus({ preventScroll: true });
        },
        openDev,
      });
    }
  }
  drawReader(pop.term.reader);
}

function dropTerm() {
  if (!pop.term) return;
  pop.term.observer?.disconnect();
  detach(pop.term);
  pop.term.el.remove();
  pop.term = null;
}

/** @param {Store} store @param {Task} item @param {WorkSession} s @param {boolean} keys @returns {TermView} */
function termView(store, item, s, keys) {
  const reader = readerOf(store, s.id);
  const view = terminalView(keys ? `Terminal of “${item.text}”: focus it and type, keys go to the session` : 'Terminal preview');
  const head = keys ? h('div', { class: 'work-term-head' }) : null;
  const bar = keys ? h('div', { class: 'work-term-bar' }) : null;
  const el = h('div', { class: keys ? 'work-term' : 'work-term peek' }, head, view.el, bar);
  /** @type {TermView} */
  const v = { view, keys, el, reader, bar, head, claude: keys ? h('span', { class: 'term-claude', 'data-own': '' }) : null,
    usage: keys ? h('span', { class: 'term-claude work-usage', 'data-own': '' }) : null, observer: null };
  reader.views.add(v);
  if (keys) {
    const base = runnerOf(store);
    // The program is fitted to the view, as Dev fits it to its own: a wider one would run off the edge.
    v.observer = new ResizeObserver(() => fitView(store, v));
    v.observer.observe(view.el);
    /** @param {File[]} images */
    const typeImages = async (images) => {
      const pid = current(reader).pid;
      const text = await imagePaths(store, images);
      const c = current(reader);
      if (!text || !c.running || c.pid !== pid) return;
      sendInput(base, pid, { data: c.term.paste ? `\x1b[200~${text}\x1b[201~` : text });
      view.el.focus({ preventScroll: true });
    };
    view.el.addEventListener('dragover', (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      view.el.classList.add('dropping');
    });
    view.el.addEventListener('dragleave', () => view.el.classList.remove('dropping'));
    view.el.addEventListener('drop', (e) => {
      if (!dragsFiles(e)) return;
      e.preventDefault();
      view.el.classList.remove('dropping');
      const images = imageFiles(e.dataTransfer);
      if (!images.length) return toast('Only PNG, JPEG, GIF and WebP images can be dropped here');
      if (!current(reader).running) return toast('Start claude in this terminal first, then drop the image');
      typeImages(images);
    });
    view.el.addEventListener('keydown', (e) => {
      const c = current(reader);
      if (!c.running || !c.pid) return;
      // Copy keeps working: Cmd+C on a Mac, and Ctrl+C elsewhere while text is selected.
      if (e.ctrlKey && e.key === 'c' && !isMac && String(getSelection())) return;
      const data = keyData(e, c.term.appCursor);
      if (data === null) return;
      e.preventDefault();
      e.stopPropagation();
      sendInput(base, c.pid, { data });
    });
    view.el.addEventListener('paste', (e) => {
      const c = current(reader);
      if (!c.running || !c.pid) return;
      e.preventDefault();
      // An image pasted goes to claude as the path of a copy the runner saved, as in Dev.
      const images = imageFiles(e.clipboardData);
      if (images.length) return typeImages(images);
      const text = (e.clipboardData?.getData('text') ?? '').replace(/\r?\n/g, '\r');
      if (text) sendInput(base, c.pid, { data: c.term.paste ? `\x1b[200~${text}\x1b[201~` : text });
    });
    view.el.addEventListener('wheel', (e) => {
      const c = current(reader);
      if (!c.running || !c.pid) return;
      const data = wheelData(c.term, e, view.screen);
      if (data) sendInput(base, c.pid, { data });
    }, { passive: false });
  }
  return v;
}

/** @param {Store} store @param {TermView} v */
function fitView(store, v) {
  const c = current(v.reader);
  if (c.running && c.pid && fitTerminal(store, v.view.el, c.term, c.pid)) drawReader(v.reader);
}

// The bar under the terminal, as in Dev: what runs, the keys a mouse needs, and Stop.
/** @param {TermView} v */
function paintBar(v) {
  const r = v.reader;
  const c = current(r);
  const store = pop.store;
  if (!v.bar || !store) return;
  const base = runnerOf(store);
  // claude to pick up once nothing runs: in a terminal that ended, or one the runner no longer has.
  const item = store.get('todos').items.find((t) => t.id === pop.id);
  const next = !c.running && r.state !== 'loading' && item ? pickUp(store, { id: r.session, command: c.command, cwd: c.cwd }) : null;
  /** @param {string} label @param {string} data @param {string} title */
  const key = (label, data, title) => h('button', { type: 'button', class: 'term-key', title, onclick: () => {
    if (c.pid) sendInput(base, c.pid, { data });
    v.view.el.focus({ preventScroll: true });
  } }, label);
  const note = /** @type {Record<string, string>} */ ({
    loading: 'Reading the terminal…',
    missing: 'The runner no longer has this terminal: it was closed in Dev.',
    offline: 'Could not reach the terminal runner. Start it with bun start, then open this again.',
  })[r.state];
  patch(v.bar, h('div', null,
    h('span', { class: `term-dot dev-${c.running ? 'working' : c.exit ? (c.exit.code === 0 ? 'done' : 'failed') : 'idle'}`, 'aria-hidden': 'true' }),
    h('span', { class: 'work-term-note' }, note ?? (c.running ? 'Click the terminal and type: keys go to the session' : c.exit ? exitText(c.exit) : 'Nothing runs in this terminal')),
    c.running ? [
      key('Esc', '\x1b', 'Send Escape (interrupts claude)'),
      key('Ctrl+C', '\x03', 'Send Ctrl+C'),
      key('⇧Tab', '\x1b[Z', 'Send Shift+Tab (cycles claude’s permission mode)'),
      h('button', { type: 'button', class: 'term-key stop', title: 'Stop the command and anything it started', onclick: () => stopCommand(base, r.session).catch((err) => toast(err.message)) }, icon('stop'), 'Stop'),
    ] : null,
    next && item ? h('button', {
      type: 'button',
      class: 'term-key resume',
      title: `${next.label}: runs\n${next.command}`,
      onclick: (/** @type {MouseEvent} */ e) => {
        /** @type {HTMLButtonElement} */ (e.currentTarget).disabled = true;
        resume(store, item, r.session, next);
      },
    }, icon('play'), next.worktree ? 'Resume claude' : 'Continue claude') : null));
}

/** @param {TermView} v */
function copyOutput(v) {
  const { term } = current(v.reader);
  const text = [...term.history, ...term.screen.slice(0, term.used())].map((l) => Array.from({ length: l.cells.length }, (_, i) => l.cells[i]?.c ?? ' ').join('').trimEnd()).join('\n');
  navigator.clipboard.writeText(text.trim()).then(() => toast('Output copied'), () => toast('Could not copy'));
}

// ---------- The peek ----------

/** @type {{ timer: number, el: HTMLElement | null, term: TermView | null }} */
const peek = { timer: 0, el: null, term: null };

/** @param {Store} store @param {Task} item @param {WorkSession} s @param {HTMLElement} anchor @param {WorkOptions} options */
function schedulePeek(store, item, s, anchor, options) {
  hidePeek();
  if (pop.id === item.id) return;
  peek.timer = window.setTimeout(() => {
    if (!anchor.isConnected) return;
    const look = devLook(options.status(s.id));
    peek.term = termView(store, item, s, false);
    peek.el = h('div', { class: 'work-peek', role: 'tooltip' },
      h('div', { class: 'work-peek-head' }, h('span', { class: `work-dot is-${look.key}`, 'aria-hidden': 'true' }), h('span', null, look.label)),
      peek.term.el);
    document.body.append(peek.el);
    const r = anchor.getBoundingClientRect();
    const width = peek.el.offsetWidth;
    peek.el.style.left = `${Math.max(8, Math.min(r.left, document.documentElement.clientWidth - width - 8)) + scrollX}px`;
    peek.el.style.top = `${r.bottom + scrollY + 6}px`;
    drawReader(peek.term.reader);
  }, PEEK_DELAY);
}

function hidePeek() {
  clearTimeout(peek.timer);
  peek.timer = 0;
  if (peek.term) detach(peek.term);
  peek.el?.remove();
  peek.el = null;
  peek.term = null;
}
window.addEventListener('hashchange', hidePeek);
