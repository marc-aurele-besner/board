// @ts-check
// Settings → Dev environment: command presets, then each project's folder and the command its tasks go to Dev
// with. The same fields as a project's page, in one list, so a preset is picked instead of pasting a command again.
import { h, icon, notice, uid } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { pickFolder } from '../folder-picker.js';
import { projectIcon, projectTree, cleanLocalPath, LOCAL_PATH_ERROR } from './projects.js';
import { DEFAULT_DEV_COMMAND, devPresets, runnerOf } from './dev.js';
/** @import { Store, DevPreset, Project } from '../../types/data' */

// The last problem shown above the cards.
const devEnvView = { error: '' };

const fail = (/** @type {Store} */ store, /** @type {string} */ message) => {
  devEnvView.error = message;
  store.refresh();
};

const plural = (/** @type {number} */ n, /** @type {string} */ one) => `${n} ${one}${n === 1 ? '' : 's'}`;

/** @param {Store} store @param {string} id @param {Partial<DevPreset>} patch */
function updatePreset(store, id, patch) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    const preset = (d.presets ??= []).find((x) => x.id === id);
    if (preset) Object.assign(preset, patch);
  });
}

// The projects that used the preset keep running its command, now as their own.
/** @param {Store} store @param {DevPreset} preset */
function removePreset(store, preset) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    d.presets = (d.presets ?? []).filter((x) => x.id !== preset.id);
  });
  store.update('projects', (d) => {
    for (const p of d.projects) {
      if (p.devPreset === preset.id) Object.assign(p, { devPreset: '', devCommand: preset.command });
    }
  });
}

/** @param {Store} store @param {string} id @param {Partial<Project>} patch */
function updateProject(store, id, patch) {
  if (patch.localPath !== undefined) {
    const localPath = cleanLocalPath(patch.localPath);
    if (localPath === null) return fail(store, LOCAL_PATH_ERROR);
    patch = { ...patch, localPath };
  }
  devEnvView.error = '';
  store.update('projects', (d) => {
    const p = d.projects.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  });
}

/** @param {Store} store @param {DevPreset[]} presets @param {Project[]} projects */
function presetsPanel(store, presets, projects) {
  const add = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    // The form below, with its two fields.
    const form = /** @type {HTMLFormElement & { elements: { name: HTMLInputElement, command: HTMLInputElement } }} */ (e.currentTarget);
    const name = form.elements.name.value.trim();
    const command = form.elements.command.value.trim();
    if (!name || !command) return fail(store, 'A preset needs a name and a command.');
    if (presets.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(store, `A preset named "${name}" already exists.`);
    devEnvView.error = '';
    store.update('dev', (d) => {
      (d.presets ??= []).push({ id: uid(), name, command });
    });
  };
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Command presets'),
        h('p', { class: 'muted' }, 'Commands you use for several projects. Pick one for a project below; editing a preset changes it for every project that uses it.'))),
    h('ul', { class: 'dev-env-list' },
      presets.length
        ? presets.map((preset) => {
            const users = projects.filter((p) => p.devPreset === preset.id).length;
            return h('li', { class: 'dev-env-row dev-preset-row' },
              h('div', { class: 'dev-env-name' },
                editText({
                  value: preset.name,
                  placeholder: 'Name',
                  onSave: (name) => {
                    const clean = name.trim();
                    if (!clean) return fail(store, 'A preset needs a name.');
                    if (presets.some((x) => x.id !== preset.id && x.name.toLowerCase() === clean.toLowerCase())) return fail(store, `A preset named "${clean}" already exists.`);
                    updatePreset(store, preset.id, { name: clean });
                  },
                }),
                h('span', { class: 'muted small' }, users ? `Used by ${plural(users, 'project')}` : 'Not used yet')),
              editText({
                value: preset.command,
                placeholder: DEFAULT_DEV_COMMAND,
                className: 'dev-env-command',
                onSave: (command) => {
                  const clean = command.trim();
                  if (!clean) return fail(store, 'A preset needs a command.');
                  updatePreset(store, preset.id, { command: clean });
                },
              }),
              h('button', {
                type: 'button',
                class: 'icon-btn',
                title: users ? `Remove this preset. Its ${plural(users, 'project')} keep the command as their own.` : 'Remove this preset',
                'aria-label': `Remove the preset ${preset.name}`,
                onclick: () => removePreset(store, preset),
              }, icon('trash')));
          })
        : h('li', { class: 'empty' }, 'No preset yet.')),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as Claude in a worktree', 'aria-label': 'Preset name', autocomplete: 'off' }),
      h('input', { name: 'command', placeholder: DEFAULT_DEV_COMMAND, 'aria-label': 'Preset command', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add preset')));
}

/** @param {Store} store @param {Project} p @param {number} depth @param {DevPreset[]} presets */
function projectRow(store, p, depth, presets) {
  const presetOptions = presets.map((x) => ({ value: x.id, label: x.name }));
  const preset = presets.find((x) => x.id === p.devPreset);
  return h('li', { class: 'dev-env-row dev-project-row' },
    h('div', { class: 'dev-env-name', style: depth ? { paddingLeft: `${depth * 16}px` } : null },
      projectIcon(p),
      h('a', { href: `#/projects?project=${p.id}` }, h('strong', null, p.name))),
    h('div', { class: 'dev-env-field' },
      h('span', { class: 'dev-env-label small' }, 'Folder'),
      h('div', { class: 'pp-icon-row' },
        editText({
          value: p.localPath ?? '',
          placeholder: '~/code/my-app',
          allowEmpty: true,
          onSave: (localPath) => updateProject(store, p.id, { localPath }),
        }),
        h('button', {
          type: 'button',
          class: 'btn-small',
          title: 'Find the folder on this machine',
          onclick: () => pickFolder({ base: runnerOf(store), start: p.localPath, onPick: (localPath) => updateProject(store, p.id, { localPath }) }),
        }, icon('folder'), 'Browse'))),
    h('div', { class: 'dev-env-field' },
      h('span', { class: 'dev-env-label small' }, 'Command'),
      presets.length
        ? pickChip({
            value: preset ? preset.id : null,
            options: presetOptions,
            nullable: true,
            nullLabel: 'Own command',
            onPick: (devPreset) => updateProject(store, p.id, { devPreset: devPreset ?? '' }),
          })
        : null,
      preset
        ? h('code', { class: 'dev-env-preview muted small' }, preset.command)
        : editText({
            value: p.devCommand ?? '',
            placeholder: DEFAULT_DEV_COMMAND,
            allowEmpty: true,
            className: 'dev-env-command',
            onSave: (devCommand) => updateProject(store, p.id, { devCommand: devCommand.trim() }),
          })));
}

/** @param {Store} store */
export function devEnvironmentCard(store) {
  const presets = devPresets(store);
  const { projects } = store.get('projects');
  return h('div', { class: 'stack-lg' },
    devEnvView.error ? notice({ text: devEnvView.error }) : null,
    presetsPanel(store, presets, projects),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Projects'),
          h('p', { class: 'muted' }, 'Where each project’s terminals open, and the command a task’s Dev button runs with the task as its prompt. An empty command uses the default.'))),
      h('ul', { class: 'dev-env-list' },
        projects.length
          ? projectTree(projects).map(({ project, depth }) => projectRow(store, project, depth, presets))
          : h('li', { class: 'empty' }, 'No project yet. Create one in ', h('a', { href: '#/projects' }, 'Projects'), '.'))));
}
