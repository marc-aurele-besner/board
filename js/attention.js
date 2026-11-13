// What waits on the user in sections they may not have open, as a number on the nav tab: Slack mentions (a DM with
// unread messages counts once), claude terminals in Dev that wait on the user (a question, a plan, a permission, or a
// turn that ended without the done signal), and unread comments on the member's LinkedIn posts on the Inbox tab.
// Read every 20 s while the page is visible. The Slack tab reads counts itself while open and reports them here,
// so they are not read twice.
import { runnersOnline } from './runners.js';
import { runnerOf } from './dev-core.js';
import { listSessions, sessionStatus, sessionTurns } from './terminal.js';
import { SLACK, SLACK_DEFAULTS, readCounts } from './slack.js';
import { LINKEDIN } from './linkedin-core.js';
/** @import { Store, SlackData } from '../types/data' */
/** @import { Count } from './slack.js' */

const EVERY_MS = 20000;
const TURNS_TIMEOUT_MS = 8000;

/** @type {Record<string, number>} by section id */
const counts = { slack: 0, dev: 0, inbox: 0 };
let slackAt = 0;
let devAt = 0;

/** @type {Record<string, (n: number) => string>} */
const TITLES = {
  slack: (n) => `${n} ${n === 1 ? 'mention' : 'mentions'} in Slack`,
  dev: (n) => `${n} ${n === 1 ? 'terminal waits' : 'terminals wait'} for you in Dev`,
  inbox: (n) => `${n} unread LinkedIn ${n === 1 ? 'comment' : 'comments'}`,
};

// The mentions a conversation shows: a DM with unread messages counts as one at least.
/** @param {string} channel @param {Count} c */
export const mentionsOf = (channel, c) => (/^D/.test(channel) && c.unread ? Math.max(c.mentions, 1) : c.mentions);

/** @param {string} id */
export const attentionOf = (id) => counts[id] ?? 0;
/** @param {string} id */
export const attentionTitle = (id) => (counts[id] ? TITLES[id]?.(counts[id]) ?? '' : '');

// Sets a section's number and updates its tab in place, so no redraw is needed.
/** @param {string} id @param {number} n */
export function setAttention(id, n) {
  if (id === 'slack') slackAt = Date.now();
  if (counts[id] === n) return;
  counts[id] = n;
  const pill = /** @type {HTMLElement | null} */ (document.querySelector(`.tab[data-id="${id}"] .tab-pill`));
  if (!pill) return;
  pill.textContent = n > 99 ? '99+' : String(n);
  pill.hidden = !n;
  pill.title = attentionTitle(id);
}

// Mentions over the conversations the board lists, from counts by team id.
/** @param {Store} store @param {Map<string, Map<string, Count>>} byTeam */
export function slackMentions(store, byTeam) {
  const d = /** @type {SlackData} */ ({ ...SLACK_DEFAULTS, ...store.get(SLACK) });
  let n = 0;
  for (const [team, map] of byTeam) {
    for (const c of d.channels[team] ?? []) {
      const count = map.get(c.id);
      if (count) n += mentionsOf(c.id, count);
    }
  }
  return n;
}

/** @param {Store} store */
async function readSlack(store) {
  const d = /** @type {SlackData} */ ({ ...SLACK_DEFAULTS, ...store.get(SLACK) });
  /** @type {Map<string, Map<string, Count>>} */
  const byTeam = new Map();
  await Promise.all(d.workspaces.filter((w) => !w.error).map(async (w) => {
    try {
      byTeam.set(w.id, await readCounts(w, store));
    } catch {}
  }));
  setAttention('slack', slackMentions(store, byTeam));
}

/** @param {Store} store */
async function readDev(store) {
  const base = runnerOf(store);
  try {
    const ids = ((await listSessions(base)).sessions ?? []).map((s) => s.id);
    const states = await sessionStatus(base, ids);
    // Only claude reports its transcript (agents); a quiet dev server is not waiting on anyone.
    const waiting = Object.entries(states).filter(([, s]) => s.state === 'waiting' && (s.ask || s.agents !== undefined));
    // A claude that asks nothing may have finished its task: its turns tell (state done once it gave the done signal).
    const open = await Promise.all(waiting.map(async ([id, s]) => {
      if (s.ask) return true;
      try {
        return (await sessionTurns(base, id, AbortSignal.timeout(TURNS_TIMEOUT_MS))).state !== 'done';
      } catch {
        return true;
      }
    }));
    setAttention('dev', open.filter(Boolean).length);
  } catch {
    setAttention('dev', 0);
  }
}

/** @param {Store} store */
export function watchAttention(store) {
  // Checked often, read only when due: the runners' heartbeat is not known yet when the page opens.
  const tick = () => {
    if (document.hidden) return;
    const now = Date.now();
    // Already in the store (the runners write it): counted on every tick, no read.
    setAttention('inbox', (store.get(LINKEDIN)?.comments ?? []).filter((c) => !c.read).length);
    if (now - devAt >= EVERY_MS) {
      devAt = now;
      readDev(store);
    }
    if (runnersOnline() && now - slackAt >= EVERY_MS) {
      slackAt = now;
      readSlack(store);
    }
  };
  tick();
  setInterval(tick, 3000);
}
