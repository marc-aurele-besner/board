// A project's agent, picked from Settings → Coding Agents's agents, or a command of its own; shared by Settings
// and a project's page. Also the agents' logos and the variables a Dev command can place.
import { h, icon } from '../ui.js';
import { pickChip } from '../inline.js';
import { commandField, codeLine } from '../command-field.js';
import { DEV_MODEL_NAMES, agentEfforts, brandOf, defaultAgent, devAgents, devCommandOf, devHarnesses, devTemplate, effortFor, harnessOf, withDevOptions } from '../dev-core.js';
/** @import { Store, DataStore, DevProvider, Project } from '../../types/data' */
/** @import { IconName } from '../ui.js' */

// An agent's, harness's or project command's logo, by the brand it names; `fallback` for another.
/** @param {string} brand @param {IconName} fallback */
export const brandLogo = (brand, fallback) => h('span', { class: `dev-logo${brand ? ` is-${brand}` : ''}` }, icon(/** @type {IconName} */ (brand || fallback)));

/** @param {DataStore} store @param {DevProvider} agent */
export const agentLogo = (store, agent) => brandLogo(brandOf(agent.name, agent.id, harnessOf(devHarnesses(store), agent.command)?.name ?? '', agent.command), 'cpu');

// The variables a Dev command can place itself, offered as chips under it.
/** @type {[string, string][]} */
export const COMMAND_VARS = [
  ['model', 'The model the task picked. Without one, the variable goes, with the flag just before it.'],
  ['effort', 'The effort the task picked. Without one, the variable goes, with the flag just before it.'],
  ['prompt', 'The task, as the prompt. Without it in the command, the harness’s prompt flag hands it over.'],
];
export const EXAMPLE_PROMPT = 'Fix the login bug';

// The program an agent runs, by name ("Claude Code"), for the labels of what is left to it: with no model or effort
// set, none is passed and the program uses its own setting.
/** @param {DataStore} store @param {DevProvider} agent */
export const programName = (store, agent) => harnessOf(devHarnesses(store), agent.command)?.name ?? 'the program';

// A model's name in a pick: a claude alias with the model it runs.
/** @param {string} v */
export const modelLabel = (v) => (DEV_MODEL_NAMES[v] ? `${v} · ${DEV_MODEL_NAMES[v]}` : v);

// The project's model and effort, among its agent's; Default is the agent's default, or, when that is not set,
// nothing passed, so the program uses its own setting.
/** @param {Store} store @param {Project} p @param {DevProvider} agent @param {(patch: Partial<Project>) => void} update */
function modelEffortPicks(store, p, agent, update) {
  const efforts = agentEfforts(store, agent);
  return h('div', { class: 'dev-model-picks' },
    agent.models.length
      ? pickChip({
          value: p.devModel && agent.models.includes(p.devModel) ? p.devModel : null,
          options: agent.models.map((m) => ({ value: m, label: modelLabel(m) })),
          nullable: true,
          nullLabel: agent.defaultModel ? `Model: agent default (${modelLabel(agent.defaultModel)})` : `Model: not set (${programName(store, agent)} decides)`,
          className: 'field-pick dev-agent-pick',
          onPick: (v) => update({ devModel: v ?? '' }),
        })
      : null,
    efforts.length
      ? pickChip({
          value: p.devEffort && efforts.includes(p.devEffort) ? p.devEffort : null,
          options: efforts.map((e) => ({ value: e, label: `Effort: ${e}` })),
          nullable: true,
          nullLabel: agent.defaultEffort && efforts.includes(agent.defaultEffort) ? `Effort: agent default (${agent.defaultEffort})` : `Effort: not set (${programName(store, agent)} decides)`,
          className: 'field-pick dev-agent-pick',
          onPick: (v) => update({ devEffort: v ?? '' }),
        })
      : null);
}

// The pick's value for a project with a command of its own.
const OWN = ':own';

/**
 * The project's agent pick, and under it the command it runs: the agent's, read-only, or its own, editable.
 * @param {Store} store
 * @param {Project} p
 * @param {(patch: Partial<Project>) => void} update
 */
export function projectAgentField(store, p, update) {
  const agents = devAgents(store);
  const fallback = defaultAgent(store);
  const agent = agents.find((a) => a.id === p.devPreset) ?? null;
  const own = !agent && Boolean(p.devCommand?.trim());
  const shown = agent ?? (own ? null : fallback);
  return h('div', { class: 'dev-agent-field' },
    pickChip({
      value: agent ? agent.id : own ? OWN : null,
      options: [
        ...agents.map((a) => ({ value: a.id, label: a.name, plainIcon: () => agentLogo(store, a) })),
        { value: OWN, label: 'Its own command', plainIcon: () => brandLogo('', 'terminal') },
      ],
      nullable: true,
      nullLabel: `Default (${fallback.name})`,
      className: 'field-pick dev-agent-pick',
      // Another agent offers other models and efforts: the project's picks go back to its defaults.
      onPick: (v) => {
        if (v === OWN) update({ devPreset: '', devCommand: p.devCommand?.trim() || devCommandOf(store, p), devModel: '', devEffort: '' });
        else update({ devPreset: v ?? '', devCommand: v ? p.devCommand ?? '' : '', devModel: '', devEffort: '' });
      },
    }),
    shown ? modelEffortPicks(store, p, shown, update) : null,
    shown
      // The command its tasks run: the agent's, with the project's model and effort (else the agent's defaults).
      ? codeLine(withDevOptions(devHarnesses(store), shown.command, {
          model: p.devModel && shown.models.includes(p.devModel) ? p.devModel : shown.defaultModel ?? '',
          effort: effortFor(store, shown, p.devEffort || shown.defaultEffort || ''),
        }), 'dev-env-preview')
      : commandField({
          key: `project-${p.id}`,
          value: p.devCommand ?? '',
          placeholder: fallback.command,
          vars: COMMAND_VARS,
          preview: (v) => devTemplate(devHarnesses(store), v),
          examples: { model: 'opus', effort: 'high', prompt: EXAMPLE_PROMPT },
          previewHint: 'What a task with a model and effort picked runs.',
          onSave: (devCommand) => update(devCommand ? { devCommand } : { devCommand: '', devPreset: '' }),
        }));
}
