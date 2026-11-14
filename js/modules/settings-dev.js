// Settings → Coding Agents, in two tabs: the agents (the program they run, the connection to a provider, the models
// a task can pick, and how the program takes them), and each project's folder and agent. Commands are edited in colour, with the variables they take as chips and a Preview of what a task runs.
import { h, icon, notice, uid } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { pickFolder } from '../folder-picker.js';
import { commandField, codeLine } from '../command-field.js';
import { projectIcon, projectTree, cleanLocalPath, LOCAL_PATH_ERROR } from './projects.js';
import { sortable } from './settings-labels.js';
import { DEFAULT_DEV_COMMAND, runnerOf } from './dev.js';
import { boardSkill, installBoardSkill } from '../terminal.js';
import { agentLogo, modelLabel, programName, projectAgentField, COMMAND_VARS, EXAMPLE_PROMPT } from './dev-agent-field.js';
import {
  DEV_MODEL_NAMES, agentEfforts, agentsOf, defaultAgent, devAgents, devHarnesses, devTemplate,
  harnessOf, splitEnv,
} from '../dev-core.js';
/** @import { Store, DevProvider, DevHarness, Project } from '../../types/data' */
/** @import { Child } from '../../types/ui' */

// The last problem shown above the cards, the tab shown (agents or projects), and the agents whose flags are unfolded.
/** @type {{ error: string, tab: string, flags: Set<string>, skill?: import('../terminal.js').BoardSkill | null, skillAsked?: boolean }} */
const devEnvView = { error: '', tab: 'agents', flags: new Set() };

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
    step('1', 'Agents', 'A coding agent program (Claude Code, Codex…), connected to a provider, with the models you can pick.'),
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

// The chip being dragged, and its list, so a chip of another list is not a drop target.
/** @type {{ key: string, value: string } | null} */
let chipDrag = null;

// A list edited as chips (an agent's models or efforts): each the value passed to the program (a claude alias names
// its model in its tooltip), with × to remove it, then a field that adds one (Enter, or a comma, adds; several may be
// pasted). Their order is the task menu's: drag a chip, or focus it and press the left and right arrows.
/** @param {{ key: string, values: string[], what: string, empty: string, save: (values: string[]) => void }} options */
function chipsEditor({ key, values, what, empty, save }) {
  const add = (/** @type {HTMLInputElement} */ input) => {
    const added = parseModels(input.value).filter((m) => !values.includes(m));
    input.value = '';
    if (added.length) save([...values, ...added]);
  };
  /** @param {string} from @param {string} to @param {boolean} after */
  const move = (from, to, after) => {
    const rest = values.filter((x) => x !== from);
    rest.splice(rest.indexOf(to) + (after ? 1 : 0), 0, from);
    if (rest.some((x, i) => x !== values[i])) save(rest);
  };
  /** @param {DragEvent & { currentTarget: HTMLElement }} e */
  const after = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    return e.clientX > r.left + r.width / 2;
  };
  /** @param {HTMLElement} el */
  const clear = (el) => el.classList.remove('drop-before', 'drop-after');
  return h('div', { class: 'dev-models' },
    values.map((m) => h('span', {
      class: 'dev-model',
      title: `${DEV_MODEL_NAMES[m] ? `${m} runs ${DEV_MODEL_NAMES[m]} today. ` : ''}Drag, or press the left and right arrows, to reorder`,
      draggable: 'true',
      tabindex: '0',
      'data-chip': `${key}:${m}`,
      ondragstart: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        // The agent card around it is draggable too: this drag is the chip's alone.
        e.stopPropagation();
        chipDrag = { key, value: m };
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', m);
        }
        e.currentTarget.classList.add('dragging');
      },
      ondragend: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        e.stopPropagation();
        chipDrag = null;
        e.currentTarget.classList.remove('dragging');
      },
      ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        if (chipDrag?.key !== key || chipDrag.value === m) return;
        e.preventDefault();
        e.stopPropagation();
        const a = after(e);
        e.currentTarget.classList.toggle('drop-before', !a);
        e.currentTarget.classList.toggle('drop-after', a);
      },
      ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => clear(e.currentTarget),
      ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        if (chipDrag?.key !== key) return;
        e.preventDefault();
        e.stopPropagation();
        clear(e.currentTarget);
        move(chipDrag.value, m, after(e));
        chipDrag = null;
      },
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
        e.preventDefault();
        const to = values[values.indexOf(m) + (e.key === 'ArrowLeft' ? -1 : 1)];
        if (to === undefined) return;
        move(m, to, e.key === 'ArrowRight');
        requestAnimationFrame(() => /** @type {HTMLElement | null} */ (document.querySelector(`[data-chip="${CSS.escape(`${key}:${m}`)}"]`))?.focus());
      },
    },
      h('code', null, m),
      h('button', {
        type: 'button',
        class: 'dev-model-x',
        'aria-label': `Remove ${m}`,
        title: `Remove ${m}`,
        onclick: () => save(values.filter((x) => x !== m)),
      }, icon('x')))),
    h('input', {
      class: 'dev-model-add',
      name: key,
      placeholder: values.length ? `Add ${what}` : `Add ${what} (${empty})`,
      'aria-label': `Add ${what}`,
      autocomplete: 'off',
      spellcheck: false,
      onkeydown: (/** @type {KeyboardEvent & { currentTarget: HTMLInputElement }} */ e) => {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          add(e.currentTarget);
        }
      },
      onchange: (/** @type {Event & { currentTarget: HTMLInputElement }} */ e) => add(e.currentTarget),
    }));
}

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
    store.update('dev', (d) => { d.removedAgents = [...new Set([...(d.removedAgents ?? []), agent.id])]; });
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
    if (!name || !harness) return fail(store, 'An agent needs a name and a program.');
    if (agents.some((x) => x.name.toLowerCase() === name.toLowerCase())) return fail(store, `An agent named "${name}" already exists.`);
    updateAgents(store, (list) => { list.push({ id: uid(), name, command, models: parseModels(form.elements.models.value) }); });
  };
  // Their order is the order of a task's Agent & model menu.
  const order = sortable('agents', agents.map((a) => a.id), (ids) => updateAgents(store, (list) => {
    list.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }));
  return panel('Agents',
    'What a task can run: a program’s command (claude, codex…), with the variables that connect it to a provider (an API address, a key from the runner’s environment) at the start of its command. MiniMax runs Claude Code with MiniMax’s API, with the key from MINIMAX_API_KEY.',
    h('ul', { class: 'dev-cards' },
      agents.map((agent) => {
        const harness = harnessOf(harnesses, agent.command);
        const isDefault = agent.id === fallback.id;
        const users = projects.filter((p) => p.devPreset === agent.id || (isDefault && !p.devPreset && !p.devCommand?.trim())).length;
        return h('li', { class: `dev-card${isDefault ? ' is-default' : ''}`, ...order.row(agent.id) },
          cardHead(
            [order.grip(agent.id, agent.name), agentLogo(store, agent)],
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
              harness?.name ?? 'Another program',
              agent.models.length ? plural(agent.models.length, 'model') : 'no models listed',
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
          h('div', { class: 'dev-chip-fields' },
            h('div', { class: 'cmd-field' },
              h('span', { class: 'dev-env-label small' }, 'Models in a task’s menu'),
              chipsEditor({ key: `models-${agent.id}`, values: agent.models, what: 'a model', empty: `none: ${programName(store, agent)} decides`,
                // A default that was removed is unset: nothing is passed.
                save: (models) => patch(agent.id, { models, ...(models.includes(agent.defaultModel ?? '') ? {} : { defaultModel: '' }) }) }),
              agent.models.length
                ? h('div', { class: 'dev-default-pick' },
                    h('span', { class: 'muted small' }, 'Default'),
                    pickChip({
                      value: agent.defaultModel && agent.models.includes(agent.defaultModel) ? agent.defaultModel : null,
                      options: agent.models.map((m) => ({ value: m, label: modelLabel(m) })),
                      nullable: true,
                      nullLabel: `Not set: ${programName(store, agent)} decides`,
                      onPick: (v) => patch(agent.id, { defaultModel: v ?? '' }),
                    }))
                : null),
            h('div', { class: 'cmd-field' },
              h('span', { class: 'dev-env-label small' }, 'Efforts in a task’s menu'),
              chipsEditor({ key: `efforts-${agent.id}`, values: agentEfforts(store, agent), what: 'an effort', empty: 'none: no Effort menu',
                save: (efforts) => patch(agent.id, { efforts, ...(efforts.includes(agent.defaultEffort ?? '') ? {} : { defaultEffort: '' }) }) }),
              agentEfforts(store, agent).length
                ? h('div', { class: 'dev-default-pick' },
                    h('span', { class: 'muted small' }, 'Default'),
                    pickChip({
                      value: agent.defaultEffort && agentEfforts(store, agent).includes(agent.defaultEffort) ? agent.defaultEffort : null,
                      options: agentEfforts(store, agent).map((e) => ({ value: e, label: e })),
                      nullable: true,
                      nullLabel: `Not set: ${programName(store, agent)} decides`,
                      onPick: (v) => patch(agent.id, { defaultEffort: v ?? '' }),
                    }))
                : null)),
          agentFlags(store, agent, harness, agents));
      })),
    h('form', { class: 'dev-preset-add', onsubmit: add },
      h('input', { name: 'name', placeholder: 'Name, such as Codex', 'aria-label': 'Agent name', autocomplete: 'off' }),
      h('select', { name: 'harness', 'aria-label': 'Program the agent runs' }, harnesses.map((x) => h('option', { value: x.id }, x.name))),
      h('input', { name: 'env', class: 'dev-env-command', placeholder: 'Connection variables (optional)', 'aria-label': 'Variables set before the harness command', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'models', placeholder: 'Models, comma separated (optional)', 'aria-label': 'Agent models', autocomplete: 'off', spellcheck: false }),
      h('button', { type: 'submit' }, icon('plus'), 'Add agent')));
}

// The harnesses as saved; the first change saves the built-in ones with it.
/** @param {Store} store @param {(harnesses: DevHarness[]) => void} mutate */
function updateHarnesses(store, mutate) {
  devEnvView.error = '';
  store.update('dev', (d) => {
    d.harnesses = devHarnesses(store).map((x) => ({ ...x }));
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

// How the agent's program takes a task's model, effort and prompt: the flags of its harness, kept per program, so
// every agent and project command that runs it shares them. A program the board does not know gets its own here.
/** @param {Store} store @param {DevProvider} agent @param {DevHarness | null} harness @param {DevProvider[]} agents */
function agentFlags(store, agent, harness, agents) {
  const open = devEnvView.flags.has(agent.id);
  const unfold = (/** @type {boolean} */ on) => {
    if (on) devEnvView.flags.add(agent.id);
    else devEnvView.flags.delete(agent.id);
  };
  if (!harness) {
    const program = splitEnv(agent.command).rest.split(/\s+/)[0] ?? '';
    return h('div', { class: 'dev-flags' },
      h('span', { class: 'muted small' }, `The board does not know how ${program || 'this program'} takes a model or an effort, so a task’s are not passed; its prompt goes after --.`),
      program
        ? h('button', {
            type: 'button',
            class: 'btn-small',
            onclick: () => {
              unfold(true);
              updateHarnesses(store, (list) => { list.push({ id: uid(), name: program.split('/').pop() ?? program, command: program, model: '', effort: '', prompt: '-- {{prompt}}' }); });
            },
          }, icon('plus'), 'Set its flags')
        : null);
  }
  const harnesses = devHarnesses(store);
  const shared = agents.filter((a) => a.id !== agent.id && harnessOf(harnesses, a.command)?.id === harness.id);
  /** @param {Partial<DevHarness>} patch */
  const save = (patch) => updateHarnesses(store, (list) => {
    const x = list.find((y) => y.id === harness.id);
    if (x) Object.assign(x, patch);
  });
  return h('div', { class: 'dev-flags' },
    h('button', {
      type: 'button',
      class: 'dev-flags-toggle',
      'aria-expanded': String(open),
      onclick: () => { unfold(!open); store.refresh(); },
    },
      icon(open ? 'chevron-down' : 'chevron-right'),
      h('span', { class: 'dev-env-label small' }, `How ${harness.name} takes the model, effort and prompt`),
      open ? null : codeLine([harness.model, harness.effort, harness.prompt].filter(Boolean).join('  ').replace(/\{\{?(\w+)\}\}?/g, '{{$1}}'), 'dev-flags-summary')),
    open
      ? [
          h('div', { class: 'dev-flag-grid' },
            HARNESS_FLAGS.map(([field, label, placeholder, about]) => commandField({
              key: `harness-${harness.id}-${field}`,
              label,
              value: (harness[field] ?? '').replace(/\{\{?(\w+)\}\}?/g, '{{$1}}'),
              placeholder,
              vars: [[field, about]],
              onSave: (text) => save({ [field]: text }),
            }))),
          h('span', { class: 'muted small' }, shared.length
            ? `Shared with ${shared.map((a) => a.name).join(', ')}, and any project command, that run ${harness.name}. Empty: not passed.`
            : `Shared with any project command that runs ${harness.name}. Empty: not passed.`),
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

// The board-tasks skill: Claude Code sessions started in Dev read it to list, add and edit their subtasks
// (tools/board.js). Read once from the command runner; Install links it into ~/.claude/skills.
/** @param {Store} store */
function skillPanel(store) {
  const base = runnerOf(store);
  if (!devEnvView.skillAsked) {
    devEnvView.skillAsked = true;
    boardSkill(base).then((s) => { devEnvView.skill = s; }, () => { devEnvView.skill = null; }).finally(() => store.refresh());
  }
  const skill = devEnvView.skill;
  const install = () => installBoardSkill(base).then((s) => {
    devEnvView.skill = s;
    if (s.state !== 'installed') fail(store, `${s.path} already exists${s.points ? ` and points at ${s.points}` : ''}. Remove it, then install again.`);
    store.refresh();
  }, (err) => fail(store, `Could not install the skill: ${err.message}`));
  /** @type {Child} */
  let state = h('span', { class: 'muted small' }, 'Checking…');
  if (skill === null) state = h('span', { class: 'muted small' }, 'The command runner did not answer. One started before this update needs a restart (bun dev).');
  else if (skill?.state === 'installed') state = h('span', { class: 'small' }, icon('check'), ` Installed: ${skill.path}`);
  else if (skill?.state === 'other') state = h('span', { class: 'small' }, `${skill.path} holds another copy${skill.points ? ` (${skill.points})` : ''}.`);
  else if (skill) state = h('button', { type: 'button', class: 'btn-small primary', onclick: install }, 'Install');
  return panel('Board tasks skill',
    h('span', null, 'Lets Claude Code sessions started on a task list, add and edit its subtasks (', h('code', null, 'board-tasks'), '). Linked into ', h('code', null, '~/.claude/skills'), ', so a pull updates it.'),
    h('div', { class: 'row' }, state));
}

// The two tabs: the agents with their harnesses under them, and each project's folder and agent.
const DEV_TABS = [['agents', 'Agents'], ['projects', 'Projects']];

/** @param {Store} store */
export function devEnvironmentCard(store) {
  const agents = devAgents(store);
  const harnesses = devHarnesses(store);
  const { projects } = store.get('projects');
  const tab = devEnvView.tab === 'projects' ? 'projects' : 'agents';
  return h('div', { class: 'stack-lg' },
    howItWorks(store),
    skillPanel(store),
    h('div', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Coding Agents' },
      DEV_TABS.map(([id, label]) => h('button', {
        type: 'button',
        role: 'tab',
        class: `sub-tab${tab === id ? ' active' : ''}`,
        'aria-selected': String(tab === id),
        onclick: () => { devEnvView.tab = id; devEnvView.error = ''; store.refresh(); },
      }, label, id === 'agents' ? h('span', { class: 'seg-count' }, String(agents.length)) : h('span', { class: 'seg-count' }, String(projects.length))))),
    devEnvView.error ? notice({ text: devEnvView.error }) : null,
    tab === 'agents'
      ? agentsPanel(store, agents, harnesses, projects)
      : panel('Projects', 'Where each project’s terminals open, and the agent its tasks run with the task as the prompt.',
          h('ul', { class: 'dev-env-list' },
            projects.length
              ? projectTree(projects).map(({ project, depth }) => projectRow(store, project, depth))
              : h('li', { class: 'empty' }, 'No project yet. Create one in ', h('a', { href: '#/projects' }, 'Projects'), '.'))));
}
