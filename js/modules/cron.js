// Cron: recurring flows that gather board data, ask an AI model, and turn the answer into a task or a notification.
// The editor draws a flow as a chain of nodes, like a workflow canvas; the inspector below edits the selected node.
import { h, icon, empty, notice, now, uid } from '../ui.js';
import { projectTree } from './projects.js';
import { modelChip } from '../model-picker.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import {
  COLLECTION, DEFAULTS, AI_TASK, STEP_TYPES, SOURCES, WEEKDAYS, SHORT_DAYS, REPEATS, STOP_WHEN, TEMPLATES, daysOf,
  makeFlow, makeStep, flowFromTemplate, nextRun, scheduleLabel, stopLabel, runFlow, isRunning,
} from '../cron.js';
import { modelForTask } from './settings.js';

// View state: the open flow and the selected node ('trigger' or a step id).
const view = { flow: '', node: 'trigger' };

const typeOf = (type) => STEP_TYPES.find(([t]) => t === type) ?? [type, type, 'info', ''];
const timeOf = (at) => (at ? new Date(at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : 'never');
const projectsOf = (store) => projectTree(store.get('projects').projects).map(({ project }) => project);
const lastRunOf = (store, flowId) => store.get(COLLECTION).runs.find((r) => r.flowId === flowId) ?? null;

function updateFlow(store, id, mutate) {
  store.update(COLLECTION, (d) => {
    const f = d.flows.find((x) => x.id === id);
    if (f) mutate(f);
  });
}

function addFlow(store, flow) {
  store.update(COLLECTION, (d) => d.flows.push(flow));
  view.flow = flow.id;
  view.node = flow.steps[0]?.id ?? 'trigger';
  store.refresh();
}

function deleteFlow(store, flow) {
  const before = structuredClone(store.get(COLLECTION));
  store.update(COLLECTION, (d) => {
    d.flows = d.flows.filter((f) => f.id !== flow.id);
    d.runs = d.runs.filter((r) => r.flowId !== flow.id);
  });
  view.flow = '';
  toast(`Deleted “${flow.name}”`, {
    undo: () => store.update(COLLECTION, (d) => {
      d.flows = before.flows;
      d.runs = before.runs;
    }),
  });
}

// A copy starts paused, so it does not run beside the original until it is switched on.
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

function setEnabled(store, flow, enabled) {
  updateFlow(store, flow.id, (f) => {
    f.enabled = enabled;
    if (enabled) f.enabledAt = now();
  });
}

function startRun(store, flow, { dry = false } = {}) {
  if (isRunning(flow.id)) return;
  const run = runFlow(store, flow.id, { manual: true, dry });
  store.refresh();
  const what = dry ? 'Test run of' : '';
  run.then((r) => toast(
    r?.status === 'ok' ? `${what} “${flow.name}” finished`.trim()
      : r?.status === 'stopped' ? `${what} “${flow.name}” stopped early`.trim()
        : `${what} “${flow.name}” failed: ${r?.error ?? 'unknown error'}`.trim(),
  ));
}

// --- Flow list ---

function flowList(store, flows) {
  return h('aside', { class: 'card cron-list' },
    h('div', { class: 'row between' },
      h('h3', null, 'Flows'),
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => openNewFlow(store) }, icon('plus'), 'New flow')),
    flows.length
      ? h('ul', { class: 'cron-flows' }, flows.map((f) => {
          const last = lastRunOf(store, f.id);
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
                h('span', { class: 'muted small' }, f.enabled ? scheduleLabel(f.schedule) : 'Paused'))),
            h('input', {
              type: 'checkbox',
              class: 'cron-flow-toggle',
              checked: f.enabled,
              title: f.enabled ? 'On schedule. Uncheck to pause.' : 'Paused. Check to run on schedule.',
              'aria-label': `Run “${f.name}” on schedule`,
              onchange: (e) => setEnabled(store, f, e.target.checked),
            }));
        }))
      : empty('No flow yet. Start from a template or a blank flow.'));
}

function openNewFlow(store) {
  const dialog = openDialog({
    title: 'New flow',
    body: h('div', { class: 'stack' },
      h('p', { class: 'muted small' }, 'Start from a template and adjust it, or from a blank flow.'),
      h('div', { class: 'cron-templates' },
        TEMPLATES.map((t) => h('button', {
          type: 'button',
          class: 'cron-template',
          onclick: () => {
            dialog.close();
            addFlow(store, flowFromTemplate(t));
          },
        },
          h('strong', null, t.name),
          h('span', { class: 'muted small' }, `${scheduleLabel(t.schedule)} · ${t.steps.map((s) => typeOf(s.type)[1]).join(' → ')}`))),
        h('button', {
          type: 'button',
          class: 'cron-template',
          onclick: () => {
            dialog.close();
            addFlow(store, makeFlow({ steps: [makeStep('ai')] }));
          },
        }, h('strong', null, 'Blank flow'), h('span', { class: 'muted small' }, 'One AI step to start with')))),
  });
}

// --- Canvas ---

function stepSummary(store, step) {
  if (step.type === 'gather') {
    const label = SOURCES.find(([k]) => k === step.source)?.[1] ?? step.source;
    return step.source === 'project' ? projectsOf(store).find((p) => p.id === step.projectId)?.name ?? 'Choose a project' : label;
  }
  if (step.type === 'ai') return step.model || modelForTask(store, AI_TASK) || 'No model set';
  if (step.type === 'task') return step.title || '{{input}}';
  if (step.type === 'stop') return stopLabel(step);
  return step.text || 'Notification';
}

function node(store, flow, { id, iconName, kind, title, sub, status }) {
  return h('button', {
    type: 'button',
    class: `flow-node${view.node === id ? ' selected' : ''}${status ? ` ${status}` : ''}`,
    onclick: () => {
      view.node = id;
      store.refresh();
    },
  },
    h('span', { class: `flow-node-icon kind-${kind}` }, icon(iconName)),
    h('span', { class: 'flow-node-text' },
      h('span', { class: 'flow-node-kind' }, title),
      h('span', { class: 'flow-node-sub' }, sub)));
}

function insertStep(store, flow, index) {
  const dialog = openDialog({
    title: 'Add a step',
    body: h('div', { class: 'cron-templates' }, STEP_TYPES.map(([type, label, iconName, about]) =>
      h('button', {
        type: 'button',
        class: 'cron-template row',
        onclick: () => {
          dialog.close();
          const step = makeStep(type);
          updateFlow(store, flow.id, (f) => f.steps.splice(index, 0, step));
          view.node = step.id;
          store.refresh();
        },
      },
        h('span', { class: `flow-node-icon kind-${type}` }, icon(iconName)),
        h('span', { class: 'grow' }, h('strong', null, label), h('span', { class: 'muted small' }, about))))),
  });
}

const link = (store, flow, index) =>
  h('div', { class: 'flow-link' },
    h('button', { type: 'button', class: 'flow-add', title: 'Add a step here', 'aria-label': 'Add a step here', onclick: () => insertStep(store, flow, index) }, icon('plus')));

function canvas(store, flow) {
  const last = lastRunOf(store, flow.id);
  const statusOfStep = (id) => {
    const s = last?.steps.find((x) => x.stepId === id);
    return s ? (s.ok ? 'ok' : 'bad') : '';
  };
  const parts = [node(store, flow, { id: 'trigger', iconName: 'clock', kind: 'trigger', title: 'Schedule', sub: scheduleLabel(flow.schedule) })];
  flow.steps.forEach((s, i) => {
    const [, label, iconName] = typeOf(s.type);
    parts.push(link(store, flow, i));
    parts.push(node(store, flow, { id: s.id, iconName, kind: s.type, title: `${i + 1}. ${label}`, sub: stepSummary(store, s), status: statusOfStep(s.id) }));
  });
  parts.push(link(store, flow, flow.steps.length));
  return h('div', { class: `flow-canvas${isRunning(flow.id) ? ' running' : ''}`, role: 'list', 'aria-label': 'Flow steps' }, parts);
}

// --- Inspector ---

const field = (label, control, hint) => h('label', null, label, control, hint ? h('span', { class: 'muted small' }, hint) : null);

function select(value, options, onchange, attrs = {}) {
  return h('select', { ...attrs, value: String(value ?? ''), onchange: (e) => onchange(e.target.value) },
    options.map(([v, l]) => h('option', { value: String(v) }, l)));
}

function triggerForm(store, flow) {
  const s = flow.schedule;
  const set = (patch) => updateFlow(store, flow.id, (f) => Object.assign(f.schedule, patch));
  const days = daysOf({ ...s, every: 'days' });
  const toggleDay = (d) => {
    const next = days.includes(d) ? days.filter((x) => x !== d) : [...days, d];
    if (next.length) set({ days: next });
  };
  return h('div', { class: 'stack' },
    h('div', { class: 'row cron-fields' },
      field('Repeat', select(s.every, REPEATS, (every) => set({ every }))),
      s.every === 'interval'
        ? field('Minutes between runs', h('input', { type: 'number', min: 5, step: 5, value: String(s.minutes ?? 60), onchange: (e) => set({ minutes: Math.max(5, Number(e.target.value) || 60) }) }))
        : null,
      s.every === 'weekly' ? field('Day', select(s.weekday, WEEKDAYS.map((d, i) => [i, d]), (v) => set({ weekday: Number(v) }))) : null,
      s.every === 'monthly'
        ? field('Day of the month', h('input', { type: 'number', min: 1, max: 31, value: String(s.day ?? 1), onchange: (e) => set({ day: Math.min(31, Math.max(1, Number(e.target.value) || 1)) }) }), 'A day the month lacks runs on its last day.')
        : null,
      s.every !== 'interval' ? field('Time', h('input', { type: 'time', value: s.time, onchange: (e) => set({ time: e.target.value || '08:00' }) })) : null),
    s.every === 'days'
      ? h('div', { class: 'cron-days', role: 'group', 'aria-label': 'Days' },
          [1, 2, 3, 4, 5, 6, 0].map((d) => h('button', {
            type: 'button',
            class: days.includes(d) ? 'cron-day on' : 'cron-day',
            'aria-pressed': String(days.includes(d)),
            title: WEEKDAYS[d],
            onclick: () => toggleDay(d),
          }, SHORT_DAYS[d])),
          h('button', { type: 'button', class: 'btn-link small', onclick: () => set({ days: [1, 2, 3, 4, 5] }) }, 'Weekdays'),
          h('button', { type: 'button', class: 'btn-link small', onclick: () => set({ days: [0, 6] }) }, 'Weekends'))
      : null,
    s.every === 'interval'
      ? h('div', { class: 'row cron-fields' },
          field('Active from', h('input', { type: 'time', value: s.from ?? '', onchange: (e) => set({ from: e.target.value }) })),
          field('Until', h('input', { type: 'time', value: s.to ?? '', onchange: (e) => set({ to: e.target.value }) }), 'Leave both empty to run around the clock.'))
      : null,
    h('p', { class: 'muted small' },
      flow.enabled ? `Next run: ${timeOf(nextRun(flow).toISOString())}. ` : 'The flow is paused. ',
      'Flows run only while the board is open; a run missed while it was closed happens once when you open it.'));
}

function stepForm(store, flow, step) {
  const set = (patch) => updateFlow(store, flow.id, (f) => Object.assign(f.steps.find((x) => x.id === step.id) ?? {}, patch));
  const projects = [['', 'Personal'], ...projectsOf(store).map((p) => [p.id, p.name])];
  const vars = h('p', { class: 'muted small' }, 'Use {{input}} for the previous step’s output, {{date}} for today and {{flow}} for the flow’s name.');
  if (step.type === 'gather') {
    return h('div', { class: 'stack' },
      h('div', { class: 'row cron-fields' },
        field('Source', select(step.source, SOURCES, (source) => set({ source }))),
        step.source === 'project' ? field('Project', select(step.projectId, [['', 'Choose…'], ...projects.slice(1)], (projectId) => set({ projectId }))) : null),
      step.source === 'text'
        ? field('Text', h('textarea', { rows: 4, onchange: (e) => set({ text: e.target.value }) }, step.text))
        : h('p', { class: 'muted small' }, 'The data is read from your board when the flow runs, as plain text for the next step.'));
  }
  if (step.type === 'ai') {
    return h('div', { class: 'stack' },
      field('Prompt', h('textarea', { rows: 6, class: 'mono-text', onchange: (e) => set({ prompt: e.target.value }) }, step.prompt)),
      vars,
      field('System instructions (optional)', h('textarea', { rows: 2, onchange: (e) => set({ system: e.target.value }) }, step.system ?? '')),
      h('div', { class: 'row' },
        h('span', { class: 'muted small' }, 'Model'),
        modelChip({ value: step.model, nullable: true, nullLabel: `Default (${modelForTask(store, AI_TASK) || 'not set'})`, onPick: (model) => set({ model: model ?? '' }) })),
      store.get('settings').openrouter?.key ? null : notice({ tone: 'info', text: 'AI steps need an OpenRouter key.', actions: [h('a', { href: '#/settings?section=openrouter', class: 'btn-link' }, 'Add a key')] }));
  }
  if (step.type === 'task') {
    return h('div', { class: 'stack' },
      field('Task title', h('input', { value: step.title, autocomplete: 'off', onchange: (e) => set({ title: e.target.value }) }), 'The first line is used. The full input becomes the description.'),
      vars,
      h('div', { class: 'row cron-fields' },
        field('Project', select(step.projectId, projects, (projectId) => set({ projectId }))),
        field('Priority', select(step.priority, [['none', 'No priority'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], (priority) => set({ priority }))),
        field('Due', select(step.due, [['', 'No deadline'], ['today', 'Day of the run'], ['tomorrow', 'Day after the run']], (due) => set({ due })))));
  }
  if (step.type === 'stop') {
    const needsText = step.when === 'contains' || step.when === 'lacks';
    return h('div', { class: 'stack' },
      h('div', { class: 'row cron-fields' },
        field('Stop when', select(step.when, STOP_WHEN, (when) => set({ when }))),
        needsText ? field('Words', h('input', { value: step.text ?? '', autocomplete: 'off', onchange: (e) => set({ text: e.target.value }) }), 'Not case-sensitive.') : null),
      h('p', { class: 'muted small' }, 'The run ends here without counting as a failure, and the steps after this one are skipped. Put it after a data step to stay quiet when there is nothing to report.'));
  }
  return h('div', { class: 'stack' },
    field('Message', h('textarea', { rows: 4, onchange: (e) => set({ text: e.target.value }) }, step.text)),
    vars,
    h('p', { class: 'muted small' }, 'Sent to the bell, and to Telegram when Settings › Notifications says so for Cron flows.'));
}

function moveStep(store, flow, id, by) {
  updateFlow(store, flow.id, (f) => {
    const i = f.steps.findIndex((s) => s.id === id);
    const j = i + by;
    if (i < 0 || j < 0 || j >= f.steps.length) return;
    [f.steps[i], f.steps[j]] = [f.steps[j], f.steps[i]];
  });
}

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
        h('button', { type: 'button', class: 'icon-btn', title: 'Move earlier', 'aria-label': 'Move earlier', disabled: index === 0, onclick: () => moveStep(store, flow, step.id, -1) }, icon('chevron-left')),
        h('button', { type: 'button', class: 'icon-btn', title: 'Move later', 'aria-label': 'Move later', disabled: index === flow.steps.length - 1, onclick: () => moveStep(store, flow, step.id, 1) }, icon('chevron-right')),
        h('button', {
          type: 'button',
          class: 'icon-btn',
          title: 'Remove step',
          'aria-label': 'Remove step',
          onclick: () => {
            updateFlow(store, flow.id, (f) => {
              f.steps = f.steps.filter((s) => s.id !== step.id);
            });
            view.node = 'trigger';
            store.refresh();
          },
        }, icon('trash')))),
    stepForm(store, flow, step),
    output
      ? h('details', { class: 'cron-output', open: !output.ok },
          h('summary', null, output.ok ? `Output of the last run (${output.ms} ms)` : 'Last run failed here'),
          output.note ? h('p', { class: 'muted small' }, output.note) : null,
          h('pre', { class: output.ok ? '' : 'error' }, output.output || '(empty)'))
      : null);
}

// --- Runs ---

const RUN_STATUS = { ok: ['Done', 'done'], stopped: ['Stopped', 'plain'], error: ['Failed', 'high'] };

// One run, folded: its status and time, and when opened each step's output. flowName: shown on the Runs tab.
function runItem(flow, r, flowName = '') {
  const nameOf = (id) => {
    const i = flow ? flow.steps.findIndex((s) => s.id === id) : -1;
    return i < 0 ? 'Removed step' : `${i + 1}. ${typeOf(flow.steps[i].type)[1]}`;
  };
  const [label, tone] = RUN_STATUS[r.status] ?? RUN_STATUS.error;
  return h('li', null, h('details', null,
    h('summary', { class: 'row' },
      h('span', { class: `pill tone-${tone}` }, label),
      r.dry ? h('span', { class: 'pill tone-low' }, 'Test') : null,
      flowName ? h('strong', null, flowName) : null,
      h('span', null, timeOf(r.at)),
      h('span', { class: 'muted small' }, r.dry ? 'test run' : r.manual ? 'run by hand' : 'on schedule'),
      r.error ? h('span', { class: `${r.status === 'error' ? 'error' : 'muted'} small grow` }, r.error) : null),
    h('ol', { class: 'cron-run-steps' }, r.steps.map((s) =>
      h('li', null,
        h('div', { class: 'row' }, h('strong', null, nameOf(s.stepId)), h('span', { class: 'muted small' }, `${s.ms} ms`)),
        s.note ? h('p', { class: 'muted small' }, s.note) : null,
        h('pre', { class: s.ok ? '' : 'error' }, s.output || '(empty)'))))));
}

function runList(store, flow) {
  const runs = store.get(COLLECTION).runs.filter((r) => r.flowId === flow.id).slice(0, 10);
  return h('section', { class: 'card stack' },
    h('h3', null, 'Runs'),
    runs.length
      ? h('ul', { class: 'cron-runs' }, runs.map((r) => runItem(flow, r)))
      : empty('No run yet. Use “Test run” to try the flow without creating anything.'));
}

// --- Editor ---

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
          onchange: (e) => updateFlow(store, flow.id, (f) => {
            f.name = e.target.value.trim() || 'Untitled flow';
          }),
        }),
        h('div', { class: 'row' },
          h('label', { class: 'check' },
            h('input', { type: 'checkbox', checked: flow.enabled, onchange: (e) => setEnabled(store, flow, e.target.checked) }),
            ' On schedule'),
          h('button', {
            type: 'button',
            class: 'btn-small',
            disabled: busy || !flow.steps.length,
            title: 'Runs every step but creates no task and sends no notification. AI steps still call the model.',
            onclick: () => startRun(store, flow, { dry: true }),
          }, icon('filter'), 'Test run'),
          h('button', { type: 'button', class: 'btn-small primary', disabled: busy || !flow.steps.length, onclick: () => startRun(store, flow) }, icon('play'), busy ? 'Running…' : 'Run now'),
          h('button', { type: 'button', class: 'icon-btn', title: 'Duplicate flow', 'aria-label': 'Duplicate flow', onclick: () => duplicateFlow(store, flow) }, icon('copy')),
          h('button', { type: 'button', class: 'icon-btn', title: 'Delete flow', 'aria-label': 'Delete flow', onclick: () => deleteFlow(store, flow) }, icon('trash')))),
      canvas(store, flow),
      h('p', { class: 'muted small' }, `Last run: ${timeOf(flow.lastRun)}${flow.enabled ? ` · next: ${timeOf(nextRun(flow).toISOString())}` : ''}`)),
    inspector(store, flow),
    runList(store, flow));
}

function draw(root, store) {
  const flows = store.get(COLLECTION).flows;
  const flow = flows.find((f) => f.id === view.flow) ?? flows[0] ?? null;
  if (flow) view.flow = flow.id;
  root.replaceChildren(
    h('div', { class: 'stack-lg cron' },
      h('header', null,
        h('h2', null, 'Cron'),
        h('p', { class: 'muted small' }, 'Recurring flows that gather data from the board, ask an AI model, and turn the answer into a task or a notification.')),
      h('div', { class: 'cron-layout' },
        flowList(store, flows),
        flow ? editor(store, flow) : h('div', { class: 'card stack' }, empty('Create a flow to schedule AI work, such as a morning plan from your open tasks.'),
          h('div', null, h('button', { type: 'button', class: 'primary', onclick: () => openNewFlow(store) }, icon('plus'), 'New flow'))))));
}

export default {
  id: 'cron',
  title: 'Cron',
  icon: 'repeat',
  collection: COLLECTION,
  defaults: DEFAULTS,
  render: draw,
  serialize: () => ({ flow: view.flow }),
  restore: (p = {}) => {
    if (p.flow && p.flow !== view.flow) view.node = 'trigger';
    view.flow = p.flow || '';
  },
};
