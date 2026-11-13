// Dev's Skills panel: Claude Code's skills, the user's own (~/.claude/skills) then the workspace project's
// (.claude/skills in its folder and repository). A click types /<skill> into the terminal shown, so a running claude
// gets it at its prompt, and an idle terminal gets a claude command that starts with it.
import { h, icon } from '../ui.js';
import { listSkills } from '../terminal.js';
import { onContextMenu, copyItem } from '../menu.js';
import { baseName, panelHead, panelAction, openFile } from './dev-files.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerSkills, RunnerSkill } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */
/** @import { MenuEntry } from '../menu.js' */

// The list is read again when the panel is drawn after this long: a skill added on disk shows on the next visit.
const STALE_MS = 30000;

// `list` is the drawn list, kept across the Dev page's rebuilds (they come up to once a second) so it keeps its
// scroll and is not drawn again; `drawn` is the data it was drawn from. `loading` is the path being read.
/**
 * @type {{ path: string, data: RunnerSkills | null, json: string, loadError: string, loading: string | null, at: number,
 *   filter: string, folded: Set<string>, list: HTMLElement | null, drawn: RunnerSkills | null, top: number }}
 */
const state = { path: '', data: null, json: '', loadError: '', loading: null, at: 0, filter: '', folded: new Set(), list: null, drawn: null, top: 0 };

// Reads the skills for the folder at `path`, unless they were read a moment ago. `force` reads them now. The page
// is redrawn only when what it shows changed: a re-read that finds the same skills leaves it alone.
/** @param {DevContext} ctx @param {string} path @param {{ force?: boolean }} [options] */
export async function refreshSkills(ctx, path, { force = false } = {}) {
  if (path !== state.path) Object.assign(state, { path, data: null, json: '', loadError: '', at: 0 });
  if (!ctx.ready() || state.loading === path || (!force && Date.now() - state.at < STALE_MS)) return;
  state.loading = path;
  let changed = false;
  try {
    const data = await listSkills(ctx.base(), path);
    const json = JSON.stringify(data);
    if (path === state.path && (json !== state.json || state.loadError)) {
      Object.assign(state, { data, json, loadError: '' });
      changed = true;
    }
  } catch (err) {
    const message = /** @type {Error} */ (err).message;
    if (path === state.path && message !== state.loadError) {
      state.loadError = message;
      changed = true;
    }
  } finally {
    if (state.loading === path) state.loading = null;
    // A read for a folder no longer shown leaves the time alone, so the shown one is read at once.
    if (path === state.path) state.at = Date.now();
    if (changed || force || path !== state.path) ctx.refresh();
  }
}

const matches = (/** @type {RunnerSkill} */ s) => {
  const q = state.filter.trim().toLowerCase();
  return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
};

/** @param {DevContext} ctx @param {RunnerSkill} s @returns {MenuEntry[]} */
const skillMenu = (ctx, s) => [
  { label: 'Type in the terminal', icon: () => icon('terminal'), onSelect: () => ctx.typeInTerminal(`/${s.name} `) },
  { label: 'Open its SKILL.md', icon: () => icon('file'), onSelect: () => openFile(ctx, s.path) },
  '-',
  copyItem('Copy command', `/${s.name}`),
  copyItem('Copy path', s.path),
];

/** @param {DevContext} ctx @param {RunnerSkill} s */
function row(ctx, s) {
  return onContextMenu(h('div', { class: 'tree-row scm-row term-list-row skill-row', role: 'listitem' },
    h('button', {
      type: 'button',
      class: 'tree-item',
      title: `Type /${s.name} in the terminal\n\n${s.description}`,
      onclick: () => ctx.typeInTerminal(`/${s.name} `),
    },
      h('span', { class: 'term-list-text' },
        h('span', { class: 'tree-name' }, `/${s.name}`),
        s.description ? h('span', { class: 'term-list-sub muted' }, s.description) : null)),
    h('button', {
      type: 'button',
      class: 'tree-action',
      title: 'Open its SKILL.md',
      'aria-label': `Open the SKILL.md of ${s.name}`,
      onclick: () => openFile(ctx, s.path),
    }, icon('file'))), () => skillMenu(ctx, s));
}

/** @param {DevContext} ctx @param {string} key @param {string} title @param {RunnerSkill[]} all @param {string} empty */
function group(ctx, key, title, all, empty) {
  const open = !state.folded.has(key);
  const rows = all.filter(matches);
  return h('div', { class: 'scm-section' },
    h('div', { class: 'tree-row scm-section-head' },
      h('button', {
        type: 'button',
        class: 'tree-item',
        'aria-expanded': String(open),
        onclick: () => {
          if (open) state.folded.add(key);
          else state.folded.delete(key);
          redrawList(ctx);
        },
      }, h('span', { class: open ? 'tree-chevron open' : 'tree-chevron' }, icon('chevron-right')), h('span', { class: 'tree-name' }, title)),
      h('span', { class: 'scm-count' }, rows.length)),
    open
      ? rows.length
        ? h('div', { role: 'list' }, rows.map((s) => row(ctx, s)))
        : h('p', { class: 'muted small skill-empty' }, all.length ? 'None match the filter.' : empty)
      : null);
}

/** @param {DevContext} ctx @param {RunnerSkills} data */
const groups = (ctx, data) => [
  group(ctx, 'global', 'Your skills', data.global, 'None in ~/.claude/skills.'),
  group(ctx, 'project', `${baseName(data.root)} skills`, data.project, 'None in this project’s .claude/skills.'),
];

// The list, drawn again only when the skills changed; otherwise the one on screen is moved into the new page as it
// is, keeping its scroll.
/** @param {DevContext} ctx @param {RunnerSkills} data */
function skillList(ctx, data) {
  if (state.list && state.drawn === data) {
    // A list moved out of the page and back may lose its place: it is put back once it is on screen.
    const list = state.list;
    const top = state.top;
    requestAnimationFrame(() => {
      if (list.isConnected && list.scrollTop !== top) list.scrollTop = top;
    });
    return list;
  }
  Object.assign(state, { drawn: data, top: 0 });
  state.list = h('div', {
    class: 'tree scm-list',
    onscroll: (/** @type {Event} */ e) => (state.top = /** @type {HTMLElement} */ (e.currentTarget).scrollTop),
  }, groups(ctx, data));
  return state.list;
}

// Draws the groups again in the list on screen (a fold, the filter) without rebuilding the page.
/** @param {DevContext} ctx */
function redrawList(ctx) {
  if (state.list && state.data) state.list.replaceChildren(...groups(ctx, state.data));
}

/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher @param {string} path */
export function skillsPanel(ctx, picker, switcher, path) {
  const data = state.data;
  let body;
  if (!ctx.ready()) body = h('p', { class: 'muted small' }, 'Skills show once the runner answers.');
  else if (data) body = skillList(ctx, data);
  else if (state.loadError) body = h('p', { class: 'small tree-error' }, state.loadError);
  else body = h('p', { class: 'muted small' }, 'Reading the skills…');
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Skills' },
    switcher,
    panelHead('Skills', panelAction('refresh', 'Read the skills again', () => refreshSkills(ctx, path, { force: true }), !ctx.ready() || state.loading === path)),
    h('div', { class: 'ide-explorer-head' }, picker),
    h('label', { class: 'search-field' },
      h('input', {
        type: 'text',
        name: 'skill-filter',
        value: state.filter,
        placeholder: 'Filter skills',
        'aria-label': 'Filter skills',
        spellcheck: false,
        autocomplete: 'off',
        oninput: (/** @type {Event} */ e) => {
          state.filter = /** @type {HTMLInputElement} */ (e.target).value;
          // Only the list changes, so the field keeps its focus.
          redrawList(ctx);
        },
      })),
    // A failed re-read keeps the skills read before, with the error above them.
    data && state.loadError ? h('p', { class: 'small tree-error' }, state.loadError) : null,
    body);
}
