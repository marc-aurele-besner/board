// @ts-check
// A dialog to find a folder on this machine and pick it. The browser cannot read local paths, so it asks the
// command runner (tools/terminal.js) for each folder's entries.
import { h, icon } from './ui.js';
import { openDialog } from './modal.js';
import { listFolder, runnerInfo } from './terminal.js';
/** @import { RunnerFolder } from '../types/terminal' */

// Shows paths under the home folder as ~/…, the way they are typed in the Local folder field.
const tilde = (/** @type {string} */ path, /** @type {string} */ home) => (home && (path === home || path.startsWith(`${home}/`)) ? `~${path.slice(home.length)}` : path);

const parentOf = (/** @type {string} */ path) => {
  const trimmed = path.replace(/[\\/]+$/, '');
  const cut = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  if (cut < 0) return null;
  if (cut === 0) return trimmed === '/' ? null : '/';
  return trimmed.slice(0, cut);
};

// Opens at `start` (a saved path), else ~/Documents, else the home folder. Calls onPick with the chosen path.
/**
 * @param {{ base: string, start?: string, onPick: (path: string) => void, title?: string }} options
 */
export function pickFolder({ base, start, onPick, title = 'Choose the local folder' }) {
  const state = { path: '', home: '', entries: /** @type {RunnerFolder['entries']} */ ([]), q: '', hidden: false, loading: true, error: '' };
  const crumbs = h('div', { class: 'fp-crumbs' });
  const search = h('input', { type: 'search', placeholder: 'Filter folders', 'aria-label': 'Filter folders', autocomplete: 'off', spellcheck: false });
  const hiddenBox = h('input', { type: 'checkbox' });
  const list = h('div', { class: 'fp-list', role: 'listbox', 'aria-label': 'Folders' });
  const chosen = h('code', { class: 'fp-chosen' });
  const useBtn = h('button', { type: 'button', class: 'primary', disabled: true, onclick: () => choose(state.path) }, 'Use this folder');

  const dialog = openDialog({
    title,
    body: h('div', { class: 'fp' },
      crumbs,
      h('div', { class: 'fp-toolbar' },
        search,
        h('label', { class: 'check fp-hidden small' }, hiddenBox, 'Hidden folders')),
      list,
      h('div', { class: 'fp-foot' }, chosen, useBtn)),
  });

  /** @param {string} path */
  function choose(path) {
    dialog.close();
    onPick(tilde(path, state.home));
  }

  // Crumbs start at ~ inside the home folder, else at the root.
  function paintCrumbs() {
    const { path, home } = state;
    const inHome = home && (path === home || path.startsWith(`${home}/`));
    const rootPath = inHome ? home : '/';
    const rest = path.slice(rootPath.length).split('/').filter(Boolean);
    const up = parentOf(path);
    const crumb = (/** @type {string} */ label, /** @type {string} */ target, /** @type {boolean} */ last) => h('button', { type: 'button', class: 'fp-crumb', 'aria-current': last ? 'true' : null, onclick: () => go(target) }, label);
    let acc = rootPath;
    crumbs.replaceChildren(
      h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Parent folder', title: 'Parent folder', disabled: !up, onclick: () => go(/** @type {string} */ (up)) }, icon('arrow-up')),
      crumb(inHome ? '~' : '/', rootPath, !rest.length),
      ...rest.flatMap((part, i) => {
        acc = acc.endsWith('/') ? `${acc}${part}` : `${acc}/${part}`;
        return [h('span', { class: 'muted' }, '/'), crumb(part, acc, i === rest.length - 1)];
      }));
    chosen.textContent = tilde(path, home);
    useBtn.disabled = state.loading || !!state.error;
  }

  function paintList() {
    if (state.loading) return list.replaceChildren(h('p', { class: 'muted small' }, 'Loading…'));
    if (state.error) return list.replaceChildren(h('p', { class: 'fp-error small' }, state.error));
    const q = state.q.trim().toLowerCase();
    const dirs = state.entries.filter((e) => e.dir && (state.hidden || !e.name.startsWith('.')) && (!q || e.name.toLowerCase().includes(q)));
    if (!dirs.length) return list.replaceChildren(h('p', { class: 'muted small' }, q ? 'No folder matches.' : 'No folders inside.'));
    const sep = state.path.endsWith('/') ? '' : '/';
    list.replaceChildren(...dirs.map((e) => {
      const target = `${state.path}${sep}${e.name}`;
      return h('button', {
        type: 'button',
        class: 'fp-row',
        role: 'option',
        onclick: () => go(target),
        ondblclick: () => choose(target),
      }, icon('folder'), h('span', null, e.name));
    }));
  }

  let ticket = 0;
  /** @param {string} path */
  async function go(path) {
    const mine = ++ticket;
    state.loading = true;
    state.error = '';
    useBtn.disabled = true;
    paintList();
    try {
      const res = await listFolder(base, path);
      if (mine !== ticket) return;
      Object.assign(state, { path: res.path, entries: res.entries, q: '', loading: false });
      search.value = '';
    } catch (err) {
      if (mine !== ticket) return;
      Object.assign(state, { path, entries: [], loading: false, error: /** @type {Error} */ (err).message });
    }
    paintCrumbs();
    paintList();
    search.focus();
  }

  search.addEventListener('input', () => {
    state.q = search.value;
    paintList();
  });
  search.addEventListener('keydown', (e) => {
    // Enter opens the only match, so a folder can be reached by typing alone.
    if (e.key !== 'Enter') return;
    e.preventDefault();
    /** @type {HTMLButtonElement | null} */ (list.querySelector('.fp-row'))?.click();
  });
  hiddenBox.addEventListener('change', () => {
    state.hidden = hiddenBox.checked;
    paintList();
  });

  paintList();
  (async () => {
    try {
      state.home = (await runnerInfo(base)).home ?? '';
    } catch (err) {
      Object.assign(state, { loading: false, error: /** @type {Error} */ (err).message });
      paintCrumbs();
      return paintList();
    }
    const first = start?.trim();
    if (first) {
      await go(first);
      if (!state.error) return;
    }
    await go('~/Documents');
    if (state.error) await go('~');
  })();
}
