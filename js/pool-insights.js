// AI insights on the Liquidity Pools tab: a read of the open positions, in range and out, with what to adjust.
import { h, icon, money, notice } from './ui.js';
import { ask, parseJson } from './ai.js';
import { systemPrompt } from './prompts.js';
import { setupBanner, hasOpenRouter } from './integrations.js';

// key: the positions the read was asked for, so a changed set is flagged instead of shown as current.
const insight = { status: 'idle', key: '', at: 0, summary: '', items: [], error: '' };

// The actions the model may pick, most urgent first; the list is shown in this order.
const ACTIONS = {
  withdraw: ['Withdraw', 'bad'],
  recenter: ['Re-center', 'act'],
  widen: ['Widen', 'act'],
  narrow: ['Narrow', 'act'],
  collect: ['Collect fees', 'act'],
  watch: ['Watch', 'warn'],
  keep: ['Keep', 'good'],
};
const ORDER = Object.keys(ACTIONS);
// Within this share of the range from an edge, an in-range position counts as near the edge.
const EDGE = 10;

const keyOf = (rows) => rows.map((r) => r.ref).sort().join(',');
const round = (n, digits = 4) => (Number.isFinite(n) ? Number(n.toPrecision(digits)) : null);
const pctOf = (n) => (Number.isFinite(n) ? round(n * 100, 3) : null);
const priceText = (n) => (n >= 1000 ? n.toLocaleString(undefined, { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(4));
const nearEdge = (r) => r.inRange && !r.full && r.marker !== null && (r.marker < EDGE || r.marker > 100 - EDGE);

// The facts the model reads for one position. Distances are worked out here so the model does not have to.
function factsOf(r) {
  const below = !r.inRange && r.current < r.min;
  return {
    id: r.ref,
    pair: r.pair,
    chain: r.chain,
    feeTierPct: r.feePct,
    status: r.inRange ? 'in range' : below ? 'out of range, price below the range' : 'out of range, price above the range',
    fullRange: r.full,
    priceUnit: `${r.sym1} per ${r.sym0}`,
    currentPrice: round(r.current, 6),
    rangeMin: r.full ? null : round(r.min, 6),
    rangeMax: r.full || !Number.isFinite(r.max) ? null : round(r.max, 6),
    // max / min - 1: how wide the range is.
    rangeWidthPct: r.full || !(r.min > 0) || !Number.isFinite(r.max) ? null : pctOf(r.max / r.min - 1),
    // Where the price sits in the range on a log scale: 0 at the lower edge, 100 at the upper.
    positionInRangePct: r.inRange && r.marker !== null ? round(r.marker, 3) : null,
    // In range: the move to the nearer edge. Out of range: the move needed to get back in.
    moveToLowerEdgePct: r.inRange && r.min > 0 ? pctOf(r.min / r.current - 1) : null,
    moveToUpperEdgePct: r.inRange && Number.isFinite(r.max) ? pctOf(r.max / r.current - 1) : null,
    moveBackInPct: r.inRange ? null : pctOf((below ? r.min : r.max) / r.current - 1),
    valueUsd: round(r.value, 6),
    unclaimedFeesUsd: round(r.fees, 6),
    feeAprPct: r.apr == null ? null : pctOf(r.apr),
    shareInToken0Pct: r.share0 == null ? null : round(r.share0 * 100, 3),
  };
}

// Keeps only what the board can show: known ids and actions, and a range with min below max.
function cleanReply(data, rows) {
  const known = new Set(rows.map((r) => r.ref));
  const items = (Array.isArray(data?.positions) ? data.positions : [])
    .filter((p) => known.has(p?.id) && Object.hasOwn(ACTIONS, p.action))
    // One entry per position: the first the model gave.
    .filter((p, i, list) => list.findIndex((q) => q.id === p.id) === i)
    .map((p) => {
      const min = Number(p.range?.min);
      const max = Number(p.range?.max);
      return {
        ref: p.id,
        action: p.action,
        headline: String(p.headline ?? '').slice(0, 120),
        reason: String(p.reason ?? '').slice(0, 600),
        range: min >= 0 && max > min && Number.isFinite(max) ? { min, max } : null,
      };
    });
  return { summary: String(data?.summary ?? '').slice(0, 1200), items };
}

async function run(store, rows) {
  insight.status = 'loading';
  insight.key = keyOf(rows);
  insight.error = '';
  store.refresh();
  try {
    const reply = await ask(store, 'task-pools', [
      { role: 'system', content: systemPrompt(store, 'pools') },
      { role: 'user', content: JSON.stringify({ positions: rows.map(factsOf) }) },
    ]);
    Object.assign(insight, cleanReply(parseJson(reply), rows), { status: 'ok', at: Date.now() });
    if (!insight.items.length && !insight.summary) throw new Error('The model returned nothing usable. Try again or pick another model in Settings.');
  } catch (err) {
    insight.status = 'error';
    insight.error = err.message;
  }
  store.refresh();
}

function item(r, it) {
  const [label, tone] = ACTIONS[it.action];
  return h('li', { class: 'insight-item' },
    h('div', { class: 'insight-top' },
      h('span', { class: `insight-action ${tone}` }, label),
      h('strong', null, r.pair),
      h('span', { class: 'muted small' }, `${r.chain} · ${r.feePct}% · #${r.tokenId}`),
      h('span', { class: r.inRange ? 'status-pill in' : 'status-pill out' }, h('span', { class: 'dot' }), r.inRange ? 'In range' : 'Out of range'),
      r.url ? h('a', { href: r.url, target: '_blank', rel: 'noopener', class: 'icon-btn insight-open', title: 'Open on Uniswap', 'aria-label': `Open position ${r.tokenId} on Uniswap` }, icon('link')) : null),
    it.headline ? h('div', { class: 'insight-headline' }, it.headline) : null,
    it.reason ? h('p', { class: 'muted small' }, it.reason) : null,
    it.range
      ? h('div', { class: 'insight-range small' },
          h('span', { class: 'muted' }, 'Suggested range'),
          h('strong', null, `${priceText(it.range.min)} – ${priceText(it.range.max)} ${r.sym1}`),
          r.full ? null : h('span', { class: 'muted' }, `now ${priceText(r.min)} – ${Number.isFinite(r.max) ? priceText(r.max) : '∞'}`))
      : null);
}

// rows: the open positions on screen (closed ones left out), with fee APR when it is known.
export function insightsPanel(store, rows) {
  if (!rows.length) return null;
  const out = rows.filter((r) => !r.inRange);
  const edge = rows.filter(nearEdge);
  const outValue = out.reduce((s, r) => s + (r.value ?? 0), 0);
  const tally = [
    `${rows.length - out.length} in range`,
    `${out.length} out of range${outValue > 0 ? ` (${money(outValue, 'USD')} idle)` : ''}`,
    edge.length ? `${edge.length} near an edge` : '',
  ].filter(Boolean).join(' · ');

  const loading = insight.status === 'loading';
  const done = insight.status === 'ok';
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: loading || !hasOpenRouter(store),
    onclick: () => run(store, rows),
  }, icon('sparkle'), loading ? 'Reading…' : done ? 'Ask again' : 'Get insights');

  const head = h('div', { class: 'row between' },
    h('div', null,
      h('h3', { class: 'insight-title' }, icon('sparkle'), 'AI insights'),
      h('p', { class: 'muted small' }, tally)),
    h('div', { class: 'row' },
      done || insight.status === 'error'
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => { insight.status = 'idle'; store.refresh(); } }, 'Hide')
        : null,
      button));

  let body = null;
  if (!hasOpenRouter(store)) body = setupBanner('openrouter', 'AI insights need an OpenRouter key.');
  else if (insight.status === 'error') body = notice({ text: insight.error });
  else if (loading) body = h('p', { class: 'muted small' }, `Reading ${rows.length} position${rows.length === 1 ? '' : 's'}…`);
  else if (done) {
    const byRef = new Map(rows.map((r) => [r.ref, r]));
    const items = insight.items
      .filter((it) => byRef.has(it.ref))
      .sort((a, b) => ORDER.indexOf(a.action) - ORDER.indexOf(b.action));
    body = h('div', { class: 'stack' },
      insight.key !== keyOf(rows)
        ? notice({ tone: 'info', text: 'The positions changed since this read. Ask again for an up-to-date one.' })
        : null,
      insight.summary ? h('p', null, insight.summary) : null,
      items.length ? h('ul', { class: 'insight-list' }, items.map((it) => item(byRef.get(it.ref), it))) : null,
      h('p', { class: 'muted small' }, `Read ${new Date(insight.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}. An AI read of the numbers above, not financial advice.`));
  }

  return h('section', { class: 'card stack lp-insights' }, head, body);
}
