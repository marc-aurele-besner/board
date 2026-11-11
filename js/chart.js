// Plain SVG bar charts with a hover tooltip. Only numbers and escaped labels go into the markup.
import { h } from './ui.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Bars per label. With several series the bars stack; `grouped` puts them side by side instead.
// Hovering, tapping or using the arrow keys on a column shows its values in a tooltip.
export function barChart(labels, series, { grouped = false, format = (v) => v.toLocaleString() } = {}) {
  const W = Math.max(360, labels.length * (grouped ? 30 : 24));
  const H = 180;
  const PAD = 24;
  const totals = labels.map((_, i) => (grouped ? Math.max(0, ...series.map((s) => s.values[i] || 0)) : series.reduce((s, sr) => s + (sr.values[i] || 0), 0)));
  // Scale to the tallest bar, so small amounts such as a few cents of AI cost still show.
  const max = Math.max(...totals) || 1;
  const slot = W / labels.length;
  const barWidth = grouped ? Math.max(4, (slot * 0.8) / series.length) : Math.max(4, slot * 0.6);
  let bars = '';
  let hits = '';
  labels.forEach((label, i) => {
    const x0 = i * slot + (slot - barWidth * (grouped ? series.length : 1)) / 2;
    let y = H - PAD;
    series.forEach((sr, k) => {
      const v = sr.values[i] || 0;
      const height = (v / max) * (H - PAD - 8);
      const x = grouped ? x0 + k * barWidth : x0;
      const top = grouped ? H - PAD - height : (y -= height);
      bars += `<rect class="bar" data-i="${i}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${esc(sr.color)}"/>`;
    });
    if (labels.length <= 14 || i % Math.ceil(labels.length / 12) === 0) {
      bars += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(label)}</text>`;
    }
    // A full-height target per column, so short or empty bars are as easy to hover as tall ones.
    hits += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H - PAD}"/>`;
  });
  bars += `<line x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" class="baseline"/>`;

  const scroller = h('div', { class: 'chart' });
  scroller.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="Bar chart. Use the arrow keys to read each value.">${bars}${hits}</svg>`;
  const tip = h('div', { class: 'chart-tip', role: 'status', 'aria-live': 'polite', hidden: true });
  const box = h('div', { class: 'chart-box' }, scroller, tip);
  const svg = scroller.firstElementChild;
  let active = -1;

  const hide = () => {
    active = -1;
    tip.hidden = true;
    svg.classList.remove('hovering');
    svg.querySelectorAll('.bar.on').forEach((b) => b.classList.remove('on'));
  };

  const show = (i) => {
    if (i < 0 || i >= labels.length) return;
    active = i;
    svg.classList.add('hovering');
    svg.querySelectorAll('.bar').forEach((b) => b.classList.toggle('on', Number(b.dataset.i) === i));
    const rows = series.map((sr) =>
      h('div', { class: 'chart-tip-row' },
        h('span', { class: 'legend-swatch', style: { background: sr.color } }),
        h('span', { class: 'grow' }, sr.name),
        h('strong', null, format(sr.values[i] || 0))));
    const total = series.length > 1 && !grouped
      ? h('div', { class: 'chart-tip-row total' }, h('span', { class: 'grow' }, 'Total'), h('strong', null, format(totals[i])))
      : null;
    tip.replaceChildren(h('div', { class: 'chart-tip-label' }, labels[i]), ...rows, total ?? '');
    tip.hidden = false;

    // Place it above the column, kept inside the chart's box.
    const outer = box.getBoundingClientRect();
    const col = svg.querySelector(`.hit[data-i="${i}"]`).getBoundingClientRect();
    const tops = [...svg.querySelectorAll(`.bar[data-i="${i}"]`)].map((b) => b.getBoundingClientRect().top);
    const top = Math.min(col.bottom, ...tops) - outer.top;
    const half = tip.offsetWidth / 2;
    const center = col.left + col.width / 2 - outer.left;
    tip.style.left = `${Math.min(Math.max(center, half), outer.width - half)}px`;
    tip.style.top = `${Math.max(top - 8, tip.offsetHeight)}px`;
  };

  svg.addEventListener('pointermove', (e) => {
    const i = Number(e.target.dataset?.i ?? -1);
    if (e.target.classList?.contains('hit') && i !== active) show(i);
  });
  svg.addEventListener('pointerleave', hide);
  svg.addEventListener('blur', hide);
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Escape') return hide();
    if (!step) return;
    e.preventDefault();
    show(active < 0 ? (step > 0 ? 0 : labels.length - 1) : Math.min(labels.length - 1, Math.max(0, active + step)));
  });
  scroller.addEventListener('scroll', hide);
  return box;
}

export function legend(series) {
  return h('div', { class: 'legend' }, series.map((sr) =>
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', style: { background: sr.color } }), sr.name)));
}
