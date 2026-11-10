import { h, icon } from '../ui.js';
import { configure, checkGithubToken } from '../github.js';

const COLLECTION = 'settings';
const OPENROUTER_CHECK = 'https://openrouter.ai/api/v1/auth/key';

// Per-card UI state: the last test result and whether the secret is shown in clear text.
const view = { results: {}, reveal: {} };

async function checkOpenRouterKey(key) {
  const res = await fetch(OPENROUTER_CHECK, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenRouter rejected this key. Create a new one at openrouter.ai/keys.' : `OpenRouter error ${res.status}`);
  const { data } = await res.json();
  return data?.label ? `Connected as “${data.label}”` : 'Connected';
}

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

// Badge in the card header: Not set, Saved (not tested yet), or Connected after a successful test.
function statusBadge(saved, result) {
  if (!saved) return h('span', { class: 'pill tone-plain' }, 'Not set');
  if (result?.status === 'ok') return h('span', { class: 'pill tone-done' }, 'Connected');
  if (result?.status === 'error') return h('span', { class: 'pill tone-high' }, 'Rejected');
  return h('span', { class: 'pill tone-doing' }, 'Saved, not tested');
}

// One service card: header with status, setup steps, the key field, and its actions.
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

  return h('section', { class: 'card svc' },
    h('header', { class: 'svc-head' },
      h('div', null,
        h('h3', null, title),
        docs ? h('a', { href: docs, target: '_blank', rel: 'noopener', class: 'muted small' }, 'Where to find it') : null),
      statusBadge(saved, result)),

    h('p', { class: 'muted' }, intro),

    h('div', { class: 'svc-section' },
      h('h4', null, 'Setup'),
      h('ol', { class: 'steps' }, steps.map((s) => h('li', null, s)))),

    h('form', {
      class: 'svc-section',
      onsubmit: (e) => {
        e.preventDefault();
        save(new FormData(e.currentTarget).get('secret').trim());
      },
    },
      h('h4', null, title + ' key'),
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
        saved ? h('button', { type: 'button', class: 'danger', onclick: () => save('') }, icon('x'), 'Clear') : null)),

    result
      ? h('p', { class: `test-result ${result.status}`, role: 'status' },
          result.status === 'testing' ? 'Testing…' : result.text)
      : null);
}

function draw(root, store) {
  root.replaceChildren(
    h('div', { class: 'settings-page stack-lg' },
      h('header', { class: 'settings-head' },
        h('div', null,
          h('h2', null, 'Settings'),
          h('p', { class: 'muted' }, 'Credentials for the services the board talks to.')),
        h('p', { class: 'privacy' }, icon('check'),
          'Keys are saved in settings.json in your data folder, on this computer. Each key is sent only to the service it belongs to.')),

      h('div', { class: 'svc-grid' },
        credentialCard(store, {
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
        }),

        credentialCard(store, {
          id: 'openrouter',
          field: 'key',
          title: 'OpenRouter',
          docs: 'https://openrouter.ai/keys',
          intro: 'One key for many AI models. It is stored now for future AI features; nothing uses it yet.',
          steps: [
            ['Sign in at ', link('https://openrouter.ai', 'openrouter.ai'), ', then open ', link('https://openrouter.ai/keys', 'Keys'), '.'],
            'Create a key and give it a name. You can set a credit limit on it.',
            'Copy the key. It starts with sk-or- and is shown only once.',
          ],
          placeholder: 'sk-or-…',
          check: checkOpenRouterKey,
          note: 'If the key is ever exposed, revoke it on openrouter.ai/keys.',
        }))));
}

export default {
  id: 'settings',
  title: 'Settings',
  icon: 'settings',
  hidden: true, // opened from the gear icon in the top bar
  collection: COLLECTION,
  defaults: { github: { token: '' }, openrouter: { key: '' } },
  render: draw,
};
