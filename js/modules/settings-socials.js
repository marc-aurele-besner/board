// Settings → X / Twitter, LinkedIn, GitHub and Instagram accounts: the accounts whose follower counts (and GitHub stars)
// Monitoring → Socials follows, each tied to a project if wanted, and LinkedIn's signed-in session for company pages.
import { h, icon, uid, refreshIcon, copyable, notice } from '../ui.js';
import { pickChip } from '../inline.js';
import { toast } from '../toast.js';
import { runJob, runnersOnline, runnersKnown } from '../runners.js';
import { LINKEDIN, signedIn } from '../linkedin-core.js';
import { linkedinApp, linkedinRedirect, linkedinSignIn, linkedinSignOut } from '../linkedin.js';
import { SOCIALS, NETWORKS, networkIcon, parseHandle, profileUrl, handleLabel, isOrganization } from '../socials.js';
import { projectIcon, projectTree } from './projects.js';
import { sessionState } from '../linkedin-session.js';
import { dateLocale, numberLocale } from '../locale.js';
/** @import { Store, SocialAccount, Project, LinkedinSettings } from '../../types/data' */

/** @param {string} text @param {string} tone */
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);
/** @param {string} href @param {string} text */
const link = (href, text) => h('a', { href, target: '_blank', rel: 'noopener noreferrer' }, text);
const count = { format: (/** @type {number} */ n) => n.toLocaleString(numberLocale()) };

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
    : h('span', { class: 'social-avatar' }, icon(networkIcon(a.network)));
}

/** @param {Store} store @param {SocialAccount} a @param {Project[]} projects */
function accountRow(store, a, projects) {
  const busy = reading.has(a.id);
  const counts = typeof a.followers === 'number'
    ? `${count.format(a.followers)} followers${typeof a.following === 'number' ? ` · ${count.format(a.following)} following` : ''}${typeof a.stars === 'number' ? ` · ${count.format(a.stars)} stars` : ''}`
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
    placeholder: network === 'x' ? '@name or https://x.com/name'
      : network === 'github' ? 'name or https://github.com/name'
        : network === 'instagram' ? '@name or https://www.instagram.com/name'
          : 'https://www.linkedin.com/in/name or /company/name',
    'aria-label': network === 'x' ? 'X handle or profile link' : network === 'github' ? 'GitHub user or organization'
      : network === 'instagram' ? 'Instagram username or profile link' : 'LinkedIn profile or page link',
  });
  const status = h('p', { class: 'small muted', role: 'status' });
  return h('form', {
    class: 'svc-section',
    onsubmit: (/** @type {SubmitEvent} */ e) => {
      e.preventDefault();
      const handle = parseHandle(network, input.value);
      if (!handle) {
        status.textContent = network === 'x' ? 'That is not an X handle: up to 15 letters, digits or _.'
          : network === 'github' ? 'That is not a GitHub login: up to 39 letters, digits or -.'
            : network === 'instagram' ? 'That is not an Instagram username: up to 30 letters, digits, _ or .'
              : 'Paste a linkedin.com/in/… or linkedin.com/company/… link.';
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

// The sign-in status line of the Publish as you card, kept across re-renders.
const publish = { text: '', ok: true };

// Settings → LinkedIn → Publish as you: the member's own developer app and its official sign-in, which posts.
/** @param {Store} store */
function publishCard(store) {
  const app = linkedinApp(store);
  const auth = store.get(LINKEDIN).auth;
  const live = signedIn(auth);
  const offline = runnersKnown() && !runnersOnline();
  /** @param {string} text @param {boolean} [ok] */
  const say = (text, ok = true) => {
    publish.text = text;
    publish.ok = ok;
    store.refresh();
  };
  const clientId = h('input', { name: 'clientId', autocomplete: 'off', spellcheck: false, placeholder: 'Client ID', value: app.clientId ?? '', 'aria-label': 'Client ID' });
  const clientSecret = h('input', { name: 'clientSecret', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'Client Secret', value: app.clientSecret ?? '', 'aria-label': 'Client Secret' });
  const ends = auth ? new Date(auth.expires).toLocaleDateString(dateLocale(), { year: 'numeric', month: 'short', day: 'numeric' }) : '';
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Publish as you'),
        h('p', { class: 'muted' }, 'Posts written in the board go out as you, through LinkedIn’s official API and a developer app of your own. Its sign-in lasts 60 days; the board reminds you a week before it ends.')),
      h('div', { class: 'row' }, badge(live ? 'Signed in' : auth ? 'Expired' : 'Not signed in', live ? 'done' : 'plain'))),
    h('div', { class: 'cred-body' },
      auth ? h('div', { class: 'svc-section' },
        h('div', { class: 'resend-name' },
          auth.picture
            ? h('img', { class: 'slack-team-icon slack-ws-icon', src: auth.picture, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
            : h('span', { class: 'social-avatar' }, icon('linkedin')),
          h('div', { class: 'slack-ws-name' },
            h('strong', null, auth.name || 'LinkedIn member'),
            h('span', { class: 'muted small' }, live ? `Signed in until ${ends}` : `The sign-in ended on ${ends}. Sign in again to post.`))),
        h('div', { class: 'svc-actions' },
          h('button', { type: 'button', class: 'danger', onclick: () => linkedinSignOut(store) }, icon('x'), 'Sign out'))) : null,
      h('div', { class: 'svc-section' },
        h('h3', null, 'Setup'),
        h('ol', { class: 'steps' }, [
          ['Create an app at ', link('https://www.linkedin.com/developers/apps', 'LinkedIn Developers'), ' (it asks for a company page; any page you admin will do).'],
          'Under Products, add “Sign In with LinkedIn using OpenID Connect” and “Share on LinkedIn”.',
          ['Under Auth → Authorized redirect URLs, add ', copyable(linkedinRedirect())],
          'Copy the Client ID and Client Secret from Auth into the fields below, save, then sign in.',
        ].map((s) => h('li', null, h('span', { class: 'step-text' }, s))))),
      h('form', {
        class: 'svc-section stack-sm',
        onsubmit: (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          store.update('settings', (d) => {
            d.linkedin = { ...d.linkedin, clientId: clientId.value.trim(), clientSecret: clientSecret.value.trim() };
          });
          say('Saved.');
        },
      },
        h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'Client ID'), clientId),
        h('label', { class: 'stack-sm' }, h('span', { class: 'small' }, 'Client Secret'), clientSecret),
        h('p', { class: 'muted small' }, 'Saved in settings.json in your data folder. The runners on this machine send them to LinkedIn to finish the sign-in, since LinkedIn’s token endpoint does not answer a browser.'),
        offline ? h('p', { class: 'small error', role: 'status' }, 'The runners are not running, so the sign-in cannot finish and posts cannot go out. Start the board with bun start.') : null,
        h('div', { class: 'svc-actions' },
          h('button', { type: 'submit' }, 'Save'),
          h('button', {
            type: 'button',
            class: 'primary',
            disabled: !app.clientId || !app.clientSecret,
            onclick: () => {
              say('Waiting for LinkedIn’s sign-in…');
              linkedinSignIn(store)
                .then((a) => say(`Signed in${a.name ? ` as ${a.name}` : ''}.`))
                .catch((err) => say(err.message, false));
            },
          }, icon('linkedin'), live ? 'Sign in again' : 'Sign in with LinkedIn')),
        publish.text ? h('p', { class: `small ${publish.ok ? 'muted' : 'error'}`, role: 'status' }, publish.text) : null)));
}

/** @param {Store} store */
function linkedinSession(store) {
  const saved = /** @type {LinkedinSettings} */ (store.get('settings').linkedin ?? {});
  const liAt = h('input', { name: 'liAt', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'AQEDA…', value: saved.liAt ?? '', 'aria-label': 'li_at cookie' });
  const jsession = h('input', { name: 'jsessionid', type: 'password', autocomplete: 'off', spellcheck: false, placeholder: 'ajax:123…', value: saved.jsessionid ?? '', 'aria-label': 'JSESSIONID cookie' });
  const state = sessionState(store);
  // New cookies are a new session: the stop LinkedIn's sign-out put on the queue is lifted.
  /** @param {{ liAt?: string, jsessionid?: string }} cookies */
  const save = (cookies) => {
    // Keeps the app of Publish as you and the daily limit, which share settings.linkedin.
    store.update('settings', (d) => {
      const { liAt: _a, jsessionid: _j, ...rest } = d.linkedin ?? {};
      d.linkedin = { ...rest, ...cookies };
    });
    store.update(LINKEDIN, (d) => {
      d.session ??= { calls: {} };
      d.session.expiredAt = null;
      d.session.error = null;
    });
    const pages = store.get(SOCIALS).accounts.filter((a) => a.network === 'linkedin' && (isOrganization(a) || a.error)).map((a) => a.id);
    if (pages.length && cookies.liAt) readNow(store, pages);
  };
  const limit = h('input', { type: 'number', min: '0', max: '1000', step: '1', value: String(state.limit), 'aria-label': 'Session calls per day' });
  const tone = !state.saved ? 'plain' : state.expiredAt ? 'high' : 'done';
  const label = !state.saved ? 'Not set' : state.expiredAt ? 'Signed out' : 'OK';
  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Signed-in session'),
        h('p', { class: 'muted' }, 'A person’s public profile shows its followers to anyone. LinkedIn shows company pages only when signed in, so the runners read those with your browser’s session, as the site does.')),
      h('div', { class: 'row' }, badge(label, tone))),
    h('div', { class: 'cred-body' },
      h('div', { class: 'svc-section stack-sm' },
        h('h3', null, 'Session'),
        state.expiredAt
          ? notice({ text: `LinkedIn signed the session out on ${new Date(state.expiredAt).toLocaleString(dateLocale())}${state.error ? ` (${state.error})` : ''}. Session reads are stopped until you save li_at and JSESSIONID again.` })
          : null,
        notice({ tone: 'info', text: 'Reads through the session use LinkedIn’s internal API, the one its own pages call. That is against LinkedIn’s terms, and the account is at risk: LinkedIn may sign it out or restrict it. The runners make one call at a time, 20 to 40 s apart, under the daily limit, and stop at the first sign-out.' }),
        h('p', { class: 'muted small' }, `${state.today} of ${state.limit} calls today${state.lastCallAt ? `, the last at ${new Date(state.lastCallAt).toLocaleTimeString(dateLocale())}` : ''}. Answers are kept and reused, so the same read does not call again for a while.`),
        h('form', {
          class: 'row',
          onsubmit: (/** @type {SubmitEvent} */ e) => {
            e.preventDefault();
            const n = Math.max(0, Math.min(1000, Math.floor(Number(limit.value))));
            if (!Number.isFinite(n)) return;
            store.update('settings', (d) => {
              d.linkedin = { ...d.linkedin, dailyLimit: n };
            });
            toast(`LinkedIn session limit: ${n} calls a day`);
          },
        },
          h('label', { class: 'row' }, h('span', { class: 'small' }, 'Calls per day'), limit),
          h('button', { type: 'submit', class: 'btn-small' }, 'Save'))),
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
          state.saved ? h('button', { type: 'button', class: 'danger', onclick: () => save({}) }, icon('x'), 'Clear') : null))));
}

/** @param {Store} store @param {'x' | 'linkedin' | 'github' | 'instagram'} network */
export function socialsCard(store, network) {
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const accounts = store.get(SOCIALS).accounts.filter((a) => a.network === network);
  const name = network === 'x' ? 'X / Twitter' : network === 'github' ? 'GitHub accounts' : network === 'instagram' ? 'Instagram' : NETWORKS[network];
  const intro = network === 'x'
    ? 'Monitoring → Socials follows the followers of each account here over time. X shows the counts of a public profile to anyone, so no key or sign-in is needed: the runners read each profile’s page every few hours.'
    : network === 'github'
      ? 'Monitoring → Socials follows the followers of each GitHub user or organization here over time, and the stars of its public repos (forks left out). The runners read them from GitHub’s API every few hours, with the token of Settings → GitHub when one is set.'
      : network === 'instagram'
        ? 'Monitoring → Socials follows the followers of each Instagram account here over time. No key or sign-in is needed: the runners read the counts Instagram gives a public profile’s link preview every few hours, rounded above 10,000 as Instagram writes them (12.3K).'
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
    network === 'linkedin' ? publishCard(store) : null,
    network === 'linkedin' ? linkedinSession(store) : null);
}
