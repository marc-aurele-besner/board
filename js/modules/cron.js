// Cron: recurring flows that gather board data, ask an AI model, and turn the answer into a task, a notification or work for claude in Dev.
// The editor draws a flow as a chain of nodes, like a workflow canvas; the inspector below edits the selected node.
import { h, icon, empty, notice, now, uid, todayISO, statusOf } from '../ui.js';
import { projectTree, projectIcon } from './projects.js';
import { pickChip, pickButton, pill } from '../inline.js';
import { taskStatuses, statusLook } from '../task-labels.js';
import { modelChip } from '../model-picker.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import {
  COLLECTION, DEFAULTS, AI_TASK, STEP_TYPES, SOURCES, WEEKDAYS, SHORT_DAYS, MONTHS, SHORT_MONTHS, REPEATS, STOP_WHEN, PROFILE_EDITED, profileEditedMode, TEMPLATES, devRunOptions, devRunValue, devCommandPreview, daysOf,
  timesOf, monthDaysOf, monthsOf, validTime, cronOf, cronError, upcomingSlots,
  makeFlow, makeStep, makeSource, MAX_FOLLOW, sourcesOf, sourceLabel, flowProjectId, withFlowProject, flowFromTemplate, templateFromFlow, nextRun, scheduleLabel, stopLabel, runFlow, isRunning,
  testStep, testsOf, isTesting, clearTests, resumeDevTests, useDevStarter, varsTree, fillParts, pathTo, parseData, INPUT_NONE, reorderSteps, projectVars, runState, devWaits, DEV_WAIT_MINUTES, devJsonOffered, devJson, DEV_JSON_PROMPT,
  FORMAT_MODES, PARSE_MODES, SEPARATOR_OPTIONS, LOOP_LIMIT, makeField, loopSpan, loopOf, loopMax, valueOf, listOf, withItem,
} from '../cron.js';
import { modelForTask } from '../models.js';
import { openSession, runnerOf, liveSession, onSessionPaint, exitText, terminalView, terminalBackground, startDevSession } from './dev.js';
import { runJob } from '../runners.js';
import { previewChips } from '../previews.js';
import { attachSession, sessionStatus, listSkills } from '../terminal.js';
import { createTerminal } from '../vt.js';
import { hasProfileSources } from '../profile.js';
/** @import { Store, CronFlow, CronStep, CronSource, CronFormatField, CronSchedule, CronTemplate, CronRun, CronRunStep, CronPr, Project, Task, IconName } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @import { Vars } from '../cron.js' */
/** @import { Exit } from './dev.js' */
/** @import { RunnerSkills } from '../../types/terminal' */
// The input, textarea or select a change handler is on; all three have value.
/** @typedef {Event & { target: HTMLInputElement }} FieldEvent */
// A drag on a node, the palette or a +: the browser always gives it data and the element it is on.
/** @typedef {DragEvent & { dataTransfer: DataTransfer, currentTarget: HTMLElement }} NodeDrag */
// What a Dev step's test data holds of its terminal.
/** @typedef {{ session?: string, cwd?: string }} DevTestData */

// View state: the tab, the open flow, the selected node ('trigger' or a step id), the Runs tab's filter and the
// flow list's project filter ('' for all, NO_PROJECT for flows without one).
// field and cursor: the {{…}} field last focused and where its cursor was, for the variable chips and the test data.
// preview: the {{…}} text fields showing their Preview tab instead of the text.
// terms: the terminals unfolded under runs (seenTerms: those drawn once, so one folded by hand stays folded).
// openRuns: the runs unfolded; focusRun: the run a link opened (#/cron?tab=runs&run=…), scrolled to once.
/**
 * @type {{ tab: string, flow: string, node: string, runs: string, project: string, field: string,
 *   cursor: { key: string, start: number, end: number } | null, preview: Set<string>, terms: Set<string>,
 *   seenTerms: Set<string>, openRuns: Set<string>, focusRun: string, scrollTo: string }}
 */
const view = { tab: 'flows', flow: '', node: 'trigger', runs: 'all', project: '', field: '', cursor: null, preview: new Set(), terms: new Set(), seenTerms: new Set(), openRuns: new Set(), focusRun: '', scrollTo: '' };
const NO_PROJECT = 'none';
const TABS = [['flows', 'Flows'], ['runs', 'Runs'], ['templates', 'Templates']];
/** @type {Record<string, string>} */
const SUBTITLES = {
  flows: 'Recurring flows that gather data from the board, ask an AI model, and turn the answer into a task, a notification or work for claude in Dev.',
  runs: 'What every flow did, step by step.',
  templates: 'Starting points, and the flows you saved as templates. A template becomes a paused flow you can adjust before switching it on.',
};

/**
 * @param {string} type
 * @returns {[string, string, IconName, string]}
 */
const typeOf = (type) => STEP_TYPES.find(([t]) => t === type) ?? [type, type, 'info', ''];
/** @param {string | undefined} at */
const timeOf = (at) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
/** @param {Store} store */
const projectsOf = (store) => projectTree(store.get('projects').projects).map(({ project }) => project);
/**
 * @param {Store} store
 * @param {string} id
 */
const projectName = (store, id) => (id ? store.get('projects').projects.find((p) => p.id === id)?.name ?? 'Removed project' : '');
/**
 * @param {Store} store
 * @param {string} flowId
 */
const lastRunOf = (store, flowId) => store.get(COLLECTION).runs.find((r) => r.flowId === flowId) ?? null;

/**
 * @param {Store} store
 * @param {string} id
 * @param {(f: CronFlow) => void} mutate
 */
function updateFlow(store, id, mutate) {
  store.update(COLLECTION, (d) => {
    const f = d.flows.find((x) => x.id === id);
    if (f) mutate(f);
  });
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function addFlow(store, flow) {
  store.update(COLLECTION, (d) => d.flows.push(flow));
  view.flow = flow.id;
  view.node = flow.steps[0]?.id ?? 'trigger';
  store.refresh();
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function deleteFlow(store, flow) {
  const before = structuredClone(store.get(COLLECTION));
  store.update(COLLECTION, (d) => {
    d.flows = d.flows.filter((f) => f.id !== flow.id);
    d.runs = d.runs.filter((r) => r.flowId !== flow.id);
    delete d.tests?.[flow.id];
  });
  view.flow = '';
  toast(`Deleted “${flow.name}”`, {
    undo: () => store.update(COLLECTION, (d) => {
      d.flows = before.flows;
      d.runs = before.runs;
      d.tests = before.tests;
    }),
  });
}

// A copy starts paused, so it does not run beside the original until it is switched on.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function duplicateFlow(store, flow) {
  const copy = structuredClone(flow);
  addFlow(store, {
    ...copy,
    id: uid(),
    name: `${flow.name} (copy)`,
    enabled: false,
    enabledAt: '',
    lastRun: '',
    created: now(),
    steps: copy.steps.map((s) => ({ ...s, id: uid() })),
  });
  toast(`Duplicated “${flow.name}”`);
}

// Steps that named the new project themselves now just follow the flow.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {string} projectId
 */
function setFlowProject(store, flow, projectId) {
  const was = flowProjectId(flow);
  // A filtered list follows the flow, so it stays open.
  if (view.project) view.project = projectId || NO_PROJECT;
  updateFlow(store, flow.id, (f) => {
    f.projectId = projectId;
    for (const s of f.steps) {
      const items = s.type === 'gather' && Array.isArray(s.sources) ? s.sources : [s];
      for (const x of items) if (x.projectId && (x.projectId === projectId || x.projectId === was)) x.projectId = '';
    }
  });
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {boolean} enabled
 */
function setEnabled(store, flow, enabled) {
  updateFlow(store, flow.id, (f) => {
    f.enabled = enabled;
    if (enabled) f.enabledAt = now();
  });
}

// A test run of a step here opens its Dev terminal on this page.
// It takes the tab's store, which is what cron.js passes it on this page.
useDevStarter(/** @type {Parameters<typeof useDevStarter>[0]} */ (startDevSession));

// Run now asks the runners (tools/jobs/cron.js), so the run is the same as a scheduled one and goes on when this tab
// closes; it shows in Runs as it goes, through cron.json. A test run (dry) runs here, like Test step, so its
// terminals and data show at once.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {{ dry?: boolean }} [options]
 */
function startRun(store, flow, { dry = false } = {}) {
  if (isRunning(flow.id)) return;
  if (!dry) {
    runJob('cron', { flowId: flow.id })
      .then(() => toast(`“${flow.name}” started in the runners. It shows in Runs as it goes.`))
      .catch((err) => toast(err.message));
    return;
  }
  const run = runFlow(store, flow.id, { manual: true, dry });
  // The run is saved before its first step, so it is the newest; it opens in Runs, with its terminals as they start.
  const id = store.get(COLLECTION).runs[0]?.id;
  if (id) view.openRuns.add(id);
  store.refresh();
  run.then((r) => toast(
    r?.status === 'ok' ? `Test run of “${flow.name}” finished`
      : r?.status === 'stopped' ? `Test run of “${flow.name}” stopped early`
        : `Test run of “${flow.name}” failed: ${r?.error ?? 'unknown error'}`,
  ));
}

// --- Flow list ---

// Narrows the list to one project's flows. Only projects some flow uses are offered.
/**
 * @param {Store} store
 * @param {CronFlow[]} flows
 */
function projectFilter(store, flows) {
  const used = new Set(flows.map(flowProjectId));
  if (used.size < 2 && !view.project) return null;
  const list = projectsOf(store).filter((p) => used.has(p.id));
  return pickChip({
    value: view.project || null,
    options: [
      ...list.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
      ...(used.has('') ? [{ value: NO_PROJECT, label: 'No project', plainIcon: () => icon('folder') }] : []),
    ],
    nullable: true,
    nullLabel: 'All projects',
    className: 'field-pick project-field-pick cron-project-filter',
    onPick: (v) => {
      view.project = v ?? '';
      view.flow = '';
      store.refresh();
    },
  });
}

/** @param {CronFlow} f */
const inFilter = (f) => !view.project || (flowProjectId(f) || NO_PROJECT) === view.project;

/**
 * @param {Store} store
 * @param {CronFlow[]} all
 * @param {CronFlow[]} flows
 */
function flowList(store, all, flows) {
  return h('aside', { class: 'card cron-list' },
    h('div', { class: 'row between' },
      h('h3', null, 'Flows'),
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => openNewFlow(store) }, icon('plus'), 'New flow')),
    projectFilter(store, all),
    flows.length
      ? h('ul', { class: 'cron-flows' }, flows.map((f) => {
          const last = lastRunOf(store, f.id);
          const project = store.get('projects').projects.find((p) => p.id === flowProjectId(f));
          return h('li', { class: 'cron-flow-row' },
            h('button', {
              type: 'button',
              class: f.id === view.flow ? 'cron-flow active' : 'cron-flow',
              onclick: () => {
                view.flow = f.id;
                view.node = 'trigger';
                store.refresh();
              },
            },
              h('span', { class: `cron-dot ${isRunning(f.id) ? 'running' : !f.enabled ? 'off' : last?.status === 'error' ? 'bad' : 'on'}` }),
              h('span', { class: 'grow' },
                h('strong', null, f.name),
                h('span', { class: 'muted small cron-flow-meta' }, h('span', { class: 'cron-flow-project' }, f.enabled ? scheduleLabel(f.schedule) : 'Paused')),
                project ? h('span', { class: 'muted small cron-flow-meta' }, projectIcon(project), h('span', { class: 'cron-flow-project' }, project.name)) : null)),
            h('input', {
              type: 'checkbox',
              class: 'cron-flow-toggle',
              checked: f.enabled,
              title: f.enabled ? 'On schedule. Uncheck to pause.' : 'Paused. Check to run on schedule.',
              'aria-label': `Run “${f.name}” on schedule`,
              onchange: (/** @type {FieldEvent} */ e) => setEnabled(store, f, e.target.checked),
            }),
            h('button', {
              type: 'button',
              class: 'icon-btn cron-flow-copy',
              title: 'Duplicate flow',
              'aria-label': `Duplicate “${f.name}”`,
              onclick: () => duplicateFlow(store, f),
            }, icon('copy')));
        }))
      : empty('No flow yet. Build one from scratch, or start from a template.'),
    h('button', { type: 'button', class: 'btn-link small', onclick: () => openTemplates(store) }, icon('bookmark'), 'Start from a template'));
}

// A new flow starts empty, on its schedule node, with every node there is in the palette above its canvas.
/** @param {Store} store */
function openNewFlow(store) {
  view.tab = 'flows';
  const flow = makeFlow();
  // A flow made while the list shows one project starts in it.
  if (view.project && view.project !== NO_PROJECT) flow.projectId = view.project;
  addFlow(store, flow);
}

/** @param {Store} store */
const openTemplates = (store) => {
  view.tab = 'templates';
  store.refresh();
};

// --- Templates tab ---

// Saves the flow as a template of the Templates tab, under a name and a short description.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function saveAsTemplate(store, flow) {
  const dialog = openDialog({
    title: 'Save as template',
    body: h('form', {
      class: 'stack',
      onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        const name = String(data.get('name') ?? '').trim() || flow.name;
        const t = templateFromFlow(flow, { name, about: String(data.get('about') ?? '').trim() });
        store.update(COLLECTION, (d) => {
          d.templates ??= [];
          d.templates.unshift(t);
        });
        dialog.close();
        toast(`Saved “${name}” as a template`);
      },
    },
      field('Name', h('input', { name: 'name', value: flow.name, autocomplete: 'off', required: true })),
      field('Description (optional)', h('textarea', { name: 'about', rows: 3, placeholder: 'What the flow does' })),
      h('p', { class: 'muted small' }, 'The template keeps the schedule, the project and every step. A flow made from it starts paused.'),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'primary' }, icon('bookmark'), 'Save template'))),
  });
}

/**
 * @param {Store} store
 * @param {CronTemplate} t
 */
function removeTemplate(store, t) {
  const before = structuredClone(store.get(COLLECTION).templates ?? []);
  store.update(COLLECTION, (d) => {
    d.templates = (d.templates ?? []).filter((x) => x.id !== t.id);
  });
  toast(`Removed the template “${t.name}”`, { undo: () => store.update(COLLECTION, (d) => { d.templates = before; }) });
}

// A built-in template has no id or project; the blank one starts a flow with one AI step.
/**
 * @param {Store} store
 * @param {{ name: string, about: string, schedule: CronSchedule, steps: Array<Omit<CronStep, 'id'>>, projectId?: string, blank?: boolean }} template
 * @param {{ remove?: (() => void) | null }} [options]
 */
function templateCard(store, { name, about, schedule, steps, projectId = '', blank = false }, { remove = null } = {}) {
  const project = projectId ? store.get('projects').projects.find((p) => p.id === projectId) : null;
  return h('article', { class: 'card stack cron-template-card' },
    h('div', { class: 'row between' },
      h('h3', null, name),
      remove ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove template', 'aria-label': `Remove the template “${name}”`, onclick: remove }, icon('trash')) : null),
    h('p', { class: 'muted small grow' }, about || 'Saved from a flow.'),
    project ? h('span', { class: 'muted small cron-flow-meta' }, projectIcon(project), h('span', { class: 'cron-flow-project' }, project.name)) : null,
    h('div', { class: 'cron-template-steps', 'aria-label': 'Steps' },
      h('span', { class: 'flow-node-icon kind-trigger', title: scheduleLabel(schedule) }, icon('clock')),
      steps.map((s) => {
        const [, label, iconName] = typeOf(s.type);
        return h('span', { class: `flow-node-icon kind-${s.type}`, title: label }, icon(iconName));
      })),
    h('p', { class: 'muted small' }, scheduleLabel(schedule)),
    h('div', null, h('button', {
      type: 'button',
      class: 'btn-small primary',
      onclick: () => {
        view.tab = 'flows';
        // A template's project that was removed since is dropped.
        const flow = blank ? makeFlow({ steps: [makeStep('ai')] }) : flowFromTemplate({ name, schedule, steps, projectId: project ? projectId : '' });
        // A flow made while the list shows one project starts in it.
        if (view.project && view.project !== NO_PROJECT) flow.projectId = view.project;
        addFlow(store, flow);
      },
    }, icon('plus'), blank ? 'Start blank' : 'Use template')));
}

/** @param {Store} store */
function templatesTab(store) {
  const blank = { name: 'Blank flow', about: 'One AI step to start with. Add data, conditions and outputs around it.', schedule: makeFlow().schedule, steps: [{ type: 'ai' }], blank: true };
  const builtIn = h('div', { class: 'cron-template-grid' }, [...TEMPLATES, blank].map((t) => templateCard(store, t)));
  const saved = store.get(COLLECTION).templates ?? [];
  if (!saved.length) return builtIn;
  return h('div', { class: 'stack-lg' },
    h('section', { class: 'stack' },
      h('h3', null, 'Your templates'),
      h('div', { class: 'cron-template-grid' }, saved.map((t) => templateCard(store, t, { remove: () => removeTemplate(store, t) })))),
    h('section', { class: 'stack' },
      h('h3', null, 'Starting points'),
      builtIn));
}

// --- Runs tab ---

const RUN_FILTERS = [['all', 'All'], ['running', 'Running'], ['error', 'Failed'], ['stopped', 'Stopped'], ['dry', 'Tests']];
/**
 * @param {CronRun} r
 * @param {string} key
 */
const runMatches = (r, key) => (key === 'all' ? true : key === 'dry' ? r.dry : key === 'error' ? ['error', 'lost'].includes(runState(r)) : runState(r) === key);

/** @param {Store} store */
function runsTab(store) {
  const { flows, runs } = store.get(COLLECTION);
  const shown = runs.filter((r) => runMatches(r, view.runs));
  watchTerminals(store, sessionsOf(shown));
  /** @param {string} key */
  const count = (key) => runs.filter((r) => runMatches(r, key)).length;
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' },
      h('p', { class: 'muted small' }, `The last ${runs.length} runs of every flow, newest first. Older runs are dropped. Open a run to see each step.`),
      h('div', { class: 'segmented', role: 'group', 'aria-label': 'Show' },
        RUN_FILTERS.map(([key, label]) => {
          const n = key === 'all' ? 0 : count(key);
          return h('button', {
            type: 'button',
            class: view.runs === key ? 'seg active' : 'seg',
            'aria-pressed': String(view.runs === key),
            onclick: () => {
              view.runs = key;
              store.refresh();
            },
          }, label, n ? h('span', { class: 'seg-count' }, String(n)) : null);
        }))),
    shown.length
      ? h('ul', { class: 'cron-runs' }, shown.map((r) => runCard(store, flows.find((f) => f.id === r.flowId) ?? null, r, { showFlow: true })))
      : empty(runs.length ? 'No run matches this filter.' : 'No run yet. Runs of every flow show here.'));
}

// --- Canvas ---

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
function stepSummary(store, flow, step) {
  if (step.type === 'gather') {
    const sources = sourcesOf(step);
    const plus = step.append ? '+ ' : '';
    if (!sources.length) return 'Add a source';
    const first = withFlowProject(flow, sources[0]);
    const one = first.source === 'page' && !first.label && !first.projectId && !first.url ? 'Enter an address' : sourceLabel(store, first);
    return `${plus}${one}${sources.length > 1 ? ` +${sources.length - 1}` : ''}`;
  }
  if (step.type === 'ai') return step.model || modelForTask(store, AI_TASK) || 'No model set';
  if (step.type === 'task') return step.title || '{{input}}';
  if (step.type === 'stop') return stopLabel(step);
  if (step.type === 'format') {
    if (step.mode === 'fields') return (step.fields ?? []).map((f) => f.name.trim()).filter(Boolean).join(', ') || 'Name a field';
    if (step.mode === 'list') return `${step.itemText || '{{item}}'} · each of ${step.items || '{{input}}'}`;
    return String(step.text ?? '').split('\n').find((l) => l.trim()) ?? 'Empty';
  }
  if (step.type === 'parse') {
    const which = /** @type {Record<string, string>} */ ({ largest: 'Largest', last: 'Last', first: 'First', all: 'All' })[step.mode || 'largest'] ?? 'Largest';
    return `${which} JSON in ${step.text || '{{input}}'}`;
  }
  if (step.type === 'loop') {
    const n = loopSpan(flow, flow.steps.indexOf(step));
    return n ? `Each of ${step.items || '{{input}}'} · next ${n === 1 ? 'step' : `${n} steps`}` : 'Add the steps to repeat after it';
  }
  if (step.type === 'profile') {
    const id = withFlowProject(flow, step).projectId;
    const edited = /** @type {Record<string, string>} */ ({ merge: ' · keeps hand edits', replace: ' · replaces hand edits', keep: ' · skips an edited profile' })[profileEditedMode(step)];
    return id ? `${projectName(store, id)}${edited}` : 'Choose a project';
  }
  if (step.type === 'dev') {
    const id = withFlowProject(flow, step).projectId;
    const where = id ? projectName(store, id) : 'Task’s project or board';
    const label = Object.fromEntries(devRunOptions(store))[devRunValue(step)] ?? 'Removed preset';
    return `${step.mode === 'command' ? step.command || 'Enter a command' : label} · ${where}`;
  }
  return step.text || 'Notification';
}

// A step's node can be dragged onto a + to move it there; the schedule node stays first.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {{ id: string, iconName: IconName, kind: string, title: string, sub: string, status?: string, pipe?: string, loop?: string }} node
 */
function node(store, flow, { id, iconName, kind, title, sub, status, pipe = '', loop = '' }) {
  const step = id !== 'trigger';
  return h('button', {
    type: 'button',
    class: `flow-node${view.node === id ? ' selected' : ''}${status ? ` ${status}` : ''}${loop ? ' in-loop' : ''}`,
    draggable: step ? 'true' : null,
    ondragstart: step ? (/** @type {NodeDrag} */ e) => startDrag(e, `move:${id}`) : null,
    ondragend: step ? endDrag : null,
    onclick: () => {
      view.node = id;
      store.refresh();
    },
  },
    h('span', { class: `flow-node-icon kind-${kind}` }, icon(iconName)),
    h('span', { class: 'flow-node-text' },
      h('span', { class: 'flow-node-kind' }, title),
      h('span', { class: 'flow-node-sub' }, sub),
      pipe ? h('span', { class: 'flow-node-pipe' }, icon('arrow-right'), pipe) : null,
      loop ? h('span', { class: 'flow-node-pipe loop' }, icon('repeat'), loop) : null));
}

// --- Building a flow: adding, moving and piping nodes ---

const DRAG_TYPE = 'application/x-cron-node';
/**
 * @param {NodeDrag} e
 * @param {string} what
 */
const startDrag = (e, what) => {
  e.dataTransfer.setData(DRAG_TYPE, what);
  e.dataTransfer.effectAllowed = 'copyMove';
  e.currentTarget.closest('.cron-editor')?.classList.add('dragging');
};
/** @param {NodeDrag} e */
const endDrag = (e) => e.currentTarget.closest('.cron-editor')?.classList.remove('dragging');

// Tests are kept by step id and their variables are rebuilt from the steps before, so an edit only drops the tests
// of the steps from `index` on, whose input may now differ. The steps before keep their data.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {number} index
 */
const clearTestsFrom = (store, flow, index) => clearTests(store, flow.id, flow.steps.slice(Math.max(0, index)).map((s) => s.id));

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {number} index
 * @param {string} type
 */
function addStepAt(store, flow, index, type) {
  const step = makeStep(type);
  clearTestsFrom(store, flow, index);
  updateFlow(store, flow.id, (f) => reorderSteps(f, [...f.steps.slice(0, index), step, ...f.steps.slice(index)]));
  view.node = step.id;
  store.refresh();
}

// Moves a step so that it lands at `index` of the list as it is now (the position of a + on the canvas).
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {string} id
 * @param {number} index
 */
function moveStepTo(store, flow, id, index) {
  const i = flow.steps.findIndex((s) => s.id === id);
  const at = index > i ? index - 1 : index;
  if (i < 0 || at === i) return;
  clearTestsFrom(store, flow, Math.min(i, at));
  updateFlow(store, flow.id, (f) => {
    const from = f.steps.findIndex((s) => s.id === id);
    if (from < 0) return;
    const rest = f.steps.filter((s) => s.id !== id);
    reorderSteps(f, [...rest.slice(0, at), f.steps[from], ...rest.slice(at)]);
  });
}

// Every node there is, always in view: a click adds one after the selected node, a drag puts it on any +.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function nodePalette(store, flow) {
  const selected = flow.steps.findIndex((s) => s.id === view.node);
  return h('div', { class: 'flow-palette' },
    h('span', { class: 'muted small' }, 'Nodes · click one to add it after the selected node, or drag it onto a +'),
    h('div', { class: 'flow-palette-list', role: 'list', 'aria-label': 'Nodes you can add' },
      STEP_TYPES.map(([type, label, iconName, about]) => h('button', {
        type: 'button',
        class: 'flow-palette-item',
        role: 'listitem',
        draggable: 'true',
        title: about,
        ondragstart: (/** @type {NodeDrag} */ e) => startDrag(e, `new:${type}`),
        ondragend: endDrag,
        onclick: () => addStepAt(store, flow, selected + 1, type),
      }, h('span', { class: `flow-node-icon kind-${type}` }, icon(iconName)), label))));
}

// What a step reads as {{input}}: the step before it, any earlier step, or nothing.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {number} index
 */
function inputPick(store, flow, step, index) {
  if (index === 0) return null;
  const options = [
    ['', `The step before (${index}. ${typeOf(flow.steps[index - 1].type)[1]})`],
    ...flow.steps.slice(0, index - 1).map((s, i) => [s.id, `${i + 1}. ${typeOf(s.type)[1]}`]),
    [INPUT_NONE, 'Nothing'],
  ];
  return field('Input from', select(step.from ?? '', options, (from) => {
    updateFlow(store, flow.id, (f) => {
      const s = f.steps.find((x) => x.id === step.id);
      if (!s) return;
      if (from) s.from = from;
      else delete s.from;
    });
    clearTestsFrom(store, flow, flow.steps.findIndex((s) => s.id === step.id));
  }), 'What {{input}} holds. Pick an earlier step to branch from it; every {{stepN}} stays readable either way.');
}

// The badge on a node whose input is not the step just before it.
/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
function pipeLabel(flow, step) {
  if (!step.from) return '';
  if (step.from === INPUT_NONE) return 'No input';
  const n = flow.steps.findIndex((s) => s.id === step.from);
  return n < 0 ? '' : `Input from ${n + 1}`;
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {number} index
 */
function insertStep(store, flow, index) {
  const dialog = openDialog({
    title: 'Add a step',
    body: h('div', { class: 'cron-templates' }, STEP_TYPES.map(([type, label, iconName, about]) =>
      h('button', {
        type: 'button',
        class: 'cron-template row',
        onclick: () => {
          dialog.close();
          addStepAt(store, flow, index, type);
        },
      },
        h('span', { class: `flow-node-icon kind-${type}` }, icon(iconName)),
        h('span', { class: 'grow' }, h('strong', null, label), h('span', { class: 'muted small' }, about))))),
  });
}

// A + takes a node dropped on it: a new one from the palette, or a step moved from elsewhere on the canvas.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {number} index
 */
const link = (store, flow, index) =>
  h('div', {
    class: 'flow-link',
    ondragover: (/** @type {NodeDrag} */ e) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      e.currentTarget.classList.add('drop');
    },
    ondragleave: (/** @type {NodeDrag} */ e) => e.currentTarget.classList.remove('drop'),
    ondrop: (/** @type {NodeDrag} */ e) => {
      const what = e.dataTransfer.getData(DRAG_TYPE);
      if (!what) return;
      e.preventDefault();
      e.currentTarget.classList.remove('drop');
      const [kind, value] = what.split(':');
      if (kind === 'new') addStepAt(store, flow, index, value);
      else moveStepTo(store, flow, value, index);
    },
  },
    h('button', { type: 'button', class: 'flow-add', title: 'Add a step here', 'aria-label': 'Add a step here', onclick: () => insertStep(store, flow, index) }, icon('plus')));

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function canvas(store, flow) {
  const last = lastRunOf(store, flow.id);
  const tested = testsOf(store, flow.id);
  /** @param {string} id */
  const statusOfStep = (id) => {
    const s = tested.get(id) ?? last?.steps.find((x) => x.stepId === id);
    return s ? (s.ok ? 'ok' : 'bad') : '';
  };
  /** @type {HTMLElement[]} */
  const parts = [node(store, flow, { id: 'trigger', iconName: 'clock', kind: 'trigger', title: 'Schedule', sub: scheduleLabel(flow.schedule) })];
  flow.steps.forEach((s, i) => {
    const [, label, iconName] = typeOf(s.type);
    parts.push(link(store, flow, i));
    const at = loopOf(flow, i);
    parts.push(node(store, flow, {
      id: s.id, iconName, kind: s.type, title: `${i + 1}. ${label}`, sub: stepSummary(store, flow, s), status: statusOfStep(s.id), pipe: pipeLabel(flow, s),
      loop: at >= 0 ? `Each item of loop ${at + 1}` : '',
    }));
  });
  parts.push(link(store, flow, flow.steps.length));
  const wires = document.createElementNS(SVG_NS, 'svg');
  wires.setAttribute('class', 'flow-wires');
  wires.setAttribute('aria-hidden', 'true');
  const hint = flow.steps.length ? null : h('p', { class: 'muted small flow-hint' }, 'Add the first node from the list above, or drop one on +.');
  const el = h('div', { class: `flow-canvas${isRunning(flow.id) ? ' running' : ''}`, role: 'list', 'aria-label': 'Flow steps' }, wires, parts, hint);
  new ResizeObserver(() => drawWires(el, wires, parts)).observe(el);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

// Joins each node and link to the next one, centre to centre (the nodes and buttons cover their part). On one row that is a straight line; when the next
// one wraps to a new row, the line goes out, down into the gap between the rows, back across
// and into it, so a wrapped step still reads as the one after.
/**
 * @param {HTMLElement} canvas
 * @param {SVGElement} svg
 * @param {HTMLElement[]} parts
 */
function drawWires(canvas, svg, parts) {
  const base = canvas.getBoundingClientRect();
  if (!base.width) return;
  const boxes = parts.map((p) => {
    const r = p.getBoundingClientRect();
    return { left: r.left - base.left, right: r.right - base.left, top: r.top - base.top, bottom: r.bottom - base.top, mid: r.top - base.top + r.height / 2, cx: r.left - base.left + r.width / 2 };
  });
  /**
   * @param {{ top: number, bottom: number }} a
   * @param {{ top: number, bottom: number }} b
   */
  const sameRow = (a, b) => a.top < b.bottom && b.top < a.bottom;
  /** @type {string[]} */
  const d = [];
  for (let i = 0; i < boxes.length - 1; i++) {
    const a = boxes[i];
    const b = boxes[i + 1];
    if (sameRow(a, b)) { d.push(`M${a.cx} ${a.mid}H${b.cx}`); continue; }
    const rowBottom = Math.max(...boxes.filter((x) => sameRow(x, a)).map((x) => x.bottom));
    const rowTop = Math.min(...boxes.filter((x) => sameRow(x, b)).map((x) => x.top));
    const gap = (rowBottom + rowTop) / 2;
    const out = Math.min(a.right + 9, base.width - 3);
    const into = Math.max(b.left - 9, 3);
    d.push(`M${a.cx} ${a.mid}H${out}V${gap}H${into}V${b.mid}H${b.cx}`);
  }
  svg.setAttribute('viewBox', `0 0 ${base.width} ${base.height}`);
  svg.innerHTML = `<path d="${d.join('')}"/>`;
}

// --- Inspector ---

/**
 * @param {string} label
 * @param {Child} control
 * @param {string | null} [hint]
 */
const field = (label, control, hint) => h('label', null, label, control, hint ? h('span', { class: 'muted small' }, hint) : null);

// --- Variables in fields ---
// A field that takes {{…}} remembers the cursor, so a variable chip or a key in the test data goes in where it is.
// Saving goes through the field's change handler; the re-render keeps its focus and cursor (keep-fields).

// Puts `{{name}}` in the field at its cursor (or its end, when it never had focus) and saves it.
/**
 * @param {string} key
 * @param {string} name
 */
function insertVar(key, name) {
  // A field varField() made.
  const el = /** @type {HTMLInputElement | HTMLTextAreaElement | null} */ (document.querySelector(`[data-var-field="${CSS.escape(key)}"]`));
  if (!el) return false;
  // A field on its Preview tab goes back to Edit, so the variable is seen going in.
  if (el.hidden) /** @type {HTMLButtonElement | null | undefined} */ (el.closest('.cron-col')?.querySelector('[data-tab="edit"]'))?.click();
  const token = `{{${name}}}`;
  const at = view.cursor?.key === key ? view.cursor : { start: el.value.length, end: el.value.length };
  el.focus();
  el.setRangeText(token, Math.min(at.start, el.value.length), Math.min(at.end, el.value.length), 'end');
  // setRangeText leaves a selection, so it has an end.
  view.cursor = { key, start: /** @type {number} */ (el.selectionEnd), end: /** @type {number} */ (el.selectionEnd) };
  el.dispatchEvent(new Event('change'));
  return true;
}

// Claude Code's skills per folder, read through the runner for a Dev step's skill picker. A folder is read again
// after STALE_SKILLS_MS, and the page redrawn only when what it lists changed.
const STALE_SKILLS_MS = 30000;
/** @type {Map<string, { data: RunnerSkills | null, json: string, error: string, at: number, loading: boolean }>} */
const skillCache = new Map();

/** @param {Store} store @param {string} path */
function skillsFor(store, path) {
  let entry = skillCache.get(path);
  if (!entry) skillCache.set(path, (entry = { data: null, json: '', error: '', at: 0, loading: false }));
  const e = entry;
  if (!e.loading && Date.now() - e.at > STALE_SKILLS_MS) {
    e.loading = true;
    listSkills(runnerOf(store), path)
      .then((data) => {
        const json = JSON.stringify(data);
        if (json === e.json && !e.error) return false;
        Object.assign(e, { data, json, error: '' });
        return true;
      }, (/** @type {Error} */ err) => {
        if (err.message === e.error) return false;
        e.error = err.message;
        return true;
      })
      .then((changed) => {
        Object.assign(e, { loading: false, at: Date.now() });
        if (changed) store.refresh();
      });
  }
  return e;
}

// Puts /<skill> at the start of a Dev prompt, where claude reads it as the skill to run. A skill already there is
// replaced; the rest of the prompt stays, as its arguments.
/** @param {string} key @param {string} name */
function putSkill(key, name) {
  const el = /** @type {HTMLTextAreaElement | null} */ (document.querySelector(`[data-var-field="${CSS.escape(key)}"]`));
  if (!el) return;
  if (el.hidden) /** @type {HTMLButtonElement | null | undefined} */ (el.closest('.cron-col')?.querySelector('[data-tab="edit"]'))?.click();
  const head = `/${name} `;
  el.value = head + el.value.replace(/^\s*\/[\w:.-]+[ \t]*/, '');
  el.focus();
  el.setSelectionRange(head.length, head.length);
  view.cursor = { key, start: head.length, end: head.length };
  el.dispatchEvent(new Event('change'));
}

// The Dev step's skill picker: the folder's skills, then the user's own, as Dev's Skills panel lists them.
/** @param {Store} store @param {string} path @param {string} key */
function skillPick(store, path, key) {
  const { data, error } = skillsFor(store, path);
  const all = data ? [...data.project, ...data.global.filter((g) => !data.project.some((p) => p.name === g.name))] : [];
  const hint = error
    ? `Could not read the skills: ${error}`
    : !data ? 'Reading the skills…' : all.length ? null : 'No skills in ~/.claude/skills or the folder’s .claude/skills.';
  return field('Skill', pickButton({
    label: 'Add a skill',
    title: 'Start the Dev prompt with a skill, as /<skill>',
    options: all.map((s) => ({ value: s.name, label: `/${s.name}`, plainIcon: () => icon('zap') })),
    onPick: (name) => putSkill(key, name),
  }), hint);
}

// Chips and tree keys keep the field's focus: a click that blurred it would save and re-render first, losing the click.
/** @param {Event} e */
const keepFocus = (e) => e.preventDefault();

// The project's parts a field offers as chips; the test input lists the rest ({{project.domain}}, {{project.repos}}…).
const PROJECT_NAMES = [
  ['project', 'The project’s name'],
  ['project.website', 'The project’s website'],
  ['project.repo', 'The project’s first GitHub repo, as owner/repo'],
  ['project.directory', 'The project’s local folder'],
  ['project.description', 'The project’s description'],
];

// What a Dev step that waits for its terminal passes on, offered as chips to the steps after it.
const DEV_PARTS = [
  ['pr.url', 'The pull request the terminal opened'],
  ['branch', 'The branch it worked on'],
  ['commit', 'Its last commit'],
  ['files', 'The files it changed'],
];

// What a step a loop repeats can read of the item it is on.
const LOOP_NAMES = [
  ['item', 'The item the loop is on; add a path for a part of it, such as {{item.title}}'],
  ['index', 'The item’s number, from 1'],
  ['count', 'How many items the loop runs'],
];

// The variables a step can use: the usual ones, the project's when it has one, then every earlier step by number.
/**
 * @param {CronFlow} flow
 * @param {number} index
 * @param {string[][]} [extra]
 * @param {string} [projectId]
 * @returns {string[][]}
 */
function varNames(flow, index, extra = [], projectId = withFlowProject(flow, flow.steps[index] ?? {}).projectId) {
  return [
    ['input', 'The previous step’s output'],
    ['date', 'The day of the run'],
    ['flow', 'The flow’s name'],
    ...(projectId ? PROJECT_NAMES : []),
    ...(loopOf(flow, index) >= 0 ? LOOP_NAMES : []),
    ...extra,
    ...flow.steps.slice(0, index).flatMap((s, i) => [
      [`step${i + 1}`, `Output of step ${i + 1}, ${typeOf(s.type)[1]}`],
      ...(s.type === 'dev' && devWaits(flow, s) ? DEV_PARTS.map(([k, about]) => [`step${i + 1}.${k}`, `${about} (step ${i + 1})`]) : []),
      ...(s.type === 'dev' && devWaits(flow, s) && devJson(flow, s) ? [[`step${i + 1}.json`, `The JSON of its final output (step ${i + 1})`]] : []),
    ]),
  ];
}

// A field that takes variables, with its variables under it as chips. A text area given `vars` (a function, so
// the values are only worked out when asked) gets Edit and Preview tabs: Preview shows the text with each {{…}}
// filled from the test data or the last run.
/**
 * @param {string} label
 * @param {HTMLInputElement | HTMLTextAreaElement} control
 * @param {string} key
 * @param {string[][]} names
 * @param {string | null} [hint]
 * @param {() => Vars} [vars]
 */
function varField(label, control, key, names, hint, vars) {
  control.dataset.varField = key;
  const remember = () => {
    view.cursor = { key, start: control.selectionStart ?? control.value.length, end: control.selectionEnd ?? control.value.length };
    view.field = key;
  };
  for (const ev of ['focus', 'keyup', 'mouseup', 'select']) control.addEventListener(ev, remember);
  const chips = h('div', { class: 'cron-vars', role: 'group', 'aria-label': `Variables for ${label}` },
    names.map(([name, title]) => h('button', {
      type: 'button', class: 'cron-var', title, onmousedown: keepFocus, onclick: () => insertVar(key, name),
    }, `{{${name}}}`)));
  if (!vars || control.tagName !== 'TEXTAREA') return h('div', { class: 'cron-col' }, field(label, control, hint), chips);

  control.setAttribute('aria-label', label);
  const box = h('div', { class: 'cron-preview-wrap stack' });
  const tabs = [['edit', 'Edit'], ['preview', 'Preview']].map(([tab, text]) =>
    h('button', { type: 'button', role: 'tab', class: 'sub-tab', 'data-tab': tab, onclick: () => show(tab === 'preview') }, text));
  // Switched in place: a re-render would save the field first and lose its cursor.
  /** @param {boolean} on */
  const sync = (on) => {
    control.hidden = on;
    box.hidden = !on;
    tabs.forEach((b) => {
      const active = (b.dataset.tab === 'preview') === on;
      b.classList.toggle('active', active);
      b.setAttribute('aria-selected', String(active));
    });
    // Only text areas with vars get here.
    if (on) box.replaceChildren(...previewOf(control.value, /** @type {() => Vars} */ (vars)()));
  };
  /** @param {boolean} on */
  const show = (on) => {
    if (on) view.preview.add(key);
    else view.preview.delete(key);
    sync(on);
    if (!on) control.focus();
  };
  const out = h('div', { class: 'cron-col' },
    h('div', { class: 'row between cron-field-head' },
      h('span', { class: 'cron-field-label' }, label),
      h('div', { class: 'sub-tabs cron-field-tabs', role: 'tablist', 'aria-label': `${label} view` }, tabs)),
    control, box,
    hint ? h('span', { class: 'muted small' }, hint) : null,
    chips);
  sync(view.preview.has(key));
  return out;
}

// The text as a step would send it: filled variables marked, the ones with no value yet left as written.
/**
 * @param {string} text
 * @param {Vars} vars
 */
function previewOf(text, vars) {
  const parts = fillParts(text, vars);
  const missing = [...new Set(parts.filter((p) => p.missing).map((p) => p.name))];
  return [
    h('pre', { class: 'cron-preview' }, parts.length
      ? parts.map((p) => (p.name
        ? h('span', { class: p.missing ? 'cron-fill missing' : 'cron-fill', title: p.missing ? `${p.name}: no value yet` : p.name }, p.text || ' ')
        : p.text))
      : h('span', { class: 'muted' }, 'Empty')),
    missing.length
      ? h('p', { class: 'muted small' }, `No value yet for ${missing.join(', ')}. Test the steps before this one to fill ${missing.length > 1 ? 'them' : 'it'}.`)
      : h('p', { class: 'muted small' }, 'Filled with the test data, else the last run.'),
  ];
}

// Folds opened or closed by hand, by tree and key path, so a re-render (a test's terminal reports every second)
// does not open a fold again just after it was closed.
/** @type {Map<string, boolean>} */
const folds = new Map();

// Each tree's scroll, by tree, put back once a re-render's new tree is on the page, so it does not jump to the top.
/** @type {Map<string, number>} */
const scrolls = new Map();

/** @param {string} fold @param {...import("../../types/ui").Child} children */
function treeBox(fold, ...children) {
  const el = h('div', {
    class: 'json-tree',
    onscroll: (/** @type {Event} */ e) => scrolls.set(fold, /** @type {HTMLElement} */ (e.currentTarget).scrollTop),
  }, ...children);
  const top = scrolls.get(fold);
  if (top) requestAnimationFrame(() => { if (el.isConnected) el.scrollTop = top; });
  return el;
}

/** @param {unknown} value */
const copyable = (value) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2) ?? String(value));
/** @param {string} text @param {string} what */
const copyText = (text, what) => navigator.clipboard.writeText(text).then(() => toast(`Copied ${what}`), () => toast('Could not copy'));
/** @param {unknown} value @param {string} label */
const copyButton = (value, label) => h('button', {
  type: 'button', class: 'json-copy', title: `Copy ${label}`, 'aria-label': `Copy ${label}`,
  onclick: (/** @type {Event} */ e) => {
    e.preventDefault(); // inside a summary, a click would fold the node too
    copyText(copyable(value), label);
  },
}, icon('copy'));

// A JSON value as a folding tree. A key's click gives its variable path to `pick`; with no path it is not clickable.
// `fold` names the node among the tree's folds; each value can be copied whole.
/**
 * @param {unknown} value
 * @param {string | null} path
 * @param {((path: string) => void) | null} pick
 * @param {number} [depth]
 * @param {string} [fold]
 * @returns {(label: string) => HTMLElement}
 */
function jsonTree(value, path, pick, depth = 0, fold = '') {
  /** @param {string} label */
  const keyButton = (label) => (path && pick
    ? h('button', { type: 'button', class: 'json-key', title: `{{${path}}}`, onmousedown: keepFocus, onclick: () => pick(path) }, label)
    : h('span', { class: 'json-key' }, label));
  return (label) => {
    const at = `${fold}/${label}`;
    if (value !== null && typeof value === 'object') {
      const entries = Array.isArray(value) ? value.map((v, i) => [i, v]) : Object.entries(value);
      return h('details', {
        class: 'json-node', open: folds.get(at) ?? depth < 2,
        ontoggle: (/** @type {Event & { target: HTMLDetailsElement }} */ e) => folds.set(at, e.target.open),
      },
        h('summary', null, keyButton(label), h('span', { class: 'muted small' }, Array.isArray(value) ? ` [${entries.length}]` : ` {${entries.length}}`), copyButton(value, label)),
        h('ul', null, entries.map(([k, v]) => h('li', null, jsonTree(v, path ? pathTo(path, k) : null, pick, depth + 1, at)(String(k))))));
    }
    const text = typeof value === 'string' ? JSON.stringify(value.length > 300 ? `${value.slice(0, 300)}…` : value) : String(value);
    return h('div', { class: 'json-leaf' }, keyButton(label), h('span', { class: `json-value json-${value === null ? 'null' : typeof value}` }, text), copyButton(value, label));
  };
}

// The tree of everything a step can read, picking into the field last focused.
/** @param {Vars} vars @param {string} fold */
function inputTree(vars, fold) {
  const tree = varsTree(vars);
  /** @param {string} path */
  const pick = (path) => {
    if (!view.field || !insertVar(view.field, path)) toast('Click in a field first, then on the key to add.');
  };
  return treeBox(fold, Object.entries(tree).map(([k, v]) => jsonTree(v, k, pick, 0, fold)(k)));
}

/**
 * @param {string | number | null | undefined} value
 * @param {string[][]} options
 * @param {(value: string) => void} onchange
 * @param {object} [attrs]
 */
function select(value, options, onchange, attrs = {}) {
  return h('select', { ...attrs, value: String(value ?? ''), onchange: (/** @type {FieldEvent} */ e) => onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: String(v) }, l)));
}

// A searchable project list with each project's icon, since a board with many projects makes a plain dropdown long.
// `none` labels the empty choice; `list` narrows the projects and `name` changes how one reads.
/**
 * @typedef {{ list?: Project[], name?: (p: Project) => string }} ProjectPickOptions
 */
/**
 * @param {Store} store
 * @param {string | undefined} value
 * @param {string} none
 * @param {(id: string) => void} onPick
 * @param {ProjectPickOptions} [options]
 */
function projectPick(store, value, none, onPick, { list = projectsOf(store), name = (p) => p.name } = {}) {
  return pickChip({
    value: value || null,
    options: list.map((p) => ({ value: p.id, label: name(p), plainIcon: () => projectIcon(p) })),
    nullable: true,
    nullLabel: none,
    className: 'field-pick project-field-pick',
    onPick: (v) => onPick(v ?? ''),
  });
}

// A step's own project: empty follows the flow's, so most steps never need one.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {string | undefined} value
 * @param {(id: string) => void} onPick
 * @param {ProjectPickOptions & { none?: string }} [options]
 */
function stepProjectPick(store, flow, value, onPick, { none = 'None', ...opts } = {}) {
  const fp = flowProjectId(flow);
  return projectPick(store, value === fp ? '' : value, fp ? `Flow’s project (${projectName(store, fp)})` : none, onPick, opts);
}

/**
 * @param {string} label
 * @param {boolean} on
 * @param {() => void} onclick
 * @param {string} title
 */
const chip = (label, on, onclick, title) =>
  h('button', { type: 'button', class: on ? 'cron-day on' : 'cron-day', 'aria-pressed': String(on), title, onclick }, label);
/**
 * @template T
 * @param {T[]} list
 * @param {T} v
 */
const toggled = (list, v) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v]);
/**
 * @param {string} label
 * @param {() => void} onclick
 */
const shortcut = (label, onclick) => h('button', { type: 'button', class: 'btn-link small', onclick }, label);

// A time an hour after the last one that is not taken yet, for "Add a time".
// timesOf() always gives one time at least.
/** @param {string[]} times */
function freeTime(times) {
  const [hh, mm] = /** @type {string} */ (times.at(-1)).split(':').map(Number);
  for (let i = 1; i < 24; i++) {
    const t = `${String((hh + i) % 24).padStart(2, '0')}:${String(mm).padStart(2, '0')}`;
    if (!times.includes(t)) return t;
  }
  return /** @type {string} */ (times.at(-1));
}

/**
 * @param {CronSchedule} s
 * @param {(patch: Partial<CronSchedule>) => void} set
 */
function timesField(s, set) {
  const times = timesOf(s);
  /** @param {string[]} list */
  const save = (list) => {
    const next = [...new Set(list.filter(validTime))].sort();
    if (next.length) set({ times: next, time: next[0] });
  };
  return h('div', { class: 'cron-days', role: 'group', 'aria-label': 'Times' },
    h('span', { class: 'muted small' }, 'At'),
    times.map((t, i) => h('span', { class: 'cron-time' },
      h('input', { type: 'time', value: t, 'aria-label': `Time ${i + 1}`, onchange: (/** @type {FieldEvent} */ e) => save(times.map((x, j) => (j === i ? e.target.value : x))) }),
      times.length > 1
        ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove this time', 'aria-label': `Remove ${t}`, onclick: () => save(times.filter((_, j) => j !== i)) }, icon('x'))
        : null)),
    shortcut('Add a time', () => save([...times, freeTime(times)])));
}

// Live check of the expression while typing; the flow saves it on change, so typing never re-renders the form.
/** @param {string} expr */
function cronHint(expr) {
  const err = cronError(expr);
  if (err) return h('span', { class: 'cron-error' }, err);
  const next = upcomingSlots({ every: 'custom', cron: expr }, 3);
  if (!next.length) return h('span', { class: 'cron-error' }, 'This expression never matches a date.');
  return h('span', null, `Next: ${next.map((d) => timeOf(d.toISOString())).join(' · ')}`);
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function triggerForm(store, flow) {
  const s = flow.schedule;
  /** @param {Partial<CronSchedule>} patch */
  const set = (patch) => updateFlow(store, flow.id, (f) => Object.assign(f.schedule, patch));
  // Flows saved as "weekly" (one day) edit as chosen days.
  const every = s.every === 'weekly' ? 'days' : s.every;
  /** @param {string} next */
  const repeat = (next) => {
    if (next === 'custom' && !String(s.cron ?? '').trim()) set({ every: next, cron: cronOf(s) });
    else if (next === 'days' && s.every === 'weekly') set({ every: next, days: /** @type {number[]} */ (daysOf(s)) });
    else set({ every: next });
  };
  // Never null for 'weekly' or 'days'.
  const days = /** @type {number[]} */ (daysOf({ ...s, every: s.every === 'weekly' ? 'weekly' : 'days' }));
  /** @param {number[]} list */
  const setDays = (list) => list.length && set({ every: 'days', days: list });
  const monthDays = monthDaysOf(s);
  const months = (s.months ?? []).length ? monthsOf(s) : [];
  const hint = h('p', { class: 'muted small' }, every === 'custom' ? cronHint(s.cron ?? '') : null);
  return h('div', { class: 'stack' },
    h('div', { class: 'row cron-fields' },
      field('Repeat', select(every, REPEATS, repeat)),
      every === 'interval'
        ? field('Minutes between runs', h('input', { type: 'number', min: 5, step: 5, value: String(s.minutes ?? 60), onchange: (/** @type {FieldEvent} */ e) => set({ minutes: Math.max(5, Number(e.target.value) || 60) }) }))
        : null,
      every === 'custom'
        ? field('Cron expression', h('input', {
            class: 'mono-text', value: s.cron ?? '', autocomplete: 'off', spellcheck: 'false', placeholder: '0 9 * * 1-5',
            oninput: (/** @type {FieldEvent} */ e) => hint.replaceChildren(cronHint(e.target.value)),
            onchange: (/** @type {FieldEvent} */ e) => set({ cron: e.target.value.trim().replace(/\s+/g, ' ') }),
          }))
        : null),
    every === 'days'
      ? h('div', { class: 'cron-days', role: 'group', 'aria-label': 'Days of the week' },
          [1, 2, 3, 4, 5, 6, 0].map((d) => chip(SHORT_DAYS[d], days.includes(d), () => setDays(toggled(days, d)), WEEKDAYS[d])),
          shortcut('Weekdays', () => setDays([1, 2, 3, 4, 5])),
          shortcut('Weekends', () => setDays([0, 6])),
          shortcut('Every day', () => setDays([0, 1, 2, 3, 4, 5, 6])))
      : null,
    every === 'monthly'
      ? h('div', { class: 'stack' },
          h('div', { class: 'cron-days cron-month', role: 'group', 'aria-label': 'Days of the month' },
            Array.from({ length: 31 }, (_, i) => i + 1).map((d) => chip(String(d), monthDays.includes(d), () => {
              const next = toggled(monthDays, d);
              if (next.length) set({ monthDays: next, day: Math.min(...next) });
            }, `Day ${d}`))),
          h('span', { class: 'muted small' }, 'A day the month lacks runs on its last day.'),
          h('div', { class: 'cron-days', role: 'group', 'aria-label': 'Months' },
            SHORT_MONTHS.map((m, i) => chip(m, !months.length || months.includes(i), () => {
              const next = toggled(months.length ? months : MONTHS.map((_, j) => j), i);
              if (next.length) set({ months: next.length === 12 ? [] : next });
            }, MONTHS[i])),
            shortcut('Every month', () => set({ months: [] }))))
      : null,
    every !== 'interval' && every !== 'custom' ? timesField(s, set) : null,
    every === 'interval'
      ? h('div', { class: 'row cron-fields' },
          field('Active from', h('input', { type: 'time', value: s.from ?? '', onchange: (/** @type {FieldEvent} */ e) => set({ from: e.target.value }) })),
          field('Until', h('input', { type: 'time', value: s.to ?? '', onchange: (/** @type {FieldEvent} */ e) => set({ to: e.target.value }) }), 'Leave both empty to run around the clock.'))
      : null,
    every === 'custom'
      ? h('p', { class: 'muted small' },
          'Five fields: minute, hour, day of the month, month, day of the week. Use * for any, lists (1,15), ranges (9-17), steps (*/15) and names (mon-fri, jan). ',
          '@hourly, @daily, @weekly and @monthly work too. When both day fields are set, a day matching either one runs.')
      : null,
    hint,
    h('p', { class: 'muted small' },
      flow.enabled ? `Next run: ${timeOf(nextRun(flow)?.toISOString())}. ` : 'The flow is paused. ',
      'Flows run in the runners, whether or not the board is open, while bun start runs. A run missed while they were stopped (or the Mac slept) happens once when they start again.'));
}

/** @type {Record<string, string | null>} */
const SOURCE_ABOUT = {
  page: 'Read through the r.jina.ai page reader when the flow runs, as text with its headings and links, without images. Long pages are cut at about 12,000 characters, linked pages at about 4,000 each.',
  history: 'The final output of this flow’s last successful runs (not test runs), so the AI can avoid repeating itself.',
  flow: 'The final output of that flow’s last successful run (not a test run).',
  text: null,
};

// The searchable list of sources, each with its icon.
/**
 * @param {string} value
 * @param {(source: string) => void} onPick
 */
const sourcePick = (value, onPick) => pickChip({
  value,
  options: SOURCES.map(([v, label, name]) => ({ value: v, label, plainIcon: () => icon(name) })),
  className: 'field-pick',
  onPick,
});

// One source of a data step: what it reads, its settings, and the label that heads its data.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronSource} own
 * @param {{ setSource: (id: string, patch: Partial<CronSource>) => void, remove: (() => void) | null }} actions
 */
function sourceCard(store, flow, own, { setSource, remove }) {
  /** @param {Partial<CronSource>} patch */
  const set = (patch) => setSource(own.id, patch);
  const src = withFlowProject(flow, own);
  const about = src.source in SOURCE_ABOUT ? SOURCE_ABOUT[src.source] : 'Read from your board when the flow runs, as plain text for the next step.';
  const otherFlows = store.get(COLLECTION).flows.filter((f) => f.id !== flow.id);
  return h('div', { class: 'cron-source stack' },
    h('div', { class: 'row cron-fields' },
      field('Source', sourcePick(src.source, (source) => set({ source }))),
      src.source === 'project' ? field('Project', stepProjectPick(store, flow, own.projectId, (projectId) => set({ projectId }), { none: 'Choose…' })) : null,
      src.source === 'page' ? field('Project', stepProjectPick(store, flow, own.projectId, (projectId) => set({ projectId }), { none: 'None: use the link below' })) : null,
      src.source === 'history'
        ? field('How many runs', h('input', { type: 'number', min: 1, max: 20, value: String(src.count ?? 5), onchange: (/** @type {FieldEvent} */ e) => set({ count: Math.min(20, Math.max(1, Number(e.target.value) || 5)) }) }))
        : null,
      src.source === 'flow'
        ? field('Flow', pickChip({
            value: src.flowId || null,
            options: otherFlows.map((f) => ({ value: f.id, label: f.name, plainIcon: () => icon('repeat') })),
            placeholder: otherFlows.length ? 'Choose…' : 'No other flow',
            className: 'field-pick',
            onPick: (flowId) => set({ flowId: flowId ?? '' }),
          }))
        : null,
      remove ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove source', 'aria-label': 'Remove source', onclick: remove }, icon('trash')) : null),
    src.source === 'page'
      ? varField(src.projectId ? 'Path or link (optional)' : 'Link',
          h('input', { value: src.url ?? '', autocomplete: 'off', placeholder: src.projectId ? '/blog or https://docs.example.com' : 'example.com/blog', onchange: (/** @type {FieldEvent} */ e) => set({ url: e.target.value.trim() }) }),
          `${own.id}:url`, src.projectId ? PROJECT_NAMES.slice(1, 3).concat([['project.repoUrl', 'The project’s first GitHub repo, as a link']]) : [],
          src.projectId ? 'Empty reads the project’s website. A path such as /blog reads that page of it; a full link reads any page, such as {{project.repoUrl}}.' : null)
      : null,
    src.source === 'page'
      ? field('Linked pages to read too',
          h('input', { type: 'number', min: 0, max: MAX_FOLLOW, value: String(src.follow ?? 0), onchange: (/** @type {FieldEvent} */ e) => set({ follow: Math.min(MAX_FOLLOW, Math.max(0, Math.round(Number(e.target.value) || 0))) }) }),
          'Also reads the best pages of the same site it links to, such as a blog’s latest posts or a site’s main sections, so the next step gets their content and not only a list of links. 0 reads this page alone.')
      : null,
    src.source === 'text'
      ? varField('Text', h('textarea', { rows: 4, onchange: (/** @type {FieldEvent} */ e) => set({ text: e.target.value }) }, src.text ?? ''), `${own.id}:text`,
          varNames(flow, flow.steps.findIndex((s) => sourcesOf(s).some((x) => x.id === own.id)), [], src.projectId), null,
          () => previewVars(store, flow, flow.steps.find((s) => sourcesOf(s).some((x) => x.id === own.id)), src.projectId))
      : null,
    field('Label (optional)',
      h('input', { value: src.label ?? '', autocomplete: 'off', placeholder: sourceLabel(store, { ...src, label: '' }), onchange: (/** @type {FieldEvent} */ e) => set({ label: e.target.value.trim() }) })),
    about ? h('p', { class: 'muted small' }, about) : null);
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
function gatherForm(store, flow, step) {
  const sources = sourcesOf(step);
  // Edits move a step saved with one source on the step itself to the list form.
  /** @param {(list: CronSource[]) => CronSource[] | void} mutate */
  const edit = (mutate) => updateFlow(store, flow.id, (f) => {
    const s = f.steps.find((x) => x.id === step.id);
    if (!s) return;
    const list = sourcesOf(s).map((x) => ({ ...x }));
    for (const k of /** @type {const} */ (['source', 'projectId', 'url', 'text', 'count'])) delete s[k];
    s.sources = mutate(list) ?? list;
  });
  /**
   * @param {string} id
   * @param {Partial<CronSource>} patch
   */
  const setSource = (id, patch) => edit((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const index = flow.steps.indexOf(step);
  return h('div', { class: 'stack' },
    sources.map((src) => sourceCard(store, flow, src, {
      setSource,
      remove: sources.length > 1 ? () => edit((list) => list.filter((x) => x.id !== src.id)) : null,
    })),
    h('div', null,
      h('button', { type: 'button', class: 'btn-small', onclick: () => edit((list) => [...list, makeSource('page')]) }, icon('plus'), ' Add a source')),
    sources.length > 1 ? h('p', { class: 'muted small' }, 'Each source’s data goes under a heading with its label, in this order.') : null,
    index > 0
      ? h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: Boolean(step.append), onchange: (/** @type {FieldEvent} */ e) => updateFlow(store, flow.id, (f) => { const s = f.steps.find((x) => x.id === step.id); if (s) s.append = e.target.checked; }) }),
          ' Add to the previous step’s output instead of replacing it')
      : null);
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 */
function stepForm(store, flow, step) {
  /** @param {Partial<CronStep>} patch */
  const set = (patch) => updateFlow(store, flow.id, (f) => Object.assign(f.steps.find((x) => x.id === step.id) ?? {}, patch));
  const names = varNames(flow, flow.steps.indexOf(step));
  /** @param {string} name */
  const key = (name) => `${step.id}:${name}`;
  const vars = () => previewVars(store, flow, step);
  if (step.type === 'gather') return gatherForm(store, flow, step);
  if (step.type === 'ai') {
    return h('div', { class: 'stack' },
      varField('Prompt', h('textarea', { rows: 6, class: 'mono-text', onchange: (/** @type {FieldEvent} */ e) => set({ prompt: e.target.value }) }, step.prompt), key('prompt'), names,
        'Ask for JSON to pick its parts in later steps, such as {{step2.title}}.', vars),
      varField('System instructions (optional)', h('textarea', { rows: 2, onchange: (/** @type {FieldEvent} */ e) => set({ system: e.target.value }) }, step.system ?? ''), key('system'), names, null, vars),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'Model'),
        modelChip({ value: step.model, nullable: true, nullLabel: `Default (${modelForTask(store, AI_TASK) || 'not set'})`, onPick: (model) => set({ model: model ?? '' }) })),
      store.get('settings').openrouter?.key ? null : notice({ tone: 'info', text: 'AI steps need an OpenRouter key.', actions: [h('a', { href: '#/settings?section=openrouter', class: 'btn-link' }, 'Add a key')] }));
  }
  if (step.type === 'task') {
    return h('div', { class: 'stack' },
      varField('Task title', h('input', { value: step.title, autocomplete: 'off', onchange: (/** @type {FieldEvent} */ e) => set({ title: e.target.value }) }), key('title'), names,
        'The first line is used.'),
      varField('Description', h('textarea', { rows: 6, class: 'mono-text', onchange: (/** @type {FieldEvent} */ e) => set({ description: e.target.value }) }, step.description ?? '{{input}}'), key('description'), names,
        'Markdown is fine. {{input}} is the output of the step before.', vars),
      h('div', { class: 'row cron-fields' },
        field('Project', stepProjectPick(store, flow, step.projectId, (projectId) => set({ projectId }), { none: 'Personal' })),
        field('Priority', select(step.priority, [['none', 'No priority'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (priority) => set({ priority }))),
        field('Due', select(step.due, [['', 'No deadline'], ['today', 'Day of the run'], ['tomorrow', 'Day after the run']], (due) => set({ due })))));
  }
  if (step.type === 'stop') {
    const needsText = step.when === 'contains' || step.when === 'lacks';
    return h('div', { class: 'stack' },
      h('div', { class: 'row cron-fields' },
        field('Stop when', select(step.when, STOP_WHEN, (when) => set({ when }))),
        needsText ? field('Words', h('input', { value: step.text ?? '', autocomplete: 'off', onchange: (/** @type {FieldEvent} */ e) => set({ text: e.target.value }) }), 'Not case-sensitive.') : null),
      h('p', { class: 'muted small' }, 'The run ends here without counting as a failure, and the steps after this one are skipped. Put it after a data step to stay quiet when there is nothing to report.'));
  }
  if (step.type === 'format') return formatForm(store, flow, step, set);
  if (step.type === 'parse') return parseForm(flow, step, set);
  if (step.type === 'loop') return loopForm(flow, step, set);
  if (step.type === 'profile') {
    const own = withFlowProject(flow, step).projectId;
    const readable = projectsOf(store).filter((p) => hasProfileSources(p) || p.id === own);
    return h('div', { class: 'stack' },
      h('div', { class: 'row cron-fields' },
        field('Project', stepProjectPick(store, flow, step.projectId, (projectId) => set({ projectId }), {
          none: 'Choose…',
          list: readable, name: (p) => (hasProfileSources(p) ? p.name : `${p.name} (nothing to read)`),
        }), 'Projects show here once they have a local folder, a repository or a website.'),
        field('When I edited it by hand', select(profileEditedMode(step), PROFILE_EDITED, (onEdited) => set({ onEdited })))),
      h('p', { class: 'muted small' },
        'Reads the project’s README, docs and recent commits through the runner, its GitHub repos and its website, then asks the model once and saves the profile on the project, as Refresh does in Projects. ',
        'Its output is the new profile. A profile you edited by hand never stops the run: by default the model updates it and keeps your edits. A test only says what it would do; “Test run” of the flow rebuilds it.'),
      store.get('settings').openrouter?.key ? null : notice({ tone: 'info', text: 'Profiles need an OpenRouter key.', actions: [h('a', { href: '#/settings?section=openrouter', class: 'btn-link' }, 'Add a key')] }));
  }
  if (step.type === 'dev') {
    const claude = step.mode !== 'command';
    const own = withFlowProject(flow, step).projectId;
    const folders = projectsOf(store).filter((p) => p.localPath || p.id === own);
    const hasTask = flow.steps.slice(0, flow.steps.indexOf(step)).some((s) => s.type === 'task');
    const options = devRunOptions(store);
    const value = devRunValue(step);
    // A preset removed in Settings still shows as chosen, so the step does not silently change what it runs.
    if (!options.some(([v]) => v === value)) options.splice(1, 0, [value, 'Removed preset']);
    /** @param {string} v */
    const run = (v) => {
      if (v.startsWith('preset:')) return set({ mode: 'preset', preset: v.slice(7) });
      // A custom command starts from what the step ran until now, so it only needs the change.
      if (v === 'custom' && !String(step.devCommand ?? '').trim()) return set({ mode: v, devCommand: devCommandPreview(store, flow, { ...step, mode: 'claude' }) });
      return set({ mode: v });
    };
    const preview = claude && step.mode !== 'custom' ? devCommandPreview(store, flow, step) : '';
    const waits = devWaits(flow, step);
    const last = flow.steps.at(-1)?.id === step.id;
    const devNames = varNames(flow, flow.steps.indexOf(step), [['task', 'The task made above: its title and description']]);
    return h('div', { class: 'stack' },
      h('div', { class: 'row cron-fields' },
        field('Run', pickChip({
          value,
          options: options.map(([v, label]) => ({ value: v, label, plainIcon: () => icon(v === 'command' ? 'terminal' : v === 'custom' ? 'code' : v.startsWith('preset:') ? 'sparkle' : 'play') })),
          className: 'field-pick',
          onPick: (v) => v && run(v),
        })),
        field('Folder', stepProjectPick(store, flow, step.projectId, (projectId) => set({ projectId }), {
          none: 'The task’s project, else this board',
          list: folders, name: (p) => (p.localPath ? p.name : `${p.name} (no local folder)`),
        }), 'Projects show here once they have a local folder.'),
        claude ? skillPick(store, projectsOf(store).find((p) => p.id === own)?.localPath ?? '', key('prompt')) : null),
      step.mode === 'custom'
        ? field('Dev command', h('input', { value: step.devCommand ?? '', class: 'mono-text', autocomplete: 'off', spellcheck: false, onchange: (/** @type {FieldEvent} */ e) => set({ devCommand: e.target.value }) }),
            'The Dev prompt is passed to it as its last word. A bare --worktree gets a name, as from a task.')
        : null,
      preview ? h('code', { class: 'muted small' }, preview) : null,
      claude
        ? varField('Dev prompt', h('textarea', { rows: 13, class: 'mono-text', onchange: (/** @type {FieldEvent} */ e) => set({ prompt: e.target.value }) }, step.prompt ?? ''), key('prompt'), devNames, null, vars)
        : varField('Command', h('input', { value: step.command ?? '', class: 'mono-text', autocomplete: 'off', spellcheck: false, placeholder: 'npm run build', onchange: (/** @type {FieldEvent} */ e) => set({ command: e.target.value }) }), key('command'), devNames,
            'Each {{…}} goes in as one quoted word, so text from a model never runs as a command.'),
      h('div', { class: 'row cron-fields' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: waits, onchange: (/** @type {FieldEvent} */ e) => set({ wait: e.target.checked === !last ? undefined : e.target.checked }) }),
          ' Wait for the terminal to finish, and pass on what it did'),
        waits
          ? field('Wait at most (minutes)', h('input', {
              type: 'number', min: 1, max: 720, value: String(step.waitMinutes ?? DEV_WAIT_MINUTES),
              onchange: (/** @type {FieldEvent} */ e) => set({ waitMinutes: Math.min(720, Math.max(1, Math.round(Number(e.target.value) || DEV_WAIT_MINUTES))) }),
            }))
          : null),
      claude && devJsonOffered(flow, step)
        ? h('div', { class: 'stack' },
            h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: Boolean(step.json), onchange: (/** @type {FieldEvent} */ e) => set({ json: e.target.checked || undefined }) }),
              ' Ask for its final output as JSON, for the Run in Dev after it'),
            step.json
              ? h('p', { class: 'muted small' },
                  `Adds “${DEV_JSON_PROMPT}” to the end of the prompt. `,
                  waits
                    ? `The JSON it ends with is read back as {{step${flow.steps.indexOf(step) + 1}.json}}, and its keys with a path such as {{step${flow.steps.indexOf(step) + 1}.json.title}}.`
                    : 'Turn on waiting for the terminal to read it back.')
              : null)
        : null,
      h('p', { class: 'muted small' },
        waits
          ? 'The run waits until the terminal ends, or until claude is done and waits for you. The steps after it then get its branch, last commit, changed files, PR and the end of its output: {{input}} as text, or parts such as {{step' + String(flow.steps.indexOf(step) + 1) + '.pr.url}}, {{step' + String(flow.steps.indexOf(step) + 1) + '.branch}} and {{step' + String(flow.steps.indexOf(step) + 1) + '.files}}. '
          : 'The run moves on as soon as the terminal starts; it keeps going in Dev. ',
        last && !waits ? 'Add steps after it, such as another Run in Dev, to build on its work. ' : ''),
      h('p', { class: 'muted small' },
        claude ? 'The command starts in the folder, in a worktree of its own when it asks for one. ' : '',
        hasTask
          ? 'The task made above goes with it, as from its Dev button: it moves to In progress, and the issues and PRs the terminal prints are added to it. '
          : 'Put a “Create task” step before this one to follow the work from a task. ',
        'Needs the runner that bun start starts.'));
  }
  return h('div', { class: 'stack' },
    varField('Message', h('textarea', { rows: 4, onchange: (/** @type {FieldEvent} */ e) => set({ text: e.target.value }) }, step.text), key('text'), names, null, vars),
    h('p', { class: 'muted small' }, 'Sent to the bell, and to Telegram when Settings › Notifications says so for Cron flows.'));
}

// The variables a list's item text sees: those of the step, with {{item}} as the list's first item.
/**
 * @param {Vars} vars
 * @param {string | undefined} items
 */
function firstItemVars(vars, items) {
  const value = valueOf(items || '{{input}}', vars);
  const list = value === undefined ? [] : listOf(value);
  return list.length ? withItem(vars, { item: list[0], index: 0, count: list.length }) : vars;
}

const ITEMS_HINT = 'A variable holding a list, such as {{input}} or {{step2.items}}. A JSON list is read as it is; text gives one item per line, without its bullet.';

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {(patch: Partial<CronStep>) => void} set
 */
function formatForm(store, flow, step, set) {
  const index = flow.steps.indexOf(step);
  const names = varNames(flow, index);
  /** @param {string} name */
  const key = (name) => `${step.id}:${name}`;
  const vars = () => previewVars(store, flow, step);
  const mode = step.mode || 'text';
  const n = String(index + 1);
  /** @param {(list: CronFormatField[]) => CronFormatField[]} mutate */
  const editFields = (mutate) => updateFlow(store, flow.id, (f) => {
    const s = f.steps.find((x) => x.id === step.id);
    if (s) s.fields = mutate((s.fields ?? []).map((x) => ({ ...x })));
  });
  /**
   * @param {string} id
   * @param {Partial<CronFormatField>} patch
   */
  const setField = (id, patch) => editFields((list) => list.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const fields = step.fields ?? [];
  return h('div', { class: 'stack' },
    h('div', { class: 'row cron-fields' }, field('Make', select(mode, FORMAT_MODES, (m) => set({ mode: m })))),
    mode === 'text'
      ? varField('Text', h('textarea', { rows: 6, class: 'mono-text', onchange: (/** @type {FieldEvent} */ e) => set({ text: e.target.value }) }, step.text ?? '{{input}}'), key('text'), names,
          `The output as it should read: plain text, Markdown, or JSON whose keys later steps can pick, such as {{step${n}.title}}.`, vars)
      : null,
    mode === 'list'
      ? [
          varField('List', h('input', { value: step.items ?? '{{input}}', class: 'mono-text', autocomplete: 'off', spellcheck: false, onchange: (/** @type {FieldEvent} */ e) => set({ items: e.target.value.trim() }) }), key('items'), names, ITEMS_HINT),
          varField('Each item as', h('textarea', { rows: 2, class: 'mono-text', onchange: (/** @type {FieldEvent} */ e) => set({ itemText: e.target.value }) }, step.itemText ?? '{{item}}'), key('itemText'),
            [...LOOP_NAMES, ...names.filter(([name]) => !LOOP_NAMES.some(([l]) => l === name))],
            '{{item}} is the item, and {{item.title}} a part of it when it is JSON; {{index}} counts from 1. Preview shows the first item.',
            () => firstItemVars(vars(), step.items)),
          h('div', { class: 'row cron-fields' }, field('Between items', select(step.separator ?? 'line', SEPARATOR_OPTIONS, (separator) => set({ separator })))),
        ]
      : null,
    mode === 'fields'
      ? [
          fields.map((f) => h('div', { class: 'cron-source stack' },
            h('div', { class: 'row cron-fields' },
              field('Name', h('input', { value: f.name, autocomplete: 'off', spellcheck: false, placeholder: 'title', onchange: (/** @type {FieldEvent} */ e) => setField(f.id, { name: e.target.value.trim() }) })),
              fields.length > 1
                ? h('button', { type: 'button', class: 'icon-btn', title: 'Remove field', 'aria-label': 'Remove field', onclick: () => editFields((list) => list.filter((x) => x.id !== f.id)) }, icon('trash'))
                : null),
            varField('Value', h('input', { value: f.value, autocomplete: 'off', onchange: (/** @type {FieldEvent} */ e) => setField(f.id, { value: e.target.value }) }), key(`field:${f.id}`), names))),
          h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: () => editFields((list) => [...list, makeField()]) }, icon('plus'), ' Add a field')),
          h('p', { class: 'muted small' },
            `The output is one JSON object with these names as keys, so later steps read {{step${n}.title}}. `,
            'A value that is a single variable keeps it whole: {{step2.items}} stays a list. Other values are text.'),
        ]
      : null);
}

/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {(patch: Partial<CronStep>) => void} set
 */
function parseForm(flow, step, set) {
  const index = flow.steps.indexOf(step);
  const n = String(index + 1);
  return h('div', { class: 'stack' },
    varField('Text', h('input', { value: step.text ?? '{{input}}', class: 'mono-text', autocomplete: 'off', spellcheck: false, onchange: (/** @type {FieldEvent} */ e) => set({ text: e.target.value.trim() }) }),
      `${step.id}:text`, varNames(flow, index), 'The text to read, such as {{input}} or {{step2.answer}}.'),
    h('div', { class: 'row cron-fields' },
      field('When it holds several', select(step.mode || 'largest', PARSE_MODES, (mode) => set({ mode })))),
    h('p', { class: 'muted small' },
      'Reads the JSON out of text that is not only JSON: a code fence, prose around it, lines a terminal wrapped, or a copy cut off at either end, of which it keeps the whole parts (the items of a list, without the one cut in half). ',
      `Later steps read it as {{step${n}}} and its parts as {{step${n}.title}} or {{step${n}[0].title}}, and a Loop can go over its list. With no JSON in the text, the step fails.`));
}

/**
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {(patch: Partial<CronStep>) => void} set
 */
function loopForm(flow, step, set) {
  const index = flow.steps.indexOf(step);
  const span = loopSpan(flow, index);
  const after = flow.steps.length - index - 1;
  const want = Math.max(1, Math.round(Number(step.span) || 1));
  const range = span > 1 ? `Steps ${index + 2} to ${index + 1 + span} run` : `Step ${index + 2} runs`;
  return h('div', { class: 'stack' },
    varField('Items', h('input', { value: step.items ?? '{{input}}', class: 'mono-text', autocomplete: 'off', spellcheck: false, onchange: (/** @type {FieldEvent} */ e) => set({ items: e.target.value.trim() }) }),
      `${step.id}:items`, varNames(flow, index), ITEMS_HINT),
    h('div', { class: 'row cron-fields' },
      field('Steps to repeat', h('input', {
        type: 'number', min: 1, max: Math.max(1, after), value: String(want),
        onchange: (/** @type {FieldEvent} */ e) => set({ span: Math.max(1, Math.round(Number(e.target.value) || 1)) }),
      }), 'The steps right after this one.'),
      field('Items at most', h('input', {
        type: 'number', min: 1, max: LOOP_LIMIT, value: String(loopMax(step)),
        onchange: (/** @type {FieldEvent} */ e) => set({ max: Math.min(LOOP_LIMIT, Math.max(1, Math.round(Number(e.target.value) || 1))) }),
      }), 'The rest of a longer list is left out.')),
    !span
      ? notice({ tone: 'info', text: 'Add the steps to repeat after this one.' })
      : want > span
        ? h('p', { class: 'muted small' }, `Only ${span} step${span === 1 ? '' : 's'} can repeat here: a loop ends at the end of the flow or before another loop.`)
        : null,
    span
      ? h('p', { class: 'muted small' },
          `${range} once for each item. In them, {{item}} is the item ({{item.title}} reads a part of a JSON item), {{index}} its number from 1 and {{count}} how many there are; `,
          `step ${index + 2} reads the item as {{input}}. A “Stop if” among them skips the rest for that item only, and a failure on any item fails the run.`)
      : null,
    span
      ? h('p', { class: 'muted small' },
          'After the loop, each repeated step reads as the list of what it gave for every item: a JSON list when they gave JSON, else their texts one after the other. ',
          'A Format step making “One line per item” turns that list into clean text.')
      : null);
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {string} id
 * @param {number} by
 */
function moveStep(store, flow, id, by) {
  const i = flow.steps.findIndex((s) => s.id === id);
  const j = i + by;
  if (i < 0 || j < 0 || j >= flow.steps.length) return;
  moveStepTo(store, flow, id, by > 0 ? j + 1 : j);
}

// A test that fails on an earlier step leaves this one without data, so it says where it stopped.
// A Dev step's test starts its terminal, so its work can be watched; a test that only said what it would start
// would tell little.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {string} stepId
 */
function runTest(store, flow, stepId) {
  const live = flow.steps.find((s) => s.id === stepId)?.type === 'dev';
  testStep(store, flow.id, stepId, { live }).then((r) => {
    if (r && !r.ok) toast(`Test failed: ${r.output}`);
  });
}

// What a step could read before it was tested: earlier test data, else the last run's outputs.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {number} index
 */
function knownVars(store, flow, index) {
  const tested = testsOf(store, flow.id);
  const last = lastRunOf(store, flow.id);
  /** @type {Vars & { $data: Record<string, unknown> }} */
  const vars = { input: '', date: todayISO(), flow: flow.name, $data: {} };
  const step = flow.steps[index];
  const projectId = (step?.type !== 'gather' && step?.projectId) || flowProjectId(flow);
  const project = projectVars(store.get('projects').projects.find((p) => p.id === projectId));
  if (project) {
    vars.project = project.name;
    vars.$data.project = project;
  }
  /** @type {Map<string, { output: string, data: unknown }>} */
  const outs = new Map();
  // In a loop, the loop and the steps before this one in it read as on the first item.
  const at = loopOf(flow, index);
  /** @type {unknown[] | null} */
  let items = null;
  flow.steps.slice(0, index).forEach((s, i) => {
    const t = tested.get(s.id);
    const r = t?.ok ? t : last?.steps.find((x) => x.stepId === s.id && x.ok);
    let output = r?.output ?? '';
    let data = t?.ok ? t.data : parseData(output) ?? output;
    if (i === at && Array.isArray(data) && data.length) items = data;
    if (items && i >= at && Array.isArray(data) && data.length) {
      data = data[0];
      output = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
    }
    vars[`step${i + 1}`] = output;
    vars.$data[`step${i + 1}`] = data;
    outs.set(s.id, { output, data });
  });
  const from = step?.from ?? '';
  const piped = from === INPUT_NONE ? null : from ? outs.get(from) : [...outs.values()].at(-1);
  if (piped) {
    vars.input = piped.output;
    vars.$data.input = piped.data;
  }
  return items ? withItem(vars, { item: items[0], index: 0, count: /** @type {unknown[]} */ (items).length }) : vars;
}

// What a field's Preview fills its variables with: the step's own test, else what it could read before it.
// A data step's source may have a project of its own.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep | undefined} step
 * @param {string} [projectId]
 * @returns {Vars}
 */
function previewVars(store, flow, step, projectId = '') {
  const index = flow.steps.indexOf(/** @type {CronStep} */ (step));
  // No step has no test: get(undefined) is undefined.
  const vars = testsOf(store, flow.id).get(/** @type {string} */ (step?.id))?.vars ?? knownVars(store, flow, index);
  const project = projectId ? projectVars(store.get('projects').projects.find((p) => p.id === projectId)) : null;
  return project ? { ...vars, project: project.name, $data: { ...vars.$data, project } } : vars;
}

// The step's test, as n8n shows a node: what it read and what it gave, as JSON. A key in the input goes into the
// field last focused; a key in the output copies its variable, for the steps after this one.
/**
 * @param {Store} store
 * @param {CronFlow} flow
 * @param {CronStep} step
 * @param {number} index
 */
function testPanel(store, flow, step, index) {
  const result = testsOf(store, flow.id).get(step.id);
  const vars = result?.vars ?? knownVars(store, flow, index);
  /** @param {string} path */
  const copy = (path) => navigator.clipboard.writeText(`{{${path}}}`).then(() => toast(`Copied {{${path}}}`), () => toast('Could not copy'));
  const next = flow.steps[index + 1];
  const outTree = result
    ? treeBox(`${flow.id}/${step.id}/out`, result.ok
      ? jsonTree(result.data, `step${index + 1}`, copy, 0, `${flow.id}/${step.id}/out`)(`step${index + 1}`)
      : h('pre', { class: 'error' }, result.output))
    : h('p', { class: 'muted small' }, 'Test the step to see what it gives.');
  return h('section', { class: 'cron-test stack' },
    h('div', { class: 'row between' },
      h('strong', null, 'Test data'),
      h('div', { class: 'row' },
        result?.pending ? h('span', { class: 'pill tone-doing' }, 'Waiting for the terminal…')
          : result ? h('span', { class: `pill tone-${result.ok ? 'done' : 'high'}` }, result.ok ? `Tested · ${duration(result.ms)}` : 'Failed') : null,
        result?.ok && !result.pending && next
          ? h('button', {
              type: 'button',
              class: 'btn-link small',
              disabled: isRunning(flow.id),
              onclick: () => {
                view.node = next.id;
                runTest(store, flow, next.id);
              },
            }, 'Test the next step')
          : null,
        testsOf(store, flow.id).size
          ? h('button', { type: 'button', class: 'btn-link small', onclick: () => { clearTests(store, flow.id); store.refresh(); } }, 'Clear test data')
          : null)),
    result?.note ? h('p', { class: 'muted small' }, result.note) : null,
    // A Dev step's test, or a test run of the flow, shows its terminal here as it runs.
    step.type === 'dev' && result?.ok && /** @type {DevTestData | null | undefined} */ (result.data)?.session
      ? terminalViewer(store, /** @type {string} */ (/** @type {DevTestData} */ (result.data).session), /** @type {DevTestData} */ (result.data).cwd)
      : null,
    h('div', { class: 'cron-test-grid' },
      h('div', { class: 'cron-col' },
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, 'Input · click a key to add it at the cursor'),
          h('button', { type: 'button', class: 'btn-link small', onclick: () => copyText(JSON.stringify(varsTree(vars), null, 2), 'the input') }, icon('copy'), 'Copy')),
        inputTree(vars, `${flow.id}/${step.id}/in`)),
      h('div', { class: 'cron-col' },
        h('div', { class: 'row between' },
          h('span', { class: 'muted small' }, 'Output · click a key to copy it for a later step'),
          result
            ? h('button', { type: 'button', class: 'btn-link small', onclick: () => copyText(result.ok ? copyable(result.data) : result.output, 'the output') }, icon('copy'), 'Copy')
            : null),
        outTree)));
}

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function inspector(store, flow) {
  const step = flow.steps.find((s) => s.id === view.node);
  if (!step) {
    return h('section', { class: 'card stack' },
      h('header', { class: 'row' }, h('span', { class: 'flow-node-icon kind-trigger' }, icon('clock')), h('h3', null, 'Schedule')),
      triggerForm(store, flow));
  }
  const index = flow.steps.indexOf(step);
  const [, label, iconName] = typeOf(step.type);
  const output = lastRunOf(store, flow.id)?.steps.find((s) => s.stepId === step.id);
  return h('section', { class: 'card stack' },
    h('header', { class: 'row between' },
      h('div', { class: 'row' }, h('span', { class: `flow-node-icon kind-${step.type}` }, icon(iconName)), h('h3', null, `${index + 1}. ${label}`)),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn-small',
          disabled: isRunning(flow.id),
          title: step.type === 'dev'
            ? 'Tests the steps before this one that have no test data yet, then starts this terminal for real in Dev and shows its output here. No task goes with it.'
            : 'Runs the steps before this one that have no test data yet, then this one, as tests: no task, no notification, no terminal.',
          onclick: () => runTest(store, flow, step.id),
        }, icon(step.type === 'dev' ? 'terminal' : 'play'), isTesting(flow.id) ? 'Testing…' : 'Test step'),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move earlier', 'aria-label': 'Move earlier', disabled: index === 0, onclick: () => moveStep(store, flow, step.id, -1) }, icon('chevron-left')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move later', 'aria-label': 'Move later', disabled: index === flow.steps.length - 1, onclick: () => moveStep(store, flow, step.id, 1) }, icon('chevron-right')),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove step',
          'aria-label': 'Remove step',
          onclick: () => {
            clearTestsFrom(store, flow, index);
            updateFlow(store, flow.id, (f) => reorderSteps(f, f.steps.filter((s) => s.id !== step.id)));
            view.node = 'trigger';
            store.refresh();
          },
        }, icon('trash')))),
    inputPick(store, flow, step, index),
    stepForm(store, flow, step),
    testPanel(store, flow, step, index),
    output
      ? h('details', { class: 'cron-output', open: !output.ok },
          h('summary', null, output.ok ? `Output of the last run (${duration(output.ms)})` : 'Last run failed here'),
          output.note ? h('p', { class: 'muted small' }, output.note) : null,
          h('pre', { class: output.ok ? '' : 'error' }, output.output || '(empty)'),
          output.session ? terminalFold(store, output.session, output.cwd) : null)
      : null);
}

// --- Dev terminals ---
// What a Run in Dev step's terminal printed, drawn as Dev draws it (colours, styles, links). The runner keeps a
// terminal's output after it ends, until it is closed in Dev, so a run's terminal can be read later. A viewer is made
// once per terminal and moved into each new page, so its scroll survives re-renders; it reads the runner only while
// it is on the page. A terminal Dev reads already is shown from Dev's copy.
/**
 * @typedef {object} Viewer
 * @property {string} session
 * @property {import('../vt.js').Terminal} term
 * @property {string} state
 * @property {boolean} running
 * @property {Exit | null} exit
 * @property {number} frame
 * @property {boolean} mirror
 * @property {HTMLElement} dot
 * @property {HTMLElement} status
 * @property {ReturnType<typeof terminalView>} view
 * @property {HTMLElement} el
 * @property {() => void} [stop]
 */
/** @type {Map<string, Viewer>} */
const viewers = new Map();

/** @param {Viewer} v */
function drawViewer(v) {
  v.frame = 0;
  const live = v.mirror ? liveSession(v.session) : null;
  const t = live?.term ?? v.term;
  const running = live ? live.running : v.running;
  const exit = live ? live.exit : v.exit;
  v.view.paint(t);
  v.view.el.hidden = !t.history.length && !t.used();
  const state = /** @type {Record<string, string>} */ ({ loading: 'loading', missing: 'gone', offline: 'gone' })[v.state] ?? (running ? 'working' : exit ? (exit.code === 0 ? 'done' : 'failed') : 'idle');
  v.dot.className = `term-dot dev-${state}`;
  v.status.textContent = /** @type {Record<string, string>} */ ({
    loading: 'Reading the terminal…',
    missing: 'The runner no longer has this terminal: it was closed in Dev.',
    offline: 'Could not reach the terminal runner. Start it with bun start, then open this again.',
  })[v.state] ?? (running ? 'Running' : exit ? exitText(exit) : 'Not started yet');
}

/**
 * @param {Store} store
 * @param {Viewer} v
 */
function attachViewer(store, v) {
  const paintSoon = () => (v.frame ||= requestAnimationFrame(() => drawViewer(v)));
  if (liveSession(v.session)) {
    v.mirror = true;
    v.state = 'live';
    v.stop = onSessionPaint(paintSoon);
    paintSoon();
    return;
  }
  const ctl = new AbortController();
  v.stop = () => ctl.abort();
  const { term } = v;
  attachSession(runnerOf(store), {
    session: v.session,
    signal: ctl.signal,
    onEvent: (e) => {
      if (e.t === 'session') {
        v.state = e.known ? 'replay' : 'missing';
        term.reset();
        term.clear();
      } else if (e.t === 'live') v.state = 'live';
      else if (e.t === 'size') term.resize(e.cols, e.rows);
      else if (e.t === 'start') {
        Object.assign(v, { running: true, exit: null });
        if (e.cols) term.resize(e.cols, e.rows);
        term.note(`${e.cwd || 'board'} $ ${e.command.replace(/\s*\n\s*/g, ' ↵ ')}`, 't-cmd');
      } else if (e.t === 'out' || e.t === 'err') term.write(e.d);
      else if (e.t === 'exit') {
        Object.assign(v, { running: false, exit: e.stopped ? { stopped: true, ms: e.ms } : { code: e.code, signal: e.signal, ms: e.ms } });
        term.reset();
        // Set just above.
        term.note(exitText(v.exit), /** @type {Exit} */ (v.exit).code === 0 ? 't-meta t-ok' : 't-meta');
      }
      paintSoon();
    },
  }).then(() => {
    if (ctl.signal.aborted) return;
    // The stream ended: the runner stopped, or Dev took the terminal over. The next page reads it again.
    if (v.state === 'loading') v.state = 'offline';
    viewers.delete(v.session);
    paintSoon();
  });
  paintSoon();
}

/**
 * @param {Store} store
 * @param {string} session
 * @param {string} [cwd]
 * @param {string[]} [taskIds]
 */
function terminalViewer(store, session, cwd = '', taskIds = []) {
  let v = viewers.get(session);
  if (!v) {
    // Its elements are added just below.
    v = /** @type {Viewer} */ ({ session, term: createTerminal({ cols: 120, rows: 32, background: terminalBackground }), state: 'loading', running: false, exit: null, frame: 0, mirror: false });
    v.dot = h('span', { class: 'term-dot' });
    v.status = h('span', { class: 'muted small grow' });
    v.view = terminalView('Run in Dev terminal output');
    v.el = h('div', { class: 'cron-term-view stack' },
      h('div', { class: 'row cron-term-bar' },
        v.dot,
        v.status,
        h('button', { type: 'button', class: 'btn-small', title: 'Open this terminal in Dev, to type in it', onclick: () => openSession({ id: session, cwd, taskIds }) },
          icon('terminal'), 'Open in Dev')),
      v.view.el);
    viewers.set(session, v);
    attachViewer(store, v);
  }
  return v.el;
}

// Viewers no longer on the page stop reading the runner.
function sweepViewers() {
  for (const v of viewers.values()) {
    if (v.el.isConnected) continue;
    v.stop?.();
    viewers.delete(v.session);
  }
}
window.addEventListener('hashchange', () => requestAnimationFrame(sweepViewers));

// A terminal folded under a run's step; it is read once opened, and stays open through re-renders. `start` opens it
// the first time it is drawn (a step still running).
/**
 * @param {Store} store
 * @param {string} session
 * @param {string | undefined} cwd
 * @param {{ start?: boolean, taskIds?: string[] }} [options]
 */
function terminalFold(store, session, cwd, { start = false, taskIds = [] } = {}) {
  if (start && !view.seenTerms.has(session)) view.terms.add(session);
  view.seenTerms.add(session);
  const open = view.terms.has(session);
  return h('details', {
    class: 'cron-output',
    open,
    ontoggle: (/** @type {Event & { target: HTMLDetailsElement }} */ e) => {
      if (e.target.open === view.terms.has(session)) return;
      if (e.target.open) view.terms.add(session);
      else view.terms.delete(session);
      store.refresh();
    },
  },
  h('summary', null, 'Terminal output'),
  open ? terminalViewer(store, session, cwd, taskIds) : null);
}

// What the terminals of the runs on the page are doing, asked of the runner every few seconds while Cron is shown,
// so a run's terminal chip says whether claude is still working, as a task's Dev button does.
const TERM_POLL_MS = 4000;
/** @type {{ status: Awaited<ReturnType<typeof sessionStatus>>, timer: number, ids: string[] }} */
const termWatch = { status: {}, timer: 0, ids: [] };
/** @type {Record<string, string>} */
const TERM_STATES = {
  working: 'Working',
  waiting: 'Waiting for you',
  done: 'Finished',
  failed: 'Ended with an error',
  stopped: 'Stopped',
  idle: 'Nothing running',
  gone: 'Closed in Dev',
};

/**
 * @param {Store} store
 * @param {string[]} ids
 */
function watchTerminals(store, ids) {
  termWatch.ids = ids;
  if (termWatch.timer || !ids.length) return;
  const poll = async () => {
    termWatch.timer = 0;
    if (!location.hash.startsWith('#/cron') || !termWatch.ids.length) return;
    let status;
    try {
      status = await sessionStatus(runnerOf(store), termWatch.ids);
    } catch {}
    termWatch.timer ||= setTimeout(poll, TERM_POLL_MS);
    if (!status || JSON.stringify(status) === JSON.stringify(termWatch.status)) return;
    termWatch.status = status;
    store.refresh();
  };
  termWatch.timer = setTimeout(poll, 0);
}

// A terminal's state as the runner last told it: unknown until asked, 'gone' once the runner no longer has it.
/** @param {string} session */
const termState = (session) => (termWatch.status[session]?.state ?? (termWatch.ids.includes(session) && Object.keys(termWatch.status).length ? 'gone' : ''));

// --- Runs ---

// [label, dot class, pill tone]
/** @type {Record<string, string[]>} */
const RUN_STATUS = {
  running: ['Running', 'running', 'doing'],
  ok: ['Done', 'on', 'done'],
  stopped: ['Stopped early', 'off', 'plain'],
  error: ['Failed', 'bad', 'high'],
  lost: ['Interrupted', 'warn', 'medium'],
};

/** @param {number} ms */
const duration = (ms) => (ms < 1000 ? `${Math.round(ms)} ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)} s` : ms < 3600000 ? `${Math.floor(ms / 60000)} min ${Math.round((ms % 60000) / 1000)} s` : `${Math.floor(ms / 3600000)} h ${Math.round((ms % 3600000) / 60000)} min`);

// The things a run made, gathered from its steps (and the step running now), newest last.
// Each list keeps the steps that have the field, so the casts only drop undefined.
/** @param {CronRun} r */
function runOutcomes(r) {
  /** @type {Partial<CronRunStep>[]} */
  const steps = [...r.steps, ...(r.current ? [r.current] : [])];
  return {
    tasks: [...new Set(/** @type {string[]} */ (steps.map((s) => s.taskId).filter(Boolean)))],
    terms: steps.filter((s) => s.session).map((s) => ({ session: /** @type {string} */ (s.session), cwd: s.cwd ?? '', terminal: s.terminal, taskId: s.taskId ?? '' })),
    prs: steps.filter((s) => s.pr?.url).map((s) => /** @type {CronPr} */ (s.pr)),
    branches: [...new Set(/** @type {string[]} */ (steps.map((s) => s.branch).filter(Boolean)))],
  };
}

// Tasks open in their project's list, scrolled to and opened (todos.js reads `task`).
/** @param {Task} t */
const taskHref = (t) => `#/todos?${new URLSearchParams({ filter: t.projectId || 'personal', status: 'all', task: t.id })}`;

/**
 * @param {Store} store
 * @param {string} id
 */
function taskChip(store, id) {
  const t = store.get('todos').items.find((x) => x.id === id);
  if (!t) return h('span', { class: 'run-chip muted', title: 'The task this run made was deleted' }, icon('check-square'), 'Task deleted');
  const status = taskStatuses(store).find((s) => s.key === statusOf(t));
  return h('a', { class: 'run-chip', href: taskHref(t), title: `Open the task “${t.text}”` },
    icon('check-square'),
    h('span', { class: 'run-chip-text' }, t.text),
    status ? pill(status.name, statusLook(status)) : null);
}

/**
 * @param {Store} store
 * @param {{ session: string, cwd: string, terminal?: number, taskId: string }} term
 */
function terminalChip(store, term) {
  const state = termState(term.session);
  const label = TERM_STATES[state] ?? 'Terminal';
  const taskIds = term.taskId ? [term.taskId] : [];
  return h('button', {
    type: 'button',
    class: 'run-chip',
    title: `Dev terminal ${term.terminal ?? ''}: ${label}. Click to open it in Dev.`,
    onclick: () => openSession({ id: term.session, cwd: term.cwd, taskIds }),
  }, h('span', { class: `term-dot dev-${state || 'idle'}` }), icon('terminal'), `Terminal ${term.terminal ?? ''}`.trim(), h('span', { class: 'muted small' }, label));
}

/** @param {CronPr} pr */
const prChip = (pr) => h('a', { class: 'run-chip', href: pr.url, target: '_blank', rel: 'noopener noreferrer', title: `${pr.repo} #${pr.number}` }, icon('git-pull-request'), `PR #${pr.number}`);
/** @param {string} name */
const branchChip = (name) => h('span', { class: 'run-chip mono', title: 'The branch the Dev step worked on' }, icon('git-branch'), name);

// A step's output: short ones in full, long ones folded under their first line.
/** @param {CronRunStep} s */
function stepOutput(s) {
  const text = s.output || '';
  if (!text) return s.ok ? null : h('pre', { class: 'error' }, '(no message)');
  const lines = text.split('\n');
  if (!s.ok || (text.length <= 400 && lines.length <= 6)) return h('pre', { class: s.ok ? '' : 'error' }, text);
  return h('details', { class: 'cron-output' },
    h('summary', null, h('span', { class: 'cron-output-first' }, lines.find((l) => l.trim())?.slice(0, 140) ?? 'Output'), h('span', { class: 'muted small' }, ` · ${lines.length} lines`)),
    h('pre', null, text));
}

// A run's steps as a timeline: what each did, the step running now, and the steps a stop or a failure skipped.
/**
 * @param {Store} store
 * @param {CronFlow | null} flow
 * @param {CronRun} r
 * @param {string} state
 */
function runSteps(store, flow, r, state) {
  /**
   * @param {string} id
   * @param {string} [saved]
   */
  const typeOfStep = (id, saved) => flow?.steps.find((x) => x.id === id)?.type ?? saved ?? '';
  /** @param {string} id */
  const nameOf = (id) => {
    const i = flow ? flow.steps.findIndex((s) => s.id === id) : -1;
    // i is -1 without a flow.
    return i < 0 ? 'Removed step' : `${i + 1}. ${typeOf(/** @type {CronFlow} */ (flow).steps[i].type)[1]}`;
  };
  /**
   * @param {string} cls
   * @param {string} type
   * @param {string} title
   * @param {Child} meta
   * @param {Child} body
   */
  const item = (cls, type, title, meta, body) => h('li', { class: `cron-run-step ${cls}` },
    h('span', { class: `flow-node-icon kind-${type || 'stop'}` }, icon(typeOf(type)[2])),
    h('div', { class: 'cron-run-step-body' },
      h('div', { class: 'row' }, h('strong', null, title), meta),
      body));
  const done = r.steps.map((s) => item(s.ok ? 'ok' : 'bad', typeOfStep(s.stepId, s.type), nameOf(s.stepId),
    h('span', { class: 'muted small' }, duration(s.ms)),
    [
      s.note ? h('p', { class: 'muted small' }, s.note) : null,
      stepOutput(s),
      s.session ? terminalFold(store, s.session, s.cwd, { taskIds: s.taskId ? [s.taskId] : [] }) : null,
    ]));
  const ran = new Set(r.steps.map((s) => s.stepId));
  const rest = flow ? flow.steps.filter((s) => !ran.has(s.id)) : [];
  const now = state === 'running' ? rest.find((s) => s.id === r.current?.stepId) ?? rest[0] : null;
  const later = rest.filter((s) => s !== now).map((s) => item('skipped', s.type, nameOf(s.id),
    h('span', { class: 'muted small' }, state === 'running' ? 'Waiting' : 'Not run'), null));
  const current = now
    ? item('running', now.type, nameOf(now.id), h('span', { class: 'muted small' }, 'Running…'),
        r.current?.session ? terminalFold(store, r.current.session, r.current.cwd, { start: true, taskIds: r.current.taskId ? [r.current.taskId] : [] }) : null)
    : null;
  return h('ol', { class: 'cron-run-steps' }, done, current, later);
}

// One run: a header that opens it (status dot, flow, time, how it started, how long it took), then what it made
// (its task, terminals, PR, its preview and branch) as links, then, once opened, each step.
/**
 * @param {Store} store
 * @param {CronFlow | null} flow
 * @param {CronRun} r
 * @param {{ showFlow?: boolean }} [options]
 */
function runCard(store, flow, r, { showFlow = false } = {}) {
  const state = runState(r);
  const [label, dot, tone] = RUN_STATUS[state] ?? RUN_STATUS.error;
  const open = view.openRuns.has(r.id);
  const toggle = () => {
    if (open) view.openRuns.delete(r.id);
    else view.openRuns.add(r.id);
    store.refresh();
  };
  // Runs saved before runs kept their end have no duration.
  const end = r.ended ? Date.parse(r.ended) : state === 'running' ? Date.now() : NaN;
  const took = end - Date.parse(r.at);
  const { tasks, terms, prs, branches } = runOutcomes(r);
  const links = [...tasks.map((id) => taskChip(store, id)), ...terms.map((t) => terminalChip(store, t)), ...prs.map(prChip), ...previewChips(store, prs, 'run-chip'), ...branches.map(branchChip)];
  return h('li', { class: `cron-run${view.focusRun === r.id ? ' focus' : ''}`, 'data-run': r.id },
    h('div', { class: 'cron-run-head' },
      h('button', { type: 'button', class: 'cron-run-toggle', 'aria-expanded': String(open), onclick: toggle },
        h('span', { class: `icon-wrap chevron${open ? ' open' : ''}` }, icon('chevron-down')),
        h('span', { class: `cron-dot ${dot}`, title: label }),
        h('span', { class: 'cron-run-name' },
          showFlow ? h('strong', null, flow?.name ?? 'Deleted flow') : h('strong', null, timeOf(r.at)),
          h('span', { class: 'muted small cron-run-meta' },
            [showFlow ? timeOf(r.at) : null, r.dry ? 'Test run' : r.manual ? 'Run by hand' : 'On schedule', took >= 0 ? duration(took) : null].filter(Boolean).join(' · ')))),
      h('div', { class: 'row cron-run-actions' },
        h('span', { class: `pill tone-${tone}` }, label),
        r.dry ? h('span', { class: 'pill tone-low' }, 'Test') : null,
        showFlow && flow
          ? h('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'Open the flow',
              'aria-label': `Open the flow “${flow.name}”`,
              onclick: () => {
                view.tab = 'flows';
                view.flow = flow.id;
                view.node = 'trigger';
                store.refresh();
              },
            }, icon('arrow-right'))
          : null)),
    links.length ? h('div', { class: 'cron-run-links' }, links) : null,
    r.error ? h('p', { class: `small cron-run-error ${state === 'error' ? 'error' : 'muted'}` }, r.error) : null,
    state === 'lost' ? h('p', { class: 'muted small' }, 'The board was closed or reloaded while this run was going, so it never finished. A terminal it started may still be running in Dev.') : null,
    open ? runSteps(store, flow, r, state) : null);
}

// The terminals of these runs, for the status poll.
/** @param {CronRun[]} runs */
const sessionsOf = (runs) => [...new Set(runs.flatMap((r) => runOutcomes(r).terms.map((t) => t.session)))];

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function runList(store, flow) {
  const runs = store.get(COLLECTION).runs.filter((r) => r.flowId === flow.id).slice(0, 10);
  watchTerminals(store, sessionsOf(runs));
  return h('section', { class: 'card stack' },
    h('h3', null, 'Runs'),
    runs.length
      ? h('ul', { class: 'cron-runs' }, runs.map((r) => runCard(store, flow, r)))
      : empty('No run yet. “Test run” tries the whole flow: it makes its tasks and starts its terminals, but sends no notification.'));
}

// --- Editor ---

/**
 * @param {Store} store
 * @param {CronFlow} flow
 */
function editor(store, flow) {
  const busy = isRunning(flow.id);
  return h('div', { class: 'stack-lg cron-editor' },
    h('section', { class: 'card stack' },
      h('div', { class: 'row between' },
        h('input', {
          class: 'cron-name',
          value: flow.name,
          'aria-label': 'Flow name',
          autocomplete: 'off',
          onchange: (/** @type {FieldEvent} */ e) => updateFlow(store, flow.id, (f) => {
            f.name = e.target.value.trim() || 'Untitled flow';
          }),
        }),
        h('div', { class: 'row' },
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: flow.enabled, onchange: (/** @type {FieldEvent} */ e) => setEnabled(store, flow, e.target.checked) }),
            ' On schedule'),
          h('button', {
            type: 'button',
            class: 'btn-small',
            disabled: busy || !flow.steps.length,
            title: 'Tries the whole flow: makes its tasks and starts its Dev terminals as a run would, tied together, but sends no notification and leaves the schedule alone.',
            onclick: () => startRun(store, flow, { dry: true }),
          }, icon('filter'), 'Test run'),
          h('button', { type: 'button', class: 'btn-small primary', disabled: busy || !flow.steps.length, onclick: () => startRun(store, flow) }, icon('play'), busy ? 'Running…' : 'Run now'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Save as template', 'aria-label': 'Save as template', disabled: !flow.steps.length, onclick: () => saveAsTemplate(store, flow) }, icon('bookmark')),
          h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate flow', 'aria-label': 'Duplicate flow', onclick: () => duplicateFlow(store, flow) }, icon('copy')),
          h('button', { type: 'button', class: 'icon-btn', title: 'Delete flow', 'aria-label': 'Delete flow', onclick: () => deleteFlow(store, flow) }, icon('trash')))),
      h('div', { class: 'row cron-fields' },
        field('Project', projectPick(store, flowProjectId(flow), 'No project', (projectId) => setFlowProject(store, flow, projectId)),
          'Data, task and Dev steps use it, unless a step chooses another.')),
      nodePalette(store, flow),
      canvas(store, flow),
      h('p', { class: 'muted small' }, `Last run: ${timeOf(flow.lastRun)}${flow.enabled ? ` · next: ${timeOf(nextRun(flow)?.toISOString())}` : ''}`)),
    inspector(store, flow),
    runList(store, flow));
}

/** @param {Store} store */
function flowsTab(store) {
  const all = store.get(COLLECTION).flows;
  // A filter whose project no flow uses any more is dropped, and so is one that hides the flow a link opened.
  if (!all.some(inFilter) || all.some((f) => f.id === view.flow && !inFilter(f))) view.project = '';
  const flows = all.filter(inFilter);
  const flow = flows.find((f) => f.id === view.flow) ?? flows[0] ?? null;
  if (flow) view.flow = flow.id;
  // A step the address names that this flow no longer has falls back to the schedule.
  if (flow && view.node !== 'trigger' && !flow.steps.some((s) => s.id === view.node)) view.node = 'trigger';
  return h('div', { class: 'cron-layout' },
    flowList(store, all, flows),
    flow ? editor(store, flow) : h('div', { class: 'card stack' }, empty('Create a flow to schedule AI work, such as a morning plan from your open tasks.'),
      h('div', { class: 'row' },
        h('button', { type: 'button', class: 'primary', onclick: () => openNewFlow(store) }, icon('plus'), 'New flow'),
        h('button', { type: 'button', class: 'btn-link', onclick: () => openTemplates(store) }, 'Start from a template'))));
}

/**
 * @param {HTMLElement} root
 * @param {Store} store
 */
function draw(root, store) {
  resumeDevTests(store);
  if (!TABS.some(([k]) => k === view.tab)) view.tab = 'flows';
  const body = view.tab === 'runs' ? runsTab(store) : view.tab === 'templates' ? templatesTab(store) : flowsTab(store);
  root.replaceChildren(
    h('div', { class: 'stack-lg cron' },
      h('header', null,
        h('h2', null, 'Cron'),
        h('p', { class: 'muted small' }, SUBTITLES[view.tab])),
      h('nav', { class: 'sub-tabs', role: 'tablist', 'aria-label': 'Cron sections' },
        TABS.map(([key, label]) => h('button', {
          type: 'button',
          role: 'tab',
          class: view.tab === key ? 'sub-tab active' : 'sub-tab',
          'aria-selected': String(view.tab === key),
          onclick: () => {
            view.tab = key;
            store.refresh();
          },
        }, label))),
      body));
  requestAnimationFrame(sweepViewers);
  if (view.scrollTo) {
    const id = view.scrollTo;
    view.scrollTo = '';
    requestAnimationFrame(() => root.querySelector(`[data-run="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
  }
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'cron',
  title: 'Cron',
  icon: 'repeat',
  collection: COLLECTION,
  defaults: DEFAULTS,
  render: draw,
  // The selected step goes in the address too, so a refresh reopens it.
  serialize: () => ({
    tab: view.tab === 'flows' ? '' : view.tab,
    flow: view.flow,
    step: view.tab === 'flows' && view.node !== 'trigger' ? view.node : '',
  }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    if (p.step) view.node = p.step;
    else if (p.flow && p.flow !== view.flow) view.node = 'trigger';
    view.flow = p.flow || '';
    // A notification links to #/cron?flow=…, with no tab, so it opens the Flows tab.
    view.tab = p.tab || 'flows';
    // A task made by a run, and a failed run's notification, link to the run: it opens, with every filter cleared.
    if (p.run) {
      view.tab = 'runs';
      view.runs = 'all';
      view.openRuns.add(p.run);
      view.focusRun = p.run;
      view.scrollTo = p.run;
    }
  },
});
