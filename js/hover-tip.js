// A quick, styled tooltip for the controls inside a container: their `title` shows a moment after the pointer
// rests on them, instead of the browser's own slow one. The title moves to data-tip while hovered so the browser
// does not show its own too, and comes back after. Dev's terminal bar uses it.

/** @type {HTMLElement | null} */
let tip = null;
/** @type {HTMLElement | null} */
let target = null;
let timer = 0;
const DELAY = 250;

function hide() {
  clearTimeout(timer);
  tip?.remove();
  tip = null;
  if (target?.dataset.tip !== undefined) {
    if (!target.hasAttribute('title')) target.setAttribute('title', target.dataset.tip);
    delete target.dataset.tip;
  }
  target = null;
}

/** @param {HTMLElement} el */
function show(el) {
  if (!el.isConnected || el !== target) return;
  const text = el.dataset.tip ?? '';
  if (!text) return;
  tip = document.createElement('div');
  tip.className = 'hover-tip';
  tip.setAttribute('role', 'tooltip');
  tip.textContent = text;
  document.body.append(tip);
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth;
  const hgt = tip.offsetHeight;
  const x = Math.max(8, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 8));
  const below = r.bottom + 6 + hgt < window.innerHeight - 8;
  tip.style.left = `${x}px`;
  tip.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - 6 - hgt)}px`;
}

/** @param {PointerEvent} e @param {string} selector */
function onOver(e, selector) {
  const el = /** @type {HTMLElement | null} */ (/** @type {Element} */ (e.target).closest?.('[title], [data-tip]'));
  if (el === target) return;
  hide();
  if (!el || !el.closest(selector)) return;
  const text = el.getAttribute('title') ?? el.dataset.tip ?? '';
  if (!text) return;
  el.dataset.tip = text;
  el.removeAttribute('title');
  target = el;
  timer = window.setTimeout(() => show(el), DELAY);
}

let installed = false;
// Shows the quick tooltip on every control with a title inside an element matching `selector`.
/** @param {string} selector */
export function hoverTips(selector) {
  if (installed) return;
  installed = true;
  document.addEventListener('pointerover', (e) => onOver(e, selector));
  document.addEventListener('pointerdown', hide, true);
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
