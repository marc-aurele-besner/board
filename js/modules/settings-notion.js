// Settings → Notion: the integration's token, and which database feeds which project.
// Every call goes through the runners (see js/notion.js), which also read the databases on a schedule.
import { h, icon, uid, notice } from '../ui.js';
import { pickChip } from '../inline.js';
import { runJob } from '../runners.js';
import { notionSettings, checkNotion, readNotionDatabase } from '../notion.js';
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
      h('strong', { title: l.name }, link(`https://www.notion.so/${l.databaseId}`, l.name || 'Untitled database'))),
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
      if (!cfg.token) return say(store, 'add', 'Save the integration secret first.', false);
      say(store, 'add', 'Reading the database…');
      readNotionDatabase(cfg.token, raw)
        .then((db) => {
          if (notionSettings(store).links.some((l) => l.databaseId === db.id)) throw new Error(`${db.name} is already linked.`);
          /** @type {NotionLink} */
          const added = { id: uid(), databaseId: db.id, name: db.name, projectId: view.project, on: true };
          save(store, (c) => ({ ...c, links: [...c.links, added] }));
          const read = [db.fields.status && `status from “${db.fields.status}”`, db.fields.due && `deadline from “${db.fields.due}”`, db.fields.priority && `priority from “${db.fields.priority}”`].filter(Boolean);
          say(store, 'add', `Linked ${db.name}${read.length ? `: ${read.join(', ')}` : ''}.`);
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
    h('button', { class: 'primary', type: 'submit', disabled: !cfg.token }, 'Add'));

  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, 'Notion'),
          h('p', { class: 'muted' }, 'The pages of a Notion database become tasks in the project you pick. When a page changes in Notion, its task follows; what you change on the board is kept, and nothing is written back to Notion.')),
        h('div', { class: 'row' }, badge(cfg.token && linked ? `${linked} database${linked === 1 ? '' : 's'}` : 'Not set', cfg.token && linked ? 'done' : 'plain'))),
      h('div', { class: 'cred-body' },
        h('div', { class: 'svc-section' },
          h('h3', null, 'Setup'),
          h('ol', { class: 'steps' }, [
            ['Open ', link('https://www.notion.so/profile/integrations', 'Notion → Integrations'), ' and create an internal integration with Read content.'],
            'Copy its Internal Integration Secret, paste it here and save.',
            'In Notion, open each database, then ⋯ → Connections, and add the integration.',
            'Copy the database’s link (⋯ → Copy link), add it below and pick its project.',
          ].map((s) => h('li', null, h('span', { class: 'step-text' }, s)))),
          h('p', { class: 'muted small' }, 'The title becomes the task. A Status (or a Done checkbox) sets its status, the first date (Due or Deadline first) its deadline, and a Priority select its priority. The first read skips pages already done.')),
        notice({ tone: 'info', text: 'Notion’s API does not answer web pages, so the runners read it: start the board with bun start. They read every database every few minutes (Settings → Runners).' }),
        tokenForm)),
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
