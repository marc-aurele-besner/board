import { h, icon, empty } from '../ui.js';
import { configure, checkGithubToken } from '../github.js';
import { editText, pickChip } from '../inline.js';

const COLLECTION = 'settings';
const OPENROUTER_CHECK = 'https://openrouter.ai/api/v1/auth/key';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

// Tasks the board can run with an AI model. Each one can be pinned to its own model.
export const DEFAULT_TASKS = [
  { id: 'task-summary', name: 'Project summaries', description: 'Summarize a project’s todos and notes into a short status.' },
  { id: 'task-plan', name: 'Next steps', description: 'Turn open todos into a prioritized plan for the day.' },
  { id: 'task-tidy', name: 'Tidy todos', description: 'Rewrite messy todo titles and suggest a category.' },
  { id: 'task-recipe', name: 'Recipe ideas', description: 'Suggest variations and substitutions for a kitchen recipe.' },
  { id: 'task-review', name: 'Issue & PR triage', description: 'Summarize open GitHub issues and PRs and flag stale ones.' },
  { id: 'task-budget', name: 'Spending review', description: 'Explain the month’s expenses and point out unusual categories.' },
];

const SECTIONS = [
  ['github', 'GitHub'],
  ['openrouter', 'OpenRouter'],
  ['models', 'Models & tasks'],
];

// Model used by a task: its own pin, else the default model. Empty string when neither is set.
export function modelForTask(store, taskId) {
  const models = store.get(COLLECTION).models;
  const task = models.tasks.find((t) => t.id === taskId);
  return task?.model || models.default || '';
}

// UI state: current section, last test result per service, whether a key is shown, and the model list.
const view = { section: 'github', results: {}, reveal: {}, catalog: { status: 'idle' } };

async function checkOpenRouterKey(key) {
  const res = await fetch(OPENROUTER_CHECK, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenRouter rejected this key. Create a new one at openrouter.ai/keys.' : `OpenRouter error ${res.status}`);
  const { data } = await res.json();
  return data?.label ? `Connected as “${data.label}”` : 'Connected';
}

function loadCatalog(store) {
  if (view.catalog.status === 'loading') return;
  view.catalog = { status: 'loading' };
  store.refresh();
  fetch(OPENROUTER_MODELS)
    .then((res) => {
      if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
      return res.json();
    })
    .then(({ data }) => {
      view.catalog = { status: 'ok', items: data.map((m) => ({ value: m.id, label: m.id, name: m.name })) };
    })
    .catch((err) => {
      view.catalog = { status: 'error', error: err.message };
    })
    .finally(() => store.refresh());
}

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

function statusBadge(saved, result) {
  if (!saved) return h('span', { class: 'pill tone-plain' }, 'Not set');
  if (result?.status === 'ok') return h('span', { class: 'pill tone-done' }, 'Connected');
  if (result?.status === 'error') return h('span', { class: 'pill tone-high' }, 'Rejected');
  return h('span', { class: 'pill tone-doing' }, 'Saved, not tested');
}

// A key card: setup steps on the left, the key field and its actions on the right.
function credentialCard(store, cfg) {
  const { id, field, title, intro, steps, placeholder, check, note, docs } = cfg;
  const saved = store.get(COLLECTION)[id]?.[field] ?? '';
  const result = view.results[id];
  const revealed = Boolean(view.reveal[id]);

  const save = (value) => {
    store.update(COLLECTION, (d) => {
      d[id] = { ...d[id], [field]: value };
    });
    if (id === 'github') configure(value);
    view.results[id] = null;
    store.refresh();
  };

  const runTest = () => {
    if (!saved) return;
    view.results[id] = { status: 'testing' };
    store.refresh();
    check(saved)
      .then((text) => (view.results[id] = { status: 'ok', text }))
      .catch((err) => (view.results[id] = { status: 'error', text: err.message }))
      .finally(() => store.refresh());
  };

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, title),
        h('p', { class: 'muted' }, intro)),
      h('div', { class: 'row' },
        statusBadge(saved, result),
        docs ? h('a', { href: docs, target: '_blank', rel: 'noopener', class: 'btn-link' }, 'Where to find it') : null)),

    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        h('ol', { class: 'steps' }, steps.map((s) => h('li', null, h('span', { class: 'step-text' }, s))))),

      h('form', {
        class: 'svc-section',
        onsubmit: (e) => {
          e.preventDefault();
          save(new FormData(e.currentTarget).get('secret').trim());
        },
      },
        h('h3', null, `${title} key`),
        h('div', { class: 'input-group' },
          h('input', {
            name: 'secret',
            type: revealed ? 'text' : 'password',
            value: saved,
            placeholder,
            autocomplete: 'off',
            spellcheck: false,
            'aria-describedby': `${id}-note`,
          }),
          h('button', {
            type: 'button',
            class: 'input-addon',
            'aria-label': revealed ? 'Hide key' : 'Show key',
            onclick: () => {
              view.reveal[id] = !revealed;
              store.refresh();
            },
          }, revealed ? 'Hide' : 'Show')),
        h('p', { id: `${id}-note`, class: 'muted small' }, note),
        h('div', { class: 'svc-actions' },
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
          h('button', { type: 'button', onclick: runTest, disabled: !saved }, 'Test connection'),
          saved ? h('button', { type: 'button', class: 'danger', onclick: () => save('') }, icon('x'), 'Clear') : null),
        result
          ? h('p', { class: `test-result ${result.status}`, role: 'status' },
              result.status === 'testing' ? 'Testing…' : result.text)
          : null)));
}

// --- Models & tasks ---

function updateModels(store, patch) {
  store.update(COLLECTION, (d) => {
    d.models = { ...d.models, ...patch };
  });
}

function updateTask(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const t = d.models.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  });
}

function addTask(store, name, description) {
  store.update(COLLECTION, (d) => {
    d.models.tasks.push({ id: `task-${Date.now().toString(36)}`, name, description, model: '' });
  });
}

function removeTask(store, id) {
  if (!confirm('Remove this task? Its model pin goes with it.')) return;
  store.update(COLLECTION, (d) => {
    d.models.tasks = d.models.tasks.filter((t) => t.id !== id);
  });
}

function modelsPanel(store) {
  const { models } = store.get(COLLECTION);
  const cat = view.catalog;
  const options = cat.items ?? [];

  const catalogLine = cat.status === 'loading'
    ? h('p', { class: 'muted' }, 'Loading the model list from OpenRouter…')
    : cat.status === 'error'
      ? h('p', { class: 'error', role: 'alert' }, `Could not load models: ${cat.error}. `)
      : h('p', { class: 'muted' }, `${options.length} models available. Pick one for each task below.`);

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Models & tasks'),
        h('p', { class: 'muted' }, 'Pin a model to each task. A task without its own pin uses the default model.')),
      h('button', { type: 'button', onclick: () => { view.catalog = { status: 'idle' }; loadCatalog(store); } }, icon('refresh'), 'Refresh models')),

    catalogLine,

    h('div', { class: 'default-model card-inset' },
      h('div', { class: 'grow' },
        h('strong', null, 'Default model'),
        h('p', { class: 'muted small' }, 'Used by every task without its own model.')),
      pickChip({
        value: models.default || null,
        options,
        placeholder: 'Choose a model',
        onPick: (v) => updateModels(store, { default: v ?? '' }),
      })),

    models.tasks.length
      ? h('ul', { class: 'task-list' },
          models.tasks.map((t) =>
            h('li', { class: 'task-row' },
              h('div', { class: 'task-info' },
                h('strong', null, editText({
                  value: t.name,
                  placeholder: 'Task name',
                  allowEmpty: false,
                  onSave: (name) => updateTask(store, t.id, { name }),
                })),
                h('div', { class: 'muted small' }, editText({
                  value: t.description,
                  placeholder: 'What this task is for',
                  allowEmpty: true,
                  onSave: (description) => updateTask(store, t.id, { description }),
                }))),
              pickChip({
                value: t.model || null,
                options,
                nullable: true,
                nullLabel: models.default ? `Default: ${models.default}` : 'Use default',
                onPick: (v) => updateTask(store, t.id, { model: v ?? '' }),
              }),
              h('button', {
                type: 'button',
                class: 'icon-btn',
                title: 'Remove task',
                'aria-label': `Remove ${t.name}`,
                onclick: () => removeTask(store, t.id),
              }, icon('x'))))
        )
      : empty('No tasks yet. Add one below.'),

    h('form', {
      class: 'add-task',
      onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = f.get('name').trim();
        if (name) addTask(store, name, f.get('description').trim());
      },
    },
      h('input', { name: 'name', placeholder: 'New task, e.g. Weekly review', 'aria-label': 'New task name', autocomplete: 'off', class: 'grow' }),
      h('input', { name: 'description', placeholder: 'What it is for (optional)', 'aria-label': 'Task description', autocomplete: 'off', class: 'grow' }),
      h('button', { class: 'primary', type: 'submit' }, 'Add task')));
}

// --- Page ---

function draw(root, store) {
  if (view.section === 'models' && view.catalog.status === 'idle') {
    // Load after this render finishes, so the refresh does not run inside it.
    setTimeout(() => loadCatalog(store), 0);
  }

  const github = credentialCard(store, {
    id: 'github',
    field: 'token',
    title: 'GitHub',
    docs: 'https://github.com/settings/personal-access-tokens',
    intro: 'A personal access token lets the board read private repos and raises the GitHub limit from 60 to 5,000 requests per hour.',
    steps: [
      ['Open ', link('https://github.com/settings/personal-access-tokens/new', 'the fine-grained token page'), '.'],
      'Resource owner: your account, or the organization that owns the private repos.',
      'Repository access: "Only select repositories", then pick the repos you link to projects.',
      'Permissions: set Issues and Pull requests to Read-only. Metadata is added automatically.',
      'Choose an expiration, generate, and copy the token. It starts with github_pat_.',
    ],
    placeholder: 'github_pat_…',
    check: checkGithubToken,
    note: 'A classic token with the repo scope also works, but it grants far broader access. Fine-grained is recommended.',
  });

  const openrouter = credentialCard(store, {
    id: 'openrouter',
    field: 'key',
    title: 'OpenRouter',
    docs: 'https://openrouter.ai/keys',
    intro: 'One key for many AI models. It is stored now for future AI features; no feature uses it yet.',
    steps: [
      ['Sign in at ', link('https://openrouter.ai', 'openrouter.ai'), ', then open ', link('https://openrouter.ai/keys', 'Keys'), '.'],
      'Create a key and give it a name. You can set a credit limit on it.',
      'Copy the key. It starts with sk-or- and is shown only once.',
    ],
    placeholder: 'sk-or-…',
    check: checkOpenRouterKey,
    note: 'If the key is ever exposed, revoke it on openrouter.ai/keys.',
  });

  const content = view.section === 'openrouter' ? openrouter
    : view.section === 'models' ? modelsPanel(store)
      : github;

  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
    SECTIONS.map(([key, label]) =>
      h('button', {
        type: 'button',
        class: view.section === key ? 'settings-tab active' : 'settings-tab',
        'aria-current': view.section === key ? 'page' : null,
        onclick: () => {
          view.section = key;
          store.refresh();
        },
      }, label)));

  root.replaceChildren(
    h('div', { class: 'settings-shell' },
      h('aside', { class: 'card settings-side' },
        h('h2', null, 'Settings'),
        h('p', { class: 'muted small' }, 'Keys are saved in settings.json in your data folder, on this computer. Each key goes only to its own service.'),
        nav),
      h('div', { class: 'settings-main' }, content)));
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  hidden: true, // opened from the gear icon in the top bar
  collection: COLLECTION,
  defaults: { github: { token: '' }, openrouter: { key: '' }, models: { default: '', tasks: DEFAULT_TASKS.map((t) => ({ ...t, model: '' })) } },
  render: draw,
  serialize: () => ({ section: view.section === 'github' ? '' : view.section }),
  restore: (p = {}) => {
    view.section = ['github', 'openrouter', 'models'].includes(p.section) ? p.section : 'github';
  },
};
