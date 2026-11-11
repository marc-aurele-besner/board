// Inbox: every email sent and received through Resend and Gmail, for every project that has a key or an account.
// Laid out like a mail client: received mail lands in the Inbox; sent, starred and archived mail have their own folders.
import { h, icon, refreshIcon, notice, statusOf } from '../ui.js';
import { projectIcon, projectTree, labelsOf, labelColor, underLabel } from './projects.js';
import { setupBanner, settingsHref } from '../integrations.js';
import { syncInbox, readEmail, keyedProjects } from '../resend.js';
import { syncGmail, readGmail, gmailAccounts, gmailProjects, connectGmail, isGmailConnected } from '../gmail.js';
import { makeTask } from '../capture.js';
import { pickChip } from '../inline.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';

const COLLECTION = 'inbox';
const STEP = 100;
// [key, label, icon, which emails it holds]
const FOLDERS = [
  ['inbox', 'Inbox', 'inbox', (e) => e.dir === 'received' && !e.archived],
  ['starred', 'Starred', 'star', (e) => e.starred],
  ['sent', 'Sent', 'send', (e) => e.dir === 'sent'],
  ['archive', 'Archive', 'archive', (e) => e.archived],
  ['all', 'All mail', 'mail', () => true],
];
const EMPTY = {
  inbox: 'Nothing new in the Inbox.',
  starred: 'No starred emails. Star one to keep it at hand.',
  sent: 'No sent emails.',
  archive: 'Nothing archived. Archiving takes an email out of the Inbox without deleting it.',
  all: 'No emails yet.',
};
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
const view = { folder: 'inbox', project: 'all', mailbox: 'all', status: 'all', flagged: false, query: '', limit: STEP, open: '' };
// The last read: whether one runs now, what failed, and which Gmail accounts need a sign-in first.
const read = { busy: false, errors: [], waiting: [], asked: false };

// The body of an email, from the service it came through.
const readBody = (store, e) => (e.source === 'gmail' ? readGmail(e) : readEmail(store, e));
// "resend" or a Gmail address: the mailbox an email was read from.
const mailboxOf = (e) => (e.source === 'gmail' ? e.account : 'resend');

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

// Emails of one conversation share a project and a subject, once "Re:" and "Fwd:" are taken off.
const topicOf = (subject) => subject.replace(/^\s*((re|fwd?|aw|tr)\s*(\[\d+\])?\s*:\s*)+/i, '').trim().toLowerCase();
const threadKey = (e) => (topicOf(e.subject) ? `${e.projectId}|${topicOf(e.subject)}` : `${e.projectId}|#${e.id}`);
function threadsOf(emails) {
  const map = new Map();
  for (const e of emails) {
    const key = threadKey(e);
    map.set(key, [...(map.get(key) ?? []), e]);
  }
  return map;
}

// Sets fields on saved emails, by id.
function patch(store, ids, fields) {
  const set = new Set(ids);
  store.update(COLLECTION, (d) => {
    for (const e of d.emails) if (set.has(e.id)) Object.assign(e, fields);
  });
}
function archive(store, e, archived) {
  patch(store, [e.id], { archived });
  toast(archived ? 'Archived' : 'Moved to the Inbox', { undo: () => patch(store, [e.id], { archived: !archived }) });
}
const current = (store, e) => store.get(COLLECTION).emails.find((x) => x.id === e.id) ?? e;

// "Today", "Yesterday", "This week", "This month", then month and year.
function groupOf(at) {
  if (!at) return 'Undated';
  const d = new Date(at);
  const today = new Date();
  const days = Math.floor((new Date(today.toDateString()) - new Date(d.toDateString())) / 86400000);
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear()) return 'This month';
  return d.toLocaleDateString([], { month: 'long', year: 'numeric' });
}

const taskOf = (store, e) => (e.taskId ? store.get('todos').items.find((t) => t.id === e.taskId) ?? null : null);

function refresh(store) {
  if (read.busy) return;
  read.busy = true;
  read.asked = true;
  store.refresh();
  const both = async () => {
    const resend = keyedProjects(store).length ? await syncInbox(store) : { added: 0, errors: [] };
    const gmail = gmailAccounts(store).length ? await syncGmail(store) : { added: 0, errors: [], waiting: [] };
    return { added: resend.added + gmail.added, errors: [...resend.errors, ...gmail.errors], waiting: gmail.waiting };
  };
  both()
    .then(({ added, errors, waiting }) => {
      read.errors = errors;
      read.waiting = waiting;
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

// Signs in to a Gmail account from a click, then reads the mail again.
function connectAndRead(store, address, after = () => refresh(store)) {
  const clientId = store.get('settings').google?.clientId ?? '';
  connectGmail(clientId, address)
    .then(after)
    .catch((err) => toast(err.message));
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
  readBody(store, e)
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

function starButton(store, e, after = () => {}) {
  return h('button', {
    type: 'button',
    class: e.starred ? 'icon-btn mail-star on' : 'icon-btn mail-star',
    title: e.starred ? 'Starred' : 'Not starred',
    'aria-label': e.starred ? `Unstar “${e.subject}”` : `Star “${e.subject}”`,
    'aria-pressed': String(Boolean(e.starred)),
    onclick: () => {
      patch(store, [e.id], { starred: !e.starred });
      after();
    },
  }, icon('star'));
}

function openReader(store, e) {
  if (e.unread) patch(store, [e.id], { unread: false });
  const project = store.get('projects').projects.find((p) => p.id === e.projectId);
  const content = h('div', { class: 'mail-body muted' }, 'Loading the email…');
  const meta = (label, value) => (value ? h('div', { class: 'mail-meta-row' }, h('span', { class: 'muted' }, label), h('span', null, value)) : null);
  // The buttons read the saved email again after each change, since the dialog is not redrawn with the page.
  const actions = h('div', { class: 'row between mail-actions' });
  const paintActions = () => {
    const now = current(store, e);
    actions.replaceChildren(
      h('div', { class: 'row' },
        starButton(store, now, paintActions),
        now.dir === 'received'
          ? h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                dialog.close();
                archive(store, now, !now.archived);
              },
            }, icon(now.archived ? 'inbox' : 'archive'), now.archived ? 'Move to Inbox' : 'Archive')
          : null,
        now.dir === 'received'
          ? h('button', {
              type: 'button',
              class: 'btn-small',
              onclick: () => {
                patch(store, [now.id], { unread: true });
                dialog.close();
              },
            }, icon('mail'), 'Mark unread')
          : null),
      taskControl(store, now, () => {
        dialog.close();
        openTaskDialog(store, now);
      }, true));
  };

  // The other emails of the conversation, sent and received, oldest first.
  const thread = store.get(COLLECTION).emails
    .filter((x) => x.id !== e.id && threadKey(x) === threadKey(e))
    .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));

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
        e.source === 'gmail' ? meta('Account', `${e.account} (Gmail)`) : null,
        e.status ? meta('Status', statusLabel(e.status)) : null),
      actions,
      content,
      thread.length
        ? h('section', { class: 'stack mail-thread' },
            h('h3', null, `In this conversation (${thread.length + 1})`),
            h('ul', { class: 'mail-list card' }, thread.map((x) => h('li', { class: 'mail-row' },
              h('button', {
                type: 'button',
                class: 'mail-open',
                onclick: () => {
                  dialog.close();
                  openReader(store, current(store, x));
                },
              },
                h('span', { class: `mail-dir ${x.dir}`, title: x.dir === 'sent' ? 'Sent' : 'Received' }, icon(x.dir === 'sent' ? 'send' : 'inbox')),
                h('span', { class: 'mail-main' },
                  h('span', { class: 'mail-who' }, x.dir === 'sent' ? `You to ${counterparty(x)}` : counterparty(x)),
                  h('span', { class: 'mail-subject' }, x.subject || '(no subject)')),
                h('span', { class: 'mail-date muted small', title: fullDate(x.at) }, dateOf(x.at)))))))
        : null),
  });
  paintActions();
  const load = () => readBody(store, e)
    .then((body) => {
      content.className = 'mail-body';
      content.replaceChildren(body.html ? htmlFrame(body.html) : body.text ? h('pre', { class: 'mail-text' }, body.text) : h('p', { class: 'muted' }, 'This email has no content.'));
    })
    .catch((err) => content.replaceChildren(notice({
      text: `The email could not be read: ${err.message}`,
      // A Gmail account signs in again from here, then the email loads.
      actions: e.source === 'gmail' && !isGmailConnected(e.account)
        ? [h('button', { type: 'button', class: 'btn-small', onclick: () => connectAndRead(store, e.account, load) }, `Connect ${e.account}`)]
        : [],
    })));
  load();
}

function matches(e, q) {
  if (!q) return true;
  return [e.subject, e.from, ...e.to, ...e.cc].some((s) => s.toLowerCase().includes(q));
}

function rowEl(store, e, projects, threadSize) {
  const project = projects.get(e.projectId);
  const [, tone] = STATUS[e.status] ?? ['', 'plain'];
  // Outside the Sent folder, a sent email says who it went to, as a mail client does.
  const who = e.dir === 'sent' && view.folder !== 'sent' ? `To: ${counterparty(e)}` : counterparty(e);
  return h('li', { class: e.unread ? 'mail-row unread' : 'mail-row' },
    starButton(store, e),
    h('button', { type: 'button', class: 'mail-open', onclick: () => openReader(store, e), 'aria-label': `${e.unread ? 'Unread. ' : ''}${who}: ${e.subject || '(no subject)'}` },
      view.folder === 'inbox' || view.folder === 'sent' ? null : h('span', { class: `mail-dir ${e.dir}`, title: e.dir === 'sent' ? 'Sent' : 'Received' }, icon(e.dir === 'sent' ? 'send' : 'inbox')),
      project ? projectIcon(project) : null,
      h('span', { class: 'mail-main' },
        h('span', { class: 'mail-who' }, who,
          threadSize > 1 ? h('span', { class: 'mail-count', title: `${threadSize} emails in this conversation` }, String(threadSize)) : null,
          project ? h('span', { class: 'muted small' }, ` · ${project.name}`) : null),
        h('span', { class: 'mail-subject' }, e.subject || '(no subject)')),
      e.archived && view.folder !== 'archive' ? h('span', { class: 'pill tone-plain' }, 'Archived') : null,
      e.status ? h('span', { class: `pill tone-${tone}` }, statusLabel(e.status)) : null,
      h('span', { class: 'mail-date muted small', title: fullDate(e.at) }, dateOf(e.at))),
    e.dir === 'received'
      ? h('button', {
          type: 'button',
          class: 'icon-btn mail-archive',
          title: e.archived ? 'Move to Inbox' : 'Archive',
          'aria-label': e.archived ? `Move “${e.subject}” to the Inbox` : `Archive “${e.subject}”`,
          onclick: () => archive(store, e, !e.archived),
        }, icon(e.archived ? 'inbox' : 'archive'))
      : null,
    taskControl(store, e));
}

function draw(root, store) {
  const accounts = gmailAccounts(store);
  const resendKeyed = keyedProjects(store);
  // Projects with a Resend key or a Gmail account, in project order.
  const withMail = new Set([...resendKeyed, ...gmailProjects(store)].map((p) => p.id));
  const keyed = store.get('projects').projects.filter((p) => withMail.has(p.id));
  const projects = new Map(store.get('projects').projects.map((p) => [p.id, p]));
  const { emails, syncedAt } = store.get(COLLECTION);
  // Read once on the first visit of the session; afterwards only when asked.
  // A Gmail account needs no project, so it counts on its own.
  const hasMail = keyed.length > 0 || accounts.length > 0;
  if (hasMail && !read.asked) setTimeout(() => refresh(store), 0);

  const folder = FOLDERS.find(([key]) => key === view.folder) ?? FOLDERS[0];
  const mailboxes = [...(resendKeyed.length || emails.some((e) => !e.source) ? [['resend', 'Resend']] : []), ...accounts.map((a) => [a.email, a.email])];
  if (!mailboxes.some(([key]) => key === view.mailbox)) view.mailbox = 'all';
  // The project filter is a project id, or "label:<id>" for a project label: Gmail mail can carry its account's label.
  const labels = store.get('projects').categories ?? [];
  const allProjects = store.get('projects').projects;
  const labelOfAccount = new Map(accounts.map((a) => [a.email, a.labelId ?? null]));
  const labelFilter = view.project.startsWith('label:') ? view.project.slice(6) : null;
  if (labelFilter && !labels.some((c) => c.id === labelFilter)) view.project = 'all';
  const inProject = (e) => view.project === 'all' ||
    (labelFilter ? underLabel(allProjects, e.projectId, e.source === 'gmail' ? labelOfAccount.get(e.account) ?? null : null, labelFilter) : e.projectId === view.project);
  const byProject = emails.filter((e) => inProject(e) && (view.mailbox === 'all' || mailboxOf(e) === view.mailbox));
  // Labels the filter offers: those of projects with mail, and those set on a Gmail account.
  const labelOptions = labels
    .filter((c) => keyed.some((p) => labelsOf(p).includes(c.id)) || accounts.some((a) => a.labelId === c.id))
    .map((c) => ({ value: `label:${c.id}`, label: c.name, color: labelColor(c) }));
  const threads = threadsOf(byProject);
  const inFolder = byProject.filter(folder[3]);
  const statuses = [...new Set(inFolder.map((e) => e.status).filter(Boolean))];
  const filtered = inFolder.filter((e) => (view.status === 'all' || e.status === view.status) && (!view.flagged || taskOf(store, e)));
  const unread = byProject.filter((e) => FOLDERS[0][3](e) && e.unread);

  const list = h('ul', { class: 'mail-list' });
  const more = h('div', { class: 'row end' });
  const paint = () => {
    const q = view.query.trim().toLowerCase();
    // A search looks through all mail, as in a mail client; the folder applies when the field is empty.
    const pool = q ? byProject.filter((e) => (view.status === 'all' || e.status === view.status) && (!view.flagged || taskOf(store, e))) : filtered;
    const shown = pool.filter((e) => matches(e, q));
    const rows = [];
    let group = '';
    for (const e of shown.slice(0, view.limit)) {
      const g = groupOf(e.at);
      if (g !== group) rows.push(h('li', { class: 'mail-group muted small' }, (group = g)));
      rows.push(rowEl(store, e, projects, threads.get(threadKey(e))?.length ?? 1));
    }
    list.replaceChildren(...(rows.length
      ? rows
      : [h('li', { class: 'empty' }, read.busy && !emails.length ? 'Reading your emails…' : q ? 'No email matches this search.' : view.flagged || view.status !== 'all' ? 'No email matches these filters.' : EMPTY[folder[0]])]));
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

  const set = (patchView) => {
    Object.assign(view, patchView, { limit: STEP });
    store.refresh();
  };
  const chip = (active, label, count, onclick, extra = {}) =>
    h('button', { type: 'button', class: active ? 'lp-chip active' : 'lp-chip', 'aria-pressed': String(active), onclick, ...extra }, label, count ? h('span', { class: 'chip-count' }, count) : null);
  const nameOfProject = (id) => projects.get(id)?.name ?? 'a project';
  const flaggedCount = inFolder.filter((e) => taskOf(store, e)).length;
  // The Inbox counts what is unread; the other folders count what they hold.
  const countOf = ([key, , , holds]) => (key === 'inbox' ? unread.length : byProject.filter(holds).length);

  root.replaceChildren(h('div', { class: 'stack-lg inbox' },
    h('div', { class: 'row between' },
      h('div', null,
        h('h2', null, 'Inbox'),
        h('p', { class: 'muted small' },
          `Emails sent and received through ${[resendKeyed.length ? 'Resend' : '', accounts.length ? 'Gmail' : ''].filter(Boolean).join(' and ') || 'Resend or Gmail'}, for ${keyed.length} project${keyed.length === 1 ? '' : 's'}.`,
          syncedAt ? ` Read ${dateOf(syncedAt)}.` : '')),
      h('button', { type: 'button', class: 'btn-small', disabled: read.busy || !hasMail, onclick: () => refresh(store) },
        refreshIcon(read.busy), read.busy ? 'Reading…' : 'Refresh')),

    hasMail ? null : setupBanner('resend', 'Add a Resend API key to a project, or a Gmail account, to see emails here.', {
      actions: [h('a', { href: settingsHref('gmail'), class: 'btn-small' }, 'Add a Gmail account')],
    }),
    // Gmail sign-ins last about an hour; an account not signed in this session waits for a click.
    read.waiting.filter((a) => !isGmailConnected(a)).length
      ? notice({
          tone: 'info',
          text: 'Connect these Gmail accounts to read their new mail. Mail read before stays here.',
          actions: read.waiting.filter((a) => !isGmailConnected(a)).map((a) =>
            h('button', { type: 'button', class: 'btn-small', onclick: () => connectAndRead(store, a) }, icon('mail'), a)),
        })
      : null,
    read.errors.map((err) => notice({
      text: err.projectIds.length ? `${err.projectIds.map(nameOfProject).join(', ')}: ${err.text}` : err.text,
    })),

    hasMail || emails.length
      ? h('div', { class: 'stack' },
          h('div', { class: 'row lp-filters inbox-folders', role: 'tablist', 'aria-label': 'Folders' },
            FOLDERS.map((f) => chip(view.folder === f[0], [icon(f[2]), f[1]], countOf(f), () => set({ folder: f[0], status: 'all' }), {
              role: 'tab',
              'aria-selected': String(view.folder === f[0]),
              title: f[0] === 'inbox' ? `${unread.length} unread` : undefined,
            }))),
          h('div', { class: 'row between' },
            h('div', { class: 'row lp-filters' },
              chip(view.flagged, 'With a task', flaggedCount, () => set({ flagged: !view.flagged })),
              view.folder === 'inbox' && unread.length
                ? h('button', { type: 'button', class: 'btn-small', onclick: () => patch(store, unread.map((e) => e.id), { unread: false }) }, icon('check'), 'Mark all read')
                : null),
            h('div', { class: 'row inbox-pickers' },
              keyed.length > 1 || labelOptions.length
                // Searchable, with each project's icon, since the list can grow long; project labels follow in their colours.
                ? pickChip({
                    value: view.project === 'all' ? null : view.project,
                    options: [...keyed.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })), ...labelOptions],
                    nullable: true,
                    nullLabel: 'All projects',
                    className: 'inbox-project-pick',
                    onPick: (v) => set({ project: v ?? 'all' }),
                  })
                : null,
              accounts.length && mailboxes.length > 1
                ? h('select', { 'aria-label': 'Mailbox', onchange: (ev) => set({ mailbox: ev.target.value }) },
                    h('option', { value: 'all' }, 'All mailboxes'),
                    mailboxes.map(([key, label]) => h('option', { value: key, selected: view.mailbox === key }, label)))
                : null,
              statuses.length
                ? h('select', { 'aria-label': 'Status', onchange: (ev) => set({ status: ev.target.value }) },
                    h('option', { value: 'all' }, 'Any status'),
                    statuses.map((s) => h('option', { value: s, selected: view.status === s }, statusLabel(s))))
                : null)),
          h('input', {
            type: 'search',
            class: 'inbox-search',
            placeholder: 'Search all mail by subject or address',
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

// Received emails in the Inbox not opened yet, for the Home page.
export const unreadCount = (store) => store.get(COLLECTION).emails.filter((e) => FOLDERS[0][3](e) && e.unread).length;

export default {
  id: 'inbox',
  title: 'Inbox',
  icon: 'mail',
  collection: COLLECTION,
  defaults: { emails: [], syncedAt: '' },
  render: draw,
  serialize: () => ({
    folder: view.folder === 'inbox' ? '' : view.folder,
    project: view.project === 'all' ? '' : view.project,
    mailbox: view.mailbox === 'all' ? '' : view.mailbox,
    status: view.status === 'all' ? '' : view.status,
    flagged: view.flagged ? '1' : '',
    email: view.open,
  }),
  restore: (p = {}) => {
    // Older links used dir=sent|received.
    view.folder = FOLDERS.some(([k]) => k === p.folder) ? p.folder : p.dir === 'sent' ? 'sent' : 'inbox';
    view.project = p.project || 'all';
    view.mailbox = p.mailbox || 'all';
    view.status = p.status || 'all';
    view.flagged = p.flagged === '1';
    view.open = p.email || '';
    view.limit = STEP;
  },
};
