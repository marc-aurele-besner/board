// Plain SVG bar charts with a tooltip. Only numbers and escaped labels go into the markup.
import { h } from './ui.js';

const esc = (s) => String(s).replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]);

// Bars per label. With several series the bars stack; `grouped` puts them side by side instead.
// tip(i): what to show for label i on hover, focus or tap, as a node or text. Without it, the tooltip lists each series' value.
export function barChart(labels, series, { grouped = false, format = (v) => v.toLocaleString(), tip = null } = {}) {
  const MIN_W = Math.max(360, labels.length * (grouped ? 30 : 16));
  // Matches the CSS height, so one SVG unit is one pixel and the axis text keeps its size.
  const H = 200;
  const PAD = 24;
  const totals = labels.map((_, i) => (grouped ? Math.max(0, ...series.map((s) => s.values[i] || 0)) : series.reduce((s, sr) => s + (sr.values[i] || 0), 0)));
  // Scale to the tallest bar, so small amounts such as a few cents of AI cost still show.
  const max = Math.max(...totals) || 1;
  tip ??= (i) => [
    h('span', { class: 'muted' }, labels[i]),
    series.map((sr) => h('span', { class: 'tip-row' },
      h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`),
      h('strong', null, format(sr.values[i] || 0)))),
    series.length > 1 && !grouped ? h('span', { class: 'tip-row' }, h('span', null, 'Total'), h('strong', null, format(totals[i]))) : null,
  ];
  // About 6px per character at the 10px axis font, plus a gap, so labels never run into each other.
  const labelWidth = Math.max(...labels.map((l) => String(l).length)) * 6 + 10;
  const draw = (W) => {
    const slot = W / labels.length;
    // Capped, so a few bars in a wide card stay bars rather than blocks.
    const barWidth = grouped ? Math.min(24, Math.max(4, (slot * 0.8) / series.length)) : Math.min(40, Math.max(4, slot * 0.6));
    const every = Math.max(1, Math.ceil(labelWidth / slot));
    let body = '';
    labels.forEach((label, i) => {
      const x0 = i * slot + (slot - barWidth * (grouped ? series.length : 1)) / 2;
      let y = H - PAD;
      series.forEach((sr, k) => {
        const v = sr.values[i] || 0;
        const height = (v / max) * (H - PAD - 8);
        const x = grouped ? x0 + k * barWidth : x0;
        const top = grouped ? H - PAD - height : (y -= height);
        body += `<rect class="bar" data-i="${i}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${height.toFixed(1)}" rx="3" style="fill:${esc(sr.color)}"/>`;
      });
      if (i % every === 0) {
        body += `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(label)}</text>`;
      }
    });
    body += `<line x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" class="baseline"/>`;
    // Full-height targets over each slot, so a short bar is as easy to hover as a tall one.
    labels.forEach((_, i) => { body += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H - PAD}"/>`; });
    return body;
  };
  const wrap = h('div', { class: 'chart interactive' });
  wrap.innerHTML = `<svg viewBox="0 0 ${MIN_W} ${H}" role="img" aria-label="Chart">${draw(MIN_W)}</svg>`;
  const svg = wrap.querySelector('svg');
  // Drawn at the card's own width, one unit per pixel, so the chart fills the card instead of
  // shrinking to its height. Narrower than MIN_W, it keeps MIN_W and scrolls sideways.
  let drawn = 0;
  new ResizeObserver(() => {
    const width = Math.floor(wrap.clientWidth);
    const W = Math.max(MIN_W, width);
    if (!width || W === drawn) return;
    drawn = W;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = W > width ? `${W}px` : '';
    svg.innerHTML = draw(W);
    wrap.dispatchEvent(new Event('chartredraw'));
  }).observe(wrap);
  hoverable(wrap, labels.length, totals, tip);
  return wrap;
}

// Lines per label, for running totals and rates. A null value leaves a gap; `dashed` draws a series as a
// dashed line (an estimate), and `area` shades under it. Hover works as on the bar chart, one point per label.
export function lineChart(labels, series, { format = (v) => v.toLocaleString(), tip = null } = {}) {
  const MIN_W = 360;
  const H = 200;
  const PAD = 24;
  const TOP = 16;
  const values = series.flatMap((sr) => sr.values.filter((v) => v != null));
  const max = Math.max(0, ...values) || 1;
  const totals = labels.map((_, i) => Math.max(0, ...series.map((sr) => sr.values[i] ?? 0)));
  tip ??= (i) => [
    h('span', { class: 'muted' }, labels[i]),
    series.filter((sr) => sr.values[i] != null).map((sr) => h('span', { class: 'tip-row' },
      h('span', null, h('span', { class: 'legend-swatch', style: { background: sr.color } }), ` ${sr.name}`),
      h('strong', null, format(sr.values[i])))),
  ];
  const labelWidth = Math.max(...labels.map((l) => String(l).length)) * 6 + 10;
  const draw = (W) => {
    const slot = W / labels.length;
    const xOf = (i) => i * slot + slot / 2;
    const yOf = (v) => H - PAD - (v / max) * (H - PAD - TOP);
    const every = Math.max(1, Math.ceil(labelWidth / slot));
    // A light grid at the top value and its half, labelled, since a line has no bar height to compare.
    let body = [max, max / 2].map((v) => `<line x1="0" x2="${W}" y1="${yOf(v).toFixed(1)}" y2="${yOf(v).toFixed(1)}" class="grid"/>`
      + `<text x="2" y="${(yOf(v) - 4).toFixed(1)}" class="axis">${esc(format(v))}</text>`).join('');
    for (const sr of series) {
      // Runs of points without a gap, each drawn as its own path.
      const runs = [];
      let run = [];
      sr.values.forEach((v, i) => {
        if (v == null) {
          if (run.length) runs.push(run);
          run = [];
        } else run.push([xOf(i), yOf(v)]);
      });
      if (run.length) runs.push(run);
      for (const pts of runs) {
        const d = pts.map(([x, y], k) => `${k ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
        if (sr.area && pts.length > 1) {
          body += `<path class="area" d="${d}L${pts[pts.length - 1][0].toFixed(1)} ${H - PAD}L${pts[0][0].toFixed(1)} ${H - PAD}Z" style="fill:${esc(sr.color)}"/>`;
        }
        body += `<path class="line${sr.dashed ? ' dashed' : ''}" d="${d}" style="stroke:${esc(sr.color)}"/>`;
      }
      sr.values.forEach((v, i) => {
        if (v != null) body += `<circle class="bar dot" data-i="${i}" cx="${xOf(i).toFixed(1)}" cy="${yOf(v).toFixed(1)}" r="4" style="fill:${esc(sr.color)}"/>`;
      });
    }
    labels.forEach((label, i) => {
      if (i % every === 0) body += `<text x="${xOf(i).toFixed(1)}" y="${H - 6}" text-anchor="middle" class="axis">${esc(label)}</text>`;
    });
    body += `<line x1="0" x2="${W}" y1="${H - PAD}" y2="${H - PAD}" class="baseline"/>`;
    labels.forEach((_, i) => { body += `<rect class="hit" data-i="${i}" x="${(i * slot).toFixed(1)}" y="0" width="${slot.toFixed(1)}" height="${H - PAD}"/>`; });
    return body;
  };
  const wrap = h('div', { class: 'chart interactive line-chart' });
  wrap.innerHTML = `<svg viewBox="0 0 ${MIN_W} ${H}" role="img" aria-label="Chart">${draw(MIN_W)}</svg>`;
  const svg = wrap.querySelector('svg');
  let drawn = 0;
  new ResizeObserver(() => {
    const width = Math.floor(wrap.clientWidth);
    const W = Math.max(MIN_W, width);
    if (!width || W === drawn) return;
    drawn = W;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.style.width = W > width ? `${W}px` : '';
    svg.innerHTML = draw(W);
    wrap.dispatchEvent(new Event('chartredraw'));
  }).observe(wrap);
  hoverable(wrap, labels.length, totals, tip);
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
    for (const el of svg.querySelectorAll('.bar')) el.classList.toggle('hot', Number(el.dataset.i) === i);
    const content = tip(i);
    box.replaceChildren(...[content].flat(Infinity).filter((x) => x != null));
    box.hidden = false;
    const hit = svg.querySelector(`rect.hit[data-i="${i}"]`).getBoundingClientRect();
    const bars = [...svg.querySelectorAll(`.bar[data-i="${i}"]`)].map((el) => el.getBoundingClientRect().top);
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
  // A resize redraws the bars, so a shown tooltip would point at bars that are gone.
  wrap.addEventListener('chartredraw', hide);
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
