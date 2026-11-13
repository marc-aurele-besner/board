// Settings → X / Twitter and Settings → LinkedIn: the accounts whose follower counts Monitoring → Socials follows,
// each tied to a project if wanted, and LinkedIn's signed-in session for company pages.
import { h, icon, uid, refreshIcon } from '../ui.js';
import { pickChip } from '../inline.js';
import { toast } from '../toast.js';
import { runJob } from '../runners.js';
import { SOCIALS, NETWORKS, parseHandle, profileUrl, handleLabel, isOrganization } from '../socials.js';
import { projectIcon, projectTree } from './projects.js';
/** @import { Store, SocialAccount, Project, LinkedinSettings } from '../../types/data' */

/** @param {string} text @param {string} tone */
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
/** @param {string} href @param {string} text */
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const count = new Intl.NumberFormat();

// Accounts being read now, so their row shows it. Shared with Monitoring → Socials.
/** @type {Set<string>} */
const reading = new Set();
/** @param {string} id */
export const isReading = (id) => reading.has(id);

// Asks the runners to read these accounts now (POST /run/socials), then reads socials.json again.
/** @param {Store} store @param {string[]} ids */
export function readNow(store, ids) {
  for (const id of ids) reading.add(id);
  store.refresh();
  runJob('socials', { ids })
    .catch((err) => toast(`Could not read the counts: ${/** @type {Error} */ (err).message}`))
    .finally(() => {
      for (const id of ids) reading.delete(id);
      store.sync();
    });
}

/** @param {SocialAccount} a */
function avatar(a) {
  return a.image
    ? h('img', { class: 'slack-team-icon slack-ws-icon', src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'social-avatar' }, icon(a.network === 'x' ? 'x-mark' : 'linkedin'));
}

/** @param {Store} store @param {SocialAccount} a @param {Project[]} projects */
function accountRow(store, a, projects) {
  const busy = reading.has(a.id);
  const counts = typeof a.followers === 'number'
    ? `${count.format(a.followers)} followers${typeof a.following === 'number' ? ` · ${count.format(a.following)} following` : ''}`
    : '';
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' },
      avatar(a),
      h('div', { class: 'slack-ws-name' },
        h('strong', { title: a.name || handleLabel(a) }, a.name || handleLabel(a)),
        h('span', { class: 'muted small' }, link(profileUrl(a), handleLabel(a)), isOrganization(a) ? ' · page' : '', counts ? ` · ${counts}` : ''))),
    h('div', { class: 'resend-key' },
      pickChip({
        value: a.projectId ?? null,
        options: projects.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
        nullable: true,
        nullLabel: 'No project',
        className: 'field-pick project-field-pick',
        onPick: (v) => store.update(SOCIALS, (d) => {
          const x = d.accounts.find((y) => y.id === a.id);
          if (x) x.projectId = v ?? null;
        }),
      }),
      a.error ? h('span', { class: 'resend-msg small error', role: 'status' }, a.error) : null),
    h('div', { class: 'resend-actions' },
      badge(a.error ? 'Not read' : a.at ? 'Read' : 'Waiting', a.error ? 'plain' : a.at ? 'done' : 'doing'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Read the counts now', 'aria-label': `Read ${handleLabel(a)} now`, disabled: busy, onclick: () => readNow(store, [a.id]) }, refreshIcon(busy)),
      h('button', {
        type: 'button',
        class: 'icon-btn',
        title: 'Remove account',
        'aria-label': `Remove ${handleLabel(a)}`,
        onclick: () => {
          const removed = store.get(SOCIALS).accounts.find((x) => x.id === a.id);
          const history = store.get(SOCIALS).history?.[a.id];
          store.update(SOCIALS, (d) => {
            d.accounts = d.accounts.filter((x) => x.id !== a.id);
            delete d.history[a.id];
          });
          toast(`Removed ${handleLabel(a)}`, {
            undo: () => store.update(SOCIALS, (d) => {
              if (removed) d.accounts.push(removed);
              if (history) d.history[a.id] = history;
            }),
          });
        },
      }, icon('x'))));
}

/** @param {Store} store @param {string} network */
function addForm(store, network) {
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  /** @type {string | null} */
  let projectId = null;
  const input = h('input', {
    name: 'handle',
    autocomplete: 'off',
    spellcheck: false,
    placeholder: network === 'x' ? '@name or https://x.com/name' : 'https://www.linkedin.com/in/name or /company/name',
    'aria-label': network === 'x' ? 'X handle or profile link' : 'LinkedIn profile or page link',
  });
  const status = h('p', { class: 'small muted', role: 'status' });
  return h('form', {
    class: 'svc-section',
    onsubmit: (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      const handle = parseHandle(network, input.value);
      if (!handle) {
        status.textContent = network === 'x' ? 'That is not an X handle: up to 15 letters, digits or _.' : 'Paste a linkedin.com/in/… or linkedin.com/company/… link.';
        return;
      }
      const have = store.get(SOCIALS).accounts.find((a) => a.network === network && a.handle.toLowerCase() === handle.toLowerCase());
      if (have) {
        status.textContent = `${handleLabel(have)} is already here.`;
        return;
      }
      const id = uid();
      store.update(SOCIALS, (d) => {
        d.accounts.push({ id, network, handle, projectId });
      });
      readNow(store, [id]);
    },
  },
    h('h3', null, 'Add an account'),
    h('div', { class: 'resend-edit' },
      input,
      pickChip({
        value: null,
        options: projects.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
        nullable: true,
        nullLabel: 'No project',
        placeholder: 'Project',
        className: 'field-pick project-field-pick',
        onPick: (v) => {
          projectId = v ?? null;
        },
      }),
      h('button', { type: 'submit', class: 'primary' }, 'Add')),
    status);
}

/** @param {Store} store */
function linkedinSession(store) {
  const saved = /** @type {LinkedinSettings} */ (store.get('settings').linkedin ?? {});
  const set = Boolean(saved.liAt && saved.jsessionid);
  const liAt = h('input', { name: 'liAt', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'AQEDA…', value: saved.liAt ?? '', 'aria-label': 'li_at cookie' });
  const jsession = h('input', { name: 'jsessionid', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'ajax:123…', value: saved.jsessionid ?? '', 'aria-label': 'JSESSIONID cookie' });
  /** @param {LinkedinSettings} value */
  const save = (value) => {
    store.update('settings', (d) => {
      d.linkedin = value;
    });
    const pages = store.get(SOCIALS).accounts.filter((a) => a.network === 'linkedin' && (isOrganization(a) || a.error)).map((a) => a.id);
    if (pages.length && value.liAt) readNow(store, pages);
  };
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Signed-in session'),
        h('p', { class: 'muted' }, 'A person’s public profile shows its followers to anyone. LinkedIn shows company pages only when signed in, so the runners read those with your browser’s session, as the site does.')),
      h('div', { class: 'row' }, badge(set ? 'Saved' : 'Not set', set ? 'done' : 'plain'))),
    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        h('ol', { class: 'steps' },
          h('li', null, h('span', { class: 'step-text' }, 'Sign in at ', link('https://www.linkedin.com/feed/', 'linkedin.com'), ' in Chrome.')),
          h('li', null, h('span', { class: 'step-text' }, 'Open the developer tools (⌥⌘I on a Mac, Ctrl+Shift+I elsewhere), then Application → Cookies → https://www.linkedin.com.')),
          h('li', null, h('span', { class: 'step-text' }, 'Copy the value of ', h('code', null, 'li_at'), ' and of ', h('code', null, 'JSESSIONID'), ' (it starts with ', h('code', null, 'ajax:'), ') into the fields below.')))),
      h('form', {
        class: 'svc-section stack-sm',
        onsubmit: (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          save({ liAt: liAt.value.trim(), jsessionid: jsession.value.trim().replace(/"/g, '') });
          toast('LinkedIn session saved');
        },
      },
        h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'li_at'), liAt),
        h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'JSESSIONID'), jsession),
        h('p', { class: 'muted small' }, 'Saved in settings.json in your data folder and sent only to LinkedIn, from the runners on this machine. Signing out of LinkedIn in the browser ends the session here too.'),
        h('div', { class: 'svc-actions' },
          h('button', { class: 'primary', type: 'submit' }, 'Save'),
          set ? h('button', { type: 'button', class: 'danger', onclick: () => save({}) }, icon('x'), 'Clear') : null))));
}

/** @param {Store} store @param {'x' | 'linkedin'} network */
export function socialsCard(store, network) {
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const accounts = store.get(SOCIALS).accounts.filter((a) => a.network === network);
  const name = network === 'x' ? 'X / Twitter' : NETWORKS[network];
  const intro = network === 'x'
    ? 'Monitoring → Socials follows the followers of each account here over time. X shows the counts of a public profile to anyone, so no key or sign-in is needed: the runners read each profile’s page every few hours.'
    : 'Monitoring → Socials follows the followers of each profile and company page here over time. The runners read them every few hours.';
  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null, h('h2', null, name), h('p', { class: 'muted' }, intro)),
        h('div', { class: 'row' }, badge(accounts.length ? `${accounts.length} account${accounts.length === 1 ? '' : 's'}` : 'Not set', accounts.length ? 'doing' : 'plain'))),
      h('div', { class: 'cred-body' }, addForm(store, network))),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Accounts'),
          h('p', { class: 'muted' }, 'A project ties an account to it in Monitoring. Removing an account removes its history from the board.')),
        accounts.length ? h('button', { type: 'button', class: 'btn-small', onclick: () => readNow(store, accounts.map((a) => a.id)) }, 'Read all now') : null),
      h('ul', { class: 'resend-list' },
        accounts.length
          ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Account'), h('span', null, 'Project'), h('span')),
              ...accounts.map((a) => accountRow(store, a, projects))]
          : [h('li', { class: 'empty' }, `No ${NETWORKS[network]} account yet.`)])),
    network === 'linkedin' ? linkedinSession(store) : null);
}
