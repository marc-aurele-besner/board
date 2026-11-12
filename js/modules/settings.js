import { h, icon, refreshIcon, empty, notice, copyable } from '../ui.js';
import { toast } from '../toast.js';
import { redirectUri } from '../google.js';
import { manualRate, setManualRate, clearCachedRates, PROVIDERS, providerId, setProvider, fallbackOn, setFallback, testProvider, lastSource } from '../fx.js';
import { configure, checkGithubToken, orgAvatar } from '../github.js';
import { editText } from '../inline.js';
import { modelChip } from '../model-picker.js';
import { isAddress, CHAINS, parsePosition, addPosition, addedPositions, addedListOf, tokenLogos } from '../uniswap.js';
import { positionFields, positionError } from '../position-input.js';
import { calendarAccountsCard, telegramCard, analyticsCard, searchCard, resendCard, gmailCard, notificationsCard, automationsCard, dataCard } from './settings-more.js';
import { promptsCard } from './settings-prompts.js';
import { labelsCard } from './settings-labels.js';
import { chainsCard } from './settings-chains.js';
import { contractsCard } from './settings-contracts.js';
import { devEnvironmentCard } from './settings-dev.js';
import { runnersCard } from './settings-runners.js';
import { logo } from './positions.js';

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
  { id: 'task-cron', name: 'Cron flows', description: 'Default model for the AI steps of Cron flows. A step can pick its own.' },
  { id: 'task-pools', name: 'Pool insights', description: 'Read Uniswap positions in and out of range and suggest range adjustments.' },
  { id: 'task-receipt', name: 'Read bills & screenshots', description: 'Turn a dropped bill or screenshot into money entries. Needs a model that can read images.' },
  { id: 'task-recipe-photo', name: 'Read recipe photos', description: 'Rewrite a photo of a handwritten or printed recipe as a Kitchen recipe. Needs a model that can read images.' },
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
      ['gmail', 'Gmail', 'inbox'],
      ['wallets', 'Wallets', 'wallet'],
      ['blockchains', 'Blockchains', 'cube'],
      ['contracts', 'Smart contracts', 'code'],
      ['uniswap', 'Uniswap', 'droplet'],
      ['telegram', 'Telegram', 'send'],
      ['analytics', 'Google Analytics', 'activity'],
      ['search', 'Search consoles', 'search'],
      ['resend', 'Resend', 'mail'],
      ['exchange', 'Exchange rates', 'coins'],
    ],
  },
  {
    title: 'Preferences',
    items: [
      ['appearance', 'Appearance', 'palette'],
      ['models', 'Models & tasks', 'cpu'],
      ['prompts', 'Prompts', 'sparkle'],
      ['categories', 'Labels', 'tag'],
      ['notifications', 'Notifications', 'bell'],
      ['automations', 'Automations', 'zap'],
      ['dev', 'Dev environment', 'terminal'],
      ['runners', 'Runners', 'activity'],
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
      h('button', {
        type: 'button',
        disabled: cat.status === 'loading',
        'aria-busy': cat.status === 'loading' ? 'true' : null,
        onclick: () => { view.catalog = { status: 'idle' }; loadCatalog(store); },
      }, refreshIcon(cat.status === 'loading'), cat.status === 'loading' ? 'Refreshing…' : 'Refresh models')),

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
                requireImages: t.id === 'task-receipt' || t.id === 'task-recipe-photo',
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

// The last check of each provider, shown on its row: { [id]: { status: 'checking' | 'ok' | 'error', text } }.
const exchange = { results: {} };

function exchangeCard(store) {
  const manual = manualRate();
  const first = providerId();
  const fallback = fallbackOn();
  const check = (p) => {
    exchange.results[p.id] = { status: 'checking', text: 'Checking…' };
    store.refresh();
    testProvider(p.id)
      .then(({ rate, date }) => {
        exchange.results[p.id] = { status: 'ok', text: `1 USD = ${rate.toFixed(4)} CAD on ${date}` };
      })
      .catch((err) => {
        exchange.results[p.id] = { status: 'error', text: err.message };
      })
      .finally(() => store.refresh());
  };
  const saveManual = (e) => {
    e.preventDefault();
    const v = Number(new FormData(e.currentTarget).get('rate'));
    setManualRate(v > 0 ? v : null);
    store.refresh();
  };
  const results = Object.values(exchange.results);
  const firstResult = exchange.results[first];
  const status = manual !== null
    ? h('span', { class: 'pill tone-doing' }, 'Your rate')
    : firstResult?.status === 'ok'
      ? h('span', { class: 'pill tone-done' }, 'Working')
      : results.some((r) => r.status === 'ok') && fallback
        ? h('span', { class: 'pill tone-doing' }, 'Using a fallback')
        : results.some((r) => r.status === 'error')
          ? h('span', { class: 'pill tone-high' }, 'Failed')
          : h('span', { class: 'pill tone-plain' }, 'Not checked');
  const used = PROVIDERS.find((p) => p.id === (lastSource.id ?? first));

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Exchange rates'),
        h('p', { class: 'muted' }, `Converts USD and CAD in Money. Each amount uses the rate of its own day. Rates come from ${used.name} (${used.source.replace(/\.$/, '')}). No account or key is needed.`)),
      h('div', { class: 'row' }, status)),

    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Providers'),
        h('p', { class: 'muted small' }, 'The board asks the provider you pick first. When it does not answer, the next one in the list is asked, so Money keeps converting if one service is down. Only the days whose rate Money needs are sent.'),
        h('ul', { class: 'fx-providers' },
          PROVIDERS.map((p) => {
            const r = exchange.results[p.id];
            return h('li', null,
              h('label', { class: 'fx-provider-pick' },
                h('input', {
                  type: 'radio',
                  name: 'fx-provider',
                  checked: p.id === first,
                  onchange: () => {
                    setProvider(p.id);
                    store.refresh();
                  },
                }),
                h('span', null,
                  h('strong', null, p.name),
                  p.id === first ? h('span', { class: 'pill tone-plain' }, 'Asked first') : null,
                  h('span', { class: 'muted small fx-provider-source' }, p.source, ' ', link(p.docs, p.host)))),
              h('span', { class: 'grow' }),
              r ? h('span', { class: `small fx-result ${r.status}`, role: 'status' }, r.text) : null,
              h('button', { type: 'button', class: 'btn-small', disabled: r?.status === 'checking', onclick: () => check(p) }, 'Check'));
          })),
        h('div', { class: 'svc-actions' },
          h('button', { type: 'button', class: 'primary', onclick: () => PROVIDERS.forEach(check) }, 'Check all'),
          h('label', { class: 'row check' },
            h('input', {
              type: 'checkbox',
              checked: fallback,
              onchange: (e) => {
                setFallback(e.target.checked);
                store.refresh();
              },
            }),
            h('span', null, 'Fall back to the other providers')))),

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
              store.refresh();
              toast('Stored rates cleared. They are fetched again when needed.');
            },
          }, 'Forget stored rates')))));
}

// --- Google Calendar ---

function googleCard(store) {
  const { clientId = '', clientSecret = '' } = store.get(COLLECTION).google ?? {};
  const save = (fields) => {
    store.update(COLLECTION, (d) => {
      d.google = { ...d.google, ...fields };
    });
  };
  const accounts = store.get(COLLECTION).gcal?.accounts?.length ?? 0;

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Google Calendar'),
          h('p', { class: 'muted' }, 'Shows the events of one or more Google accounts in Calendar and the next two days on Home, read-only. Each account connects once: its sign-in is kept in google.json in the data folder and renewed before it expires, so every browser profile that opens the folder is connected. Gmail, Analytics and Search Console use the same Client ID and secret.')),
        h('div', { class: 'row' },
          clientId
            ? h('span', { class: 'pill tone-done' }, accounts ? `${accounts} account${accounts === 1 ? '' : 's'}` : 'Client ID set')
            : h('span', { class: 'pill tone-plain' }, 'Not set'))),

      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          h('ol', { class: 'steps' }, [
            ['Open ', link('https://console.cloud.google.com/', 'Google Cloud Console'), ' and create a project, or pick one.'],
            ['APIs & Services → Library: enable ', link('https://console.cloud.google.com/apis/library/calendar-json.googleapis.com', 'Google Calendar API'), '.'],
            ['APIs & Services → OAuth consent screen: choose External, and add each Google account you will connect as a test user.'],
            ['APIs & Services → Credentials → Create credentials → OAuth client ID → Web application.'],
            ['Under Authorized JavaScript origins, add the address you open the board at: ', copyable(location.origin), '.'],
            ['Under Authorized redirect URIs, add ', copyable(redirectUri()), '.'],
            ['Copy the Client ID (it ends in .apps.googleusercontent.com) and the Client secret, paste them here, then add your accounts below.'],
          ].map((s) => h('li', null, h('span', { class: 'step-text' }, s))))),

        h('form', {
          class: 'svc-section',
          onsubmit: (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            save({ clientId: form.get('clientId').trim(), clientSecret: form.get('clientSecret').trim() });
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
          h('h3', null, 'OAuth Client secret'),
          h('p', { class: 'muted small' }, 'Lets the board renew each sign-in by itself. Saved in settings.json and sent only to Google.'),
          h('input', {
            name: 'clientSecret',
            type: 'password',
            value: clientSecret,
            placeholder: 'GOCSPX-…',
            autocomplete: 'off',
            spellcheck: false,
          }),
          h('div', { class: 'svc-actions' },
            h('button', { class: 'primary', type: 'submit' }, 'Save'))))),
    calendarAccountsCard(store));
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

const uniswapView = { message: '', ok: null };

// Token logos, read once from the token list; the page redraws when they arrive.
let tokenLogoMap = new Map();
let tokenLogosAsked = false;

// The positions added by hand, with the pair and range from the last Liquidity Pools read when there is one.
function addedList(store, added, remove) {
  if (!tokenLogosAsked) {
    tokenLogosAsked = true;
    tokenLogos().then((map) => {
      tokenLogoMap = map;
      store.refresh();
    });
  }
  // The same key as a pools row's ref: v3 rows have no version in it.
  const refOf = (x) => (x.version === 'v3' ? `${x.chainId}:${x.tokenId}` : `${x.chainId}:${x.version}:${x.tokenId}`);
  const read = new Map();
  for (const part of Object.values(store.get('pools')?.cache ?? {})) for (const r of part.rows ?? []) read.set(r.ref, r);
  const tokenLogo = (chainId, address) => (address ? tokenLogoMap.get(`${chainId}:${address.toLowerCase()}`) ?? null : null);
  const rows = added
    .map((x) => ({ x, r: read.get(refOf(x)) ?? null, chain: CHAINS.find((c) => c.id === x.chainId) }))
    .sort((a, b) => (a.chain?.name ?? '').localeCompare(b.chain?.name ?? '') || Number(a.x.tokenId) - Number(b.x.tokenId));
  const status = (r) => (!r ? ['unread', 'Not read yet'] : r.closed ? ['closed', 'Closed'] : r.inRange ? ['in', 'In range'] : ['out', 'Out of range']);

  return h('ul', { class: 'added-list' },
    h('li', { class: 'added-row added-head', 'aria-hidden': 'true' },
      h('span', null, 'Chain'), h('span', null, 'Pair'), h('span', null, 'Position'), h('span', null, 'Status'), h('span')),
    rows.map(({ x, r, chain }) => {
      const [tone, label] = status(r);
      return h('li', { class: `added-row tone-${tone}` },
        h('span', { class: 'added-chain' }, logo(chain?.logo, chain?.name ?? `Chain ${x.chainId}`, 'xs'), chain?.name ?? `Chain ${x.chainId}`),
        r
          ? h('span', { class: 'added-pair' },
              h('span', { class: 'pair' }, logo(tokenLogo(x.chainId, r.addr0), r.sym0, 'sm'), logo(tokenLogo(x.chainId, r.addr1), r.sym1, 'sm second')),
              h('strong', null, `${r.sym0} / ${r.sym1}`))
          : h('span', { class: 'added-pair muted' }, 'Open Liquidity Pools to read it'),
        h('span', { class: 'added-id' }, r?.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, `${x.version} #${x.tokenId}`) : `${x.version} #${x.tokenId}`),
        h('span', { class: 'added-status small' }, h('span', { class: `pos-dot ${tone === 'unread' ? 'gone' : tone}`, 'aria-hidden': 'true' }), label),
        h('button', { type: 'button', class: 'btn-small', onclick: () => remove(x) }, 'Remove'));
    }));
}

const walletsView = { message: '', ok: null };

// Saves into settings.uniswap, where the wallet list was first kept, so older data folders keep their wallets.
const saveUniswap = (store, patch) => {
  store.update(COLLECTION, (d) => {
    d.uniswap = { wallets: [], chains: {}, ...d.uniswap, ...patch };
  });
  store.refresh();
};

// Public wallet addresses that every DeFi tab reads: Liquidity Pools, Wallets and Lending / Borrowing.
function walletsCard(store) {
  const wallets = store.get(COLLECTION).uniswap?.wallets ?? [];
  const save = (patch) => saveUniswap(store, patch);
  const addWallet = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const address = String(form.get('address') ?? '').trim();
    if (!isAddress(address)) {
      walletsView.ok = false;
      walletsView.message = 'That is not an Ethereum address. It starts with 0x and has 40 hex characters.';
    } else if (wallets.some((w) => w.address.toLowerCase() === address.toLowerCase())) {
      walletsView.ok = false;
      walletsView.message = 'That address is already in the list.';
    } else {
      save({ wallets: [...wallets, { address, label: String(form.get('label') ?? '').trim() }] });
      e.currentTarget.reset();
      walletsView.ok = true;
      walletsView.message = 'Wallet added. Open DeFi to read it.';
    }
    store.refresh();
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Wallets'),
    h('p', { class: 'muted small' }, 'Add the public address of each wallet to follow. DeFi reads them for Uniswap positions, wallet balances and Aave lending. The board only reads them. It never asks for a key and never signs anything.'),
    wallets.length
      ? h('ul', { class: 'stack' }, wallets.map((w, i) => h('li', { class: 'row between' },
        h('span', null, w.label ? `${w.label} · ` : '', copyable(w.address)),
        h('button', { type: 'button', class: 'btn-small', onclick: () => save({ wallets: wallets.filter((_, j) => j !== i) }) }, 'Remove'))))
      : h('p', { class: 'muted small' }, 'No wallets yet.'),
    h('form', { class: 'row', onsubmit: addWallet },
      h('input', { name: 'label', placeholder: 'Label (optional)', 'aria-label': 'Wallet label' }),
      h('input', { name: 'address', placeholder: '0x…', spellcheck: false, 'aria-label': 'Wallet address' }),
      h('button', { type: 'submit', class: 'btn-small' }, 'Add wallet')),
    walletsView.message ? notice({ tone: walletsView.ok ? 'info' : 'error', text: walletsView.message }) : null);
}

// Uniswap positions added by hand, for those the board does not find in the wallets.
function uniswapCard(store) {
  const cfg = store.get(COLLECTION).uniswap ?? { wallets: [], chains: {} };
  const added = addedPositions(cfg);
  const save = (patch) => saveUniswap(store, patch);
  // A position the board does not find: a link from the Uniswap app, or a number with its chain and version.
  const addAdded = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const entry = parsePosition(form.get('position'), Number(form.get('chain')), String(form.get('version')));
    const error = entry ? addPosition(store, entry) : positionError(form.get('position'));
    uniswapView.ok = !error;
    uniswapView.message = error || 'Position added. Open Liquidity Pools to read it.';
    if (!error) e.currentTarget.reset();
    store.refresh();
  };
  const removeAdded = (x) => {
    const list = addedListOf(x.version);
    save({ [list]: (cfg[list] ?? []).filter((y) => !(y.chainId === x.chainId && String(y.tokenId) === String(x.tokenId))) });
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Uniswap'),
    h('p', { class: 'muted small' }, 'Uniswap v3 and v4 positions are read from the wallets in ',
      h('button', { type: 'button', class: 'btn-link-inline', onclick: () => { view.section = 'wallets'; store.refresh(); } }, 'Wallets'), '.'),
    h('p', { class: 'muted small' }, 'Positions added by hand: a v3 position held by an address that is not in Wallets, or a v4 position the board does not find. v4 positions are found by searching each wallet\'s history on the chain, and most public nodes only search recent blocks. The Liquidity Pools tab has the same Add position button.'),
    added.length ? addedList(store, added, removeAdded) : null,
    (() => {
      const f = positionFields();
      return h('form', { class: 'stack', onsubmit: addAdded, onreset: f.reset },
        h('div', { class: 'row' }, f.input, f.pickers, h('button', { type: 'submit', class: 'btn-small' }, 'Add position')),
        f.hint);
    })(),
    h('p', { class: 'muted small' }, 'The chains the LP tab reads, the node each is read from, and the Etherscan API key are set in ',
      h('button', { type: 'button', class: 'btn-link-inline', onclick: () => { view.section = 'blockchains'; store.refresh(); } }, 'Blockchains'), '.'),
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
        choice('Compact', 'compact', density, pickDensity))));
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
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
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
            orgAvatar(name),
            h('strong', null, name),
            h('span', { class: entry ? 'muted small' : 'org-missing small' }, entry ? 'Token saved' : 'No token'),
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
      : view.section === 'prompts' ? promptsCard(store)
      : view.section === 'google' ? googleCard(store)
        : view.section === 'exchange' ? exchangeCard(store)
        : view.section === 'appearance' ? appearanceCard(store)
        : view.section === 'wallets' ? walletsCard(store)
        : view.section === 'uniswap' ? uniswapCard(store)
        : view.section === 'blockchains' ? chainsCard(store)
        : view.section === 'contracts' ? contractsCard(store)
        : view.section === 'categories' ? labelsCard(store)
        : view.section === 'telegram' ? telegramCard(store)
        : view.section === 'analytics' ? analyticsCard(store)
        : view.section === 'search' ? searchCard(store)
        : view.section === 'resend' ? resendCard(store)
        : view.section === 'gmail' ? gmailCard(store)
        : view.section === 'notifications' ? notificationsCard(store)
        : view.section === 'automations' ? automationsCard(store)
        : view.section === 'dev' ? devEnvironmentCard(store)
        : view.section === 'runners' ? runnersCard(store)
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
  hidden: true, // opened from the gear in the top bar
  collection: COLLECTION,
  // Settings → Runners shows each job's last and next run, so it redraws on every heartbeat change.
  get readsRunners() {
    return view.section === 'runners' ? 'all' : false;
  },
  defaults: { github: { token: '', orgs: [] }, openrouter: { key: '' }, google: { clientId: '', clientSecret: '' }, uniswap: { wallets: [], chains: {} }, blockchains: { custom: [] }, contracts: [], telegram: { token: '', chatId: '', confirm: true, offset: 0 }, analytics: { properties: {} }, bing: { key: '', relay: '' }, resend: { relay: '', keys: {} }, gmail: { accounts: [] }, gcal: { accounts: [] }, automations: {}, models: { default: '', tasks: DEFAULT_TASKS.map((t) => ({ ...t, model: '' })) }, prompts: {} },
  render: draw,
  serialize: () => ({ section: view.section === 'github' ? '' : view.section }),
  restore: (p = {}) => {
    view.section = PAGES.includes(p.section) ? p.section : 'github';
  },
};
