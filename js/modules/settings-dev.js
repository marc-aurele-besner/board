// Settings → Dev environment: the AI providers and the coding harness each runs on, the harnesses, command presets,
// then each project's folder and the command its tasks go to Dev with. Commands are edited in colour, with the
// variables they take as chips and a Preview of what a task runs.
import { h, icon, notice, uid } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { pickFolder } from '../folder-picker.js';
import { commandField, codeLine } from '../command-field.js';
import { projectIcon, projectTree, cleanLocalPath, LOCAL_PATH_ERROR } from './projects.js';
import { DEFAULT_DEV_COMMAND, devPresets, runnerOf } from './dev.js';
import { CLAUDE_PROVIDER, DEFAULT_PROVIDERS, DEFAULT_HARNESSES, DEV_MODEL_NAMES, devProviders, devHarnesses, devTemplate, harnessOf, splitEnv, brandOf } from '../dev-core.js';
/** @import { Store, DevPreset, DevProvider, DevHarness, Project } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @import { IconName } from '../ui.js' */

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


// A provider's, harness's or preset's logo, by the brand it names; `fallback` for another.
/** @param {string} brand @param {IconName} fallback */
const logo = (brand, fallback) => h('span', { class: `dev-logo${brand ? ` is-${brand}` : ''}` }, icon(/** @type {IconName} */ (brand || fallback)));

// The variables a Dev command can place itself, offered as chips under it.
/** @type {[string, string][]} */
const COMMAND_VARS = [
  ['model', 'The model the task picked. Without one, the variable goes, with the flag just before it.'],
  ['effort', 'The effort the task picked. Without one, the variable goes, with the flag just before it.'],
  ['prompt', 'The task, as the prompt. Without it in the command, the harness’s prompt flag hands it over.'],
];
const EXAMPLE_PROMPT = 'Fix the login bug';

// A card's head: logo, name with a line under it, the controls on the right.
/** @param {Child} mark @param {Child} name @param {Child} meta @param {...Child} controls */
const cardHead = (mark, name, meta, ...controls) => h('div', { class: 'dev-card-head' },
  mark,
  h('div', { class: 'dev-card-title' }, name, h('span', { class: 'muted small' }, meta)),
  h('div', { class: 'dev-card-tools' }, ...controls));

/** @param {string} title @param {() => void} onclick @param {string} label */
const removeButton = (title, onclick, label) => h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': label, onclick }, icon('trash'));

/** @param {string} title @param {string} about @param {...Child} body */
const panel = (title, about, ...body) => h('section', { class: 'card panel' },
  h('header', { class: 'panel-head' },
    h('div', null, h('h2', null, title), h('p', { class: 'muted' }, about))),
  ...body);

/** @param {Store} store @param {DevPreset[]} presets @param {Project[]} projects @param {DevHarness[]} harnesses */
function presetsPanel(store, presets, projects, harnesses) {
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
  return panel('Command presets', 'Commands you use for several projects. Pick one for a project below; editing a preset changes it for every project that uses it.',
    h('ul', { class: 'dev-cards' },
      presets.length
        ? presets.map((preset) => {
            const users = projects.filter((p) => p.devPreset === preset.id).length;
            const harness = harnessOf(harnesses, preset.command);
            return h('li', { class: 'dev-card' },
              cardHead(
                logo(brandOf(harness?.name ?? '', preset.command), 'terminal'),
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
                `${harness ? harness.name : 'Other program'} · ${users ? `used by ${plural(users, 'project')}` : 'not used yet'}`,
                removeButton(users ? `Remove this preset. Its ${plural(users, 'project')} keep the command as their own.` : 'Remove this preset',
                  () => removePreset(store, preset), `Remove the preset ${preset.name}`)),
              commandField({
                key: `preset-${preset.id}`,
                label: 'Command',
                value: preset.command,
                placeholder: DEFAULT_DEV_COMMAND,
                vars: COMMAND_VARS,
                preview: (v) => devTemplate(harnesses, v),
                examples: { model: 'opus', effort: 'high', prompt: EXAMPLE_PROMPT },
                previewHint: 'What a task with a model and effort picked runs.',
                onSave: (command) => {
                  if (!command) return fail(store, 'A preset needs a command.');
                  updatePreset(store, preset.id, { command });
                },
              }));
          })
        : h('li', { class: 'empty' }, 'No preset yet.')),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as Claude in a worktree', 'aria-label': 'Preset name', autocomplete: 'off' }),
      h('input', { name: 'command', placeholder: DEFAULT_DEV_COMMAND, 'aria-label': 'Preset command', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add preset')));
}

// The providers as saved; the first change saves the built-in ones with it.
/** @param {Store} store @param {(providers: DevProvider[]) => void} mutate */
function updateProviders(store, mutate) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    d.providers ??= DEFAULT_PROVIDERS.map((p) => ({ ...p, models: [...p.models] }));
    mutate(d.providers);
  });
}

// "opus, sonnet" or one per line, as a list without blanks or repeats.
const parseModels = (/** @type {string} */ text) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** @param {string} text */
const modelPills = (text) => h('span', { class: 'dev-models' }, parseModels(text).map((m) => h('span', { class: 'dev-model' }, DEV_MODEL_NAMES[m] ?? m)));

/** @param {DevHarness[]} harnesses */
const harnessOptions = (harnesses) => harnesses.map((x) => ({ value: x.id, label: x.name, plainIcon: () => logo(brandOf(x.name, x.command), 'terminal') }));

// Tasks that picked a removed provider's model go back to their project's command (taskProvider skips it).
/** @param {Store} store @param {DevProvider[]} providers @param {DevHarness[]} harnesses */
function providersPanel(store, providers, harnesses) {
  /** @param {string} id @param {Partial<DevProvider>} patch */
  const patch = (id, patch) => updateProviders(store, (list) => {
    const p = list.find((x) => x.id === id);
    if (p) Object.assign(p, patch);
  });
  const add = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: { name: HTMLInputElement, harness: HTMLSelectElement, env: HTMLInputElement, models: HTMLInputElement } }} */ (e.currentTarget);
    const name = form.elements.name.value.trim();
    const harness = harnesses.find((x) => x.id === form.elements.harness.value);
    const command = [form.elements.env.value.trim(), harness?.command.trim() ?? ''].filter(Boolean).join(' ');
    const models = parseModels(form.elements.models.value);
    if (!name || !harness || !models.length) return fail(store, 'A provider needs a name, a harness and at least one model.');
    if (providers.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(store, `A provider named "${name}" already exists.`);
    updateProviders(store, (list) => { list.push({ id: uid(), name, command, models }); });
  };
  return panel('AI providers',
    'The models a task’s right-click menu offers, by provider, and the harness each runs on. Claude’s command runs for projects without their own; picking another provider’s model runs that provider’s command instead of the project’s. MiniMax runs Claude Code with its API in place of Anthropic’s, with the key from MINIMAX_API_KEY in the runner’s environment. Picking a harness keeps the variables at the start of the command and replaces the rest.',
    h('ul', { class: 'dev-cards' },
      providers.map((provider) => {
        const harness = harnessOf(harnesses, provider.command);
        return h('li', { class: 'dev-card' },
          cardHead(
            logo(brandOf(provider.name, provider.id, provider.command), 'cpu'),
            editText({
              value: provider.name,
              placeholder: 'Name',
              onSave: (name) => {
                const clean = name.trim();
                if (!clean) return fail(store, 'A provider needs a name.');
                if (providers.some((x) => x.id !== provider.id && x.name.toLowerCase() === clean.toLowerCase())) return fail(store, `A provider named "${clean}" already exists.`);
                patch(provider.id, { name: clean });
              },
            }),
            provider.id === CLAUDE_PROVIDER ? 'Default' : plural(provider.models.length, 'model'),
            h('span', { class: 'dev-runs-on muted small' }, 'Runs on'),
            pickChip({
              value: harness?.id ?? null,
              options: harnessOptions(harnesses),
              placeholder: 'Other program',
              className: 'field-pick dev-harness-pick',
              onPick: (id) => {
                const next = harnesses.find((x) => x.id === id);
                if (next) patch(provider.id, { command: [splitEnv(provider.command).env, next.command.trim()].filter(Boolean).join(' ') });
              },
            }),
            provider.id === CLAUDE_PROVIDER
              ? null
              : removeButton('Remove this provider. Tasks that picked its models go back to their project’s command.',
                  () => updateProviders(store, (list) => list.splice(list.findIndex((x) => x.id === provider.id), 1)), `Remove the provider ${provider.name}`)),
          commandField({
            key: `provider-${provider.id}`,
            label: 'Command',
            value: provider.command,
            placeholder: DEFAULT_DEV_COMMAND,
            vars: COMMAND_VARS,
            preview: (v) => devTemplate(harnesses, v),
            examples: { model: provider.models[0] ?? '', effort: 'high', prompt: EXAMPLE_PROMPT },
            previewHint: `What a task runs with ${provider.models[0] ?? 'a model'} and high effort picked.`,
            onSave: (command) => {
              if (!command) return fail(store, 'A provider needs a command.');
              patch(provider.id, { command });
            },
          }),
          h('div', { class: 'cmd-field' },
            h('span', { class: 'dev-env-label small' }, 'Models'),
            editText({
              value: provider.models.join(', '),
              placeholder: 'model-a, model-b',
              display: modelPills,
              onSave: (text) => {
                const models = parseModels(text);
                if (!models.length) return fail(store, 'A provider needs at least one model.');
                patch(provider.id, { models });
              },
            })));
      })),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as MiniMax', 'aria-label': 'Provider name', autocomplete: 'off' }),
      h('select', { name: 'harness', 'aria-label': 'Provider harness' }, harnesses.map((x) => h('option', { value: x.id }, x.name))),
      h('input', { name: 'env', class: 'dev-env-command', placeholder: 'Variables, such as ANTHROPIC_BASE_URL=…', 'aria-label': 'Variables set before the harness command', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'models', placeholder: 'Models, comma separated', 'aria-label': 'Provider models', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add provider')));
}

// The harnesses as saved; the first change saves the built-in ones with it.
/** @param {Store} store @param {(harnesses: DevHarness[]) => void} mutate */
function updateHarnesses(store, mutate) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    d.harnesses ??= DEFAULT_HARNESSES.map((x) => ({ ...x }));
    mutate(d.harnesses);
  });
}

// The flags a harness takes, each a template with its value's variable.
/** @type {['model' | 'effort' | 'prompt', string, string, string][]} */
const HARNESS_FLAGS = [
  ['model', 'Model flag', '--model {{model}}', 'The model the task picked, quoted'],
  ['effort', 'Effort flag', 'No flag', 'The effort the task picked, quoted'],
  ['prompt', 'Prompt', '-- {{prompt}}', 'The task, as the prompt, quoted'],
];

// Providers and commands that run a removed harness's program are left as they are, run without its flags.
/** @param {Store} store @param {DevHarness[]} harnesses @param {DevProvider[]} providers */
function harnessesPanel(store, harnesses, providers) {
  /** @param {string} id @param {Partial<DevHarness>} patch */
  const patch = (id, patch) => updateHarnesses(store, (list) => {
    const x = list.find((y) => y.id === id);
    if (x) Object.assign(x, patch);
  });
  const add = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: { name: HTMLInputElement, command: HTMLInputElement, model: HTMLInputElement, prompt: HTMLInputElement } }} */ (e.currentTarget);
    const name = form.elements.name.value.trim();
    const command = form.elements.command.value.trim();
    if (!name || !command) return fail(store, 'A harness needs a name and a command.');
    if (harnesses.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(store, `A harness named "${name}" already exists.`);
    const program = harnessOf(harnesses, command);
    if (program) return fail(store, `${program.name} already runs this program.`);
    updateHarnesses(store, (list) => {
      list.push({ id: uid(), name, command, model: form.elements.model.value.trim(), effort: '', prompt: form.elements.prompt.value.trim() || '-- {{prompt}}' });
    });
  };
  return panel('Coding harnesses',
    'The coding agents a Dev session can run. A command runs the harness that starts with the same program, so a task’s model, effort and prompt reach it the way it takes them. Leave a flag empty when the harness has none. Status, done signal and usage are read for Claude Code only.',
    h('ul', { class: 'dev-cards' },
      harnesses.map((harness) => {
        const users = providers.filter((p) => harnessOf(harnesses, p.command)?.id === harness.id);
        return h('li', { class: 'dev-card' },
          cardHead(
            logo(brandOf(harness.name, harness.command), 'terminal'),
            editText({
              value: harness.name,
              placeholder: 'Name',
              onSave: (name) => {
                const clean = name.trim();
                if (!clean) return fail(store, 'A harness needs a name.');
                if (harnesses.some((x) => x.id !== harness.id && x.name.toLowerCase() === clean.toLowerCase())) return fail(store, `A harness named "${clean}" already exists.`);
                patch(harness.id, { name: clean });
              },
            }),
            users.length ? `Runs ${users.map((p) => p.name).join(', ')}` : 'No provider yet',
            harness.id === CLAUDE_PROVIDER
              ? null
              : removeButton('Remove this harness. Providers that run its program keep their command, without its flags.',
                  () => updateHarnesses(store, (list) => list.splice(list.findIndex((x) => x.id === harness.id), 1)), `Remove the harness ${harness.name}`)),
          commandField({
            key: `harness-${harness.id}`,
            label: 'Command',
            value: harness.command,
            placeholder: 'program --flags',
            preview: (v) => devTemplate([{ ...harness, command: v }], v),
            examples: { model: harness.id === CLAUDE_PROVIDER ? 'opus' : 'model-name', effort: 'high', prompt: EXAMPLE_PROMPT },
            previewHint: 'What a task with a model and effort picked runs.',
            onSave: (command) => {
              if (!command) return fail(store, 'A harness needs a command.');
              const other = harnessOf(harnesses.filter((x) => x.id !== harness.id), command);
              if (other) return fail(store, `${other.name} already runs this program.`);
              patch(harness.id, { command });
            },
          }),
          h('div', { class: 'dev-flag-grid' },
            HARNESS_FLAGS.map(([field, label, placeholder, about]) => commandField({
              key: `harness-${harness.id}-${field}`,
              label,
              value: (harness[field] ?? '').replace(/\{\{?(\w+)\}\}?/g, '{{$1}}'),
              placeholder,
              vars: [[field, about]],
              onSave: (text) => patch(harness.id, { [field]: text }),
            }))));
      })),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as Qwen Code', 'aria-label': 'Harness name', autocomplete: 'off' }),
      h('input', { name: 'command', placeholder: 'qwen --yolo', 'aria-label': 'Harness command', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'model', class: 'dev-env-command', placeholder: '--model {{model}}', 'aria-label': 'Harness model flag', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'prompt', class: 'dev-env-command', placeholder: '-- {{prompt}}', 'aria-label': 'How the harness takes its prompt', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add harness')));
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
        ? codeLine(preset.command, 'dev-env-preview')
        : editText({
            value: p.devCommand ?? '',
            placeholder: DEFAULT_DEV_COMMAND,
            allowEmpty: true,
            className: 'dev-env-command',
            display: (v) => codeLine(v),
            onSave: (devCommand) => updateProject(store, p.id, { devCommand: devCommand.trim() }),
          })));
}

/** @param {Store} store */
export function devEnvironmentCard(store) {
  const presets = devPresets(store);
  const harnesses = devHarnesses(store);
  const providers = devProviders(store);
  const { projects } = store.get('projects');
  return h('div', { class: 'stack-lg' },
    devEnvView.error ? notice({ text: devEnvView.error }) : null,
    providersPanel(store, providers, harnesses),
    harnessesPanel(store, harnesses, providers),
    presetsPanel(store, presets, projects, harnesses),
    panel('Projects', 'Where each project’s terminals open, and the command a task’s Dev button runs with the task as its prompt. An empty command uses the default.',
      h('ul', { class: 'dev-env-list' },
        projects.length
          ? projectTree(projects).map(({ project, depth }) => projectRow(store, project, depth, presets))
          : h('li', { class: 'empty' }, 'No project yet. Create one in ', h('a', { href: '#/projects' }, 'Projects'), '.'))));
}
