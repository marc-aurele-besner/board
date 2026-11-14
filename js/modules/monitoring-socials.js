// Monitoring → Socials: the followers of each X, LinkedIn, GitHub and Instagram account added in Settings (and a GitHub account's
// stars), and how they grew over the period. The runners read the counts a few times a day (tools/jobs/socials.js);
// each day keeps its last read.
import { h, icon, empty, notice, noticePills, refreshIcon } from '../ui.js';
import { lineChart } from '../chart.js';
import { settingsHref } from '../integrations.js';
import { SOCIALS, NETWORKS, networkIcon, dayKey, profileUrl, handleLabel } from '../socials.js';
import { stat } from './monitoring.js';
import { projectLabel } from './monitoring-ai.js';
import { sortTable } from './monitoring-web.js';
import { readNow, isReading } from './settings-socials.js';
import { postMarks, postsCard } from './monitoring-linkedin-posts.js';
import { dateLocale, numberLocale } from '../locale.js';
/** @import { Store, SocialAccount, Project } from '../../types/data' */
/** @import { PeriodWindow } from '../../types/monitoring' */

const DAY = 86400000;
// The Settings section of each network's accounts.
/** @type {Record<string, import('../integrations.js').SetupKey>} */
const SETTINGS_KEY = { x: 'x', linkedin: 'linkedin', github: 'githubAccounts', instagram: 'instagram' };
// A day's period still draws a week, since the counts are read once or a few times a day.
const MIN_DAYS = 7;
const count = { format: (/** @type {number} */ n) => n.toLocaleString(numberLocale()) };
const signed = (/** @type {number} */ n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${count.format(Math.abs(n))}`;
const percent = (/** @type {number | null} */ p) => (p === null ? '' : `${p > 0 ? '+' : p < 0 ? '−' : ''}${Math.abs(p * 100).toFixed(Math.abs(p) < 0.1 ? 1 : 0)}%`);

/** @typedef {{ now: number | null, change: number | null, pct: number | null, values: (number | null)[] }} Series */
/** @typedef {Series & { account: SocialAccount, project: string, projectOf: Project | undefined, stars: Series | null }} AccountRow */

// The days from `start` to `end` (ms), both included, as history keys.
/** @param {number} start @param {number} end */
function daysBetween(start, end) {
  const out = [];
  const d = new Date(start);
  d.setHours(12, 0, 0, 0);
  for (; d.getTime() <= end + DAY / 2; d.setDate(d.getDate() + 1)) out.push(dayKey(d));
  return out;
}

// The followers at the end of the period, and their change since the last count before it (or its first count).
/** @param {Record<string, number>} hist @param {string} first @param {string} last */
function changeOver(hist, first, last) {
  const keys = Object.keys(hist).filter((k) => k <= last).sort();
  if (!keys.length) return { now: null, change: null, pct: null };
  const now = hist[keys[keys.length - 1]];
  const base = keys.filter((k) => k < first).pop() ?? keys.find((k) => k >= first);
  if (!base || base === keys[keys.length - 1]) return { now, change: null, pct: null };
  const from = hist[base];
  return { now, change: now - from, pct: from ? (now - from) / from : null };
}

/** @param {SocialAccount} a */
function avatar(a) {
  return a.image
    ? h('img', { class: 'social-pic', src: a.image, alt: '', loading: 'lazy', referrerpolicy: 'no-referrer' })
    : h('span', { class: 'social-avatar' }, icon(networkIcon(a.network)));
}

// A network named with its icon.
/** @param {string} network @param {string} [text] */
export const networkLabel = (network, text = NETWORKS[network] ?? network) => h('span', { class: 'social-net' }, icon(networkIcon(network)), text);

/** @param {number | null} change @param {number | null} pct */
const changePill = (change, pct) => (change === null
  ? h('span', { class: 'muted small' }, 'No change yet')
  : h('span', { class: `social-change ${change > 0 ? 'up' : change < 0 ? 'down' : ''}` }, `${signed(change)}${pct === null ? '' : ` (${percent(pct)})`}`));

/** @param {Store} store @param {AccountRow} row @param {string[]} labels @param {string[]} days */
function accountCard(store, row, labels, days) {
  const { account: a } = row;
  const fmt = (/** @type {number} */ v) => count.format(Math.round(v));
  // A LinkedIn account's posts, marked on its line.
  const posts = postMarks(store, a, days, labels, row.values, fmt);
  const busy = isReading(a.id);
  const points = row.values.filter((v) => v !== null).length;
  return h('section', { class: 'card stack social-card' },
    h('header', { class: 'social-head' },
      avatar(a),
      h('div', { class: 'social-name' },
        h('strong', null, a.name || handleLabel(a)),
        h('span', { class: 'muted small' },
          icon(networkIcon(a.network)), ' ',
          h('a', { href: profileUrl(a), target: '_blank', rel: 'noopener noreferrer' }, handleLabel(a)),
          row.projectOf ? [' · ', projectLabel(row.projectOf)] : '')),
      h('button', { type: 'button', class: 'icon-btn social-read', title: 'Read the counts now', 'aria-label': `Read ${handleLabel(a)} now`, disabled: busy, onclick: () => readNow(store, [a.id]) }, refreshIcon(busy))),
    h('div', { class: 'social-figures' },
      h('div', { class: 'social-now' },
        h('strong', null, row.now === null ? '—' : count.format(row.now)),
        h('span', { class: 'muted small' }, 'followers'),
        changePill(row.change, row.pct)),
      row.stars
        ? h('div', { class: 'social-now' },
            h('strong', null, row.stars.now === null ? '—' : count.format(row.stars.now)),
            h('span', { class: 'muted small' }, 'stars'),
            changePill(row.stars.change, row.stars.pct))
        : null),
    a.error ? h('p', { class: 'small social-error', role: 'status' }, a.error) : null,
    points > 1
      ? lineChart(labels, [{ name: 'Followers', color: 'var(--accent)', values: row.values, area: true }], { fit: true, format: fmt, marks: posts.marks, tip: posts.tip })
      : h('p', { class: 'muted small' }, points ? 'The line starts once a second day is read.' : 'Not read yet. The runners read the counts every few hours.'),
    // Stars get their own line: an account's stars and followers are often far apart.
    row.stars && row.stars.values.filter((v) => v !== null).length > 1
      ? lineChart(labels, [{ name: 'Stars', color: 'var(--warn)', values: row.stars.values, area: true }], { fit: true, format: (v) => count.format(Math.round(v)) })
      : null,
    a.at ? h('p', { class: 'muted small' }, `Read ${new Date(a.at).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })}`) : null);
}

/** @param {Store} store @param {PeriodWindow} w */
export function socialsTab(store, w) {
  const { accounts, history, stars } = store.get(SOCIALS);
  if (!accounts.length) {
    return notice({
      tone: 'info',
      text: 'No account followed yet. Add your X, LinkedIn, GitHub and Instagram accounts in Settings, and their followers show here over time.',
      actions: [
        ...Object.keys(NETWORKS).map((n) => h('a', { href: settingsHref(SETTINGS_KEY[n]), class: 'btn-small primary-link' }, networkLabel(n, `Add ${NETWORKS[n]} accounts`))),
      ],
    });
  }
  const end = w.end - 1;
  const first = dayKey(w.start);
  const last = dayKey(end);
  const days = daysBetween(Math.min(w.start, end - (MIN_DAYS - 1) * DAY), end);
  const labels = days.map((k) => `${Number(k.slice(5, 7))}/${Number(k.slice(8))}`);
  const projects = new Map(store.get('projects').projects.map((p) => [p.id, p]));

  /** @type {AccountRow[]} */
  /** @param {Record<string, number>} hist @returns {Series} */
  const series = (hist) => ({ ...changeOver(hist, first, last), values: days.map((k) => hist[k] ?? null) });
  const rows = accounts.map((a) => {
    const projectOf = a.projectId ? projects.get(a.projectId) : undefined;
    return {
      account: a,
      ...series(history?.[a.id] ?? {}),
      stars: a.network === 'github' ? series(stars?.[a.id] ?? {}) : null,
      project: projectOf?.name ?? '',
      projectOf,
    };
  });

  const read = rows.filter((r) => r.now !== null);
  const total = read.reduce((s, r) => s + /** @type {number} */ (r.now), 0);
  const changed = rows.filter((r) => r.change !== null);
  const gained = changed.reduce((s, r) => s + /** @type {number} */ (r.change), 0);
  const startTotal = changed.reduce((s, r) => s + /** @type {number} */ (r.now) - /** @type {number} */ (r.change), 0);
  const byNetwork = Object.keys(NETWORKS).map((n) => ({ network: n, n: accounts.filter((a) => a.network === n).length })).filter((x) => x.n);
  const failed = accounts.filter((a) => a.error);
  const starRows = rows.flatMap((r) => (r.stars ? [r.stars] : []));
  const starsNow = starRows.reduce((s, r) => s + (r.now ?? 0), 0);
  const starsChanged = starRows.filter((r) => r.change !== null);
  const starsGained = starsChanged.reduce((s, r) => s + /** @type {number} */ (r.change), 0);
  const starsStart = starsChanged.reduce((s, r) => s + /** @type {number} */ (r.now) - /** @type {number} */ (r.change), 0);
  const busy = accounts.some((a) => isReading(a.id));
  const lastAt = Math.max(0, ...accounts.map((a) => a.at ?? 0));

  return h('div', { class: 'stack-lg' },
    h('div', { class: 'social-bar' },
      // An account that could not be read folds into a pill, as the Inbox does, instead of a banner across the page.
      noticePills('socials', failed.map((a) => ({
        text: `${handleLabel(a)} (${NETWORKS[a.network] ?? a.network}): ${a.error}`,
        actions: [h('a', { href: settingsHref(SETTINGS_KEY[a.network] ?? 'linkedin'), class: 'btn-small primary-link' }, 'Open Settings')],
      }))),
      h('span', { class: 'muted small' }, lastAt ? `Last read ${new Date(lastAt).toLocaleString(dateLocale(), { dateStyle: 'medium', timeStyle: 'short' })}` : 'Not read yet'),
      h('button', { type: 'button', class: 'btn-small', disabled: busy, onclick: () => readNow(store, accounts.map((a) => a.id)) },
        refreshIcon(busy), busy ? 'Reading…' : 'Read all now')),
    h('div', { class: 'summary' },
      stat('Followers', count.format(total), `across ${read.length} of ${accounts.length} account${accounts.length === 1 ? '' : 's'}`),
      stat('Growth', changed.length ? signed(gained) : '—', changed.length ? `${percent(startTotal ? gained / startTotal : null) || 'new'} over the period` : 'Needs counts from two days'),
      starRows.length
        ? stat(networkLabel('github', 'GitHub stars'), count.format(starsNow), starsChanged.length ? `${signed(starsGained)}${starsStart ? ` (${percent(starsGained / starsStart)})` : ''} over the period` : 'Needs counts from two days')
        : null,
      stat('Accounts', String(accounts.length), h('span', { class: 'social-nets' }, byNetwork.map((x) => networkLabel(x.network, `${x.n} ${NETWORKS[x.network]}`))))),
    h('div', { class: 'social-grid' }, rows.map((r) => accountCard(store, r, labels, days))),
    postsCard(store, w, projects),
    h('section', { class: 'card stack' },
      h('h3', null, 'By account'),
      sortTable('socials', [
        { label: 'Account', value: (r) => r.account.name || handleLabel(r.account), format: (v, r) => h('span', { class: 'social-net' }, avatar(r.account), v) },
        { label: 'Network', value: (r) => NETWORKS[r.account.network] ?? r.account.network, format: (_, r) => networkLabel(r.account.network) },
        { label: 'Project', value: (r) => r.project || '—', format: (v, r) => (r.projectOf ? projectLabel(r.projectOf) : v) },
        { label: 'Followers', num: true, value: (r) => r.now ?? -1, format: (v) => (v < 0 ? '—' : count.format(v)) },
        { label: 'Change', num: true, value: (r) => r.change ?? 0, format: (v, r) => (r.change === null ? '—' : signed(v)) },
        { label: 'Change %', num: true, value: (r) => r.pct ?? 0, format: (v, r) => (r.pct === null ? '—' : percent(v)) },
        ...(starRows.length ? [
          { label: 'Stars', num: true, value: (/** @type {AccountRow} */ r) => r.stars?.now ?? -1, format: (/** @type {number} */ v) => (v < 0 ? '—' : count.format(v)) },
          { label: 'Stars change', num: true, value: (/** @type {AccountRow} */ r) => r.stars?.change ?? 0, format: (/** @type {number} */ v, /** @type {AccountRow} */ r) => (r.stars?.change == null ? '—' : signed(v)) },
        ] : []),
      ], rows)),
    rows.some((r) => r.now !== null) ? null : empty('The runners read the counts every few hours. Start them with bun start.'));
}
