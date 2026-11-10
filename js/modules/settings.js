import { h, icon, empty, notice, todayISO } from '../ui.js';
import { fetchDayRate, manualRate, setManualRate, clearCachedRates } from '../fx.js';
import { configure, checkGithubToken } from '../github.js';
import { connect, disconnect, isConnected } from '../google.js';
import { editText } from '../inline.js';
import { modelChip } from '../model-picker.js';

const COLLECTION = 'settings';
const OPENROUTER_CHECK = 'https://openrouter.ai/api/v1/auth/key';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

// Tasks the board can run with an AI model. Each one can be pinned to its own model.
export const DEFAULT_TASKS = [
  { id: 'task-summary', name: 'Project summaries', description: 'Summarize a project’s todos and notes into a short status.' },
  { id: 'task-plan', name: 'Next steps', description: 'Turn open tasks into a prioritized plan for the day.' },
  { id: 'task-tidy', name: 'Tidy tasks', description: 'Rewrite messy todo titles and suggest a category.' },
  { id: 'task-recipe', name: 'Recipe ideas', description: 'Suggest variations and substitutions for a kitchen recipe.' },
  { id: 'task-review', name: 'Issue & PR triage', description: 'Summarize open GitHub issues and PRs and flag stale ones.' },
  { id: 'task-budget', name: 'Spending review', description: 'Explain the month’s expenses and point out unusual categories.' },
  { id: 'task-receipt', name: 'Read bills & screenshots', description: 'Turn a dropped bill or screenshot into money entries. Needs a model that can read images.' },
];

// Adds tasks that were introduced after a user's settings.json was created.
export function ensureTasks(store) {
  const have = new Set(store.get(COLLECTION).models.tasks.map((t) => t.id));
  const missing = DEFAULT_TASKS.filter((t) => !have.has(t.id));
  if (!missing.length) return;
  store.update(COLLECTION, (d) => {
    d.models.tasks.push(...missing.map((t) => ({ ...t, model: '' })));
  });
}

const SECTIONS = [
  ['github', 'GitHub'],
  ['openrouter', 'OpenRouter'],
  ['models', 'Models & tasks'],
  ['google', 'Google Calendar'],
  ['exchange', 'Exchange rates'],
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
      modelChip({
        value: models.default,
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
              modelChip({
                value: t.model,
                nullable: true,
                nullLabel: models.default ? `Default: ${models.default}` : 'Use default',
                requireImages: t.id === 'task-receipt',
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

// --- Exchange rates ---

// Result of the last connection check, shown on the card.
const exchange = { message: '', ok: null };

function exchangeCard(store) {
  const manual = manualRate();
  const today = todayISO();
  const check = () => {
    exchange.message = 'Checking…';
    exchange.ok = null;
    store.refresh();
    fetchDayRate(today)
      .then((rate) => {
        exchange.message = `Working. Today’s rate: 1 USD = ${rate.toFixed(4)} CAD.`;
        exchange.ok = true;
      })
      .catch((err) => {
        exchange.message = err.message;
        exchange.ok = false;
      })
      .finally(() => store.refresh());
  };
  const saveManual = (e) => {
    e.preventDefault();
    const v = Number(new FormData(e.currentTarget).get('rate'));
    setManualRate(v > 0 ? v : null);
    store.refresh();
  };

  const status = manual !== null
    ? h('span', { class: 'pill tone-doing' }, 'Your rate')
    : exchange.ok === true
      ? h('span', { class: 'pill tone-done' }, 'Working')
      : exchange.ok === false
        ? h('span', { class: 'pill tone-high' }, 'Failed')
        : h('span', { class: 'pill tone-plain' }, 'Not checked');

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Exchange rates'),
        h('p', { class: 'muted' }, 'Converts USD and CAD in Money. Each amount uses the rate of its own day, from the European Central Bank through Frankfurter. No account or key is needed.')),
      h('div', { class: 'row' }, status)),

    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Check the connection'),
        h('p', { class: 'muted small' }, 'Fetches today’s rate to confirm this browser can reach the service.'),
        h('div', { class: 'svc-actions' },
          h('button', { type: 'button', class: 'primary', onclick: check, disabled: exchange.message === 'Checking…' }, 'Check now')),
        exchange.ok === null || !exchange.message
          ? null
          : notice({ tone: exchange.ok ? 'ok' : 'error', text: exchange.message })),

      h('form', { class: 'svc-section', onsubmit: saveManual },
        h('h3', null, 'Use one rate instead'),
        h('p', { class: 'muted small' }, 'Optional. A fixed USD to CAD rate for every day, for example when you are offline. Leave it empty to use daily rates.'),
        h('div', { class: 'input-group' },
          h('input', {
            name: 'rate',
            type: 'number',
            step: '0.0001',
            min: '0',
            value: manual ?? '',
            placeholder: 'e.g. 1.3800',
            inputmode: 'decimal',
            'aria-label': 'Fixed USD to CAD rate',
          })),
        h('div', { class: 'svc-actions' },
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
          manual !== null
            ? h('button', { type: 'button', onclick: () => { setManualRate(null); store.refresh(); } }, 'Use daily rates')
            : null),

        h('h3', null, 'Stored rates'),
        h('p', { class: 'muted small' }, 'Daily rates are kept in this browser so past days are not fetched again.'),
        h('div', { class: 'svc-actions' },
          h('button', {
            type: 'button',
            class: 'danger',
            onclick: () => {
              clearCachedRates();
              exchange.message = 'Stored rates cleared. They will be fetched again when needed.';
              exchange.ok = true;
              store.refresh();
            },
          }, 'Forget stored rates')))));
}

// --- Google Calendar ---

// Connection state and the last message shown on the card.
const google = { message: '' };

function googleCard(store) {
  const clientId = store.get(COLLECTION).google?.clientId ?? '';
  const connected = isConnected();

  const save = (value) => {
    store.update(COLLECTION, (d) => {
      d.google = { ...d.google, clientId: value };
    });
    google.message = '';
    store.refresh();
  };
  const connectNow = () => {
    google.message = 'Waiting for Google…';
    store.refresh();
    connect(clientId)
      .then(() => {
        google.message = 'Connected. Home now shows your calendar.';
      })
      .catch((err) => {
        google.message = err.message;
      })
      .finally(() => store.refresh());
  };
  const disconnectNow = () => {
    disconnect();
    google.message = 'Disconnected.';
    store.refresh();
  };

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Google Calendar'),
        h('p', { class: 'muted' }, 'Shows the next two days of events on Home, read-only. Nothing is stored on disk. The connection lasts about an hour, then you connect again.')),
      h('div', { class: 'row' },
        connected
          ? h('span', { class: 'pill tone-done' }, 'Connected')
          : h('span', { class: 'pill tone-plain' }, 'Not connected'))),

    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        h('ol', { class: 'steps' }, [
          ['Open ', link('https://console.cloud.google.com/', 'Google Cloud Console'), ' and create a project, or pick one.'],
          ['APIs & Services → Library: enable ', link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'), '.'],
          ['APIs & Services → OAuth consent screen: choose External, and add your own Google account as a test user.'],
          ['APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.'],
          ['Under Authorized JavaScript origins, add the exact address you open the board at, such as http://localhost:8000.'],
          ['Copy the Client ID (it ends in .apps.googleusercontent.com) and paste it here.'],
        ].map((s) => h('li', null, h('span', { class: 'step-text' }, s))))),

      h('form', {
        class: 'svc-section',
        onsubmit: (e) => {
          e.preventDefault();
          save(new FormData(e.currentTarget).get('clientId').trim());
        },
      },
        h('h3', null, 'OAuth Client ID'),
        h('input', {
          name: 'clientId',
          value: clientId,
          placeholder: '123456789-abc….apps.googleusercontent.com',
          autocomplete: 'off',
          spellcheck: false,
        }),
        h('div', { class: 'svc-actions' },
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
          h('button', { type: 'button', onclick: connectNow, disabled: !clientId }, connected ? 'Reconnect' : 'Connect Google Calendar'),
          connected ? h('button', { type: 'button', onclick: disconnectNow }, 'Disconnect') : null),
        google.message ? h('p', { class: 'test-result', role: 'status' }, google.message) : null)));
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
      : view.section === 'google' ? googleCard(store)
        : view.section === 'exchange' ? exchangeCard(store)
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
  defaults: { github: { token: '' }, openrouter: { key: '' }, google: { clientId: '' }, models: { default: '', tasks: DEFAULT_TASKS.map((t) => ({ ...t, model: '' })) } },
  render: draw,
  serialize: () => ({ section: view.section === 'github' ? '' : view.section }),
  restore: (p = {}) => {
    view.section = ['github', 'openrouter', 'models', 'google', 'exchange'].includes(p.section) ? p.section : 'github';
  },
};
