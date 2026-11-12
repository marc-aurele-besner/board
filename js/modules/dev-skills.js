// Dev's Skills panel: Claude Code's skills, the user's own (~/.claude/skills) then the workspace project's
// (.claude/skills in its folder and repository). A click types /<skill> into the terminal shown, so a running claude
// gets it at its prompt, and an idle terminal gets a claude command that starts with it.
import { h, icon } from '../ui.js';
import { listSkills } from '../terminal.js';
import { baseName, panelHead, panelAction, openFile } from './dev-files.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerSkills, RunnerSkill } from '../../types/terminal' */
/** @import { Child } from '../../types/ui' */

// The list is read again when the panel is drawn after this long: a skill added on disk shows on the next visit.
const STALE_MS = 30000;

/**
 * @type {{ path: string, data: RunnerSkills | null, loadError: string, loading: boolean, at: number, filter: string,
 *   folded: Set<string> }}
 */
const state = { path: '', data: null, loadError: '', loading: false, at: 0, filter: '', folded: new Set() };

// Reads the skills for the folder at `path`, unless they were read a moment ago. `force` reads them now.
/** @param {DevContext} ctx @param {string} path @param {{ force?: boolean }} [options] */
export async function refreshSkills(ctx, path, { force = false } = {}) {
  if (path !== state.path) Object.assign(state, { path, data: null, loadError: '', at: 0 });
  if (!ctx.ready() || state.loading || (!force && Date.now() - state.at < STALE_MS)) return;
  state.loading = true;
  try {
    const data = await listSkills(ctx.base(), path);
    if (path === state.path) Object.assign(state, { data, loadError: '' });
  } catch (err) {
    if (path === state.path) state.loadError = /** @type {Error} */ (err).message;
  } finally {
    state.loading = false;
    state.at = Date.now();
    ctx.refresh();
  }
}

const matches = (/** @type {RunnerSkill} */ s) => {
  const q = state.filter.trim().toLowerCase();
  return !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q);
};

/** @param {DevContext} ctx @param {RunnerSkill} s */
function row(ctx, s) {
  return h('div', { class: 'tree-row scm-row term-list-row skill-row', role: 'listitem' },
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
    }, icon('file')));
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
          ctx.refresh();
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

/** @param {DevContext} ctx @param {Child} picker @param {Child} switcher @param {string} path */
export function skillsPanel(ctx, picker, switcher, path) {
  const data = state.data;
  let body;
  if (!ctx.ready()) body = h('p', { class: 'muted small' }, 'Skills show once the runner answers.');
  else if (state.loadError) body = h('p', { class: 'small tree-error' }, state.loadError);
  else if (!data) body = h('p', { class: 'muted small' }, 'Reading the skills…');
  else {
    body = h('div', { class: 'tree scm-list' }, groups(ctx, data));
  }
  return h('aside', { class: 'card ide-explorer scm', 'aria-label': 'Skills' },
    switcher,
    panelHead('Skills', panelAction('refresh', 'Read the skills again', () => refreshSkills(ctx, path, { force: true }), !ctx.ready() || state.loading)),
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
          const list = /** @type {HTMLElement} */ (e.target).closest('aside')?.querySelector('.scm-list');
          if (list && state.data) list.replaceChildren(...groups(ctx, state.data));
        },
      })),
    body);
}
