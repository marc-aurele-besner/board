// A preview deployment's details and build log, opened from its chip on a task or a Cron run. While the deployment
// queues or builds, the panel asks the runners to read the PR again and reloads the log, until it ends or is closed.
import { h, icon, copyable } from './ui.js';
import { openDialog } from './modal.js';
import { deployLog } from './deployments.js';
import { runJob } from './runners.js';
/** @import { Store, PreviewItem } from '../types/data' */
/** @import { DeployLog } from './deployments.js' */
/** @typedef {PreviewItem & { pr: { repo: string, number: number } }} PrPreview */

export const PROVIDER_NAMES = /** @type {Record<string, string>} */ ({ vercel: 'Vercel', netlify: 'Netlify' });
export const STATE_NAMES = /** @type {Record<string, string>} */ ({ ready: 'Ready', queued: 'Queued', building: 'Building', failed: 'Failed', canceled: 'Canceled' });
export const isLive = (/** @type {string} */ state) => state === 'building' || state === 'queued';
// How often an open panel reloads a build in progress.
const EVERY = 5000;

/** @param {number} ms */
function span(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}
/** @param {number} at */
const ago = (at) => (Date.now() - at < 45000 ? 'just now' : `${span(Date.now() - at).split(' ')[0]} ago`);
/** @param {number} at */
const clock = (at) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });

/** @param {string} state */
export const stateDot = (state) => h('span', { class: `deploy-dot deploy-${state || 'unknown'}`, 'aria-hidden': 'true' });

/** @param {PrPreview} i */
function facts(i) {
  const name = PROVIDER_NAMES[i.provider] ?? 'Preview';
  const took = i.created && i.ready ? i.ready - i.created : i.created && isLive(i.state) ? Date.now() - i.created : 0;
  return h('div', { class: 'deploy-facts' },
    h('div', { class: 'deploy-state-line' },
      h('span', { class: `deploy-state deploy-${i.state || 'unknown'}` }, stateDot(i.state), STATE_NAMES[i.state] ?? 'Unknown'),
      i.name ? h('span', { class: 'muted' }, `${name} · ${i.name}`) : h('span', { class: 'muted' }, name)),
    h('dl', { class: 'deploy-dl' },
      h('dt', null, 'Pull request'),
      h('dd', null, h('a', { href: `https://github.com/${i.pr.repo}/pull/${i.pr.number}`, target: '_blank', rel: 'noopener' }, `${i.pr.repo} #${i.pr.number}`)),
      i.sha ? [h('dt', null, 'Commit'), h('dd', null, h('a', { class: 'mono', href: `https://github.com/${i.pr.repo}/commit/${i.sha}`, target: '_blank', rel: 'noopener' }, i.sha.slice(0, 7)))] : null,
      i.created ? [h('dt', null, 'Started'), h('dd', { title: new Date(i.created).toLocaleString() }, ago(i.created))] : null,
      took ? [h('dt', null, isLive(i.state) ? 'Running for' : 'Took'), h('dd', null, span(took))] : null,
      i.url ? [h('dt', null, 'Preview'), h('dd', { class: 'deploy-url' }, copyable(i.url))] : null),
    i.error ? h('p', { class: 'deploy-error', role: 'alert' }, icon('alert'), h('span', null, i.error)) : null,
    h('div', { class: 'row deploy-actions' },
      i.url ? h('a', { class: 'btn-small primary-link', href: i.url, target: '_blank', rel: 'noopener noreferrer' }, icon('globe'), 'Open preview') : null,
      i.inspect ? h('a', { class: 'btn-small', href: i.inspect, target: '_blank', rel: 'noopener noreferrer' }, icon('link'), `Open on ${name}`) : null));
}

/** @param {DeployLog} log */
function logLines(log) {
  if (!log.lines.length) return h('p', { class: 'muted small' }, 'The log is empty so far.');
  return h('pre', { class: 'deploy-log', tabindex: '0', 'aria-label': 'Build log' },
    log.truncated ? h('span', { class: 'deploy-log-line muted' }, `Only the last ${log.lines.length} lines are shown.\n`) : null,
    log.lines.map((l) => h('span', { class: `deploy-log-line${l.level ? ` log-${l.level}` : ''}` },
      l.at ? h('span', { class: 'deploy-log-time' }, clock(l.at)) : null,
      `${l.text.replace(/\n+$/, '')}\n`)));
}

// The panel. `find` gives the item as it is now in github.json, so a refresh shows its new state.
/** @param {Store} store @param {PrPreview} item @param {() => PrPreview | undefined} find */
export function openDeployPanel(store, item, find) {
  let current = item;
  /** @type {DeployLog | null} */
  let log = null;
  /** @type {string | null} */
  let logError = null;
  let loading = false;
  let errorsOnly = false;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;

  const top = h('div', null);
  const logBox = h('div', { class: 'deploy-log-box' });
  const status = h('span', { class: 'muted small', role: 'status' });
  const reload = h('button', { type: 'button', class: 'btn-small', onclick: () => load() }, icon('refresh'), 'Reload');
  const filter = h('label', { class: 'check small' },
    h('input', { type: 'checkbox', onchange: (/** @type {Event} */ e) => { errorsOnly = /** @type {HTMLInputElement} */ (e.currentTarget).checked; drawLog(); } }),
    'Errors only');

  const drawTop = () => top.replaceChildren(facts(current));
  const drawLog = () => {
    const pre = logBox.querySelector('pre');
    // Keep following the end only when the reader is already there.
    const atEnd = !pre || pre.scrollHeight - pre.scrollTop - pre.clientHeight < 24;
    if (logError) logBox.replaceChildren(h('p', { class: 'deploy-error' }, icon('alert'), h('span', null, logError)));
    else if (!log) logBox.replaceChildren(h('p', { class: 'muted small' }, 'Reading the log…'));
    else logBox.replaceChildren(logLines(errorsOnly ? { ...log, lines: log.lines.filter((l) => l.level === 'error' || l.level === 'warn') } : log));
    const next = logBox.querySelector('pre');
    if (next && atEnd) next.scrollTop = next.scrollHeight;
    status.textContent = loading ? 'Reading…' : log ? `${log.lines.length} lines${isLive(current.state) ? ' · reloads while it builds' : ''}` : '';
    reload.toggleAttribute('disabled', loading);
  };

  const load = async () => {
    if (loading || !top.isConnected) return;
    clearTimeout(timer);
    loading = true;
    drawLog();
    try {
      log = await deployLog(store, current);
      logError = null;
    } catch (err) {
      logError = /** @type {Error} */ (err).message;
    }
    loading = false;
    if (!top.isConnected) return;
    drawLog();
    if (isLive(current.state)) timer = setTimeout(tick, EVERY);
  };

  // While it builds: the runners read the PR again, the store picks up their write, and the log reloads.
  const tick = async () => {
    if (!top.isConnected) return;
    await runJob('previews', { prs: [current.pr] }).then(() => store.sync()).catch(() => {});
    const now = find();
    if (now) current = { ...now, pr: current.pr };
    if (!top.isConnected) return;
    drawTop();
    load();
  };

  drawTop();
  drawLog();
  const name = PROVIDER_NAMES[item.provider] ?? 'Preview';
  openDialog({
    title: `${name} preview`,
    wide: true,
    body: h('div', { class: 'deploy-panel stack' },
      top,
      h('div', { class: 'deploy-log-head' }, h('h3', null, 'Build log'), status, filter, reload),
      logBox),
  });
  if (current.id) load();
  else {
    logError = 'This preview was read from its PR comment, so its log cannot be read. Add a token in Settings → Vercel or Netlify.';
    drawLog();
  }
}
