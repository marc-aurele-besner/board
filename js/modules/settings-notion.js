// Settings → Notion: the accounts the board signs in with (integration secrets, OAuth sign-ins and browser sessions,
// as many of each as there are workspaces or people), the project each account feeds, and which database feeds which
// project. Every call goes through the runners (see js/notion.js), which also read the databases on a schedule.
import { h, icon, uid, notice, copyable } from '../ui.js';
import { pickChip } from '../inline.js';
import { runJob } from '../runners.js';
import { notionSettings, normalizeNotion, checkNotion, checkNotionSession, readNotionDatabase, finishNotionSignIn, wayLabel, accountName, linkProject } from '../notion.js';
import { projectIcon, projectTree } from './projects.js';

/** @import { Store, Project, NotionAccount, NotionLink, NotionSettings } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @typedef {SubmitEvent & { currentTarget: HTMLFormElement }} FormSubmit */
/** @typedef {NotionSettings & { accounts: NotionAccount[] }} Cfg */

/** @param {string} href @param {Child} text */
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
/** @param {string} text @param {string} tone */
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);

// A database's project picker value for "its account's project".
const FOLLOW = '@account';

// The add form's account and project, and the messages shown after an action: { text, ok } per key.
/** @type {{ account: string | null, project: string | null, messages: Record<string, { text: string, ok: boolean } | null>, busy: Record<string, boolean> }} */
const view = { account: null, project: FOLLOW, messages: {}, busy: {} };
/** @param {Store} store @param {string} key @param {string} text @param {boolean} [ok] */
const say = (store, key, text, ok = true) => {
  view.messages[key] = text ? { text, ok } : null;
  store.refresh();
};
/** @param {string} key @param {string} [className] */
const result = (key, className = 'test-result') => {
  const m = view.messages[key];
  return m ? h('p', { class: `${className} ${m.ok ? 'ok' : 'error'}`, role: 'status' }, m.text) : null;
};


/**
 * @param {Project[]} projects
 * @param {string | null} value
 * @param {(id: string | null) => void} onPick
 * @param {string} [follow] the label of "the account's project", when the database may follow it
 */
const projectPick = (projects, value, onPick, follow) => pickChip({
  value,
  options: [
    ...(follow ? [{ value: FOLLOW, label: follow }] : []),
    ...projects.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
  ],
  nullable: true,
  nullLabel: 'Personal (To Organize)',
  className: 'field-pick project-field-pick',
  onPick: (v) => onPick(v ?? null),
});

/** @param {Store} store @param {(cfg: Cfg) => NotionSettings} change */
const save = (store, change) => store.update('settings', (d) => {
  d.notion = normalizeNotion(change(normalizeNotion(d.notion)));
});
/** @param {Store} store @param {string} id @param {Partial<NotionLink>} patch */
const setLink = (store, id, patch) => save(store, (cfg) => ({ ...cfg, links: cfg.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));
/** @param {Store} store @param {NotionAccount} account */
const putAccount = (store, account) => save(store, (cfg) => ({
  ...cfg,
  accounts: cfg.accounts.some((a) => a.id === account.id) ? cfg.accounts.map((a) => (a.id === account.id ? account : a)) : [...cfg.accounts, account],
}));

// Tasks follow their database to its new project, unless they were moved on the board since.
/** @param {Store} store @param {Cfg} before @param {Cfg} after */
function moveTasks(store, before, after) {
  /** @type {Map<string, { from: string | null, to: string | null }>} */
  const moves = new Map();
  for (const l of after.links) {
    const old = before.links.find((x) => x.id === l.id);
    const m = { from: old ? linkProject(before, old) : null, to: linkProject(after, l) };
    if (old && m.from !== m.to) moves.set(l.id, m);
  }
  if (!moves.size) return;
  store.update('todos', (d) => {
    for (const t of d.items) {
      const m = t.auto === 'notion' && t.notion ? moves.get(t.notion.link) : null;
      if (!m || t.projectId !== m.from) continue;
      t.projectId = m.to;
      t.inbox = !m.to;
    }
  });
}
/** @param {Store} store @param {(cfg: Cfg) => Cfg} change */
const saveAndMove = (store, change) => {
  const before = notionSettings(store);
  const after = change(before);
  moveTasks(store, before, after);
  save(store, () => after);
};

/** @param {Store} store @param {NotionLink} l */
function syncNow(store, l) {
  view.busy[l.id] = true;
  say(store, l.id, 'Reading the database…');
  runJob('notion', { ids: [l.id] })
    .then((/** @type {{ added?: number, updated?: number }} */ a) => {
      const added = a.added ?? 0;
      const updated = a.updated ?? 0;
      say(store, l.id, added || updated ? `${added} new, ${updated} updated.` : 'Up to date.');
    })
    .catch((err) => say(store, l.id, err.message, false))
    .finally(() => {
      view.busy[l.id] = false;
      store.refresh();
    });
}

const AUTHORIZE = 'https://api.notion.com/v1/oauth/authorize';
const SIGN_IN_WAIT = 5 * 60000;
// The redirect address to add to the public integration. oauth.html hands the code back over a BroadcastChannel.
const redirectUri = () => `${location.origin}/oauth.html`;

// Opens Notion's sign-in in a popup (from a click, or the browser blocks it), waits for oauth.html to pass the code
// on, and has the runners trade it for a token. A workspace signed in to before gets its new token; another one
// becomes a new account.
/** @param {Store} store */
async function signIn(store) {
  const { oauth } = notionSettings(store);
  if (!oauth?.clientId || !oauth.clientSecret) throw new Error('Save the OAuth client ID and secret first.');
  const state = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  const params = new URLSearchParams({ client_id: oauth.clientId, response_type: 'code', owner: 'user', redirect_uri: redirectUri(), state });
  const popup = window.open(`${AUTHORIZE}?${params}`, 'board-notion-sign-in', 'width=600,height=760');
  if (!popup) throw new Error('The browser blocked Notion’s sign-in. Allow popups for the board and try again.');
  /** @type {{ state?: string, code?: string, error?: string }} */
  const answer = await new Promise((resolve, reject) => {
    const channel = new BroadcastChannel('board-oauth');
    const timer = setTimeout(() => {
      channel.close();
      reject(new Error('Notion’s sign-in was not finished.'));
    }, SIGN_IN_WAIT);
    channel.onmessage = ({ data: msg }) => {
      if (msg?.state !== state) return;
      clearTimeout(timer);
      channel.close();
      resolve(msg);
    };
  });
  if (answer.error || !answer.code) throw new Error(answer.error === 'access_denied' ? 'Notion’s sign-in was cancelled.' : `Notion sign-in error: ${answer.error ?? 'no code'}`);
  const token = await finishNotionSignIn({ clientId: oauth.clientId, clientSecret: oauth.clientSecret, code: answer.code, redirectUri: redirectUri() });
  const same = notionSettings(store).accounts.find((a) => a.way === 'oauth'
    && (token.workspaceId ? a.workspaceId === token.workspaceId : a.workspace === token.workspace));
  putAccount(store, { id: uid(), name: token.workspace, ...same, way: 'oauth', ...token });
  return { workspace: token.workspace, again: Boolean(same) };
}

/** @param {string} iso */
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** @param {Store} store @param {Cfg} cfg @param {NotionAccount} a @param {Project[]} projects */
function accountRow(store, cfg, a, projects) {
  const key = `account-${a.id}`;
  const count = cfg.links.filter((l) => l.account === a.id).length;
  const test = () => {
    say(store, key, 'Asking Notion…');
    const asked = a.way === 'session' ? checkNotionSession({ tokenV2: a.tokenV2 ?? '', userId: a.userId ?? '' }) : checkNotion(a.way === 'oauth' ? a.accessToken ?? '' : a.token ?? '');
    asked.then((r) => say(store, key, r.text)).catch((err) => say(store, key, err.message, false));
  };
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' }, icon(a.way === 'token' ? 'key' : a.way === 'session' ? 'users' : 'notion'),
      h('strong', { title: accountName(a) }, accountName(a)),
      h('span', { class: 'muted small', title: `${count} database${count === 1 ? '' : 's'}` }, wayLabel(a))),
    h('div', { class: 'resend-key' },
      projectPick(projects, a.projectId ?? null, (projectId) => saveAndMove(store, (c) => ({ ...c, accounts: c.accounts.map((x) => (x.id === a.id ? { ...x, projectId } : x)) }))),
      result(key, 'resend-msg small')),
    h('div', { class: 'resend-actions' },
      h('button', { type: 'button', class: 'btn-small', onclick: test }, 'Test'),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: count ? 'Remove account and its databases (their tasks stay)' : 'Remove account',
        'aria-label': `Remove ${accountName(a)}`,
        onclick: () => save(store, (c) => ({ ...c, accounts: c.accounts.filter((x) => x.id !== a.id), links: c.links.filter((l) => l.account !== a.id) })),
      }, icon('x'))));
}

/** @param {Store} store @param {Cfg} cfg @param {NotionLink} l @param {Project[]} projects */
function linkRow(store, cfg, l, projects) {
  const on = l.on !== false;
  const account = cfg.accounts.find((a) => a.id === l.account);
  const accountProject = account?.projectId ? projects.find((p) => p.id === account.projectId)?.name : null;
  const status = l.error ? h('span', { class: 'resend-msg small error' }, l.error)
    : l.syncedAt ? h('span', { class: 'muted small' }, `Pages edited up to ${when(l.syncedAt)} are read.`)
    : h('span', { class: 'muted small' }, 'Not read yet.');
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' }, icon('notion'),
      h('strong', { title: l.name }, link(`https://www.notion.so/${l.databaseId}`, l.name || 'Untitled database')),
      h('span', { class: 'muted small', title: wayLabel(account) }, accountName(account))),
    h('div', { class: 'resend-key' },
      projectPick(projects, l.projectId === undefined ? FOLLOW : l.projectId,
        (v) => saveAndMove(store, (c) => ({ ...c, links: c.links.map((x) => {
          if (x.id !== l.id) return x;
          const { projectId: _, ...rest } = x;
          return v === FOLLOW ? rest : { ...rest, projectId: v };
        }) })),
        `Account’s: ${accountProject ?? 'Personal'}`),
      result(l.id, 'resend-msg small') ?? status),
    h('div', { class: 'resend-actions' },
      h('label', { class: 'row check', title: on ? 'Read on a schedule' : 'Not read' },
        h('input', { type: 'checkbox', checked: on, 'aria-label': `Read ${l.name}`, onchange: (/** @type {{ target: HTMLInputElement }} */ e) => setLink(store, l.id, { on: e.target.checked }) })),
      h('button', { type: 'button', class: 'btn-small', disabled: !on || view.busy[l.id], onclick: () => syncNow(store, l) }, 'Sync now'),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Remove database (its tasks stay)',
        'aria-label': `Remove ${l.name}`,
        onclick: () => save(store, (cfg) => ({ ...cfg, links: cfg.links.filter((x) => x.id !== l.id) })),
      }, icon('x'))));
}

/** @param {Store} store */
export function notionCard(store) {
  const cfg = notionSettings(store);
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const linked = cfg.links.filter((l) => l.on !== false).length;
  const hasAccount = cfg.accounts.length > 0;
  if (view.account && !cfg.accounts.some((a) => a.id === view.account)) view.account = null;

  const tokenForm = h('form', {
    class: 'notion-way',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const token = String(new FormData(form).get('token') ?? '').trim();
      if (!token) return say(store, 'token', 'Paste the secret first.', false);
      const same = notionSettings(store).accounts.find((a) => a.way === 'token' && a.token === token);
      if (same) return say(store, 'token', `This secret is already added, as ${accountName(same)}.`, false);
      say(store, 'token', 'Asking Notion…');
      checkNotion(token)
        .then((r) => {
          putAccount(store, { id: uid(), way: 'token', token, name: r.name });
          form.reset();
          say(store, 'token', `${r.text} Added.`);
        })
        .catch((err) => say(store, 'token', err.message, false));
    },
  },
    h('h3', null, 'Integration secret'),
    h('p', { class: 'muted small' }, 'For a workspace where you may create an integration. Add one secret per workspace.'),
    h('ol', { class: 'steps' }, [
      ['Open ', link('https://www.notion.so/profile/integrations', 'Notion → Integrations'), ' and create an internal integration with Read content.'],
      'Copy its Internal Integration Secret, paste it here and add it.',
      'In Notion, open each database, then ⋯ → Connections, and add the integration.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('div', { class: 'notion-way-fields' },
      h('input', { name: 'token', type: 'password', placeholder: 'ntn_…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Integration secret' }),
      h('div', { class: 'svc-actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add account')),
      result('token')));

  const oauth = { clientId: '', clientSecret: '', ...cfg.oauth };
  const oauthForm = h('form', {
    class: 'notion-way',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const clientId = String(form.get('clientId') ?? '').trim();
      const clientSecret = String(form.get('clientSecret') ?? '').trim();
      save(store, (c) => ({ ...c, oauth: { clientId, clientSecret } }));
      say(store, 'oauth', 'Saved.');
    },
  },
    h('h3', null, 'Sign in with Notion (OAuth)'),
    h('p', { class: 'muted small' }, 'For a workspace where you cannot create an integration, but may add one made elsewhere. Sign in once per workspace.'),
    h('ol', { class: 'steps' }, [
      ['In a workspace of your own (a personal one is fine), open ', link('https://www.notion.so/profile/integrations', 'Notion → Integrations'), ' and create a public integration with Read content.'],
      ['Under Redirect URIs, add ', copyable(redirectUri())],
      'Copy its OAuth client ID and client secret, paste them here and save.',
      'Sign in with Notion, pick a workspace, and choose the databases it may read. Sign in again for each other workspace.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('div', { class: 'notion-way-fields' },
      h('input', { name: 'clientId', value: oauth.clientId, placeholder: 'OAuth client ID', autocomplete: 'off', spellcheck: false, 'aria-label': 'OAuth client ID' }),
      h('input', { name: 'clientSecret', type: 'password', value: oauth.clientSecret, placeholder: 'OAuth client secret', autocomplete: 'off', spellcheck: false, 'aria-label': 'OAuth client secret' }),
      h('div', { class: 'svc-actions' },
        h('button', { type: 'submit' }, 'Save'),
        h('button', {
          type: 'button',
          class: 'primary',
          disabled: !oauth.clientId || !oauth.clientSecret,
          onclick: () => {
            say(store, 'oauth', 'Waiting for Notion’s sign-in…');
            signIn(store)
              .then(({ workspace, again }) => say(store, 'oauth', again ? `Signed in again${workspace ? ` to ${workspace}` : ''}.` : `Added ${workspace || 'the workspace'}.`))
              .catch((err) => say(store, 'oauth', err.message, false));
          },
        }, 'Sign in with Notion')),
      result('oauth')));

  const sessionForm = h('form', {
    class: 'notion-way',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const data = new FormData(form);
      const tokenV2 = String(data.get('tokenV2') ?? '').trim().replace(/^token_v2=/, '');
      const userId = String(data.get('userId') ?? '').trim().replace(/^notion_user_id=/, '');
      if (!tokenV2) return say(store, 'session', 'Paste the token_v2 cookie first.', false);
      say(store, 'session', 'Asking Notion…');
      checkNotionSession({ tokenV2, userId })
        .then((r) => {
          // The same person signed in again: a fresh cookie for the account already there.
          const same = notionSettings(store).accounts.find((a) => a.way === 'session' && ((userId && a.userId === userId) || (r.name && a.name === r.name)));
          putAccount(store, { id: uid(), ...same, way: 'session', tokenV2, userId, name: r.name || same?.name || '' });
          form.reset();
          say(store, 'session', `${r.text} ${same ? 'Updated.' : 'Added.'}`);
        })
        .catch((err) => say(store, 'session', err.message, false));
    },
  },
    h('h3', null, 'Browser session'),
    h('p', { class: 'muted small' }, 'Reads as you, with the sign-in of notion.so: no integration and no admin approval. It reads every database your account can open. Add one per person.'),
    h('ol', { class: 'steps' }, [
      ['Open ', link('https://www.notion.so', 'notion.so'), ' in this browser, signed in to the workspace.'],
      'Open the developer tools → Application (Storage in Firefox) → Cookies → https://www.notion.so.',
      'Copy the value of token_v2 and paste it here. Signed in to several accounts? Copy notion_user_id too, for the one to read as.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('p', { class: 'muted small' }, 'This uses the API of Notion’s own web app, which is not documented and may change. The cookie is a full sign-in to your account: it is kept in settings.json, so keep the data folder private, and sent only to www.notion.so. It stops working when you sign out of Notion in this browser.'),
    h('div', { class: 'notion-way-fields' },
      h('input', { name: 'tokenV2', type: 'password', placeholder: 'token_v2', autocomplete: 'off', spellcheck: false, 'aria-label': 'token_v2 cookie' }),
      h('input', { name: 'userId', placeholder: 'notion_user_id (optional)', autocomplete: 'off', spellcheck: false, 'aria-label': 'notion_user_id cookie' }),
      h('div', { class: 'svc-actions' }, h('button', { class: 'primary', type: 'submit' }, 'Add account')),
      result('session')));

  const addForm = h('form', {
    class: 'resend-edit',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const raw = String(new FormData(form).get('database') ?? '').trim();
      if (!raw) return say(store, 'add', 'Paste the database’s link first.', false);
      if (!hasAccount) return say(store, 'add', 'Add an account first.', false);
      say(store, 'add', 'Reading the database…');
      readNotionDatabase(cfg, raw, view.account ?? undefined)
        .then((db) => {
          const now = notionSettings(store);
          if (now.links.some((l) => l.databaseId === db.id && l.account === db.account)) throw new Error(`${db.name} is already linked with this account.`);
          /** @type {NotionLink} */
          const added = { id: uid(), databaseId: db.id, name: db.name, account: db.account, on: true, ...(view.project !== FOLLOW ? { projectId: view.project } : {}) };
          save(store, (c) => ({ ...c, links: [...c.links, added] }));
          const read = [db.fields.status && `status from “${db.fields.status}”`, db.fields.due && `deadline from “${db.fields.due}”`, db.fields.priority && `priority from “${db.fields.priority}”`].filter(Boolean);
          const how = now.accounts.length > 1 ? ` with ${accountName(now.accounts.find((a) => a.id === db.account))}` : '';
          say(store, 'add', `Linked ${db.name}${how}${read.length ? `: ${read.join(', ')}` : ''}.`);
          form.reset();
          syncNow(store, added);
        })
        .catch((err) => say(store, 'add', err.message, false));
    },
  },
    h('input', { name: 'database', placeholder: 'https://www.notion.so/…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Notion database link' }),
    cfg.accounts.length > 1 ? pickChip({
      value: view.account,
      options: cfg.accounts.map((a) => ({ value: a.id, label: accountName(a) })),
      nullable: true,
      nullLabel: 'Any account',
      className: 'field-pick',
      onPick: (v) => {
        view.account = v ?? null;
        store.refresh();
      },
    }) : null,
    projectPick(projects, view.project, (id) => {
      view.project = id;
      store.refresh();
    }, 'Account’s project'),
    h('button', { class: 'primary', type: 'submit', disabled: !hasAccount }, 'Add'));

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Notion'),
          h('p', { class: 'muted' }, 'The pages of a Notion database become tasks in the project you pick. When a page changes in Notion, its task follows; what you change on the board is kept, and nothing is written back to Notion.')),
        h('div', { class: 'row' }, badge(hasAccount && linked ? `${linked} database${linked === 1 ? '' : 's'}` : 'Not set', hasAccount && linked ? 'done' : 'plain'))),
      h('div', { class: 'notion-intro' },
        h('div', { class: 'notion-intro-text' },
          h('p', { class: 'muted small' }, 'Add an account with any of the three ways below, as many as you have workspaces: an integration secret if you can create an integration in the workspace, otherwise Sign in with Notion or the browser session. Each account can feed a project. Then copy each database’s link (⋯ → Copy link) and add it under Databases; it goes to its account’s project unless you pick another.'),
          h('p', { class: 'muted small' }, 'The title becomes the task. A Status (or a Done checkbox) sets its status, the first date (Due or Deadline first) its deadline, and a Priority select its priority. The first read skips pages already done.')),
        notice({ tone: 'info', text: 'Notion’s API does not answer web pages, so the runners read it: start the board with bun start. They read every database every few minutes (Settings → Runners).' })),
      h('div', { class: 'notion-ways' }, tokenForm, oauthForm, sessionForm)),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Accounts'), h('p', { class: 'muted' }, 'Each account’s databases go to its project, unless a database picks its own.'))),
      h('ul', { class: 'resend-list' },
        cfg.accounts.length
          ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Account'), h('span', null, 'Project'), h('span')),
              ...cfg.accounts.map((a) => accountRow(store, cfg, a, projects))]
          : [h('li', { class: 'empty' }, 'No account yet. Add one above.')])),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Databases'), h('p', { class: 'muted' }, 'Each database feeds one project. Removing one keeps the tasks it made.'))),
      h('div', { class: 'stack' },
        addForm,
        result('add'),
        h('ul', { class: 'resend-list' },
          cfg.links.length
            ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Database'), h('span', null, 'Project'), h('span')),
                ...cfg.links.map((l) => linkRow(store, cfg, l, projects))]
            : [h('li', { class: 'empty' }, 'No database linked yet.')]))));
}
