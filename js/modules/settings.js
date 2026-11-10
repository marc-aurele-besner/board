import { h, icon } from '../ui.js';
import { configure, checkGithubToken } from '../github.js';

const COLLECTION = 'settings';
const OPENROUTER_CHECK = 'https://openrouter.ai/api/v1/auth/key';

// Per-card UI state: test results and whether the secret is shown in clear text.
const view = { results: {}, reveal: {} };

async function checkOpenRouterKey(key) {
  const res = await fetch(OPENROUTER_CHECK, { headers: { Authorization: `Bearer ${key}` } });
  if (!res.ok) throw new Error(res.status === 401 ? 'OpenRouter rejected this key. Create a new one at openrouter.ai/keys.' : `OpenRouter error ${res.status}`);
  const { data } = await res.json();
  return data?.label ? `Connected as “${data.label}”` : 'Connected';
}

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);

// One credential card: instructions, a masked input, Save, Test and Clear.
function credentialCard(store, cfg) {
  const { id, field, title, intro, steps, placeholder, check, note } = cfg;
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

  return h('section', { class: 'card stack-lg credential' },
    h('div', null,
      h('h3', null, title),
      h('p', { class: 'muted' }, intro)),

    h('div', { class: 'card-inset' },
      h('h3', { class: 'steps-title' }, 'How to get it'),
      h('ol', { class: 'steps' }, steps.map((s) => h('li', null, s)))),

    h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        save(new FormData(e.currentTarget).get('secret').trim());
      },
    },
      h('label', null, 'Key',
        h('div', { class: 'row' },
          h('input', {
            name: 'secret',
            type: revealed ? 'text' : 'password',
            value: saved,
            placeholder,
            autocomplete: 'off',
            spellcheck: false,
            'aria-describedby': `${id}-note`,
            class: 'grow',
          }),
          h('button', {
            type: 'button',
            onclick: () => {
              view.reveal[id] = !revealed;
              store.refresh();
            },
          }, revealed ? 'Hide' : 'Show'))),
      h('p', { id: `${id}-note`, class: 'muted small' }, note),
      h('div', { class: 'row end' },
        saved ? h('button', { type: 'button', class: 'danger', onclick: () => save('') }, icon('x'), 'Clear') : null,
        h('button', { type: 'button', onclick: runTest, disabled: !saved }, 'Test connection'),
        h('button', { class: 'primary', type: 'submit' }, 'Save'))),

    result
      ? h('p', { class: `test-result ${result.status}`, role: 'status' },
          result.status === 'testing' ? 'Testing…' : result.text)
      : null);
}

function draw(root, store) {
  root.replaceChildren(
    h('div', { class: 'stack-lg settings-page' },
      h('div', null,
        h('h2', null, 'Settings'),
        h('p', { class: 'muted' }, 'Keys are saved in settings.json inside your data folder, on this computer. They are sent only to the service they belong to.')),

      credentialCard(store, {
        id: 'github',
        field: 'token',
        title: 'GitHub',
        intro: 'A personal access token lets the board read private repos and raises the GitHub limit from 60 to 5,000 requests per hour.',
        steps: [
          ['Open ', link('https://github.com/settings/personal-access-tokens/new', 'github.com/settings/personal-access-tokens/new'), ' (fine-grained token).'],
          'Resource owner: your account, or the organization that owns the private repos.',
          'Repository access: choose "Only select repositories", then pick the repos you link to projects.',
          'Repository permissions: set "Issues" to Read-only and "Pull requests" to Read-only. Metadata is added automatically.',
          'Pick an expiration date, generate the token, and copy it. It starts with github_pat_.',
          'Paste it above, press Save, then Test connection.',
        ],
        placeholder: 'github_pat_…',
        check: checkGithubToken,
        note: 'A classic token with the repo scope also works, but it grants much broader access. Fine-grained is recommended.',
      }),

      credentialCard(store, {
        id: 'openrouter',
        field: 'key',
        title: 'OpenRouter',
        intro: 'OpenRouter gives one API key for many AI models. The key is stored now for AI features; no feature uses it yet.',
        steps: [
          ['Sign in at ', link('https://openrouter.ai', 'openrouter.ai'), ' and open ', link('https://openrouter.ai/keys', 'openrouter.ai/keys'), '.'],
          'Create a key and give it a name. You can set a credit limit on it.',
          'Copy the key. It starts with sk-or- and is shown only once.',
          'Paste it above, press Save, then Test connection.',
        ],
        placeholder: 'sk-or-…',
        check: checkOpenRouterKey,
        note: 'Revoke the key on openrouter.ai/keys if it is ever exposed.',
      })));
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
