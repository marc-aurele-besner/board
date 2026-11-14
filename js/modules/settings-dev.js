// Settings → Dev environment, in the order things are chosen: the agents (a coding harness, the connection to a
// provider, the models a task can pick), then each project's folder and agent, then, out of the way, the harnesses
// themselves. Commands are edited in colour, with the variables they take as chips and a Preview of what a task runs.
import { h, icon, notice, uid } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { pickFolder } from '../folder-picker.js';
import { commandField } from '../command-field.js';
import { projectIcon, projectTree, cleanLocalPath, LOCAL_PATH_ERROR } from './projects.js';
import { DEFAULT_DEV_COMMAND, runnerOf } from './dev.js';
import { agentLogo, brandLogo, projectAgentField, COMMAND_VARS, EXAMPLE_PROMPT } from './dev-agent-field.js';
import {
  CLAUDE_PROVIDER, DEFAULT_HARNESSES, DEV_MODEL_NAMES, agentsOf, defaultAgent, devAgents, devHarnesses, devTemplate,
  harnessOf, splitEnv, brandOf,
} from '../dev-core.js';
/** @import { Store, DevProvider, DevHarness, Project } from '../../types/data' */
/** @import { Child } from '../../types/ui' */

// The last problem shown above the cards, and whether the harnesses are unfolded.
const devEnvView = { error: '', harnesses: false };

const fail = (/** @type {Store} */ store, /** @type {string} */ message) => {
  devEnvView.error = message;
  store.refresh();
};

const plural = (/** @type {number} */ n, /** @type {string} */ one) => `${n} ${one}${n === 1 ? '' : 's'}`;

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

// A card's head: logo, name with a line under it, the controls on the right.
/** @param {Child} mark @param {Child} name @param {Child} meta @param {...Child} controls */
const cardHead = (mark, name, meta, ...controls) => h('div', { class: 'dev-card-head' },
  mark,
  h('div', { class: 'dev-card-title' }, name, h('span', { class: 'muted small' }, meta)),
  h('div', { class: 'dev-card-tools' }, ...controls));

/** @param {string} title @param {() => void} onclick @param {string} label */
const removeButton = (title, onclick, label) => h('button', { type: 'button', class: 'icon-btn', title, 'aria-label': label, onclick }, icon('trash'));

/** @param {string} title @param {Child} about @param {...Child} body */
const panel = (title, about, ...body) => h('section', { class: 'card panel' },
  h('header', { class: 'panel-head' },
    h('div', null, h('h2', null, title), h('p', { class: 'muted' }, about))),
  ...body);

// How the pieces fit, above them: what a task's Dev button runs.
/** @param {Store} store */
function howItWorks(store) {
  const step = (/** @type {string} */ n, /** @type {string} */ title, /** @type {Child} */ text) =>
    h('li', null, h('span', { class: 'dev-how-n' }, n), h('div', null, h('strong', null, title), h('span', { class: 'muted small' }, text)));
  return h('ol', { class: 'dev-how' },
    step('1', 'Agents', 'A coding harness (Claude Code, Codex…), connected to a provider, with the models you can pick.'),
    step('2', 'Projects', `Each runs its agent in its folder; ${defaultAgent(store).name} unless you pick another.`),
    step('3', 'Tasks', 'The Dev button runs the project’s agent. Right-click it to pick another agent’s model for that task.'));
}

// The agents as saved; the first change saves the built-in ones, and the presets saved before agents, with it.
/** @param {Store} store @param {(agents: DevProvider[]) => void} mutate */
function updateAgents(store, mutate) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    d.providers = agentsOf(d).map((a) => ({ ...a, models: [...a.models] }));
    d.presets = [];
    mutate(d.providers);
  });
}

// "opus, sonnet" or one per line, as a list without blanks or repeats.
const parseModels = (/** @type {string} */ text) => [...new Set(text.split(/[\s,]+/).filter(Boolean))];

/** @param {string} text */
const modelPills = (text) => h('span', { class: 'dev-models' }, parseModels(text).map((m) =>
  h('span', { class: 'dev-model', title: DEV_MODEL_NAMES[m] ? `Runs as ${m}` : m }, h('code', null, m), DEV_MODEL_NAMES[m] ? h('span', { class: 'muted' }, DEV_MODEL_NAMES[m]) : null)));

/** @param {DevHarness[]} harnesses */
const harnessOptions = (harnesses) => harnesses.map((x) => ({ value: x.id, label: x.name, plainIcon: () => brandLogo(brandOf(x.name, x.command), 'terminal') }));

// Projects that ran a removed agent keep its command as their own; tasks that picked it go back to their project's.
/** @param {Store} store @param {DevProvider[]} agents @param {DevHarness[]} harnesses @param {Project[]} projects */
function agentsPanel(store, agents, harnesses, projects) {
  const fallback = defaultAgent(store);
  /** @param {string} id @param {Partial<DevProvider>} patch */
  const patch = (id, patch) => updateAgents(store, (list) => {
    const a = list.find((x) => x.id === id);
    if (a) Object.assign(a, patch);
  });
  /** @param {DevProvider} agent */
  const remove = (agent) => {
    updateAgents(store, (list) => { list.splice(list.findIndex((x) => x.id === agent.id), 1); });
    store.update('projects', (d) => {
      for (const p of d.projects) if (p.devPreset === agent.id) Object.assign(p, { devPreset: '', devCommand: agent.command });
    });
  };
  const add = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement & { elements: { name: HTMLInputElement, harness: HTMLSelectElement, env: HTMLInputElement, models: HTMLInputElement } }} */ (e.currentTarget);
    const name = form.elements.name.value.trim();
    const harness = harnesses.find((x) => x.id === form.elements.harness.value);
    const command = [form.elements.env.value.trim(), harness?.command.trim() ?? ''].filter(Boolean).join(' ');
    if (!name || !harness) return fail(store, 'An agent needs a name and a harness.');
    if (agents.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(store, `An agent named "${name}" already exists.`);
    updateAgents(store, (list) => { list.push({ id: uid(), name, command, models: parseModels(form.elements.models.value) }); });
  };
  return panel('Agents',
    'What a task can run. Pick the harness it runs on; put the variables that connect it to a provider (an API address, a key from the runner’s environment) at the start of its command. MiniMax runs Claude Code with MiniMax’s API, with the key from MINIMAX_API_KEY.',
    h('ul', { class: 'dev-cards' },
      agents.map((agent) => {
        const harness = harnessOf(harnesses, agent.command);
        const isDefault = agent.id === fallback.id;
        const users = projects.filter((p) => p.devPreset === agent.id || (isDefault && !p.devPreset && !p.devCommand?.trim())).length;
        return h('li', { class: `dev-card${isDefault ? ' is-default' : ''}` },
          cardHead(
            agentLogo(store, agent),
            editText({
              value: agent.name,
              placeholder: 'Name',
              onSave: (name) => {
                const clean = name.trim();
                if (!clean) return fail(store, 'An agent needs a name.');
                if (agents.some((x) => x.id !== agent.id && x.name.toLowerCase() === clean.toLowerCase())) return fail(store, `An agent named "${clean}" already exists.`);
                patch(agent.id, { name: clean });
              },
            }),
            [
              agent.models.length ? plural(agent.models.length, 'model') : 'Harness’s default model',
              users ? plural(users, 'project') : 'no project',
            ].join(' · '),
            isDefault
              ? h('span', { class: 'dev-default-badge', title: 'Projects that pick no agent run this one' }, 'Default')
              : h('button', {
                  type: 'button',
                  class: 'btn-small',
                  title: 'Projects that pick no agent will run this one',
                  onclick: () => store.update('dev', (d) => { d.defaultAgent = agent.id; }),
                }, 'Make default'),
            h('span', { class: 'dev-runs-on muted small' }, 'Runs on'),
            pickChip({
              value: harness?.id ?? null,
              options: harnessOptions(harnesses),
              placeholder: 'Another program',
              className: 'field-pick dev-harness-pick',
              onPick: (id) => {
                const next = harnesses.find((x) => x.id === id);
                if (next) patch(agent.id, { command: [splitEnv(agent.command).env, next.command.trim()].filter(Boolean).join(' ') });
              },
            }),
            isDefault
              ? null
              : removeButton('Remove this agent. Projects that run it keep its command as their own; tasks that picked it go back to their project’s.',
                  () => remove(agent), `Remove the agent ${agent.name}`)),
          commandField({
            key: `agent-${agent.id}`,
            label: 'Command',
            value: agent.command,
            placeholder: DEFAULT_DEV_COMMAND,
            vars: COMMAND_VARS,
            preview: (v) => devTemplate(harnesses, v),
            examples: { model: agent.models[0] ?? '', effort: 'high', prompt: EXAMPLE_PROMPT },
            previewHint: agent.models.length
              ? `What a task runs with ${agent.models[0]} and high effort picked (examples; each task passes its own).`
              : 'What a task runs with high effort picked (an example; each task passes its own).',
            onSave: (command) => {
              if (!command) return fail(store, 'An agent needs a command.');
              patch(agent.id, { command });
            },
          }),
          h('div', { class: 'cmd-field' },
            h('span', { class: 'dev-env-label small' }, 'Models in a task’s menu'),
            editText({
              value: agent.models.join(', '),
              placeholder: 'None: the harness picks the model',
              allowEmpty: true,
              display: modelPills,
              onSave: (text) => patch(agent.id, { models: parseModels(text) }),
            })));
      })),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as Codex', 'aria-label': 'Agent name', autocomplete: 'off' }),
      h('select', { name: 'harness', 'aria-label': 'Harness the agent runs on' }, harnesses.map((x) => h('option', { value: x.id }, x.name))),
      h('input', { name: 'env', class: 'dev-env-command', placeholder: 'Connection variables (optional)', 'aria-label': 'Variables set before the harness command', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'models', placeholder: 'Models, comma separated (optional)', 'aria-label': 'Agent models', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add agent')));
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

// Agents and commands that run a removed harness's program are left as they are, run without its flags.
/** @param {Store} store @param {DevHarness[]} harnesses @param {DevProvider[]} agents */
function harnessesPanel(store, harnesses, agents) {
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
  const open = devEnvView.harnesses;
  return h('section', { class: 'card panel' },
    h('button', {
      type: 'button',
      class: 'dev-fold',
      'aria-expanded': String(open),
      onclick: () => { devEnvView.harnesses = !open; store.refresh(); },
    },
      icon(open ? 'chevron-down' : 'chevron-right'),
      h('div', null,
        h('h2', null, 'Advanced: coding harnesses'),
        h('p', { class: 'muted' }, `How each program takes a task’s model, effort and prompt: ${harnesses.map((x) => x.name).join(', ')}. An agent runs the harness its command starts with. Status, done signal and usage are read for Claude Code only.`))),
    open
      ? [
          h('ul', { class: 'dev-cards' },
            harnesses.map((harness) => {
              const users = agents.filter((a) => harnessOf(harnesses, a.command)?.id === harness.id);
              return h('li', { class: 'dev-card' },
                cardHead(
                  brandLogo(brandOf(harness.name, harness.command), 'terminal'),
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
                  users.length ? `Runs ${users.map((a) => a.name).join(', ')}` : 'No agent yet',
                  harness.id === CLAUDE_PROVIDER
                    ? null
                    : removeButton('Remove this harness. Agents that run its program keep their command, without its flags.',
                        () => updateHarnesses(store, (list) => { list.splice(list.findIndex((x) => x.id === harness.id), 1); }), `Remove the harness ${harness.name}`)),
                commandField({
                  key: `harness-${harness.id}`,
                  label: 'Command',
                  value: harness.command,
                  placeholder: 'program --flags',
                  preview: (v) => devTemplate([{ ...harness, command: v }], v),
                  examples: { model: harness.id === CLAUDE_PROVIDER ? 'opus' : 'model-name', effort: 'high', prompt: EXAMPLE_PROMPT },
                  previewHint: 'What a task with a model and effort picked runs (examples).',
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
            h('button', { type: 'submit' }, icon('plus'), 'Add harness')),
        ]
      : null);
}

/** @param {Store} store @param {Project} p @param {number} depth */
function projectRow(store, p, depth) {
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
      h('span', { class: 'dev-env-label small' }, 'Agent'),
      projectAgentField(store, p, (patch) => updateProject(store, p.id, patch))));
}

/** @param {Store} store */
export function devEnvironmentCard(store) {
  const agents = devAgents(store);
  const harnesses = devHarnesses(store);
  const { projects } = store.get('projects');
  return h('div', { class: 'stack-lg' },
    howItWorks(store),
    devEnvView.error ? notice({ text: devEnvView.error }) : null,
    agentsPanel(store, agents, harnesses, projects),
    panel('Projects', 'Where each project’s terminals open, and the agent its tasks run with the task as the prompt.',
      h('ul', { class: 'dev-env-list' },
        projects.length
          ? projectTree(projects).map(({ project, depth }) => projectRow(store, project, depth))
          : h('li', { class: 'empty' }, 'No project yet. Create one in ', h('a', { href: '#/projects' }, 'Projects'), '.'))),
    harnessesPanel(store, harnesses, agents));
}
