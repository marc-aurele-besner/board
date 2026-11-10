import { h, icon, empty, notice, todayISO, copyable } from '../ui.js';
import { fetchDayRate, manualRate, setManualRate, clearCachedRates } from '../fx.js';
import { configure, checkGithubToken } from '../github.js';
import { connect, disconnect, isConnected } from '../google.js';
import { editText, pill } from '../inline.js';
import { modelChip } from '../model-picker.js';
import { isAddress, CHAINS, chainSettings, savedNode } from '../uniswap.js';
import { telegramCard, analyticsCard, searchCard, notificationsCard, automationsCard, dataCard } from './settings-more.js';

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

// Settings pages in nav order, grouped. Each item is [key, label, icon].
const SECTION_GROUPS = [
  {
    title: 'Connections',
    items: [
      ['github', 'GitHub', 'github'],
      ['openrouter', 'OpenRouter', 'key'],
      ['google', 'Google Calendar', 'calendar'],
      ['uniswap', 'Uniswap', 'wallet'],
      ['telegram', 'Telegram', 'send'],
      ['analytics', 'Google Analytics', 'activity'],
      ['search', 'Search consoles', 'search'],
    ],
  },
  {
    title: 'Preferences',
    items: [
      ['appearance', 'Appearance', 'palette'],
      ['models', 'Models & tasks', 'cpu'],
      ['categories', 'Categories', 'tag'],
      ['exchange', 'Exchange rates', 'coins'],
      ['notifications', 'Notifications', 'bell'],
      ['automations', 'Automations', 'zap'],
      ['data', 'Data folder', 'folder'],
    ],
  },
];
const PAGES = SECTION_GROUPS.flatMap((g) => g.items.map(([key]) => key));

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
  const { id, field, title, fieldLabel, intro, steps, placeholder, check, note, docs } = cfg;
  const saved = store.get(COLLECTION)[id]?.[field] ?? '';
  const result = view.results[id];
  const revealed = Boolean(view.reveal[id]);

  const save = (value) => {
    store.update(COLLECTION, (d) => {
      d[id] = { ...d[id], [field]: value };
    });
    if (id === 'github') configure(store.get(COLLECTION).github);
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
        h('h3', null, fieldLabel ?? `${title} key`),
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
          ['Under Authorized JavaScript origins, add the address you open the board at: ', copyable(location.origin), '.'],
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

// --- Appearance ---

const THEME_KEY = 'board:theme'; // unset: follow the system; otherwise 'light' or 'dark'
const DENSITY_KEY = 'board:density'; // 'comfortable' (default) or 'compact'

// Applies the saved theme and density. Runs at startup and whenever either changes.
export function applyAppearance() {
  let theme = null;
  let density = 'comfortable';
  try {
    theme = localStorage.getItem(THEME_KEY);
    density = localStorage.getItem(DENSITY_KEY) ?? 'comfortable';
  } catch {
    /* storage blocked: system theme, comfortable density */
  }
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
  document.body.classList.toggle('compact', density === 'compact');
}

// Colours for Money categories. The colour is saved on the Money data, so it shows wherever the category does.
function categoriesCard(store) {
  const fin = store.get('finance');
  const colors = fin.categoryColors ?? {};
  const names = [...new Set([...fin.categories, ...fin.entries.map((e) => e.category).filter(Boolean)])].sort((a, b) => a.localeCompare(b));
  const setColor = (name, color) => store.update('finance', (d) => {
    d.categoryColors = { ...(d.categoryColors ?? {}), [name]: color };
  });
  const clearColor = (name) => store.update('finance', (d) => {
    const next = { ...(d.categoryColors ?? {}) };
    delete next[name];
    d.categoryColors = next;
  });

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Categories'),
        h('p', { class: 'muted' }, 'Pick a colour for each category. Money shows it on the category wherever it appears, and in the category breakdown.'))),
    names.length
      ? h('ul', { class: 'category-colors' }, names.map((name) =>
          h('li', null,
            h('input', {
              type: 'color',
              value: colors[name] ?? '#8a8a85',
              'aria-label': `Colour for ${name}`,
              onchange: (e) => setColor(name, e.currentTarget.value),
            }),
            pill(name, { color: colors[name] }),
            h('span', { class: 'grow' }),
            h('span', { class: 'muted small' }, `${fin.entries.filter((e) => e.category === name).length} entries`),
            colors[name] ? h('button', { type: 'button', class: 'btn-small', onclick: () => clearColor(name) }, 'Reset') : null)))
      : empty('No categories yet. They appear here once an entry uses one.'));
}

const uniswapView = { message: '', ok: null };

// Public wallet addresses whose Uniswap v3 positions the LP tab reads, and the chains and nodes to read them from.
function uniswapCard(store) {
  const cfg = store.get(COLLECTION).uniswap ?? { wallets: [], chains: {} };
  const wallets = cfg.wallets ?? [];
  const save = (patch) => {
    store.update(COLLECTION, (d) => {
      d.uniswap = { wallets: [], chains: {}, ...d.uniswap, ...patch };
    });
    store.refresh();
  };
  const addWallet = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const address = String(form.get('address') ?? '').trim();
    if (!isAddress(address)) {
      uniswapView.ok = false;
      uniswapView.message = 'That is not an Ethereum address. It starts with 0x and has 40 hex characters.';
    } else if (wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
      uniswapView.ok = false;
      uniswapView.message = 'That address is already in the list.';
    } else {
      save({ wallets: [...wallets, { address, label: String(form.get('label') ?? '').trim() }] });
      e.currentTarget.reset();
      uniswapView.ok = true;
      uniswapView.message = 'Wallet added. Open LP positions to read it.';
    }
    store.refresh();
  };
  const saveChains = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const chains = {};
    const bad = [];
    for (const chain of CHAINS) {
      const node = String(form.get(`node-${chain.id}`) ?? '').trim();
      if (node && !/^https?:\/\//i.test(node)) bad.push(chain.name);
      chains[chain.id] = { enabled: form.get(`on-${chain.id}`) === 'on', node };
    }
    if (bad.length) {
      uniswapView.ok = false;
      uniswapView.message = `Node addresses start with https://. Check: ${bad.join(', ')}.`;
    } else {
      // node: '' drops the Ethereum-only field kept from before the chains list.
      save({ chains, node: '' });
      uniswapView.ok = true;
      uniswapView.message = 'Chains saved.';
    }
    store.refresh();
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Uniswap'),
    h('p', { class: 'muted small' }, 'Add the public address of each wallet that holds Uniswap v3 positions. The board only reads them. It never asks for a key and never signs anything.'),
    wallets.length
      ? h('ul', { class: 'stack' }, wallets.map((w, i) => h('li', { class: 'row between' },
        h('span', null, w.label ? `${w.label} · ` : '', copyable(w.address)),
        h('button', { type: 'button', class: 'btn-small', onclick: () => save({ wallets: wallets.filter((_, j) => j !== i) }) }, 'Remove'))))
      : h('p', { class: 'muted small' }, 'No wallets yet.'),
    h('form', { class: 'row', onsubmit: addWallet },
      h('input', { name: 'label', placeholder: 'Label (optional)', 'aria-label': 'Wallet label' }),
      h('input', { name: 'address', placeholder: '0x…', spellcheck: false, 'aria-label': 'Wallet address' }),
      h('button', { type: 'submit', class: 'btn-small' }, 'Add wallet')),
    h('form', { class: 'stack', onsubmit: saveChains },
      h('p', { class: 'muted small' }, 'Chains: the networks the LP tab reads. A node is the JSON-RPC address to read from. Leave it empty to use the public node shown as the placeholder.'),
      CHAINS.map((chain) => {
        const s = chainSettings(cfg, chain);
        return h('div', { class: 'row chain-row' },
          h('label', { class: 'row chain-name' },
            h('input', { type: 'checkbox', name: `on-${chain.id}`, checked: s.enabled }),
            h('span', null, chain.name)),
          h('input', { name: `node-${chain.id}`, value: savedNode(cfg, chain), placeholder: chain.rpc, spellcheck: false, 'aria-label': `${chain.name} node URL` }));
      }),
      h('button', { type: 'submit', class: 'btn-small' }, 'Save chains')),
    uniswapView.message ? notice({ tone: uniswapView.ok ? 'info' : 'error', text: uniswapView.message }) : null);
}

function setStored(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* storage blocked */
  }
}

function appearanceCard(store) {
  let theme = null;
  let density = 'comfortable';
  try {
    theme = localStorage.getItem(THEME_KEY);
    density = localStorage.getItem(DENSITY_KEY) ?? 'comfortable';
  } catch {
    /* storage blocked */
  }
  const choice = (label, value, current, onPick) =>
    h('button', {
      type: 'button',
      class: current === value ? 'seg active' : 'seg',
      'aria-pressed': String(current === value),
      onclick: () => onPick(value),
    }, label);
  const pickTheme = (value) => {
    setStored(THEME_KEY, value);
    applyAppearance();
    store.refresh();
  };
  const pickDensity = (value) => {
    setStored(DENSITY_KEY, value === 'compact' ? 'compact' : null);
    applyAppearance();
    store.refresh();
  };
  const labels = store.get('projects').categories ?? [];
  const setLabelColor = (id, color) => {
    store.update('projects', (d) => {
      const label = d.categories.find((x) => x.id === id);
      if (label) label.color = color;
    });
  };

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Appearance'),
        h('p', { class: 'muted' }, 'How the board looks on this computer. Saved in this browser, and changes apply as you pick them.'))),

    h('div', { class: 'svc-section' },
      h('h3', null, 'Theme'),
      h('div', { class: 'segmented app-seg' },
        choice('System', null, theme, pickTheme),
        choice('Light', 'light', theme, pickTheme),
        choice('Dark', 'dark', theme, pickTheme))),

    h('div', { class: 'svc-section' },
      h('h3', null, 'Density'),
      h('p', { class: 'muted small' }, 'Compact tightens the rows in tasks, projects and the board.'),
      h('div', { class: 'segmented app-seg' },
        choice('Comfortable', 'comfortable', density, pickDensity),
        choice('Compact', 'compact', density, pickDensity))),

    h('div', { class: 'svc-section' },
      h('h3', null, 'Label colours'),
      h('p', { class: 'muted small' }, 'Each project label has a colour. It shows on projects, tasks, the project tiles and in the label picker.'),
      labels.length
        ? h('ul', { class: 'label-colours' },
            labels.map((l) =>
              h('li', null,
                h('input', {
                  type: 'color',
                  value: l.color || '#2f6f4e',
                  'aria-label': `Colour for ${l.name}`,
                  onchange: (e) => setLabelColor(l.id, e.target.value),
                }),
                h('span', { class: 'pill tone-custom', style: { '--c': l.color || '#2f6f4e' } }, l.name))))
        : empty('No labels yet. Create them from Projects.')));
}

// --- Keys per organization ---

// The organization name from what was typed: a name, or a github.com link to one.
const orgNameFrom = (text) => String(text ?? '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '');

// Result of the last test of an organization key, which one is being tested, and the organization picked
// in the dropdown (set by the "Add token" button on a row).
const orgKeys = { message: '', ok: true, testing: null, pick: '' };

// Every organization the projects use: the org set on each project, and the owner of each linked repo.
function knownOrgs(store) {
  const names = new Map(); // lower-case name -> name as written
  const add = (name) => {
    const v = String(name ?? '').trim();
    if (v && !names.has(v.toLowerCase())) names.set(v.toLowerCase(), v);
  };
  for (const p of store.get('projects').projects) {
    add(p.github?.org);
    for (const repo of p.github?.repos ?? []) add(String(repo).split('/')[0]);
  }
  return [...names.values()];
}

function orgKeysCard(store) {
  const orgs = store.get(COLLECTION).github?.orgs ?? [];
  const tokenFor = (name) => orgs.find((x) => x.org.toLowerCase() === name.toLowerCase());
  // Projects' organizations, plus any organization that has a token but no project yet.
  const known = knownOrgs(store);
  const all = [...known, ...orgs.map((o) => o.org).filter((o) => !known.some((k) => k.toLowerCase() === o.toLowerCase()))]
    .sort((a, b) => a.localeCompare(b));
  const missing = all.filter((name) => !tokenFor(name));

  const saveOrgs = (list) => {
    store.update(COLLECTION, (d) => {
      d.github = { ...d.github, orgs: list };
    });
    configure(store.get(COLLECTION).github);
    store.refresh();
  };
  const testOrg = (entry) => {
    orgKeys.testing = entry.org;
    orgKeys.message = '';
    store.refresh();
    checkGithubToken(entry.token)
      .then((login) => {
        orgKeys.ok = true;
        orgKeys.message = `${entry.org}: connected as ${login}.`;
      })
      .catch((err) => {
        orgKeys.ok = false;
        orgKeys.message = `${entry.org}: ${err.message}`;
      })
      .finally(() => {
        orgKeys.testing = null;
        store.refresh();
      });
  };
  const mask = (token) => `••••${token.slice(-4)}`;

  const rows = all.length
    ? h('ul', { class: 'org-keys' },
        all.map((name) => {
          const entry = tokenFor(name);
          return h('li', null,
            h('span', { class: 'pill tone-plain' }, name),
            entry
              ? h('span', { class: 'pill tone-done' }, 'Token saved')
              : h('span', { class: 'pill tone-doing' }, 'No token'),
            entry ? h('code', { class: 'muted small' }, mask(entry.token)) : null,
            h('span', { class: 'grow' }),
            entry
              ? h('button', {
                  type: 'button',
                  class: 'btn-small',
                  disabled: orgKeys.testing === entry.org,
                  onclick: () => testOrg(entry),
                }, orgKeys.testing === entry.org ? 'Testing…' : 'Test')
              : h('button', {
                  type: 'button',
                  class: 'btn-small primary-link',
                  onclick: () => {
                    orgKeys.pick = name;
                    orgKeys.message = '';
                    store.refresh();
                  },
                }, icon('plus'), 'Add token'),
            entry
              ? h('button', {
                  type: 'button',
                  class: 'btn-small danger',
                  onclick: () => {
                    if (confirm(`Remove the token for ${name}? Its repos fall back to the personal token.`)) {
                      saveOrgs(orgs.filter((x) => x.org !== name));
                    }
                  },
                }, icon('x'), 'Remove')
              : null);
        }))
    : empty('No organizations yet. Link a project to a GitHub organization and it appears here.');

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Organization tokens'),
        h('p', { class: 'muted' }, `Organizations your projects use. ${missing.length ? `${missing.length} ${missing.length === 1 ? 'has' : 'have'} no token yet and use the personal token.` : 'Every organization has a token.'} A token is made with that organization as resource owner, with the same permissions as the personal token. If the organization requires approval for personal access tokens, an organization owner has to approve it first.`))),

    rows,

    orgKeys.message ? notice({ tone: orgKeys.ok ? 'ok' : 'error', text: orgKeys.message }) : null,

    h('h3', null, 'Add a token'),
    h('form', {
      class: 'org-key-form',
      onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const org = orgNameFrom(f.get('other')) || String(f.get('org') ?? '');
        const token = String(f.get('token') ?? '').trim();
        if (!/^[\w.-]+$/.test(org) || !token) return;
        saveOrgs([...orgs.filter((x) => x.org.toLowerCase() !== org.toLowerCase()), { org, token }]);
        orgKeys.pick = '';
        orgKeys.message = '';
        e.currentTarget.reset();
      },
    },
      h('select', { name: 'org', value: orgKeys.pick, 'aria-label': 'Organization without a token' },
        h('option', { value: '' }, missing.length ? 'Choose an organization without a token' : 'Every organization has a token'),
        missing.map((name) => h('option', { value: name }, name))),
      h('input', { name: 'other', placeholder: 'Or type another organization', 'aria-label': 'Another organization', autocomplete: 'off', spellcheck: false }),
      h('input', { name: 'token', type: 'password', placeholder: 'github_pat_…', 'aria-label': 'Token for this organization', autocomplete: 'off', spellcheck: false }),
      h('button', { class: 'primary', type: 'submit' }, 'Add token')));
}

// Explains which GitHub token does what, so a personal token is not mistaken for an organization one.
function tokenGuide() {
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Which token do I need?'),
        h('p', { class: 'muted' }, 'Start with a personal token. Add an organization token only when an organization needs its own.'))),
    h('div', { class: 'token-guide' },
      h('div', null,
        h('h3', null, 'Personal token (required)'),
        h('p', { class: 'muted small' }, 'Made from your own account. Used for every repo that has no organization token: your repos and public repos.')),
      h('div', null,
        h('h3', null, 'Organization token (optional)'),
        h('p', { class: 'muted small' }, 'Made with the organization as resource owner. Used for that organization’s repos, private ones included. Add one when your personal token cannot see the organization’s private repos, or when you want that organization’s access kept separate.'))),
    h('p', { class: 'muted small' }, 'Lookup: a repo under an organization that has a token uses that token. Every other repo uses the personal token.'));
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
    title: 'Personal token',
    fieldLabel: 'Personal token',
    docs: 'https://github.com/settings/personal-access-tokens',
    intro: 'Your main token. The board uses it for every repo that has no organization token: your own repos and public repos. It also raises the GitHub limit from 60 to 5,000 requests per hour.',
    steps: [
      ['Open ', link('https://github.com/settings/personal-access-tokens/new', 'the fine-grained token page'), '.'],
      'Resource owner: your own account.',
      'Repository access: "All repositories" lets the board see every repo you can see. "Only select repositories" limits it to the repos you link to projects.',
      'Permissions: Contents and Pull requests set to Read-only. Issues set to Read and write, so tasks can create issues. Metadata is added automatically.',
      'Choose an expiration, generate the token, and copy it. It starts with github_pat_.',
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
    intro: 'One key for many AI models. It powers Plan my day, Tidy with AI, recipe import, bill reading, triage and the spending review.',
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
        : view.section === 'appearance' ? appearanceCard(store)
        : view.section === 'uniswap' ? uniswapCard(store)
        : view.section === 'categories' ? categoriesCard(store)
        : view.section === 'telegram' ? telegramCard(store)
        : view.section === 'analytics' ? analyticsCard(store)
        : view.section === 'search' ? searchCard(store)
        : view.section === 'notifications' ? notificationsCard(store)
        : view.section === 'automations' ? automationsCard(store)
        : view.section === 'data' ? dataCard(store)
        : h('div', { class: 'stack-lg' }, tokenGuide(), github, orgKeysCard(store));

  const nav = h('nav', { class: 'settings-nav', 'aria-label': 'Settings sections' },
    SECTION_GROUPS.map((group) =>
      h('div', { class: 'settings-group' },
        h('p', { class: 'settings-group-title' }, group.title),
        group.items.map(([key, label, iconName]) =>
          h('button', {
            type: 'button',
            class: view.section === key ? 'settings-tab active' : 'settings-tab',
            'aria-current': view.section === key ? 'page' : null,
            onclick: () => {
              view.section = key;
              store.refresh();
            },
          }, icon(iconName), h('span', null, label))))));

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
  collection: COLLECTION,
  defaults: { github: { token: '', orgs: [] }, openrouter: { key: '' }, google: { clientId: '' }, uniswap: { wallets: [], chains: {} }, telegram: { token: '', chatId: '', confirm: true, offset: 0 }, analytics: { properties: {} }, bing: { key: '', relay: '' }, automations: {}, models: { default: '', tasks: DEFAULT_TASKS.map((t) => ({ ...t, model: '' })) } },
  render: draw,
  serialize: () => ({ section: view.section === 'github' ? '' : view.section }),
  restore: (p = {}) => {
    view.section = PAGES.includes(p.section) ? p.section : 'github';
  },
};
