// Plain SVG bar charts. Only numbers and labels from the app go into the markup.
import { h } from './ui.js';

// Bars per label. With several series the bars stack; `grouped` puts them side by side instead.
export function barChart(labels, series, { grouped = false, format = (v) => String(v) } = {}) {
  const W = Math.max(360, labels.length * (grouped ? 30 : 24));
  const H = 180;
  const PAD = 24;
  const totals = labels.map((_, i) => (grouped ? Math.max(0, ...series.map((s) => s.values[i] || 0)) : series.reduce((s, sr) => s + (sr.values[i] || 0), 0)));
  const max = Math.max(1, ...totals);
  const slot = W / labels.length;
  const barWidth = grouped ? Math.max(4, (slot * 0.8) / series.length) : Math.max(4, slot * 0.6);
  let body = '';
  labels.forEach((label, i) => {
    const x0 = i * slot + (slot - barWidth * (grouped ? series.length : 1)) / 2;
    let y = H - PAD;
    series.forEach((sr, k) => {
      const v = sr.values[i] || 0;
      const height = (v / max) * (H - PAD - 8);
      const x = grouped ? x0 + k * barWidth : x0;
      const top = grouped ? H - PAD - height : (y -= height);
      body += `<rect x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${sr.color}"><title>${label} · ${sr.name}: ${format(v)}</title></rect>`;
    });
    if (labels.length <= 14 || i % Math.ceil(labels.length / 12) === 0) {
      body += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${label}</text>`;
    }
  });
  body += `<line x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" class="baseline"/>`;
  const wrap = h('div', { class: 'chart' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${body}</svg>`;
  return wrap;
}

export function legend(series) {
  return h('div', { class: 'legend' }, series.map((sr) =>
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', style: { background: sr.color } }), sr.name)));
}
