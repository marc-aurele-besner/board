// Settings → Slack: sign in to more workspaces (or another account's), and see, tie to a project or remove the ones
// signed in. The sign-in form is the Slack tab's own.
import { h, icon } from '../ui.js';
import { pickChip } from '../inline.js';
import { toast } from '../toast.js';
import { SLACK, SLACK_DEFAULTS } from '../slack.js';
import { signInForm, confirmRemove, teamIcon } from './slack.js';
import { projectIcon, projectTree } from './projects.js';
/** @import { Store, SlackData, SlackWorkspace, Project } from '../../types/data' */

/** @param {string} text @param {string} tone */
const badge = (text, tone) => h('span', { class: `pill tone-${tone}` }, text);

/** @param {Store} store @param {SlackWorkspace} w @param {Project[]} projects */
function workspaceRow(store, w, projects) {
  const host = w.url.replace(/^https?:\/\//, '').replace(/\/$/, '');
  return h('li', { class: 'resend-row has-key' },
    h('div', { class: 'resend-name' },
      teamIcon(w, 'slack-team-icon slack-ws-icon'),
      h('div', { class: 'slack-ws-name' },
        h('strong', { title: w.name }, w.name),
        h('span', { class: 'muted small' }, [w.userName ? `@${w.userName}` : '', host].filter(Boolean).join(' · ')))),
    h('div', { class: 'resend-key' },
      pickChip({
        value: w.projectId ?? null,
        options: projects.map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
        nullable: true,
        nullLabel: 'No project',
        className: 'field-pick project-field-pick',
        onPick: (v) => store.update(SLACK, (d) => {
          const x = d.workspaces.find((y) => y.id === w.id);
          if (x) x.projectId = v ?? null;
        }),
      }),
      w.error ? h('span', { class: 'resend-msg small error', role: 'status' }, w.error) : null),
    h('div', { class: 'resend-actions' },
      badge(w.error ? 'Signed out' : 'Signed in', w.error ? 'plain' : 'done'),
      h('a', { class: 'btn-small', href: w.url || 'https://app.slack.com/', target: '_blank', rel: 'noopener noreferrer' }, 'Open'),
      h('button', { type: 'button', class: 'icon-btn', title: 'Remove workspace', 'aria-label': `Remove ${w.name}`, onclick: () => confirmRemove(store, w) }, icon('x'))));
}

/** @param {Store} store */
export function slackCard(store) {
  const d = /** @type {SlackData} */ ({ ...SLACK_DEFAULTS, ...store.get(SLACK) });
  const projects = projectTree(store.get('projects').projects).map(({ project }) => project);
  const count = d.workspaces.length;
  return h('div', { class: 'stack-lg' },
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Slack'),
          h('p', { class: 'muted' }, 'The Slack tab shows every workspace signed in here in one sidebar. Sign in again with the tokens of another browser profile to add another account’s workspaces; a workspace already here is updated.')),
        h('div', { class: 'row' }, badge(count ? `${count} workspace${count === 1 ? '' : 's'}` : 'Not set', count ? 'doing' : 'plain'))),
      signInForm(store, (said) => toast(said))),
    h('section', { class: 'card panel' },
      h('header', { class: 'panel-head' },
        h('div', null,
          h('h2', null, 'Workspaces'),
          h('p', { class: 'muted' }, 'A workspace’s project ties all its conversations to it, unless a group or a conversation has its own. Removing a workspace removes it from the board only.'))),
      h('ul', { class: 'resend-list' },
        count
          ? [h('li', { class: 'resend-row resend-head', 'aria-hidden': 'true' }, h('span', null, 'Workspace'), h('span', null, 'Project'), h('span')),
              ...d.workspaces.map((w) => workspaceRow(store, w, projects))]
          : [h('li', { class: 'empty' }, 'No Slack workspace yet.')])));
}
