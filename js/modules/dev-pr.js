// Dev's pull request view, as GitHub's "Files changed": what the workspace's branch changes against the default
// branch, from where they part. A summary (branches, commits, lines), the changed files listed on the left, and each
// file's diff as a card that folds; "Viewed" folds it and is kept until the file changes again.
import { h, icon } from '../ui.js';
import { gitPullRequest, gitDiff } from '../terminal.js';
import { languageOf } from '../highlight.js';
import { openView, openDiff, openFile, splitDiff, diffRows, baseName } from './dev-files.js';
import { dateLocale } from '../locale.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { GitPullRequest } from '../../types/terminal' */
/** @import { DiffFile, FileTab } from './dev-files.js' */

// A file this long starts folded, as GitHub does with large diffs: drawing it waits until it is opened.
const LARGE = 1500;
const VIEWED_KEY = 'dev-pr-viewed';
// Branches whose viewed files are kept; the oldest are forgotten first.
const VIEWED_KEPT = 30;

// Uncommitted and new files are shown unless `committed`. `viewed`: per repository and branch, each viewed file's
// path and a hash of its diff, so a file changed since shows as not viewed again.
/** @type {{ committed: boolean, viewed: Record<string, Record<string, string>> | null }} */
const state = { committed: false, viewed: null };

function viewedAll() {
  if (state.viewed) return state.viewed;
  try {
    state.viewed = JSON.parse(localStorage.getItem(VIEWED_KEY) ?? '{}') ?? {};
  } catch {
    state.viewed = {};
  }
  return /** @type {Record<string, Record<string, string>>} */ (state.viewed);
}

/** @param {string} key */
function viewedOf(key) {
  const all = viewedAll();
  // Read last, kept first: moved to the end of the list.
  const own = all[key] ?? {};
  delete all[key];
  all[key] = own;
  for (const old of Object.keys(all).slice(0, -VIEWED_KEPT)) delete all[old];
  return own;
}

function saveViewed() {
  try {
    localStorage.setItem(VIEWED_KEY, JSON.stringify(viewedAll()));
  } catch {}
}

/** @param {DiffFile} f */
function signature(f) {
  let hash = 5381;
  const text = `${f.status}\n${f.from ?? ''}\n${f.lines.join('\n')}`;
  for (let i = 0; i < text.length; i++) hash = ((hash << 5) + hash + text.charCodeAt(i)) | 0;
  return (hash >>> 0).toString(36);
}

/** @type {Record<string, [string, string, string]>} */
const LETTERS = { A: ['A', 'git-new', 'Added'], D: ['D', 'git-del', 'Deleted'], R: ['R', 'git-mod', 'Renamed'], M: ['M', 'git-mod', 'Modified'] };
const letterOf = (/** @type {string} */ status) => LETTERS[status] ?? LETTERS.M;

// GitHub's five squares: the share of added and removed lines.
/** @param {number} adds @param {number} dels */
function squares(adds, dels) {
  const total = adds + dels;
  const green = total ? Math.round((adds / total) * 5) : 0;
  const red = total ? Math.min(5 - green, Math.round((dels / total) * 5)) : 0;
  return h('span', { class: 'pr-squares', 'aria-hidden': 'true' },
    Array.from({ length: 5 }, (_, i) => h('span', { class: i < green ? 'add' : i < green + red ? 'del' : '' })));
}

const counts = (/** @type {number} */ adds, /** @type {number} */ dels) => h('span', { class: 'pr-counts' },
  h('span', { class: 'pr-adds' }, `+${adds}`), h('span', { class: 'pr-dels' }, `−${dels}`));

const plural = (/** @type {number} */ n, /** @type {string} */ word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The text by the tab's title: files and lines, worked out once per read.
/** @type {WeakMap<GitPullRequest, string>} */
const metaText = new WeakMap();
/** @param {FileTab} tab */
function meta(tab) {
  const pr = /** @type {GitPullRequest} */ (tab.data);
  let text = metaText.get(pr);
  if (text === undefined) {
    const files = splitDiff(pr.diff);
    text = `${plural(files.length, 'file')} · +${files.reduce((n, f) => n + f.adds, 0)} −${files.reduce((n, f) => n + f.dels, 0)}`;
    metaText.set(pr, text);
  }
  return text;
}

/** @param {DevContext} ctx @param {string} path @param {FileTab} tab */
function draw(ctx, path, tab) {
  const pr = /** @type {GitPullRequest} */ (tab.data);
  const files = splitDiff(pr.diff);
  const viewed = viewedOf(`${pr.root}\0${pr.branch || pr.mergeBase}`);
  // A file no longer changed is no longer viewed either.
  for (const name of Object.keys(viewed)) if (!files.some((f) => f.name === name)) delete viewed[name];
  saveViewed();
  const adds = files.reduce((n, f) => n + f.adds, 0);
  const dels = files.reduce((n, f) => n + f.dels, 0);

  const progress = h('span', { class: 'pr-progress muted small' });
  const showProgress = () => (progress.textContent = `${files.filter((f) => viewed[f.name] === signature(f)).length} / ${plural(files.length, 'file')} viewed`);
  showProgress();

  const scroller = h('div', { class: 'code-view pr-main', tabindex: '0', onscroll: () => (tab.scroll = scroller.scrollTop) });
  /** @type {HTMLElement[]} */
  const listRows = [];

  const cards = files.map((f, i) => {
    const [letter, tone, label] = letterOf(f.status);
    const sig = signature(f);
    let open = viewed[f.name] !== sig && f.lines.length <= LARGE && !f.binary;
    const body = h('div', { class: 'pr-file-body' });
    let drawn = false;
    const fill = () => {
      if (drawn) return;
      drawn = true;
      if (f.binary) return body.append(h('p', { class: 'muted small ide-msg' }, 'A binary file. The view shows text changes.'));
      if (!f.lines.length) return body.append(h('p', { class: 'muted small ide-msg' }, f.status === 'R' ? 'Renamed without changes.' : 'No lines changed.'));
      const { rows, last } = diffRows(f.lines, languageOf(baseName(f.name)));
      body.append(h('div', { class: 'code diff', style: { '--gutter': `${String(last).length + 1}ch` } }, rows));
    };
    const chevron = h('span', { class: 'tree-chevron' }, icon('chevron-right'));
    const card = h('section', { class: 'pr-file', 'aria-label': f.name });
    const setOpen = (/** @type {boolean} */ value) => {
      open = value;
      if (open) fill();
      card.classList.toggle('folded', !open);
      chevron.classList.toggle('open', open);
      toggle.setAttribute('aria-expanded', String(open));
    };
    const toggle = h('button', { type: 'button', class: 'pr-file-toggle', title: 'Fold or unfold the file', onclick: () => setOpen(!open) },
      chevron,
      h('span', { class: `scm-letter ${tone}`, title: label }, letter),
      h('span', { class: 'pr-file-name' }, f.from ? [h('span', { class: 'muted' }, `${f.from} → `), f.name] : f.name));
    const check = h('input', {
      type: 'checkbox',
      checked: viewed[f.name] === sig,
      onchange: () => {
        if (check.checked) viewed[f.name] = sig;
        else delete viewed[f.name];
        saveViewed();
        listRows[i].classList.toggle('viewed', check.checked);
        showProgress();
        setOpen(!check.checked);
        // Folding a file seen from below brings its head back to the top, as GitHub does.
        if (check.checked && card.offsetTop < scroller.scrollTop) scroller.scrollTop = card.offsetTop;
      },
    });
    card.append(
      h('div', { class: 'pr-file-head' },
        toggle,
        f.binary ? h('span', { class: 'muted small' }, 'Binary') : [counts(f.adds, f.dels), squares(f.adds, f.dels)],
        f.status !== 'D' ? h('button', { type: 'button', class: 'icon-btn', title: 'Open the file', 'aria-label': `Open ${f.name}`, onclick: () => openFile(ctx, `${pr.root}/${f.name}`) }, icon('file')) : null,
        h('label', { class: 'pr-viewed small' }, check, 'Viewed')),
      body);
    setOpen(open);
    return card;
  });

  files.forEach((f, i) => {
    const [letter, tone, label] = letterOf(f.status);
    const dir = f.name.split('/').slice(0, -1).join('/');
    listRows.push(h('button', {
      type: 'button',
      class: viewed[f.name] === signature(f) ? 'tree-item pr-list-row viewed' : 'tree-item pr-list-row',
      title: `${f.from ? `${f.from} → ` : ''}${f.name} · ${label}`,
      onclick: () => {
        scroller.scrollTop = cards[i].offsetTop;
        cards[i].querySelector('button')?.focus({ preventScroll: true });
      },
    },
      h('span', { class: `scm-letter ${tone}`, 'aria-hidden': 'true' }, letter),
      h('span', { class: 'tree-name' }, baseName(f.name)),
      dir ? h('span', { class: 'scm-dir muted' }, dir) : null,
      h('span', { class: 'pr-list-check' }, icon('check'))));
  });

  const uncommitted = h('input', {
    type: 'checkbox',
    checked: !pr.committed,
    onchange: () => {
      state.committed = !uncommitted.checked;
      openPullRequest(ctx, path);
    },
  });
  const summary = h('div', { class: 'pr-summary' },
    h('div', { class: 'pr-branches' },
      h('code', { class: 'pr-branch' }, pr.base),
      h('span', { class: 'muted' }, '←'),
      h('code', { class: 'pr-branch', title: pr.branch ? '' : 'Not on a branch' }, pr.branch || pr.mergeBase.slice(0, 7))),
    h('div', { class: 'pr-stats small' },
      h('span', null, plural(pr.count, 'commit')),
      h('span', null, plural(files.length, 'file')),
      counts(adds, dels),
      squares(adds, dels)),
    h('label', { class: 'pr-toggle small', title: 'Include the changes not committed yet and new files, as the pull request will hold them once committed' },
      uncommitted, pr.committed || !pr.uncommitted ? 'Include uncommitted changes' : `Include uncommitted changes (${plural(pr.uncommitted, 'file')})`),
    pr.commits.length ? h('details', { class: 'pr-commits' },
      h('summary', { class: 'small' }, `Commits (${pr.count})`),
      pr.commits.map((c) => h('button', {
        type: 'button',
        class: 'tree-item',
        title: `${c.subject}\n${c.author} · ${new Date(c.at).toLocaleString(dateLocale())}`,
        onclick: () => openDiff(ctx, { key: `git:commit:${c.hash}`, name: c.short, title: c.subject, load: () => gitDiff(ctx.base(), { path, commit: c.hash }) }),
      }, icon('git-commit'), h('span', { class: 'tree-name' }, c.subject), h('code', { class: 'scm-dir muted' }, c.short))),
      pr.count > pr.commits.length ? h('p', { class: 'muted small' }, `${pr.count - pr.commits.length} older commits not listed.`) : null) : null,
    pr.more ? h('p', { class: 'muted small' }, `${plural(pr.more, 'new file')} not shown.`) : null);

  scroller.append(summary, ...(files.length ? cards : [h('p', { class: 'muted small ide-msg' }, `No changes against ${pr.base}.`)]));
  return h('div', { class: 'pr' },
    files.length ? h('nav', { class: 'pr-files', 'aria-label': 'Files changed' },
      h('div', { class: 'pr-files-head' }, h('span', { class: 'small' }, 'Files changed'), progress),
      h('div', { class: 'tree pr-list' }, listRows)) : null,
    scroller);
}

// Opens (or reads again) the pull request of the repository holding `path` in an editor tab.
/** @param {DevContext} ctx @param {string} path */
export function openPullRequest(ctx, path) {
  return openView(ctx, {
    key: `pr:${path}`,
    name: 'Pull request',
    title: `Pull request · ${baseName(path)}`,
    icon: 'git-pull-request',
    read: () => gitPullRequest(ctx.base(), path, state.committed),
    draw: (tab) => draw(ctx, path, tab),
    meta,
  });
}
