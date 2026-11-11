// Plain SVG bar charts. Only numbers and labels from the app go into the markup.
import { h } from './ui.js';

// Bars per label. With several series the bars stack; `grouped` puts them side by side instead.
// tip(i): what to show for label i on hover, focus or tap, as a node or text. Without it, bars keep a plain title.
export function barChart(labels, series, { grouped = false, format = (v) => String(v), tip = null } = {}) {
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
      const title = tip ? '' : `<title>${label} · ${sr.name}: ${format(v)}</title>`;
      body += `<rect class="bar" data-i="${i}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${sr.color}">${title}</rect>`;
    });
    if (labels.length <= 14 || i % Math.ceil(labels.length / 12) === 0) {
      body += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${label}</text>`;
    }
  });
  body += `<line x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" class="baseline"/>`;
  // Full-height targets over each slot, so a short bar is as easy to hover as a tall one.
  if (tip) labels.forEach((_, i) => { body += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H - PAD}"/>`; });
  const wrap = h('div', { class: tip ? 'chart interactive' : 'chart' });
  wrap.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Chart">${body}</svg>`;
  if (tip) hoverable(wrap, labels.length, totals, tip);
  return wrap;
}

// Hover, tap and arrow keys pick a bar: the others dim and a tooltip shows what tip() says about it.
function hoverable(wrap, count, totals, tip) {
  const svg = wrap.querySelector('svg');
  const box = h('div', { class: 'chart-tip', role: 'status', hidden: true });
  wrap.append(box);
  svg.setAttribute('tabindex', '0');
  svg.setAttribute('aria-label', 'Chart. Use the arrow keys to read each bar.');
  let current = -1;
  const show = (i) => {
    if (i < 0 || i >= count) return;
    current = i;
    wrap.classList.add('hovering');
    for (const el of svg.querySelectorAll('rect.bar')) el.classList.toggle('hot', Number(el.dataset.i) === i);
    const content = tip(i);
    box.replaceChildren(...[content].flat(Infinity).filter((x) => x != null));
    box.hidden = false;
    const hit = svg.querySelector(`rect.hit[data-i="${i}"]`).getBoundingClientRect();
    const bars = [...svg.querySelectorAll(`rect.bar[data-i="${i}"]`)].map((el) => el.getBoundingClientRect().top);
    const outer = wrap.getBoundingClientRect();
    const top = Math.min(hit.bottom, ...bars) - outer.top;
    // Kept inside the chart's width, so it never makes the page scroll sideways.
    const half = box.offsetWidth / 2;
    const center = hit.left + hit.width / 2 - outer.left + wrap.scrollLeft;
    const left = Math.max(half + 4, Math.min(wrap.scrollWidth - half - 4, center));
    box.style.left = `${left}px`;
    box.style.top = `${Math.max(box.offsetHeight + 6, top - 8)}px`;
  };
  const hide = () => {
    current = -1;
    wrap.classList.remove('hovering');
    box.hidden = true;
  };
  const indexOf = (e) => {
    const el = e.target.closest?.('rect[data-i]');
    return el ? Number(el.dataset.i) : -1;
  };
  svg.addEventListener('pointermove', (e) => {
    const i = indexOf(e);
    if (i >= 0 && i !== current) show(i);
  });
  svg.addEventListener('pointerdown', (e) => show(indexOf(e)));
  svg.addEventListener('pointerleave', (e) => {
    if (e.pointerType === 'mouse') hide();
  });
  svg.addEventListener('blur', hide);
  svg.addEventListener('focus', () => {
    // Keyboard focus starts on the latest bar with a value.
    let i = count - 1;
    while (i > 0 && !totals[i]) i--;
    show(i);
  });
  svg.addEventListener('keydown', (e) => {
    const step = { ArrowLeft: -1, ArrowRight: 1 }[e.key];
    if (e.key === 'Escape') return hide();
    if (!step) return;
    e.preventDefault();
    show(Math.max(0, Math.min(count - 1, (current < 0 ? count : current) + step)));
  });
}

export function legend(series) {
  return h('div', { class: 'legend' }, series.map((sr) =>
    h('span', { class: 'legend-item' }, h('span', { class: 'legend-swatch', style: { background: sr.color } }), sr.name)));
}
