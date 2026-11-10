// Settings sections for Telegram, Google Analytics, the search consoles, notifications and automations.
import { h, icon, empty, notice, statusOf } from '../ui.js';
import { editText } from '../inline.js';
import { connect, isConnected } from '../google.js';
import { checkBot, findChat, pollTelegram, hasTelegram } from '../telegram.js';
import { propertyName, checkBing } from '../webstats.js';
import { KINDS, prefOf, setPref } from '../notifications.js';
import { RULES, ruleOf, sitesOf } from '../automations.js';
import { hostOf } from '../sitecheck.js';
import { projectIcon } from './projects.js';
import { setupBanner } from '../integrations.js';

const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
const steps = (list) => h('ol', { class: 'steps' }, list.map((s) => h('li', null, h('span', { class: 'step-text' }, s))));
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
const head = (title, intro, right) =>
  h('header', { class: 'panel-head' }, h('div', null, h('h2', null, title), h('p', { class: 'muted' }, intro)), right ? h('div', { class: 'row' }, right) : null);
const toggle = (checked, label, onchange) =>
  h('label', { class: 'row check' }, h('input', { type: 'checkbox', checked, 'aria-label': label, onchange: (e) => onchange(e.target.checked) }), h('span', null, label));

// Messages shown on each card after an action: { text, ok }.
const messages = {};
const say = (store, key, text, ok = true) => {
  messages[key] = text ? { text, ok } : null;
  store.refresh();
};
const result = (key) => (messages[key] ? h('p', { class: `test-result ${messages[key].ok ? 'ok' : 'error'}`, role: 'status' }, messages[key].text) : null);

// --- Telegram ---

export function telegramCard(store) {
  const t = store.get('settings').telegram ?? {};
  const save = (patch) => store.update('settings', (d) => {
    d.telegram = { ...d.telegram, ...patch };
  });
  const tryIt = (work, done) => {
    say(store, 'telegram', 'Asking Telegram…');
    work().then((value) => say(store, 'telegram', done(value))).catch((err) => say(store, 'telegram', err.message, false));
  };
  return h('section', { class: 'card panel' },
    head('Telegram', 'Message your own bot to create a task. A message that names a project and a deadline is filed directly; anything less waits in Tasks › To Organize, flagged as coming from Telegram.',
      badge(hasTelegram(store) ? 'Set up' : 'Not set', hasTelegram(store) ? 'done' : 'plain')),
    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        steps([
          ['In Telegram, open a chat with ', h('code', null, '@BotFather'), ' and send ', h('code', null, '/newbot'), '.'],
          'Pick a name. BotFather replies with a token such as 123456:ABC…. Paste it here and save.',
          'Send any message to your new bot, then press “Find my chat”, so the board knows which chat is yours.',
          'Only messages from that chat become tasks. Everything else is ignored.',
        ]),
        h('h3', null, 'What to send'),
        h('ul', { class: 'stack' },
          h('li', null, h('code', null, 'fix the footer #atlas !high friday'), h('div', { class: 'muted small' }, 'A project, a priority and a deadline: filed in that project.')),
          h('li', null, h('code', null, 'call the plumber'), h('div', { class: 'muted small' }, 'No project or no deadline: goes to To Organize.'))),
        h('p', { class: 'muted small' }, 'The board has no server. It reads the bot’s new messages while it is open, about once a minute, so a task sent at night appears the next time you open it.')),
      h('form', {
        class: 'svc-section',
        onsubmit: (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          save({ token: String(f.get('token') ?? '').trim(), chatId: String(f.get('chatId') ?? '').trim() });
          say(store, 'telegram', 'Saved.');
        },
      },
        h('h3', null, 'Bot token'),
        h('input', { name: 'token', type: 'password', value: t.token ?? '', placeholder: '123456:ABC…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Bot token' }),
        h('h3', null, 'Chat ID'),
        h('div', { class: 'input-group' },
          h('input', { name: 'chatId', value: t.chatId ?? '', placeholder: 'Filled in by Find my chat', autocomplete: 'off', spellcheck: false, 'aria-label': 'Chat ID' }),
          h('button', {
            type: 'button',
            class: 'input-addon',
            disabled: !t.token,
            onclick: () => tryIt(() => findChat(t.token), (id) => {
              save({ chatId: id });
              return 'Found your chat and saved it.';
            }),
          }, 'Find my chat')),
        toggle(t.confirm !== false, 'Reply in Telegram when a task is created', (on) => save({ confirm: on })),
        h('div', { class: 'svc-actions' },
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
          h('button', { type: 'button', disabled: !t.token, onclick: () => tryIt(() => checkBot(t.token), (text) => text) }, 'Test connection'),
          h('button', {
            type: 'button',
            disabled: !hasTelegram(store),
            onclick: () => tryIt(() => pollTelegram(store), (n) => (n ? `${n} new task${n === 1 ? '' : 's'} read.` : 'No new messages.')),
          }, 'Read messages now'),
          t.token ? h('button', { type: 'button', class: 'danger', onclick: () => { save({ token: '', chatId: '', offset: 0 }); say(store, 'telegram', ''); } }, icon('x'), 'Clear') : null),
        result('telegram'))));
}

// --- Google Analytics ---

function googleConnect(store, service, name, key) {
  const clientId = store.get('settings').google?.clientId ?? '';
  const connected = isConnected(service);
  return h('div', { class: 'stack' },
    h('div', { class: 'svc-actions' },
      h('button', {
        type: 'button',
        class: 'primary',
        disabled: !clientId,
        onclick: () => {
          say(store, key, 'Waiting for Google…');
          connect(clientId, service).then(() => say(store, key, `Connected. Monitoring now shows ${name}.`)).catch((err) => say(store, key, err.message, false));
        },
      }, connected ? 'Reconnect' : `Connect ${name}`)),
    clientId ? null : setupBanner('google', 'Add the Google OAuth Client ID first. The same one is used here.'),
    result(key));
}

export function analyticsCard(store) {
  const props = store.get('settings').analytics?.properties ?? {};
  const sites = sitesOf(store);
  const setProp = (id, value) => store.update('settings', (d) => {
    d.analytics = { ...d.analytics, properties: { ...(d.analytics?.properties ?? {}), [id]: value } };
  });
  return h('section', { class: 'card panel' },
    head('Google Analytics', 'Visitors and page views for each project website, shown in Monitoring. Read-only. It uses the same Google OAuth Client ID as Calendar, with one more permission, and the connection lasts about an hour.',
      badge(isConnected('analytics') ? 'Connected' : 'Not connected', isConnected('analytics') ? 'done' : 'plain')),
    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        steps([
          ['Set the OAuth Client ID under ', h('a', { href: '#/settings?section=google' }, 'Google Calendar'), ' first.'],
          ['In Google Cloud Console, enable the ', link('https://console.cloud.google.com/apis/library/analyticsdata.googleapis.com', 'Google Analytics Data API'), ' for that project.'],
          'Press Connect and allow “See and download your Google Analytics data”.',
          'For each project, paste its property ID. It is in Analytics under Admin → Property details, and is a number such as 123456789.',
        ]),
        googleConnect(store, 'analytics', 'Google Analytics', 'analytics')),
      h('div', { class: 'svc-section' },
        h('h3', null, 'Property for each project'),
        sites.length
          ? h('ul', { class: 'stack' }, sites.map((p) =>
              h('li', { class: 'row prop-row' },
                projectIcon(p),
                h('div', { class: 'grow' }, h('strong', null, p.name), h('div', { class: 'muted small' }, hostOf(p.website))),
                editText({
                  value: props[p.id] ?? '',
                  placeholder: 'Property ID',
                  allowEmpty: true,
                  onSave: (v) => {
                    const name = propertyName(v);
                    if (v && !name) return say(store, 'analytics', 'A property ID is a number, such as 123456789.', false);
                    setProp(p.id, name);
                  },
                }))))
          : empty('No project has a website yet. Add one on a project page.'))));
}

// --- Search consoles ---

export function searchCard(store) {
  const bingKey = store.get('settings').bing?.key ?? '';
  const saveBing = (key) => store.update('settings', (d) => {
    d.bing = { key };
  });
  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      head('Google Search Console', 'Clicks, impressions and queries for each project website, shown in Monitoring. Read-only. A project is matched to the Search Console property with the same website address.',
        badge(isConnected('search') ? 'Connected' : 'Not connected', isConnected('search') ? 'done' : 'plain')),
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        steps([
          ['Verify each website in ', link('https://search.google.com/search-console', 'Search Console'), ' with the Google account you connect.'],
          ['In Google Cloud Console, enable the ', link('https://console.cloud.google.com/apis/library/searchconsole.googleapis.com', 'Google Search Console API'), '.'],
          'Press Connect and allow “View Search Console data for your verified sites”.',
        ]),
        googleConnect(store, 'search', 'Search Console', 'search'))),
    h('section', { class: 'card panel' },
      head('Bing Webmaster Tools', 'Bing uses an API key instead of a sign-in. The key is saved in settings.json and goes only to Bing.', badge(bingKey ? 'Saved' : 'Not set', bingKey ? 'doing' : 'plain')),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          steps([
            ['Add and verify each website in ', link('https://www.bing.com/webmasters', 'Bing Webmaster Tools'), '. You can import them from Search Console.'],
            'Open Settings → API access → API key, and generate a key.',
            'Paste the key here, save, and test it.',
          ]),
          notice({ tone: 'info', text: 'Bing’s API may refuse requests that come from a web page. If the test says so, Bing data cannot be read from the board, and the Google tab is not affected.' })),
        h('form', {
          class: 'svc-section',
          onsubmit: (e) => {
            e.preventDefault();
            saveBing(String(new FormData(e.currentTarget).get('key') ?? '').trim());
            say(store, 'bing', 'Saved.');
          },
        },
          h('h3', null, 'API key'),
          h('input', { name: 'key', type: 'password', value: bingKey, placeholder: 'Bing Webmaster API key', autocomplete: 'off', spellcheck: false, 'aria-label': 'Bing Webmaster API key' }),
          h('div', { class: 'svc-actions' },
            h('button', { class: 'primary', type: 'submit' }, 'Save'),
            h('button', {
              type: 'button',
              disabled: !bingKey,
              onclick: () => {
                say(store, 'bing', 'Testing…');
                checkBing(bingKey).then((text) => say(store, 'bing', text)).catch((err) => say(store, 'bing', err.message, false));
              },
            }, 'Test connection'),
            bingKey ? h('button', { type: 'button', class: 'danger', onclick: () => { saveBing(''); say(store, 'bing', ''); } }, icon('x'), 'Clear') : null),
          result('bing')))));
}

// --- Notifications ---

export function notificationsCard(store) {
  return h('section', { class: 'card panel' },
    head('Notifications', 'Notifications appear under the bell at the top of every page. Each kind can also be sent to your Telegram chat.'),
    hasTelegram(store) ? null : setupBanner('telegram', 'Sending notifications to Telegram needs a bot and a chat.'),
    h('div', { class: 'mon-scroll' },
      h('table', { class: 'mon-table' },
        h('thead', null, h('tr', null, h('th', null, 'Notify me about'), h('th', null, 'In the board'), h('th', null, 'On Telegram'))),
        h('tbody', null, KINDS.map(([key, label, iconName]) => {
          const pref = prefOf(store, key);
          return h('tr', null,
            h('td', null, h('span', { class: 'row' }, icon(iconName), label)),
            h('td', null, h('input', { type: 'checkbox', checked: pref.app, 'aria-label': `${label} in the board`, onchange: (e) => setPref(store, key, { app: e.target.checked }) })),
            h('td', null, h('input', { type: 'checkbox', checked: pref.telegram, disabled: !hasTelegram(store), 'aria-label': `${label} on Telegram`, onchange: (e) => setPref(store, key, { telegram: e.target.checked }) })));
        })))),
    h('p', { class: 'muted small' }, 'A task with a deadline notifies you on the day, and once more when the deadline has passed. It stays in Tasks › Today until it is done or moved.'));
}

// --- Automations ---

export function automationsCard(store) {
  const setRule = (key, patch) => store.update('settings', (d) => {
    d.automations = { ...d.automations, [key]: { ...ruleOf(store, key), ...patch } };
  });
  const open = store.get('todos').items.filter((t) => t.auto && t.auto !== 'telegram' && statusOf(t) !== 'done').length;
  return h('section', { class: 'card panel' },
    head('Automations', 'The board can create tasks by itself. An automated task shows an “Auto” flag, says why it exists in its description, and is listed under Tasks › Automated. A rule never creates a second task while its first one is still open.'),
    h('ul', { class: 'rule-list' }, RULES.map(([key, title, text, hasDays]) => {
      const rule = ruleOf(store, key);
      return h('li', null,
        h('div', { class: 'grow' }, h('strong', null, title), h('div', { class: 'muted small' }, text)),
        hasDays
          ? h('label', { class: 'row rule-days' },
              h('input', { type: 'number', min: '1', max: '120', value: String(rule.days), 'aria-label': `${title}: days before`, onchange: (e) => setRule(key, { days: Math.min(120, Math.max(1, Number(e.target.value) || 1)) }) }),
              h('span', { class: 'muted small' }, 'days before'))
          : null,
        h('input', { type: 'checkbox', checked: rule.on, 'aria-label': `${title}: on`, onchange: (e) => setRule(key, { on: e.target.checked }) }));
    })),
    h('p', { class: 'muted small' }, `${open} automated task${open === 1 ? ' is' : 's are'} open now. Site checks run from `, h('a', { href: '#/tools' }, 'Tools'), ' while the board is open.'));
}
