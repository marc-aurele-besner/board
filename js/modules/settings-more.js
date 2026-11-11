// Settings sections for Google Calendar accounts, Telegram, Google Analytics, the search consoles, Resend, Gmail, notifications and automations.
import { h, icon, empty, notice, statusOf, copyable } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { connect, isConnected } from '../google.js';
import { checkBot, findChat, pollTelegram, hasTelegram } from '../telegram.js';
import { propertyName, checkBing, BING_RELAY } from '../webstats.js';
import { checkResend, resendSettings, RESEND_RELAY } from '../resend.js';
import { connectGmail, disconnectGmail, isGmailConnected, gmailAccounts } from '../gmail.js';
import { calendarAccounts, connectCalendar, disconnectCalendar, isCalendarConnected, syncCalendarList, removeCalendarAccount, setCalendar, setCalendarAccount } from '../gcal.js';
import { KINDS, prefOf, setPref } from '../notifications.js';
import { RULES, ruleOf, sitesOf } from '../automations.js';
import { hostOf } from '../sitecheck.js';
import { projectIcon, projectTree, labelColor } from './projects.js';
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
const byName = (a, b) => String(a.name ?? '').localeCompare(String(b.name ?? ''), undefined, { sensitivity: 'base' });

// A project in the searchable pickers below, with its icon, since the project list can grow long.
const projectOption = (p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) });

// Optional project and project-label pickers for an account or a calendar. Empty is a choice: `none` names it.
function projectPick(projects, value, none, onPick) {
  return pickChip({
    value: value ?? null,
    options: projects.map(projectOption),
    nullable: true,
    nullLabel: none,
    className: 'field-pick project-field-pick',
    onPick: (v) => onPick(v ?? null),
  });
}

// Project labels in their colours. A label that was deleted since reads as none.
const projectLabels = (store) => store.get('projects').categories ?? [];
const labelName = (store, id) => projectLabels(store).find((c) => c.id === id)?.name ?? '';

function labelPick(store, value, none, onPick) {
  const labels = projectLabels(store);
  return pickChip({
    value: labels.some((c) => c.id === value) ? value : null,
    options: labels.map((c) => ({ value: c.id, label: c.name, color: labelColor(c) })),
    nullable: true,
    nullLabel: none,
    className: 'field-pick project-field-pick',
    onPick: (v) => onPick(v ?? null),
  });
}

// --- Google Calendar accounts ---

function calendarRow(store, account, cal, projects) {
  const accountProject = projects.find((p) => p.id === account.projectId);
  const accountLabel = labelName(store, account.labelId);
  return h('li', { class: 'resend-row has-key gcal-row' },
    h('label', { class: 'resend-name check' },
      h('input', { type: 'checkbox', checked: cal.on, 'aria-label': `Show ${cal.name}`, onchange: (e) => setCalendar(store, account.email, cal.id, { on: e.target.checked }) }),
      h('span', { class: 'gcal-swatch', style: { '--c': cal.color || 'var(--accent)' } }),
      h('strong', { title: cal.id }, cal.name)),
    // Left empty, a calendar takes the account's project and label.
    h('div', { class: 'resend-key' },
      projectPick(projects, cal.projectId, accountProject ? `Account’s: ${accountProject.name}` : 'No project',
        (projectId) => setCalendar(store, account.email, cal.id, { projectId }))),
    h('div', { class: 'resend-actions' },
      labelPick(store, cal.labelId, accountLabel ? `Account’s: ${accountLabel}` : 'No label',
        (labelId) => setCalendar(store, account.email, cal.id, { labelId }))));
}

function calendarAccount(store, account, projects, clientId) {
  const key = `gcal:${account.email}`;
  const connected = isCalendarConnected(account.email);
  const sayRow = (text, ok) => say(store, key, text, ok);
  const reconnect = () => {
    sayRow('Waiting for Google…');
    connectCalendar(clientId, account.email)
      .then(() => syncCalendarList(store, account.email))
      .then(() => sayRow('Connected.'))
      .catch((err) => sayRow(err.message, false));
  };
  return h('div', { class: 'svc-section' },
    h('div', { class: 'row between' },
      h('h3', { class: 'grow' }, account.email),
      badge(connected ? 'Connected' : 'Not connected', connected ? 'done' : 'plain'),
      connected
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => { disconnectCalendar(account.email); sayRow('Disconnected.'); } }, 'Disconnect')
        : h('button', { type: 'button', class: 'btn-small', disabled: !clientId, onclick: reconnect }, 'Connect'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remove account', 'aria-label': `Remove ${account.email}`, onclick: () => { removeCalendarAccount(store, account.email); sayRow(''); } }, icon('x'))),
    result(key),
    h('ul', { class: 'resend-list' },
      h('li', { class: 'resend-row resend-head gcal-row', 'aria-hidden': 'true' }, h('span', null, 'Calendar'), h('span', null, 'Project'), h('span', null, 'Project label')),
      // The account's own project and label sit in the same columns as its calendars', as the default they inherit.
      h('li', { class: 'resend-row has-key gcal-row gcal-account-row' },
        h('div', { class: 'resend-name' },
          icon('calendar'),
          h('div', null, h('strong', null, 'All calendars'), h('div', { class: 'muted small' }, 'Used by any calendar without its own'))),
        h('div', { class: 'resend-key' },
          projectPick(projects, account.projectId, 'No project', (projectId) => setCalendarAccount(store, account.email, { projectId }))),
        h('div', { class: 'resend-actions' },
          labelPick(store, account.labelId, 'No label', (labelId) => setCalendarAccount(store, account.email, { labelId })))),
      account.calendars.length
        ? account.calendars.map((c) => calendarRow(store, account, c, projects))
        : h('li', { class: 'empty' }, 'No calendars read yet. Connect to read them.')));
}

// The accounts the Calendar section reads, each with its calendars. Shown under the Client ID on the Google Calendar page.
export function calendarAccountsCard(store) {
  const clientId = store.get('settings').google?.clientId ?? '';
  const accounts = calendarAccounts(store);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const add = () => {
    say(store, 'gcal', 'Waiting for Google…');
    connectCalendar(clientId)
      .then(async (email) => {
        const known = accounts.some((a) => a.email === email);
        await syncCalendarList(store, email);
        say(store, 'gcal', known ? `${email} is already added. It is connected again.` : `Added ${email}. Its calendars show in Calendar.`);
      })
      .catch((err) => say(store, 'gcal', err.message, false));
  };
  return h('section', { class: 'card panel' },
    head('Accounts', 'Each Google account signs in on its own, so work and personal calendars can sit side by side. Untick a calendar to hide it. A project and a project label are optional: set on an account, they apply to each of its calendars that has none of its own. Calendar can be filtered by either, and a task made from an event gets its calendar’s project. Only the addresses and calendar choices are saved.',
      badge(accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'None', accounts.length ? 'doing' : 'plain')),
    h('div', { class: 'stack-lg' },
      h('div', { class: 'svc-section' },
        h('div', { class: 'svc-actions' },
          h('button', { type: 'button', class: 'primary', disabled: !clientId, onclick: add }, icon('plus'), 'Add a Google account')),
        clientId ? null : h('p', { class: 'muted small' }, 'Save the OAuth Client ID above first.'),
        result('gcal')),
      accounts.map((a) => calendarAccount(store, a, projects, clientId))));
}

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
          ['In Telegram, open a chat with ', copyable('@BotFather'), ' (', link('https://t.me/BotFather', 'open it'), ') and send ', copyable('/newbot'), '.'],
          'Pick a name. BotFather replies with a token such as 123456:ABC…. Paste it here and save.',
          'Send any message to your new bot, then press “Find my chat”, so the board knows which chat is yours.',
          'Only messages from that chat become tasks. Everything else is ignored.',
        ]),
        h('h3', null, 'What to send'),
        h('ul', { class: 'stack' },
          h('li', null, copyable('fix the footer #atlas !high friday'), h('div', { class: 'muted small' }, 'A project, a priority and a deadline: filed in that project.')),
          h('li', null, copyable('call the plumber'), h('div', { class: 'muted small' }, 'No project or no deadline: goes to To Organize.'))),
        h('p', { class: 'muted small' }, 'The board has no server. It reads the bot’s new messages while it is open, about once a minute, so a task sent at night appears the next time you open it.')),
      h('form', {
        class: 'svc-section',
        onsubmit: (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          const token = String(f.get('token') ?? '').trim();
          // update_id counts per bot, so an offset kept from another bot would hide every message.
          save({ token, chatId: String(f.get('chatId') ?? '').trim(), ...(token !== t.token ? { offset: 0 } : {}) });
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
            // Uses the token in the field, so it works before Save is pressed.
            onclick: (e) => {
              const token = String(e.currentTarget.form.elements.token.value ?? '').trim();
              if (!token) return say(store, 'telegram', 'Paste the bot token first.', false);
              tryIt(() => findChat(token, () => say(store, 'telegram', 'No message waiting. Send your bot a message now…')), (id) => {
                save({ token, chatId: id, ...(token !== t.token ? { offset: 0 } : {}) });
                return 'Found your chat and saved it.';
              });
            },
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
  const sites = [...sitesOf(store)].sort(byName);
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
  const bingRelay = store.get('settings').bing?.relay ?? '';
  const saveBing = (key, relay = bingRelay) => store.update('settings', (d) => {
    d.bing = { key, relay };
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
      head('Bing Webmaster Tools', 'Bing uses an API key instead of a sign-in. The key is saved in settings.json and goes only to Bing, through a relay on this machine.', badge(bingKey ? 'Saved' : 'Not set', bingKey ? 'doing' : 'plain')),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          steps([
            ['Add and verify each website in ', link('https://www.bing.com/webmasters', 'Bing Webmaster Tools'), '. You can import them from Search Console.'],
            'Open Settings → API access → API key, and generate a key.',
            ['In the board folder, run ', h('code', null, 'bun start'), ', which starts the board with its relays, and keep it open while you use Bing data.'],
            'Paste the key here, save, and test it.',
          ]),
          notice({ tone: 'info', text: 'Bing’s API does not let a web page read its answers, so the board asks a small relay on this machine to fetch them. The relay only forwards to Bing and only answers pages served from this machine.' })),
        h('form', {
          class: 'svc-section',
          onsubmit: (e) => {
            e.preventDefault();
            const form = new FormData(e.currentTarget);
            saveBing(String(form.get('key') ?? '').trim(), String(form.get('relay') ?? '').trim());
            say(store, 'bing', 'Saved.');
          },
        },
          h('h3', null, 'API key'),
          h('input', { name: 'key', type: 'password', value: bingKey, placeholder: 'Bing Webmaster API key', autocomplete: 'off', spellcheck: false, 'aria-label': 'Bing Webmaster API key' }),
          h('input', { name: 'relay', type: 'url', value: bingRelay, placeholder: `Relay address (default ${BING_RELAY})`, autocomplete: 'off', spellcheck: false, 'aria-label': 'Bing relay address' }),
          h('div', { class: 'svc-actions' },
            h('button', { class: 'primary', type: 'submit' }, 'Save'),
            h('button', {
              type: 'button',
              disabled: !bingKey,
              onclick: () => {
                say(store, 'bing', 'Testing…');
                checkBing(bingKey, bingRelay).then((text) => say(store, 'bing', text)).catch((err) => say(store, 'bing', err.message, false));
              },
            }, 'Test connection'),
            bingKey ? h('button', { type: 'button', class: 'danger', onclick: () => { saveBing('', ''); say(store, 'bing', ''); } }, icon('x'), 'Clear') : null),
          result('bing')))));
}

// --- Resend ---

// The project whose key is being typed, and the search over the project list.
const resendView = { editing: null, query: '' };
// "re_AbCd…wxyz": enough to tell keys apart without showing them.
const maskKey = (key) => (key.length > 12 ? `${key.slice(0, 7)}…${key.slice(-4)}` : 're_…');

function resendRow(store, p, keys, relay, setKey) {
  const key = keys[p.id] ?? '';
  const msg = messages[`resend:${p.id}`];
  const editing = resendView.editing === p.id;
  const shared = key ? Object.entries(keys).filter(([id, k]) => k === key && id !== p.id).length : 0;
  const test = () => {
    say(store, `resend:${p.id}`, 'Testing…');
    checkResend(key, relay).then((text) => say(store, `resend:${p.id}`, text)).catch((err) => say(store, `resend:${p.id}`, err.message, false));
  };
  const edit = (id) => {
    resendView.editing = id;
    store.refresh();
  };

  const body = editing
    ? h('form', {
        class: 'resend-edit',
        onsubmit: (e) => {
          e.preventDefault();
          const value = String(new FormData(e.currentTarget).get('key') ?? '').trim();
          resendView.editing = null;
          setKey(p.id, value);
          say(store, `resend:${p.id}`, value ? 'Saved. Press Test to check it.' : '');
        },
      },
        h('input', { name: 'key', type: 'password', value: key, placeholder: 'Paste the API key, re_…', autocomplete: 'off', spellcheck: false, 'aria-label': `Resend API key for ${p.name}` }),
        h('button', { type: 'submit', class: 'btn-small primary' }, 'Save'),
        h('button', { type: 'button', class: 'btn-small', onclick: () => edit(null) }, 'Cancel'))
    : h('div', { class: 'resend-sub muted small' },
        key ? [h('code', null, maskKey(key)), shared ? ` · shared with ${shared} other project${shared === 1 ? '' : 's'}` : ''] : 'No key');

  // Three columns that line up from row to row: project, key, actions. On a phone the key moves under the name.
  return h('li', { class: key ? 'resend-row has-key' : 'resend-row' },
    h('div', { class: 'resend-name' }, projectIcon(p), h('strong', { title: p.name }, p.name)),
    h('div', { class: 'resend-key' }, body,
      msg ? h('span', { class: `resend-msg small ${msg.ok ? 'ok' : 'error'}`, role: 'status' }, msg.text) : null),
    editing ? h('div', { class: 'resend-actions' }) : h('div', { class: 'resend-actions' },
      key
        ? [
            h('button', { type: 'button', class: 'btn-small', onclick: test }, 'Test'),
            h('button', { type: 'button', class: 'btn-small', onclick: () => edit(p.id) }, 'Change'),
            h('button', {
              type: 'button',
              class: 'icon-btn',
              title: 'Remove key',
              'aria-label': `Remove the Resend key of ${p.name}`,
              onclick: () => {
                setKey(p.id, '');
                say(store, `resend:${p.id}`, '');
              },
            }, icon('x')),
          ]
        : h('button', { type: 'button', class: 'btn-small', onclick: () => edit(p.id) }, icon('plus'), 'Add key')));
}

export function resendCard(store) {
  const cfg = resendSettings(store);
  const keys = cfg.keys ?? {};
  const save = (patch) => store.update('settings', (d) => {
    d.resend = { relay: '', keys: {}, ...d.resend, ...patch };
  });
  const setKey = (id, key) => save({ keys: Object.fromEntries(Object.entries({ ...keys, [id]: key }).filter(([, v]) => v)) });
  // Projects with a key first, each group by name.
  const all = projectTree(store.get('projects').projects).map(({ project }) => project).sort(byName);
  const projects = [...all.filter((p) => keys[p.id]), ...all.filter((p) => !keys[p.id])];
  const count = all.filter((p) => keys[p.id]).length;

  const list = h('ul', { class: 'resend-list' });
  const paint = () => {
    const q = resendView.query.trim().toLowerCase();
    const shown = projects.filter((p) => !q || p.name.toLowerCase().includes(q));
    list.replaceChildren(...(shown.length
      ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Project'), h('span', null, 'API key'), h('span')),
          ...shown.map((p) => resendRow(store, p, keys, cfg.relay, setKey))]
      : [h('li', { class: 'empty' }, all.length ? 'No project matches.' : 'No projects yet. Add one in Projects.')]));
  };
  paint();

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      head('Resend', 'The Inbox lists the emails each project sends and receives through Resend. Keys are saved in settings.json and go only to Resend, through a relay on this machine.',
        badge(count ? `${count} of ${all.length} project${all.length === 1 ? '' : 's'}` : 'Not set', count ? 'doing' : 'plain')),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          steps([
            ['In each Resend account, open ', link('https://resend.com/api-keys', 'API Keys'), ' and create a key with Full access. A sending-only key cannot read emails.'],
            ['In the board folder, run ', h('code', null, 'bun start'), ', which starts the board with its relays, and keep it open while you use the Inbox.'],
            'Add each key to its project below, then test it.',
          ])),
        h('form', {
          class: 'svc-section',
          onsubmit: (e) => {
            e.preventDefault();
            save({ relay: String(new FormData(e.currentTarget).get('relay') ?? '').trim() });
            say(store, 'resend', 'Relay address saved.');
          },
        },
          h('h3', null, 'Relay'),
          h('p', { class: 'muted small' }, `Leave empty to use ${RESEND_RELAY}. Change it only if you started the relay on another port.`),
          h('div', { class: 'row resend-relay' },
            h('input', { name: 'relay', type: 'url', value: cfg.relay ?? '', placeholder: RESEND_RELAY, autocomplete: 'off', spellcheck: false, 'aria-label': 'Resend relay address' }),
            h('button', { type: 'submit' }, 'Save')),
          result('resend'),
          notice({ tone: 'info', text: 'Resend’s API does not let a web page read its answers, so a small relay on this machine fetches them. It only reads emails, only forwards to Resend, and only answers pages served from this machine.' })))),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Keys per project'),
          h('p', { class: 'muted' }, 'Projects that share a Resend account can share a key; their emails are told apart by the project website’s domain.')),
        all.length > 8
          ? h('input', {
              type: 'search',
              class: 'resend-search',
              placeholder: 'Find a project',
              value: resendView.query,
              'aria-label': 'Find a project',
              // Only the list is redrawn, so the field keeps focus while typing.
              oninput: (e) => {
                resendView.query = e.target.value;
                paint();
              },
            })
          : null),
      list));
}

// --- Gmail ---

// The project a newly added account goes to, if any.
const gmailView = { project: null };

function gmailRow(store, account, projects, saveAccounts, clientId) {
  const msg = messages[`gmail:${account.email}`];
  const connected = isGmailConnected(account.email);
  const sayRow = (text, ok) => say(store, `gmail:${account.email}`, text, ok);
  const setProject = (projectId) => {
    saveAccounts(gmailAccounts(store).map((a) => (a.email === account.email ? { ...a, projectId } : a)));
    // Saved mail follows the account to its new project.
    store.update('inbox', (d) => {
      for (const e of d.emails) if (e.source === 'gmail' && e.account === account.email) e.projectId = projectId;
    });
  };
  const remove = () => {
    disconnectGmail(account.email);
    saveAccounts(gmailAccounts(store).filter((a) => a.email !== account.email));
    store.update('inbox', (d) => {
      d.emails = d.emails.filter((e) => !(e.source === 'gmail' && e.account === account.email));
    });
    sayRow('');
  };
  const project = projects.find((p) => p.id === account.projectId);
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' }, project ? projectIcon(project) : icon('mail'), h('strong', { title: account.email }, account.email)),
    h('div', { class: 'resend-key' },
      h('div', { class: 'gmail-picks' },
        projectPick(projects, account.projectId, 'No project', setProject),
        labelPick(store, account.labelId, 'No label', (labelId) =>
          saveAccounts(gmailAccounts(store).map((a) => (a.email === account.email ? { ...a, labelId } : a))))),
      msg ? h('span', { class: `resend-msg small ${msg.ok ? 'ok' : 'error'}`, role: 'status' }, msg.text) : null),
    h('div', { class: 'resend-actions' },
      badge(connected ? 'Connected' : 'Not connected', connected ? 'done' : 'plain'),
      connected
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => { disconnectGmail(account.email); sayRow('Disconnected.'); } }, 'Disconnect')
        : h('button', {
            type: 'button',
            class: 'btn-small',
            disabled: !clientId,
            onclick: () => {
              sayRow('Waiting for Google…');
              connectGmail(clientId, account.email).then(() => sayRow('Connected.')).catch((err) => sayRow(err.message, false));
            },
          }, 'Connect'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remove account', 'aria-label': `Remove ${account.email}`, onclick: remove }, icon('x'))));
}

export function gmailCard(store) {
  const clientId = store.get('settings').google?.clientId ?? '';
  const accounts = gmailAccounts(store);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const saveAccounts = (list) => store.update('settings', (d) => {
    d.gmail = { ...d.gmail, accounts: list };
  });
  // Optional: an account can be added without a project.
  const target = projects.some((p) => p.id === gmailView.project) ? gmailView.project : null;
  const add = () => {
    const projectId = target;
    say(store, 'gmail', 'Waiting for Google…');
    connectGmail(clientId)
      .then((email) => {
        if (gmailAccounts(store).some((a) => a.email === email)) return say(store, 'gmail', `${email} is already added. It is connected again.`);
        saveAccounts([...gmailAccounts(store), { email, projectId }]);
        say(store, 'gmail', `Added ${email}. Its mail shows in the Inbox.`);
      })
      .catch((err) => say(store, 'gmail', err.message, false));
  };
  // Accounts grouped by project, in project order.
  const order = new Map(projects.map((p, i) => [p.id, i]));
  const sorted = [...accounts].sort((a, b) => (order.get(a.projectId) ?? 1e9) - (order.get(b.projectId) ?? 1e9) || a.email.localeCompare(b.email));

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      head('Gmail', 'The Inbox lists the mail each project receives and sends through Gmail, read-only. A project can have several accounts. Each account signs in on its own; nothing but the list of addresses is saved, and the connection lasts about an hour.',
        badge(accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'Not set', accounts.length ? 'doing' : 'plain')),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          steps([
            ['Set the OAuth Client ID under ', h('a', { href: '#/settings?section=google' }, 'Google Calendar'), ' first. Gmail uses the same one.'],
            ['In Google Cloud Console, enable the ', link('https://console.cloud.google.com/apis/library/gmail.googleapis.com', 'Gmail API'), ' for that project.'],
            'On the OAuth consent screen, add each Gmail address you will connect as a test user. Gmail access is restricted, so the app stays in Testing.',
            'Pick a project if you like, press Add a Gmail account, choose the account and allow “View your email messages and settings”.',
          ])),
        h('div', { class: 'svc-section' },
          h('h3', null, 'Add an account'),
          h('div', { class: 'svc-actions' },
            projects.length
              ? projectPick(projects, target, 'No project', (v) => {
                  gmailView.project = v;
                  store.refresh();
                })
              : null,
            h('button', { type: 'button', class: 'primary', disabled: !clientId, onclick: add }, icon('plus'), 'Add a Gmail account')),
          clientId ? null : setupBanner('google', 'Add the Google OAuth Client ID first. The same one is used here.'),
          result('gmail')))),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Accounts'),
          h('p', { class: 'muted' }, 'A project and a project label are optional; the Inbox can be filtered by either. Change an account’s project and its saved mail moves with it. Removing an account removes its mail from the Inbox.'))),
      h('ul', { class: 'resend-list' },
        sorted.length
          ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Account'), h('span', null, 'Project and label'), h('span')),
              ...sorted.map((a) => gmailRow(store, a, projects, saveAccounts, clientId))]
          : [h('li', { class: 'empty' }, 'No Gmail account yet.')])));
}

// --- Data folder ---

const DATA_FILES = ['projects', 'todos', 'recipes', 'finance', 'tools', 'inbox', 'notifications', 'usage', 'settings'];

export function dataCard(store) {
  return h('section', { class: 'card panel' },
    head('Data folder', 'Your data lives as plain JSON files in a folder you chose. It stays on this computer; back it up the way you back up any other folder.', badge('Connected', 'done')),
    h('div', { class: 'card-inset stack' },
      h('strong', null, store.folderName ?? 'Data folder'),
      h('p', { class: 'muted small' }, `${DATA_FILES.map((f) => `${f}.json`).join(' · ')} · bills/`)),
    h('div', { class: 'svc-actions' },
      h('button', { type: 'button', onclick: () => window.dispatchEvent(new CustomEvent('board:pick-folder')) }, 'Pick another folder')),
    h('p', { class: 'muted small' }, 'The board reloads on the folder you pick. The current folder is left as it is, and you can come back to it the same way.'),
    h('p', { class: 'muted small' }, 'Changes are written about a third of a second after you make them. The status in the top bar says Saving…, Saved or Save failed.'));
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
