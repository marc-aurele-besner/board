// Inbox: every email sent and received through Resend, for every project that has a key, in one list.
import { h, icon, refreshIcon, notice, statusOf } from '../ui.js';
import { projectIcon, projectTree } from './projects.js';
import { setupBanner } from '../integrations.js';
import { syncInbox, readEmail, keyedProjects } from '../resend.js';
import { makeTask } from '../capture.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';

const COLLECTION = 'inbox';
const STEP = 100;
const DIRS = [['all', 'All'], ['received', 'Received'], ['sent', 'Sent']];
// Resend's last event of a sent email, and the tone it is shown in.
const STATUS = {
  delivered: ['Delivered', 'done'],
  opened: ['Opened', 'doing'],
  clicked: ['Clicked', 'doing'],
  bounced: ['Bounced', 'high'],
  complained: ['Spam report', 'high'],
  failed: ['Failed', 'high'],
  canceled: ['Canceled', 'plain'],
  delivery_delayed: ['Delayed', 'medium'],
  sent: ['Sent', 'plain'],
  queued: ['Queued', 'plain'],
  scheduled: ['Scheduled', 'plain'],
};

// View state. open: an email to open once it is on screen (from a link in a task).
const view = { dir: 'all', project: 'all', status: 'all', flagged: false, query: '', limit: STEP, open: '' };
// The last read: whether one runs now, and what failed.
const read = { busy: false, errors: [], asked: false };

const statusLabel = (s) => STATUS[s]?.[0] ?? s.replace(/_/g, ' ');
const nameOf = (address) => address.replace(/\s*<[^>]*>\s*$/, '').replace(/^"|"$/g, '').trim() || address.replace(/[<>]/g, '');
const counterparty = (e) => (e.dir === 'sent' ? (e.to.length > 1 ? `${nameOf(e.to[0])} +${e.to.length - 1}` : nameOf(e.to[0] ?? '')) : nameOf(e.from));

function dateOf(at) {
  if (!at) return '';
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', ...(d.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }) });
}
const fullDate = (at) => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');

const taskOf = (store, e) => (e.taskId ? store.get('todos').items.find((t) => t.id === e.taskId) ?? null : null);

function refresh(store) {
  if (read.busy) return;
  read.busy = true;
  read.asked = true;
  store.refresh();
  syncInbox(store)
    .then(({ added, errors }) => {
      read.errors = errors;
      if (added) toast(`${added} new email${added === 1 ? '' : 's'}`);
    })
    .catch((err) => {
      read.errors = [{ projectIds: [], text: err.message }];
    })
    .finally(() => {
      read.busy = false;
      store.refresh();
    });
}

// Text for a task description: the plain part of the email, or its HTML read as text.
function plainText(body) {
  const text = body.text || new DOMParser().parseFromString(body.html || '', 'text/html').body.textContent || '';
  const clean = text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return clean.length > 800 ? `${clean.slice(0, 800)}…` : clean;
}

// A task from an email, filled in for its project and editable before it is added. The email keeps the task's id.
function openTaskDialog(store, e) {
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const head = `${e.dir === 'sent' ? `Sent to ${e.to.join(', ')}` : `From ${e.from}`} · ${fullDate(e.at)}`;
  const description = h('textarea', { name: 'description', rows: 6 }, head);
  let edited = false;
  description.addEventListener('input', () => {
    edited = true;
  });
  // The body arrives after the dialog opens; it is added unless the description was already changed.
  readEmail(store, e)
    .then((body) => {
      const text = plainText(body);
      if (!edited && text) description.value = `${head}\n\n${text}`;
    })
    .catch(() => {});

  const dialog = openDialog({
    title: 'Create a task from this email',
    body: h('form', {
      class: 'stack',
      onsubmit: (ev) => {
        ev.preventDefault();
        const f = new FormData(ev.currentTarget);
        const title = String(f.get('text') ?? '').trim();
        if (!title) return;
        const projectId = f.get('project') || null;
        const task = makeTask({
          text: title,
          description: String(f.get('description') ?? '').trim(),
          projectId,
          priority: String(f.get('priority')),
          due: String(f.get('due') ?? ''),
          email: { id: e.id, dir: e.dir },
        });
        store.update('todos', (d) => d.items.push(task));
        store.update(COLLECTION, (d) => {
          const row = d.emails.find((x) => x.id === e.id);
          if (row) row.taskId = task.id;
        });
        dialog.close();
        toast(`Task added to ${projects.find((x) => x.id === projectId)?.name ?? 'Personal'}`);
      },
    },
      h('label', null, 'Task', h('input', { name: 'text', value: e.dir === 'received' ? `Reply: ${e.subject}` : `Follow up: ${e.subject}`, required: true, autocomplete: 'off' })),
      h('label', null, 'Description', description),
      h('div', { class: 'row' },
        h('label', null, 'Project', h('select', { name: 'project' },
          h('option', { value: '' }, 'Personal'),
          projects.map((x) => h('option', { value: x.id, selected: x.id === e.projectId }, x.name)))),
        h('label', null, 'Priority', h('select', { name: 'priority' },
          [['none', 'No priority'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']].map(([v, l]) => h('option', { value: v, selected: v === 'medium' }, l)))),
        h('label', null, 'Due', h('input', { name: 'due', type: 'date' }))),
      h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Create task'))),
  });
}

// The task of an email as a link, or a button that makes one.
function taskControl(store, e, onCreate = () => openTaskDialog(store, e), label = false) {
  const task = taskOf(store, e);
  if (task) {
    const done = statusOf(task) === 'done';
    return h('a', {
      href: `#/todos?filter=${task.projectId ?? 'personal'}${done ? '&status=all' : ''}`,
      class: done ? 'issue-link mail-task done' : 'issue-link mail-task',
      title: `${done ? 'Done' : 'Open'} task: ${task.text}`,
    }, icon('check-square'), done ? 'Done' : 'Task');
  }
  return label
    ? h('button', { type: 'button', class: 'btn-small', onclick: onCreate }, icon('check-square'), 'Create task')
    : h('button', { type: 'button', class: 'icon-btn mail-flag', title: 'Create a task from this email', 'aria-label': `Create a task from “${e.subject}”`, onclick: onCreate }, icon('check-square'));
}

// HTML mail is shown in a sandboxed frame: no scripts, nothing read from this page, links open in a new tab.
function htmlFrame(html) {
  const head = '<!doctype html><meta charset="utf-8">'
    + '<meta http-equiv="Content-Security-Policy" content="default-src \'none\'; img-src https: http: data:; style-src \'unsafe-inline\' https:; font-src https: data:">'
    + '<base target="_blank">';
  return h('iframe', { class: 'mail-frame', sandbox: 'allow-popups allow-popups-to-escape-sandbox', srcdoc: head + html, title: 'Email content' });
}

function openReader(store, e) {
  const project = store.get('projects').projects.find((p) => p.id === e.projectId);
  const content = h('div', { class: 'mail-body muted' }, 'Loading the email…');
  const meta = (label, value) => (value ? h('div', { class: 'mail-meta-row' }, h('span', { class: 'muted' }, label), h('span', null, value)) : null);
  const dialog = openDialog({
    title: e.subject || '(no subject)',
    wide: true,
    body: h('div', { class: 'stack' },
      h('div', { class: 'mail-meta' },
        meta('From', e.from),
        meta('To', e.to.join(', ')),
        meta('Cc', e.cc.join(', ')),
        meta('Date', fullDate(e.at)),
        meta('Project', project?.name),
        e.status ? meta('Status', statusLabel(e.status)) : null),
      h('div', { class: 'row end' }, taskControl(store, e, () => {
        dialog.close();
        openTaskDialog(store, e);
      }, true)),
      content),
  });
  readEmail(store, e)
    .then((body) => {
      content.className = 'mail-body';
      content.replaceChildren(body.html ? htmlFrame(body.html) : body.text ? h('pre', { class: 'mail-text' }, body.text) : h('p', { class: 'muted' }, 'This email has no content.'));
    })
    .catch((err) => content.replaceChildren(notice({ text: `The email could not be read: ${err.message}` })));
}

function matches(e, q) {
  if (!q) return true;
  return [e.subject, e.from, ...e.to, ...e.cc].some((s) => s.toLowerCase().includes(q));
}

function rowEl(store, e, projects) {
  const project = projects.get(e.projectId);
  const [, tone] = STATUS[e.status] ?? ['', 'plain'];
  return h('li', { class: 'mail-row' },
    h('button', { type: 'button', class: 'mail-open', onclick: () => openReader(store, e) },
      h('span', { class: `mail-dir ${e.dir}`, title: e.dir === 'sent' ? 'Sent' : 'Received' }, icon(e.dir === 'sent' ? 'send' : 'inbox')),
      project ? projectIcon(project) : null,
      h('span', { class: 'mail-main' },
        h('span', { class: 'mail-who' }, counterparty(e), project ? h('span', { class: 'muted small' }, ` · ${project.name}`) : null),
        h('span', { class: 'mail-subject' }, e.subject || '(no subject)')),
      e.status ? h('span', { class: `pill tone-${tone}` }, statusLabel(e.status)) : null,
      h('span', { class: 'mail-date muted small', title: fullDate(e.at) }, dateOf(e.at))),
    taskControl(store, e));
}

function draw(root, store) {
  const keyed = keyedProjects(store);
  const projects = new Map(store.get('projects').projects.map((p) => [p.id, p]));
  const { emails, syncedAt } = store.get(COLLECTION);
  // Read once on the first visit of the session; afterwards only when asked.
  if (keyed.length && !read.asked) setTimeout(() => refresh(store), 0);

  const byProject = emails.filter((e) => view.project === 'all' || e.projectId === view.project);
  const byDir = byProject.filter((e) => view.dir === 'all' || e.dir === view.dir);
  const statuses = [...new Set(byDir.map((e) => e.status).filter(Boolean))];
  const filtered = byDir.filter((e) => (view.status === 'all' || e.status === view.status) && (!view.flagged || taskOf(store, e)));

  const list = h('ul', { class: 'mail-list' });
  const more = h('div', { class: 'row end' });
  const paint = () => {
    const q = view.query.trim().toLowerCase();
    const shown = filtered.filter((e) => matches(e, q));
    list.replaceChildren(...(shown.length
      ? shown.slice(0, view.limit).map((e) => rowEl(store, e, projects))
      : [h('li', { class: 'empty' }, emails.length ? 'No email matches these filters.' : read.busy ? 'Reading your emails…' : 'No emails yet.')]));
    more.replaceChildren(...(shown.length > view.limit
      ? [h('button', { type: 'button', class: 'btn-small', onclick: () => { view.limit += STEP; paint(); } }, `Show more (${shown.length - view.limit} left)`)]
      : []));
  };
  paint();

  if (view.open) {
    const target = emails.find((e) => e.id === view.open);
    if (target) {
      view.open = '';
      setTimeout(() => openReader(store, target), 0);
    }
  }

  const set = (patch) => {
    Object.assign(view, patch, { limit: STEP });
    store.refresh();
  };
  const chip = (active, label, count, onclick) =>
    h('button', { type: 'button', class: active ? 'lp-chip active' : 'lp-chip', 'aria-pressed': String(active), onclick }, label, h('span', { class: 'chip-count' }, count));
  const nameOfProject = (id) => projects.get(id)?.name ?? 'a project';
  const flaggedCount = byDir.filter((e) => taskOf(store, e)).length;

  root.replaceChildren(h('div', { class: 'stack-lg inbox' },
    h('div', { class: 'row between' },
      h('div', null,
        h('h2', null, 'Inbox'),
        h('p', { class: 'muted small' },
          `Emails sent and received through Resend, for ${keyed.length} project${keyed.length === 1 ? '' : 's'}.`,
          syncedAt ? ` Read ${dateOf(syncedAt)}.` : '')),
      h('button', { type: 'button', class: 'btn-small', disabled: read.busy || !keyed.length, onclick: () => refresh(store) },
        refreshIcon(read.busy), read.busy ? 'Reading…' : 'Refresh')),

    keyed.length ? null : setupBanner('resend', 'Add a Resend API key to a project to see its emails here.'),
    read.errors.map((err) => notice({
      text: err.projectIds.length ? `${err.projectIds.map(nameOfProject).join(', ')}: ${err.text}` : err.text,
    })),

    keyed.length || emails.length
      ? h('div', { class: 'stack' },
          h('div', { class: 'row between' },
            h('div', { class: 'row lp-filters' },
              DIRS.map(([key, label]) => chip(view.dir === key, label, key === 'all' ? byProject.length : byProject.filter((e) => e.dir === key).length, () => set({ dir: key, status: 'all' }))),
              chip(view.flagged, 'With a task', flaggedCount, () => set({ flagged: !view.flagged }))),
            h('div', { class: 'row inbox-pickers' },
              keyed.length > 1
                ? h('select', { 'aria-label': 'Project', onchange: (ev) => set({ project: ev.target.value }) },
                    h('option', { value: 'all' }, 'All projects'),
                    keyed.map((p) => h('option', { value: p.id, selected: view.project === p.id }, p.name)))
                : null,
              statuses.length
                ? h('select', { 'aria-label': 'Status', onchange: (ev) => set({ status: ev.target.value }) },
                    h('option', { value: 'all' }, 'Any status'),
                    statuses.map((s) => h('option', { value: s, selected: view.status === s }, statusLabel(s))))
                : null)),
          h('input', {
            type: 'search',
            class: 'inbox-search',
            placeholder: 'Search subject or address',
            value: view.query,
            'aria-label': 'Search emails',
            // Only the list is redrawn, so the field keeps focus while typing.
            oninput: (ev) => {
              view.query = ev.target.value;
              view.limit = STEP;
              paint();
            },
          }),
          h('section', { class: 'card inbox-card' }, list),
          more)
      : null));
}

export default {
  id: 'inbox',
  title: 'Inbox',
  icon: 'mail',
  collection: COLLECTION,
  defaults: { emails: [], syncedAt: '' },
  render: draw,
  serialize: () => ({
    dir: view.dir === 'all' ? '' : view.dir,
    project: view.project === 'all' ? '' : view.project,
    status: view.status === 'all' ? '' : view.status,
    flagged: view.flagged ? '1' : '',
    email: view.open,
  }),
  restore: (p = {}) => {
    view.dir = DIRS.some(([k]) => k === p.dir) ? p.dir : 'all';
    view.project = p.project || 'all';
    view.status = p.status || 'all';
    view.flagged = p.flagged === '1';
    view.open = p.email || '';
    view.limit = STEP;
  },
};
