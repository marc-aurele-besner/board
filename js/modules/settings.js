import { h, icon, refreshIcon, empty, notice, copyable } from '../ui.js';
import { toast } from '../toast.js';
import { redirectUri } from '../google.js';
import { manualRate, setManualRate, clearCachedRates, PROVIDERS, providerId, setProvider, fallbackOn, setFallback, testProvider, lastSource } from '../fx.js';
import { configure, checkGithubToken, orgAvatar } from '../github.js';
import { checkVercel, checkNetlify } from '../deployments.js';
import { trackedPrs } from '../previews.js';
import { runJob } from '../runners.js';
import { editText } from '../inline.js';
import { modelChip } from '../model-picker.js';
import { isAddress, CHAINS, parsePosition, addPosition, addedPositions, addedListOf, tokenLogos, dexName } from '../uniswap.js';
import { positionFields, positionError } from '../position-input.js';
import { calendarAccountsCard, telegramCard, analyticsCard, websitesCard, searchCard, resendCard, gmailCard, notificationsCard, automationsCard, dataCard } from './settings-more.js';
import { promptsCard } from './settings-prompts.js';
import { labelsCard } from './settings-labels.js';
import { chainsCard } from './settings-chains.js';
import { contractsCard } from './settings-contracts.js';
import { devEnvironmentCard } from './settings-dev.js';
import { runnersCard } from './settings-runners.js';
import { slackCard } from './settings-slack.js';
import { socialsCard } from './settings-socials.js';
import { notionCard } from './settings-notion.js';
import { modelForTask } from '../models.js';
import { logo } from './positions.js';
import { appearanceCard } from './settings-appearance.js';
import { SETTINGS_CATEGORIES, SETTINGS_PAGES, categoryOf } from '../settings-pages.js';
import { runnersKnown, runnersOnline } from '../runners.js';
import { isConnected } from '../google-core.js';
import { sitesOf } from '../automations.js';
import { overrides } from '../prompts.js';
import { devAgents, defaultAgent } from '../dev-core.js';
import { removeWithUndo } from '../remove.js';

/** @import { Store, IconName, AddedPosition, GithubOrgToken, UniswapSettings, PoolRow, ModelsSettings, ModelTask, GoogleSettings } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @typedef {SubmitEvent & { currentTarget: HTMLFormElement }} FormSubmit */
/** @typedef {AddedPosition & { version: string }} Added */

const COLLECTION = 'settings';
const OPENROUTER_CHECK = 'https://openrouter.ai/api/v1/auth/key';
const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';

// The tasks that read images: their model dialog lists the models that can.
const IMAGE_TASKS = ['task-receipt', 'task-recipe-photo'];

// Tasks the board can run with an AI model. Each one can be pinned to its own model.
export const DEFAULT_TASKS = [
  { id: 'task-summary', name: 'Project summaries', description: 'Summarize a project’s todos and notes into a short status.' },
  { id: 'task-plan', name: 'Next steps', description: 'Turn open tasks into a prioritized plan for the day.' },
  { id: 'task-tidy', name: 'Tidy tasks', description: 'Rewrite messy todo titles and suggest a category.' },
  { id: 'task-recipe', name: 'Recipe ideas', description: 'Suggest variations and substitutions for a kitchen recipe.' },
  { id: 'task-review', name: 'Issue & PR triage', description: 'Summarize open GitHub issues and PRs and flag stale ones.' },
  { id: 'task-budget', name: 'Spending review', description: 'Explain the month’s expenses and point out unusual categories.' },
  { id: 'task-reply', name: 'Reply drafts', description: 'Draft a short reply to a comment on one of your LinkedIn posts.' },
  { id: 'task-cron', name: 'Cron flows', description: 'Default model for the AI steps of Cron flows. A step can pick its own.' },
  { id: 'task-pools', name: 'Pool insights', description: 'Read Uniswap positions in and out of range and suggest range adjustments.' },
  { id: 'task-receipt', name: 'Read bills & screenshots', description: 'Turn a dropped bill or screenshot into money entries. Needs a model that can read images.' },
  { id: 'task-recipe-photo', name: 'Read recipe photos', description: 'Rewrite a photo of a handwritten or printed recipe as a Kitchen recipe. Needs a model that can read images.' },
];

// Adds tasks that were introduced after a user's settings.json was created.
/** @param {Store} store */
export function ensureTasks(store) {
  const have = new Set(store.get(COLLECTION).models.tasks.map((t) => t.id));
  const missing = DEFAULT_TASKS.filter((t) => !have.has(t.id));
  if (!missing.length) return;
  store.update(COLLECTION, (d) => {
    d.models.tasks.push(...missing.map((t) => ({ ...t, model: '' })));
  });
}

const PAGES = SETTINGS_PAGES.map(([key]) => key);

export { modelForTask };


// UI state: current section, last test result per service, whether a key is shown, and the model list.
// On a phone the page shows the list of a category or one page, not both: list is true while the list is shown.
/**
 * @type {{ section: string, list: boolean, results: Record<string, { status: string, text?: string } | null>, reveal: Record<string, boolean>,
 *   catalog: { status: string, items?: { value: string, label: string, name: string, price: string }[], error?: string } }}
 */
const view = { section: 'github', list: false, results: {}, reveal: {}, catalog: { status: 'idle' } };

/** @param {string} key */
async function checkOpenRouterKey(key) {
  const res = await fetch(OPENROUTER_CHECK, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenRouter rejected this key. Create a new one at openrouter.ai/keys.' : `OpenRouter error ${res.status}`);
  const { data } = /** @type {{ data?: { label?: string } }} */ (await res.json());
  return data?.label ? `Connected as “${data.label}”` : 'Connected';
}

/** @param {Store} store */
function loadCatalog(store) {
  if (view.catalog.status === 'loading') return;
  view.catalog = { status: 'loading' };
  store.refresh();
  fetch(OPENROUTER_MODELS)
    .then((res) => {
      if (!res.ok) throw new Error(`OpenRouter error ${res.status}`);
      return res.json();
    })
    .then((/** @type {{ data: { id: string, name: string, pricing?: { prompt?: string, completion?: string } }[] }} */ { data }) => {
      view.catalog = { status: 'ok', items: data.map((m) => ({ value: m.id, label: m.id, name: m.name, price: priceLine(m.pricing) })) };
    })
    .catch((err) => {
      view.catalog = { status: 'error', error: err.message };
    })
    .finally(() => store.refresh());
}

// "$3.00 / $15.00 per 1M": a model's input and output price per million tokens, as OpenRouter lists them per token.
/** @param {{ prompt?: string, completion?: string } | undefined} pricing */
function priceLine(pricing) {
  const per = (/** @type {string | undefined} */ v) => (v === undefined || !Number.isFinite(Number(v)) ? null : Number(v) * 1e6);
  const money = (/** @type {number} */ n) => (n === 0 ? 'free' : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`);
  const input = per(pricing?.prompt);
  const output = per(pricing?.completion);
  if (input === null || output === null) return '';
  return input === 0 && output === 0 ? 'Free' : `${money(input)} / ${money(output)} per 1M`;
}

/** @param {string} id */
const priceOf = (id) => view.catalog.items?.find((m) => m.value === id)?.price ?? '';

/** @param {string} href @param {Child} text */
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

/** @param {string} saved @param {{ status: string } | null | undefined} result */
function statusBadge(saved, result) {
  if (!saved) return h('span', { class: 'pill tone-plain' }, 'Not set');
  if (result?.status === 'ok') return h('span', { class: 'pill tone-done' }, 'Connected');
  if (result?.status === 'error') return h('span', { class: 'pill tone-high' }, 'Rejected');
  return h('span', { class: 'pill tone-doing' }, 'Saved, not tested');
}

// A key card: setup steps on the left, the key field and its actions on the right.
/**
 * @param {Store} store
 * @param {{ id: 'github' | 'openrouter' | 'vercel' | 'netlify', field: string, title: string, fieldLabel?: string, intro: string, steps: Child[], placeholder: string,
 *   check: (key: string) => Promise<string>, note: string, docs?: string }} cfg
 */
function credentialCard(store, cfg) {
  const { id, field, title, fieldLabel, intro, steps, placeholder, check, note, docs } = cfg;
  // `field` is the card's key field in that part of the settings (github.token, openrouter.key).
  const saved = /** @type {Record<string, string> | undefined} */ (/** @type {unknown} */ (store.get(COLLECTION)[id]))?.[field] ?? '';
  const result = view.results[id];
  const revealed = Boolean(view.reveal[id]);

  /** @param {string} value */
  const save = (value) => {
    store.update(COLLECTION, (d) => {
      /** @type {Record<string, object>} */ (/** @type {unknown} */ (d))[id] = { ...d[id], [field]: value };
    });
    if (id === 'github') configure(store.get(COLLECTION).github);
    // The previews already read stay as they were until their next read, which may be 20 minutes off.
    if ((id === 'vercel' || id === 'netlify') && value) {
      runJob('previews', { prs: trackedPrs(store).slice(0, 30) }).then(() => store.sync()).catch(() => {});
    }
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
        /** @param {FormSubmit} e */
        onsubmit: (e) => {
          e.preventDefault();
          save(/** @type {string} */ (new FormData(e.currentTarget).get('secret')).trim());
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

/** @param {Store} store @param {Partial<ModelsSettings>} patch */
function updateModels(store, patch) {
  store.update(COLLECTION, (d) => {
    d.models = { ...d.models, ...patch };
  });
}

/** @param {Store} store @param {string} id @param {Partial<ModelTask>} patch */
function updateTask(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const t = d.models.tasks.find((x) => x.id === id);
    if (t) Object.assign(t, patch);
  });
}

/** @param {Store} store @param {string} name @param {string} description */
function addTask(store, name, description) {
  store.update(COLLECTION, (d) => {
    d.models.tasks.push({ id: `task-${Date.now().toString(36)}`, name, description, model: '' });
  });
}

/** @param {Store} store @param {string} id */
function removeTask(store, id) {
  removeWithUndo(store, {
    ask: 'Remove this task? Its model pin goes with it.',
    done: 'Task removed',
    collections: ['settings'],
    run: () => {
      store.update(COLLECTION, (d) => {
        d.models.tasks = d.models.tasks.filter((t) => t.id !== id);
      });
    },
  });
}

/** @param {Store} store */
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
        h('p', { class: 'muted' }, `Pin a model to each task. A task without its own pin uses the default model. ${models.tasks.filter((t) => t.model).length} of ${models.tasks.length} tasks pinned.`)),
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
        detail: priceOf(models.default),
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
              IMAGE_TASKS.includes(t.id) ? h('span', { class: 'pill tone-doing', title: 'Its dialog lists the models that can read images' }, 'Reads images') : null,
              modelChip({
                value: t.model,
                nullable: true,
                nullLabel: models.default ? `Default: ${models.default}` : 'Use default',
                requireImages: IMAGE_TASKS.includes(t.id),
                detail: priceOf(t.model || models.default),
                onPick: (v) => updateTask(store, t.id, { model: v ?? '' }),
              }),
              t.model ? h('button', { type: 'button', class: 'btn-small btn-ghost', title: 'Follow the default model', onclick: () => updateTask(store, t.id, { model: '' }) }, 'Unpin') : null,
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
      /** @param {FormSubmit} e */
      onsubmit: (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        const name = /** @type {string} */ (f.get('name')).trim();
        if (name) addTask(store, name, /** @type {string} */ (f.get('description')).trim());
      },
    },
      h('input', { name: 'name', placeholder: 'New task, e.g. Weekly review', 'aria-label': 'New task name', autocomplete: 'off', class: 'grow' }),
      h('input', { name: 'description', placeholder: 'What it is for (optional)', 'aria-label': 'Task description', autocomplete: 'off', class: 'grow' }),
      h('button', { class: 'primary', type: 'submit' }, 'Add task')));
}

// --- Exchange rates ---

// The last check of each provider, shown on its row: { [id]: { status: 'checking' | 'ok' | 'error', text } }.
/** @type {{ results: Record<string, { status: string, text: string }> }} */
const exchange = { results: {} };

/** @param {Store} store */
function exchangeCard(store) {
  const manual = manualRate();
  const first = providerId();
  const fallback = fallbackOn();
  /** @param {{ id: string }} p */
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
  /** @param {FormSubmit} e */
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
  // The saved last source may name a provider since removed; providerId() is always one of them.
  const used = /** @type {typeof PROVIDERS[number]} */ (PROVIDERS.find((p) => p.id === lastSource.id) ?? PROVIDERS.find((p) => p.id === first));

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
              onchange: (/** @type {{ target: HTMLInputElement }} */ e) => {
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
        h('p', { class: 'muted small' }, 'Daily rates are kept in fx.json in the data folder, so past days are not fetched again. The runners read them.'),
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

/** @param {Store} store */
function googleCard(store) {
  const { clientId = '', clientSecret = '' } = store.get(COLLECTION).google ?? {};
  /** @param {GoogleSettings} fields */
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
          /** @param {FormSubmit} e */
          onsubmit: (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            save({ clientId: /** @type {string} */ (form.get('clientId')).trim(), clientSecret: /** @type {string} */ (form.get('clientSecret')).trim() });
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

/** @type {{ message: string, ok: boolean | null }} */
const uniswapView = { message: '', ok: null };

// Token logos, read once from the token list; the page redraws when they arrive.
let tokenLogoMap = new Map();
let tokenLogosAsked = false;

// The positions added by hand, with the pair and range from the last Liquidity Pools read when there is one.
/** @param {Store} store @param {Added[]} added @param {(x: Added) => void} remove */
function addedList(store, added, remove) {
  if (!tokenLogosAsked) {
    tokenLogosAsked = true;
    tokenLogos().then((/** @type {Map<string, string>} */ map) => {
      tokenLogoMap = map;
      store.refresh();
    });
  }
  // The same key as a pools row's ref: v3 rows have no version in it. A v2 pair is read once per wallet that
  // holds it, so it is found by its address, and any of its rows names its tokens.
  /** @param {Added} x */
  const refOf = (x) => {
    const kind = x.dex && x.dex !== 'uniswap' ? `${x.dex}-${x.version}` : x.version;
    return kind === 'v3' ? `${x.chainId}:${x.tokenId}` : `${x.chainId}:${kind}:${String(x.tokenId).toLowerCase()}`;
  };
  /** @type {Map<string, PoolRow>} */
  const read = new Map();
  for (const part of Object.values(store.get('pools')?.cache ?? {})) for (const r of part.rows ?? []) read.set(r.version === 'v2' ? r.ref.split(':').slice(0, 3).join(':') : r.ref, r);
  /** @param {number} chainId @param {string | undefined} address */
  const tokenLogo = (chainId, address) => (address ? tokenLogoMap.get(`${chainId}:${address.toLowerCase()}`) ?? null : null);
  const rows = added
    .map((x) => ({ x, r: read.get(refOf(x)) ?? null, chain: CHAINS.find((c) => c.id === x.chainId) }))
    .sort((a, b) => (a.chain?.name ?? '').localeCompare(b.chain?.name ?? '') || Number(a.x.tokenId) - Number(b.x.tokenId));
  // A v2 pair no wallet holds has no row either.
  /** @param {PoolRow | null} r @param {Added} x */
  const status = (r, x) => (!r ? ['unread', x.version === 'v2' ? 'Not read, or not held' : 'Not read yet'] : r.closed ? ['closed', 'Closed'] : r.inRange ? ['in', 'In range'] : ['out', 'Out of range']);
  /** @param {Added} x */
  const nameOf = (x) => `${x.dex && x.dex !== 'uniswap' ? `${dexName(x.dex)} ` : ''}${x.version === 'v2' ? `v2 ${String(x.tokenId).slice(0, 6)}…${String(x.tokenId).slice(-4)}` : `${x.version} #${x.tokenId}`}`;

  return h('ul', { class: 'added-list' },
    h('li', { class: 'added-row added-head', 'aria-hidden': 'true' },
      h('span', null, 'Chain'), h('span', null, 'Pair'), h('span', null, 'Position'), h('span', null, 'Status'), h('span')),
    rows.map(({ x, r, chain }) => {
      const [tone, label] = status(r, x);
      return h('li', { class: `added-row tone-${tone}` },
        h('span', { class: 'added-chain' }, logo(chain?.logo, chain?.name ?? `Chain ${x.chainId}`, 'xs'), chain?.name ?? `Chain ${x.chainId}`),
        r
          ? h('span', { class: 'added-pair' },
              h('span', { class: 'pair' }, logo(tokenLogo(x.chainId, r.addr0), r.sym0, 'sm'), logo(tokenLogo(x.chainId, r.addr1), r.sym1, 'sm second')),
              h('strong', null, `${r.sym0} / ${r.sym1}`))
          : h('span', { class: 'added-pair muted' }, 'Open Liquidity Pools to read it'),
        h('span', { class: 'added-id', title: x.version === 'v2' ? String(x.tokenId) : null }, r?.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener' }, nameOf(x)) : nameOf(x)),
        h('span', { class: 'added-status small' }, h('span', { class: `pos-dot ${tone === 'unread' ? 'gone' : tone}`, 'aria-hidden': 'true' }), label),
        h('button', { type: 'button', class: 'btn-small', onclick: () => remove(x) }, 'Remove'));
    }));
}

/** @type {{ message: string, ok: boolean | null }} */
const walletsView = { message: '', ok: null };

// Saves into settings.uniswap, where the wallet list was first kept, so older data folders keep their wallets.
/** @param {Store} store @param {Partial<UniswapSettings>} patch */
const saveUniswap = (store, patch) => {
  store.update(COLLECTION, (d) => {
    // Older files may lack the lists.
    d.uniswap = { wallets: [], chains: {}, .../** @type {Partial<UniswapSettings>} */ (d.uniswap), ...patch };
  });
  store.refresh();
};

// Public wallet addresses that every DeFi tab reads: Liquidity Pools, Wallets and Lending / Borrowing.
/** @param {Store} store */
function walletsCard(store) {
  const wallets = store.get(COLLECTION).uniswap?.wallets ?? [];
  /** @param {Partial<UniswapSettings>} patch */
  const save = (patch) => saveUniswap(store, patch);
  /** @param {FormSubmit} e */
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
/** @param {Store} store */
function uniswapCard(store) {
  /** @type {UniswapSettings} */
  const cfg = store.get(COLLECTION).uniswap ?? { wallets: [], chains: {} };
  /** @type {Added[]} */
  const added = addedPositions(cfg);
  /** @param {Partial<UniswapSettings>} patch */
  const save = (patch) => saveUniswap(store, patch);
  // A position the board does not find: a link from the Uniswap app, or a number with its chain and version.
  /** @param {FormSubmit} e */
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
  /** @param {Added} x */
  const removeAdded = (x) => {
    const list = addedListOf(x.version);
    save({ [list]: (cfg[list] ?? []).filter((y) => !(y.chainId === x.chainId && (y.dex || '') === (x.dex || '') && String(y.tokenId) === String(x.tokenId))) });
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Uniswap'),
    h('p', { class: 'muted small' }, 'Uniswap v2, v3 and v4 and PancakeSwap v2 and v3 positions are read from the wallets in ',
      h('button', { type: 'button', class: 'btn-link-inline', onclick: () => { view.section = 'wallets'; store.refresh(); } }, 'Wallets'), '.'),
    h('p', { class: 'muted small' }, 'Positions added by hand: a v3 position held by an address that is not in Wallets, or a v4 position the board does not find. v4 positions are found by searching each wallet\'s history on the chain, and most public nodes only search recent blocks. The Liquidity Pools tab has the same Add position button.'),
    h('p', { class: 'muted small' }, 'A v2 position is a wallet\'s share of a pair, and the chain cannot list the pairs a wallet holds. Add a pair by its link or its address, and it is read for every wallet. With an Etherscan key in Blockchains, the pairs your wallets hold are found by themselves.'),
    h('p', { class: 'muted small' }, 'PancakeSwap positions staked in its farm are found with the others, with the CAKE they can harvest. Add one by hand with its pancakeswap.finance link, or its number with PancakeSwap v3 picked.'),
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

// --- Keys per organization ---

// The organization name from what was typed: a name, or a github.com link to one.
/** @param {unknown} text */
const orgNameFrom = (text) => String(text ?? '').trim().replace(/^https?:\/\/(www\.)?github\.com\//i, '').replace(/\/.*$/, '');

// Result of the last test of an organization key, which one is being tested, and the organization picked
// in the dropdown (set by the "Add token" button on a row).
/** @type {{ message: string, ok: boolean, testing: string | null, pick: string }} */
const orgKeys = { message: '', ok: true, testing: null, pick: '' };

// Every organization the projects use: the org set on each project, and the owner of each linked repo.
/** @param {Store} store */
function knownOrgs(store) {
  /** @type {Map<string, string>} */
  const names = new Map(); // lower-case name -> name as written
  /** @param {unknown} name */
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

/** @param {Store} store */
function orgKeysCard(store) {
  const orgs = store.get(COLLECTION).github?.orgs ?? [];
  /** @param {string} name */
  const tokenFor = (name) => orgs.find((x) => x.org.toLowerCase() === name.toLowerCase());
  // Projects' organizations, plus any organization that has a token but no project yet.
  const known = knownOrgs(store);
  const all = [...known, ...orgs.map((o) => o.org).filter((o) => !known.some((k) => k.toLowerCase() === o.toLowerCase()))]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  const missing = all.filter((name) => !tokenFor(name));

  /** @param {GithubOrgToken[]} list */
  const saveOrgs = (list) => {
    store.update(COLLECTION, (d) => {
      d.github = { ...d.github, orgs: list };
    });
    configure(store.get(COLLECTION).github);
    store.refresh();
  };
  /** @param {GithubOrgToken} entry */
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
  /** @param {string} token */
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
      /** @param {FormSubmit} e */
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

/** @param {HTMLElement} root @param {Store} store */
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

  const deployNote = 'The runners read the deployments of the PRs on open tasks and recent Cron runs: state, commit, timings and errors. A task’s preview then opens its details and build log.';
  const vercelCard = () => credentialCard(store, {
    id: 'vercel',
    field: 'token',
    title: 'Vercel',
    fieldLabel: 'Access token',
    docs: 'https://vercel.com/account/settings/tokens',
    intro: `Shows each PR’s Vercel preview as it builds, on the task. ${deployNote}`,
    steps: [
      ['Open ', link('https://vercel.com/account/settings/tokens', 'Account settings → Tokens'), ' on Vercel.'],
      'Create a token. Scope: the team your projects are in, or Full Account to reach every team.',
      'Choose an expiration, create it and copy the token.',
    ],
    placeholder: 'Paste the Vercel token',
    check: checkVercel,
    note: 'Vercel tokens cannot be made read-only, so keep this one to your own machine. Revoke it on the same page if it is ever exposed.',
  });
  const netlifyCard = () => credentialCard(store, {
    id: 'netlify',
    field: 'token',
    title: 'Netlify',
    fieldLabel: 'Personal access token',
    docs: 'https://app.netlify.com/user/applications#personal-access-tokens',
    intro: `Shows each PR’s Netlify deploy preview as it builds, on the task. ${deployNote}`,
    steps: [
      ['Open ', link('https://app.netlify.com/user/applications#personal-access-tokens', 'User settings → Applications'), ' on Netlify.'],
      'Under Personal access tokens, create a new token and give it a name.',
      'Choose an expiration, generate it and copy the token. It starts with nfp_.',
    ],
    placeholder: 'nfp_…',
    check: checkNetlify,
    note: 'The build log streams over a WebSocket, so the runners read it: start them with bun start (or Node 22). Revoke the token on Netlify if it is ever exposed.',
  });

  const content = view.section === 'openrouter' ? openrouter
    : view.section === 'vercel' ? vercelCard()
    : view.section === 'netlify' ? netlifyCard()
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
        : view.section === 'notion' ? notionCard(store)
        : view.section === 'analytics' ? analyticsCard(store)
        : view.section === 'websites' ? websitesCard(store)
        : view.section === 'search' ? searchCard(store)
        : view.section === 'resend' ? resendCard(store)
        : view.section === 'gmail' ? gmailCard(store)
        : view.section === 'slack' ? slackCard(store)
        : view.section === 'x' ? socialsCard(store, 'x')
        : view.section === 'linkedin' ? socialsCard(store, 'linkedin')
        : view.section === 'github-accounts' ? socialsCard(store, 'github')
        : view.section === 'instagram' ? socialsCard(store, 'instagram')
        : view.section === 'notifications' ? notificationsCard(store)
        : view.section === 'automations' ? automationsCard(store)
        : view.section === 'dev' ? devEnvironmentCard(store)
        : view.section === 'runners' ? runnersCard(store)
        : view.section === 'data' ? dataCard(store)
        : h('div', { class: 'stack-lg' }, tokenGuide(), github, orgKeysCard(store));

  root.replaceChildren(shell(store, content));
}

// --- The shell: the categories on a rail, the category's pages with their state, then the page ---

/** @param {number} n @param {string} one */
const count = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

// A page's state for the list: 'ok' (connected, or has what it needs), 'warn' (a saved key was rejected, a sign-in
// lost, the runners stopped), 'off' (nothing set up yet), or 'pref' for a page of preferences; with a short line.
/** @param {Store} store @param {string} key @returns {{ state: string, text: string }} */
function pageState(store, key) {
  const s = store.get(COLLECTION);
  const rejected = view.results[key]?.status === 'error';
  /** @param {boolean} set @param {string} on @param {string} none */
  const has = (set, on, none) => (set ? { state: rejected ? 'warn' : 'ok', text: rejected ? 'Key rejected' : on } : { state: 'off', text: none });
  /** @param {number} n @param {string} one @param {string} none */
  const many = (n, one, none) => (n ? { state: 'ok', text: count(n, one) } : { state: 'off', text: none });
  /** @param {string} network */
  const socials = (network) => (store.get('socials').accounts ?? []).filter((a) => a.network === network).length;
  const pref = 'pref';
  switch (key) {
    case 'openrouter': return has(Boolean(s.openrouter.key), 'Key saved', 'No key yet');
    case 'github': return has(Boolean(s.github.token), s.github.orgs?.length ? `Token saved · ${count(s.github.orgs.length, 'org key')}` : 'Token saved', 'No token yet');
    case 'vercel': return has(Boolean(s.vercel?.token), 'Token saved', 'No token yet');
    case 'netlify': return has(Boolean(s.netlify?.token), 'Token saved', 'No token yet');
    case 'models': return { state: pref, text: s.models.default ? `${s.models.default.split('/').pop()} by default` : 'No default model' };
    case 'prompts': {
      const edited = Object.keys(overrides(store)).filter((id) => id !== 'global').length;
      return { state: pref, text: edited ? `${count(edited, 'prompt')} edited` : 'All on their defaults' };
    }
    case 'dev': return { state: pref, text: `${count(devAgents(store).length, 'agent')} · ${defaultAgent(store).name} by default` };
    case 'runners':
      if (runnersOnline()) return { state: 'ok', text: 'Running' };
      return runnersKnown() ? { state: 'warn', text: 'Not running: start bun start' } : { state: 'off', text: 'Not seen yet' };
    case 'google':
      return s.gcal.accounts.length ? { state: 'ok', text: count(s.gcal.accounts.length, 'account') } : { state: 'off', text: s.google.clientId ? 'No account yet' : 'No client ID yet' };
    case 'gmail': return many(s.gmail.accounts.length, 'inbox', 'No account yet');
    case 'websites': {
      const sites = [...sitesOf(store)];
      const off = new Set(s.search?.off ?? []);
      return { state: pref, text: sites.length ? `${sites.filter((p) => !off.has(p.id)).length} of ${count(sites.length, 'site')} in Monitoring` : 'No project website yet' };
    }
    case 'analytics': return many(Object.values(s.analytics.properties ?? {}).filter(Boolean).length, 'property', 'No property yet');
    case 'search': {
      const parts = [isConnected('search') ? 'Google connected' : '', s.bing?.key ? 'Bing key saved' : ''].filter(Boolean);
      return parts.length ? { state: 'ok', text: parts.join(' · ') } : { state: 'off', text: 'Not connected yet' };
    }
    case 'slack': {
      const ws = store.get('slack').workspaces ?? [];
      const out = ws.filter((w) => w.error).length;
      return ws.length ? { state: out ? 'warn' : 'ok', text: out ? `${count(out, 'workspace')} signed out` : count(ws.length, 'workspace') } : { state: 'off', text: 'Not signed in yet' };
    }
    case 'telegram': return has(Boolean(s.telegram.token && s.telegram.chatId), 'Bot connected', s.telegram.token ? 'No chat yet' : 'No bot yet');
    case 'notion': return many(s.notion?.accounts?.length ?? 0, 'account', 'No account yet');
    case 'resend': return many(new Set(Object.values(s.resend.keys ?? {}).filter(Boolean)).size, 'key', 'No key yet');
    case 'x': return many(socials('x'), 'account', 'No account yet');
    case 'linkedin': return many(socials('linkedin'), 'account', 'No account yet');
    case 'github-accounts': return many(socials('github'), 'account', 'No account yet');
    case 'instagram': return many(socials('instagram'), 'account', 'No account yet');
    case 'wallets': return many(s.uniswap.wallets.length, 'wallet', 'No wallet yet');
    case 'contracts': return many(s.contracts.length, 'contract', 'No contract yet');
    case 'blockchains': return { state: pref, text: s.blockchains.custom?.length ? `${count(s.blockchains.custom.length, 'chain')} added` : 'Built-in chains' };
    default: return { state: pref, text: '' };
  }
}

/** @param {string} key */
const goTo = (key) => {
  view.section = key;
  view.list = false;
};

/** @param {Store} store @param {Child} content */
function shell(store, content) {
  const cat = categoryOf(view.section);
  /** @param {string} state */
  const needsFix = (state) => state === 'warn';
  const rail = h('nav', { class: 'settings-rail', 'aria-label': 'Settings categories' },
    SETTINGS_CATEGORIES.map((c) => {
      const fix = c.pages.filter(([key]) => needsFix(pageState(store, key).state)).length;
      const on = c.id === cat.id;
      return h('button', {
        type: 'button',
        class: on ? 'settings-cat active' : 'settings-cat',
        'aria-current': on ? 'true' : null,
        title: fix ? `${c.name}: ${count(fix, 'page')} to fix` : c.name,
        onclick: () => {
          // A phone shows the category's list first; a wider screen opens its first page beside it.
          view.section = on ? view.section : c.pages[0][0];
          view.list = true;
          store.refresh();
        },
      },
        h('span', { class: 'settings-cat-icon' }, icon(c.icon), fix ? h('span', { class: 'settings-cat-badge', 'aria-label': `${count(fix, 'page')} to fix` }, String(fix)) : null),
        h('span', null, c.name));
    }));

  const states = cat.pages.map(([key]) => pageState(store, key));
  const linked = states.filter((x) => x.state !== 'pref');
  const ok = linked.filter((x) => x.state === 'ok').length;
  const fix = states.filter((x) => x.state === 'warn').length;
  const progress = linked.length
    ? `${ok} of ${linked.length} connected${fix ? ` · ${fix} to fix` : ''}`
    : `${count(states.length, 'page')} of preferences${fix ? ` · ${fix} to fix` : ''}`;
  const list = h('section', { class: 'settings-list', 'aria-label': cat.name },
    h('div', { class: 'settings-list-head' },
      h('p', { class: 'muted small' }, 'Settings'),
      h('h2', null, cat.name),
      h('p', { class: 'muted small' }, progress),
      linked.length ? h('progress', { class: 'settings-progress', value: String(ok), max: String(linked.length), 'aria-label': 'Connected' }) : null),
    h('ul', { class: 'settings-pages' },
      cat.pages.map(([key, label, iconName], i) => {
        const { state, text } = states[i];
        const on = key === view.section;
        const stateName = state === 'ok' ? 'Connected' : state === 'warn' ? 'Needs attention' : state === 'off' ? 'Not set up' : '';
        return h('li', null,
          h('button', {
            type: 'button',
            class: on ? 'settings-page active' : 'settings-page',
            'aria-current': on ? 'page' : null,
            onclick: () => {
              goTo(key);
              store.refresh();
            },
          },
            h('span', { class: 'settings-page-icon' }, icon(iconName)),
            h('span', { class: 'settings-page-text' }, h('strong', null, label), text ? h('span', { class: 'muted small' }, text) : null),
            stateName ? h('span', { class: `settings-dot is-${state}`, title: stateName, 'aria-label': stateName }) : null));
      })),
    h('p', { class: 'muted small settings-list-foot' }, 'Keys are saved in settings.json in your data folder, on this computer. Each key goes only to its own service.'));

  const page = cat.pages.find(([key]) => key === view.section);
  return h('div', { class: view.list ? 'settings-shell show-list' : 'settings-shell' },
    rail,
    list,
    h('div', { class: 'settings-main' },
      h('button', { type: 'button', class: 'btn-ghost settings-back', onclick: () => { view.list = true; store.refresh(); } }, icon('chevron-left'), cat.name),
      h('p', { class: 'settings-crumb muted small' }, page ? `Settings › ${cat.name} › ${page[1]}` : 'Settings'),
      content));
}

export default /** @satisfies {import('../../types/data').Module} */ ({
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
  /** @param {Record<string, string>} [p] */
  restore: (p = {}) => {
    view.section = PAGES.includes(p.section) ? p.section : 'github';
    // Opened with no page named, a phone starts on the list.
    view.list = !p.section;
  },
});
