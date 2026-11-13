// Settings → Notion: how the board signs in (an integration secret, an OAuth sign-in or the browser session), and
// which database feeds which project. Every call goes through the runners (see js/notion.js), which also read the
// databases on a schedule.
import { h, icon, uid, notice, copyable } from '../ui.js';
import { pickChip } from '../inline.js';
import { runJob } from '../runners.js';
import { notionSettings, checkNotion, checkNotionSession, readNotionDatabase, finishNotionSignIn, ways, WAY_LABELS } from '../notion.js';
import { projectIcon, projectTree } from './projects.js';

/** @import { Store, Project, NotionLink, NotionSettings } from '../../types/data' */
/** @import { Child } from '../../types/ui' */
/** @typedef {SubmitEvent & { currentTarget: HTMLFormElement }} FormSubmit */

/** @param {string} href @param {Child} text */
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
/** @param {string} text @param {string} tone */
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);

// The add form's project, and the messages shown after an action: { text, ok } per key.
/** @type {{ project: string | null, messages: Record<string, { text: string, ok: boolean } | null>, busy: Record<string, boolean> }} */
const view = { project: null, messages: {}, busy: {} };
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

/** @param {Project[]} projects @param {string | null} value @param {(id: string | null) => void} onPick */
const projectPick = (projects, value, onPick) => pickChip({
  value,
  options: projects.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
  nullable: true,
  nullLabel: 'Personal (To Organize)',
  className: 'field-pick project-field-pick',
  onPick: (v) => onPick(v ?? null),
});

/** @param {Store} store @param {(cfg: NotionSettings) => NotionSettings} change */
const save = (store, change) => store.update('settings', (d) => {
  d.notion = change({ token: '', links: [], ...(d.notion ?? {}) });
});
/** @param {Store} store @param {string} id @param {Partial<NotionLink>} patch */
const setLink = (store, id, patch) => save(store, (cfg) => ({ ...cfg, links: cfg.links.map((l) => (l.id === id ? { ...l, ...patch } : l)) }));

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
// on, and has the runners trade it for a token.
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
  save(store, (c) => ({ ...c, oauth: { clientId: '', clientSecret: '', ...c.oauth, ...token } }));
  return token.workspace;
}

/** @param {string} iso */
const when = (iso) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

/** @param {Store} store @param {NotionLink} l @param {Project[]} projects */
function linkRow(store, l, projects) {
  const on = l.on !== false;
  // Tasks follow their database to its new project, unless they were moved on the board since.
  /** @param {string | null} projectId */
  const move = (projectId) => {
    store.update('todos', (d) => {
      for (const t of d.items) {
        if (t.auto !== 'notion' || t.notion?.link !== l.id || t.projectId !== l.projectId) continue;
        t.projectId = projectId;
        t.inbox = !projectId;
      }
    });
    setLink(store, l.id, { projectId });
  };
  const status = l.error ? h('span', { class: 'resend-msg small error' }, l.error)
    : l.syncedAt ? h('span', { class: 'muted small' }, `Pages edited up to ${when(l.syncedAt)} are read.`)
    : h('span', { class: 'muted small' }, 'Not read yet.');
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' }, icon('notion'),
      h('strong', { title: l.name }, link(`https://www.notion.so/${l.databaseId}`, l.name || 'Untitled database')),
      h('span', { class: 'muted small' }, WAY_LABELS[/** @type {keyof typeof WAY_LABELS} */ (l.via ?? 'token')] ?? '')),
    h('div', { class: 'resend-key' }, projectPick(projects, l.projectId, move), result(l.id, 'resend-msg small') ?? status),
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
  const signedIn = ways(cfg).length > 0;

  const tokenForm = h('form', {
    class: 'svc-section',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const token = String(new FormData(e.currentTarget).get('token') ?? '').trim();
      save(store, (c) => ({ ...c, token }));
      say(store, 'token', 'Saved.');
    },
  },
    h('h3', null, 'Integration secret'),
    h('ol', { class: 'steps' }, [
      ['Open ', link('https://www.notion.so/profile/integrations', 'Notion → Integrations'), ' and create an internal integration with Read content.'],
      'Copy its Internal Integration Secret, paste it here and save.',
      'In Notion, open each database, then ⋯ → Connections, and add the integration.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('input', { name: 'token', type: 'password', value: cfg.token, placeholder: 'ntn_…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Integration secret' }),
    h('div', { class: 'svc-actions' },
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
      h('button', {
        type: 'button',
        disabled: !cfg.token,
        onclick: () => {
          say(store, 'token', 'Asking Notion…');
          checkNotion(cfg.token).then((text) => say(store, 'token', text)).catch((err) => say(store, 'token', err.message, false));
        },
      }, 'Test connection'),
      cfg.token ? h('button', { type: 'button', class: 'danger', onclick: () => { save(store, (c) => ({ ...c, token: '' })); say(store, 'token', ''); } }, icon('x'), 'Clear') : null),
    result('token'));

  const addForm = h('form', {
    class: 'resend-edit',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const raw = String(new FormData(form).get('database') ?? '').trim();
      if (!raw) return say(store, 'add', 'Paste the database’s link first.', false);
      if (!ways(cfg).length) return say(store, 'add', 'Set up a way to sign in first.', false);
      say(store, 'add', 'Reading the database…');
      readNotionDatabase(cfg, raw)
        .then((db) => {
          if (notionSettings(store).links.some((l) => l.databaseId === db.id)) throw new Error(`${db.name} is already linked.`);
          /** @type {NotionLink} */
          const added = { id: uid(), databaseId: db.id, name: db.name, projectId: view.project, on: true, ...(db.via !== 'token' ? { via: db.via } : {}) };
          save(store, (c) => ({ ...c, links: [...c.links, added] }));
          const read = [db.fields.status && `status from “${db.fields.status}”`, db.fields.due && `deadline from “${db.fields.due}”`, db.fields.priority && `priority from “${db.fields.priority}”`].filter(Boolean);
          const how = ways(cfg).length > 1 ? ` with the ${WAY_LABELS[/** @type {keyof typeof WAY_LABELS} */ (db.via)].toLowerCase()}` : '';
          say(store, 'add', `Linked ${db.name}${how}${read.length ? `: ${read.join(', ')}` : ''}.`);
          form.reset();
          syncNow(store, added);
        })
        .catch((err) => say(store, 'add', err.message, false));
    },
  },
    h('input', { name: 'database', placeholder: 'https://www.notion.so/…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Notion database link' }),
    projectPick(projects, view.project, (id) => {
      view.project = id;
      store.refresh();
    }),
    h('button', { class: 'primary', type: 'submit', disabled: !ways(cfg).length }, 'Add'));

  const oauth = { clientId: '', clientSecret: '', ...cfg.oauth };
  const oauthForm = h('form', {
    class: 'svc-section',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const clientId = String(form.get('clientId') ?? '').trim();
      const clientSecret = String(form.get('clientSecret') ?? '').trim();
      save(store, (c) => ({ ...c, oauth: { ...c.oauth, clientId, clientSecret } }));
      say(store, 'oauth', 'Saved.');
    },
  },
    h('h3', null, 'Sign in with Notion (OAuth)'),
    h('p', { class: 'muted small' }, 'For a workspace where you cannot create an integration, but may add one made elsewhere.'),
    h('ol', { class: 'steps' }, [
      ['In a workspace of your own (a personal one is fine), open ', link('https://www.notion.so/profile/integrations', 'Notion → Integrations'), ' and create a public integration with Read content.'],
      ['Under Redirect URIs, add ', copyable(redirectUri()), '.'],
      'Copy its OAuth client ID and client secret, paste them here and save.',
      'Sign in with Notion, pick the other workspace, and choose the databases it may read.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('input', { name: 'clientId', value: oauth.clientId, placeholder: 'OAuth client ID', autocomplete: 'off', spellcheck: false, 'aria-label': 'OAuth client ID' }),
    h('input', { name: 'clientSecret', type: 'password', value: oauth.clientSecret, placeholder: 'OAuth client secret', autocomplete: 'off', spellcheck: false, 'aria-label': 'OAuth client secret' }),
    oauth.accessToken ? h('p', { class: 'muted small' }, `Signed in${oauth.workspace ? ` to ${oauth.workspace}` : ''}.`) : null,
    h('div', { class: 'svc-actions' },
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
      h('button', {
        type: 'button',
        disabled: !oauth.clientId || !oauth.clientSecret,
        onclick: () => {
          say(store, 'oauth', 'Waiting for Notion’s sign-in…');
          signIn(store)
            .then((workspace) => say(store, 'oauth', `Signed in${workspace ? ` to ${workspace}` : ''}.`))
            .catch((err) => say(store, 'oauth', err.message, false));
        },
      }, oauth.accessToken ? 'Sign in again' : 'Sign in with Notion'),
      oauth.accessToken ? h('button', {
        type: 'button',
        disabled: !oauth.accessToken,
        onclick: () => {
          say(store, 'oauth', 'Asking Notion…');
          checkNotion(/** @type {string} */ (oauth.accessToken)).then((text) => say(store, 'oauth', text)).catch((err) => say(store, 'oauth', err.message, false));
        },
      }, 'Test connection') : null,
      oauth.accessToken ? h('button', {
        type: 'button',
        class: 'danger',
        onclick: () => {
          save(store, (c) => ({ ...c, oauth: { ...oauth, accessToken: '', refreshToken: '', workspace: '' } }));
          say(store, 'oauth', '');
        },
      }, icon('x'), 'Sign out') : null),
    result('oauth'));

  const session = { tokenV2: '', userId: '', ...cfg.session };
  const sessionForm = h('form', {
    class: 'svc-section',
    /** @param {FormSubmit} e */
    onsubmit: (e) => {
      e.preventDefault();
      const form = new FormData(e.currentTarget);
      const tokenV2 = String(form.get('tokenV2') ?? '').trim().replace(/^token_v2=/, '');
      const userId = String(form.get('userId') ?? '').trim().replace(/^notion_user_id=/, '');
      save(store, (c) => ({ ...c, session: { tokenV2, userId } }));
      say(store, 'session', 'Saved.');
    },
  },
    h('h3', null, 'Browser session'),
    h('p', { class: 'muted small' }, 'Reads as you, with the sign-in of notion.so: no integration and no admin approval. It reads every database your account can open.'),
    h('ol', { class: 'steps' }, [
      ['Open ', link('https://www.notion.so', 'notion.so'), ' in this browser, signed in to the workspace.'],
      'Open the developer tools → Application (Storage in Firefox) → Cookies → https://www.notion.so.',
      'Copy the value of token_v2 and paste it here. Signed in to several accounts? Copy notion_user_id too, for the one to read as.',
    ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
    h('input', { name: 'tokenV2', type: 'password', value: session.tokenV2, placeholder: 'token_v2', autocomplete: 'off', spellcheck: false, 'aria-label': 'token_v2 cookie' }),
    h('input', { name: 'userId', value: session.userId, placeholder: 'notion_user_id (optional)', autocomplete: 'off', spellcheck: false, 'aria-label': 'notion_user_id cookie' }),
    h('div', { class: 'svc-actions' },
      h('button', { class: 'primary', type: 'submit' }, 'Save'),
      h('button', {
        type: 'button',
        disabled: !session.tokenV2,
        onclick: () => {
          say(store, 'session', 'Asking Notion…');
          checkNotionSession(session).then((text) => say(store, 'session', text)).catch((err) => say(store, 'session', err.message, false));
        },
      }, 'Test session'),
      session.tokenV2 ? h('button', { type: 'button', class: 'danger', onclick: () => { save(store, (c) => ({ ...c, session: { tokenV2: '', userId: '' } })); say(store, 'session', ''); } }, icon('x'), 'Clear') : null),
    result('session'),
    h('p', { class: 'muted small' }, 'This uses the API of Notion’s own web app, which is not documented and may change. The cookie is a full sign-in to your account: it is kept in settings.json, so keep the data folder private, and sent only to www.notion.so. It stops working when you sign out of Notion in this browser.'));

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Notion'),
          h('p', { class: 'muted' }, 'The pages of a Notion database become tasks in the project you pick. When a page changes in Notion, its task follows; what you change on the board is kept, and nothing is written back to Notion.')),
        h('div', { class: 'row' }, badge(signedIn && linked ? `${linked} database${linked === 1 ? '' : 's'}` : 'Not set', signedIn && linked ? 'done' : 'plain'))),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          h('p', { class: 'muted small' }, 'Set up one of the three ways to sign in below: an integration secret if you can create an integration in the workspace, otherwise Sign in with Notion or the browser session. Then copy each database’s link (⋯ → Copy link), add it under Databases and pick its project; it is read with the first way that can open it.'),
          h('p', { class: 'muted small' }, 'The title becomes the task. A Status (or a Done checkbox) sets its status, the first date (Due or Deadline first) its deadline, and a Priority select its priority. The first read skips pages already done.')),
        notice({ tone: 'info', text: 'Notion’s API does not answer web pages, so the runners read it: start the board with bun start. They read every database every few minutes (Settings → Runners).' }),
        tokenForm,
        oauthForm,
        sessionForm)),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Databases'), h('p', { class: 'muted' }, 'Each database feeds one project. Removing one keeps the tasks it made.'))),
      h('div', { class: 'stack' },
        addForm,
        result('add'),
        h('ul', { class: 'resend-list' },
          cfg.links.length
            ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Database'), h('span', null, 'Project'), h('span')),
                ...cfg.links.map((l) => linkRow(store, l, projects))]
            : [h('li', { class: 'empty' }, 'No database linked yet.')]))));
}
