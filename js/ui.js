// Small DOM and formatting helpers. No framework.
/** @import { Child } from '../types/ui' */

export const CURRENCY = 'USD'; // change to your currency code, e.g. 'CAD' or 'EUR'

/** @template {string} T @typedef {T extends keyof HTMLElementTagNameMap ? HTMLElementTagNameMap[T] : HTMLElement} ElementOf */

// The handlers h() attached to each element, by event name.
/** @type {WeakMap<Element, [string, EventListener][]>} */
const handlers = new WeakMap();

// Build an element: h('button', { class: 'primary', onclick: fn }, 'Save')
// Attributes with null/undefined/false are skipped. `value` and `checked` are set after children exist.
/**
 * @template {string} T
 * @param {T} tag
 * @param {Record<string, any> | null} [attrs] any: attribute values vary per key (text, handlers, style objects)
 * @param {...Child} children
 * @returns {ElementOf<T>}
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  // Style and element properties set by name.
  const style = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (el.style));
  const byName = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (el));
  /** @type {[string, unknown][]} */
  const props = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') {
      for (const [prop, val] of Object.entries(value)) {
        // Custom properties (--name) need setProperty; plain properties can be assigned.
        if (prop.startsWith('--')) el.style.setProperty(prop, val);
        else style[prop] = val;
      }
    }
    else if (key.startsWith('on')) {
      el.addEventListener(key.slice(2), value);
      // Kept, so patch() can hand an element on screen the handlers of the one that replaces it.
      handlers.set(el, [...(handlers.get(el) ?? []), [key.slice(2), value]]);
    }
    else if (key === 'value' || key === 'checked') props.push([key, value]);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of /** @type {unknown[]} */ (children).flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  for (const [key, value] of props) byName[key] = value;
  return /** @type {ElementOf<T>} */ (el);
}

// A redraw replaces elements, which would load every image again and restart every CSS animation: an avatar
// blanks while it decodes and a pulsing dot jumps back to its start, so a page redrawn every few seconds flashes.
// Call with the part being replaced and the part replacing it, before the swap: each image already shown is moved
// into the new part (it keeps its decoded picture), taking the new one's attributes.
/** @param {ParentNode} before @param {ParentNode} after */
export function keepImages(before, after) {
  /** @type {Map<string, HTMLImageElement[]>} */
  const shown = new Map();
  for (const img of before.querySelectorAll('img')) {
    const src = img.getAttribute('src');
    if (src && img.complete && img.naturalWidth) shown.set(src, [...(shown.get(src) ?? []), img]);
  }
  if (!shown.size) return;
  for (const img of after.querySelectorAll('img')) {
    const old = shown.get(img.getAttribute('src') ?? '')?.shift();
    if (!old) continue;
    for (const { name } of [...old.attributes]) if (!img.hasAttribute(name)) old.removeAttribute(name);
    for (const { name, value } of [...img.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
    img.replaceWith(old);
  }
}

// After the swap: endless animations (pulses, spinners) run on the page's clock, so a redrawn one goes on in step
// with the one it replaced instead of starting over.
/** @param {Element} root */
export function steadyAnimations(root) {
  for (const a of root.getAnimations({ subtree: true })) {
    if (a.effect?.getTiming().iterations === Infinity && a.startTime !== 0) a.startTime = 0;
  }
}

// Makes the children of an element on screen match those of a freshly drawn one, changing only what differs, so a
// redraw keeps what a rebuild would lose: hover, scroll, focus, a caret, loaded images and running animations.
// Children are matched by data-key or data-id when they have one (a task, an email), else by tag and class in
// order; one with no match is moved over from the fresh tree. A matched element takes the fresh one's attributes,
// form values (unless it has focus) and h() handlers. An element marked data-own is a section's own, redrawn in
// place later through a reference the section keeps, so it is swapped whole: the section keeps a live reference.
/** @param {Element} old @param {Element} fresh */
export function patch(old, fresh) {
  const left = [...old.childNodes];
  /** @type {Map<string, Element>} */
  const keyed = new Map();
  for (const n of left) {
    const k = keyOf(n);
    if (k) keyed.set(k, /** @type {Element} */ (n));
  }
  /** @type {Set<ChildNode>} */
  const used = new Set();
  let cursor = 0; // the first unkeyed old child not yet used
  const free = (/** @type {ChildNode} */ o) => !used.has(o) && !keyOf(o);
  /** @type {ChildNode[]} */
  const wanted = [];
  for (const n of [...fresh.childNodes]) {
    const k = keyOf(n);
    while (cursor < left.length && !free(left[cursor])) cursor++;
    /** @type {ChildNode | undefined} */
    let match = k ? keyed.get(k) : undefined;
    if (!k) {
      // The same tag and class further on (a row added above it), else the next free child if it has the tag.
      for (let i = cursor; i < Math.min(left.length, cursor + 20) && !match; i++) if (free(left[i]) && sameClass(left[i], n)) match = left[i];
      if (!match && left[cursor]?.nodeName === n.nodeName) match = left[cursor];
    }
    if (match && (match.nodeName !== n.nodeName || used.has(match))) match = undefined;
    if (!match || (n instanceof Element && n.hasAttribute('data-own'))) {
      wanted.push(n);
      continue;
    }
    used.add(match);
    if (n instanceof Element) patchElement(/** @type {Element} */ (match), n);
    else if (match.nodeValue !== n.nodeValue) match.nodeValue = n.nodeValue;
    wanted.push(match);
  }
  for (const o of left) if (!used.has(o)) o.remove();
  // In order, moving only what is out of place: moving an element resets its scroll and restarts its animations.
  wanted.forEach((n, i) => {
    if (old.childNodes[i] !== n) old.insertBefore(n, old.childNodes[i] ?? null);
  });
}

/** @param {Node} n */
const keyOf = (n) => (n instanceof Element ? n.getAttribute('data-key') ?? n.getAttribute('data-id') ?? '' : '');
/** @param {Node} a @param {Node} b */
const sameClass = (a, b) => a.nodeName === b.nodeName && (!(a instanceof Element) || a.getAttribute('class') === /** @type {Element} */ (b).getAttribute('class'));

/** @param {Element} old @param {Element} fresh */
function patchElement(old, fresh) {
  for (const { name } of [...old.attributes]) if (!fresh.hasAttribute(name)) old.removeAttribute(name);
  for (const { name, value } of [...fresh.attributes]) if (old.getAttribute(name) !== value) old.setAttribute(name, value);
  for (const [type, fn] of handlers.get(old) ?? []) old.removeEventListener(type, fn);
  const on = handlers.get(fresh) ?? [];
  for (const [type, fn] of on) old.addEventListener(type, fn);
  handlers.set(old, on);
  const isField = old instanceof HTMLInputElement || old instanceof HTMLTextAreaElement || old instanceof HTMLSelectElement;
  // A select's value needs its options first.
  if (!(old instanceof HTMLTextAreaElement)) patch(old, fresh);
  if (isField && old !== document.activeElement) {
    const f = /** @type {HTMLInputElement} */ (fresh);
    const o = /** @type {HTMLInputElement} */ (old);
    if (o.value !== f.value) o.value = f.value;
    if (o instanceof HTMLInputElement && o.checked !== f.checked) o.checked = f.checked;
  }
}

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export const now = () => new Date().toISOString();

// Local date as YYYY-MM-DD (toISOString alone would shift to UTC).
export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** @param {string} isoDate */
export const monthKey = (isoDate) => isoDate.slice(0, 7); // YYYY-MM

export const CURRENCIES = ['USD', 'CAD'];

// Formats an amount with two decimals in the given currency (default: CURRENCY).
/** @type {Map<string, Intl.NumberFormat>} */
const formatters = new Map();
/** @param {number | bigint} n @param {string} [currency] */
export const money = (n, currency = CURRENCY) => {
  if (!formatters.has(currency)) formatters.set(currency, new Intl.NumberFormat(undefined, { style: 'currency', currency }));
  return /** @type {Intl.NumberFormat} */ (formatters.get(currency)).format(n);
};

/** @param {Child} text */
export const empty = (text) => h('p', { class: 'empty' }, text);

// A loading bar for work whose length is not known, with a label saying what is happening.
/** @param {Child} label */
export function progress(label) {
  return h('div', { class: 'progress', role: 'status', 'aria-live': 'polite' },
    h('div', { class: 'progress-label' }, label),
    h('div', { class: 'progress-track' }, h('div', { class: 'progress-bar' })));
}

// A status box with an icon, the message, and optional action buttons. tone: 'error' | 'ok' | 'info'.
/** @param {{ tone?: 'error' | 'ok' | 'info', text: Child, actions?: Child[] }} options */
export function notice({ tone = 'error', text, actions = [] }) {
  const iconName = tone === 'error' ? 'alert' : tone === 'ok' ? 'check' : 'info';
  return h('div', { class: `notice ${tone}`, role: tone === 'error' ? 'alert' : 'status' },
    icon(iconName),
    h('div', { class: 'notice-body' },
      h('p', null, text),
      actions.length ? h('div', { class: 'notice-actions' }, actions) : null));
}

// Todo status replaced the old `done` flag. Items saved before that fall back to `done`.
/** @param {{ status?: string, done?: boolean }} item */
export const statusOf = (item) => item.status ?? (item.done ? 'done' : 'todo');

// Stroke icons (Lucide-style, 24×24 grid). Markup here is trusted static code.
const ICON_PATHS = {
  'check-square': '<polyline points="9 11 12 14 22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/>',
  'chef-hat': '<path d="M6 13.87A4 4 0 0 1 7.41 6a5.11 5.11 0 0 1 1.05-1.54 5 5 0 0 1 7.08 0A5.11 5.11 0 0 1 16.59 6 4 4 0 0 1 18 13.87V21H6Z"/><line x1="6" y1="17" x2="18" y2="17"/>',
  code: '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/>',
  cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  wallet: '<path d="M19 7V5a2 2 0 0 0-2-2H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  save: '<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>',
  x: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  'chevron-down': '<polyline points="6 9 12 15 18 9"/>',
  'chevron-up': '<polyline points="18 15 12 9 6 15"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9Z"/><polyline points="14 3 14 9 20 9"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="13" y2="17"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><polyline points="3 7 12 13 21 7"/>',
  files: '<path d="M20 7h-3a2 2 0 0 1-2-2V2"/><path d="M9 18a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h7l4 4v10a2 2 0 0 1-2 2Z"/><path d="M3 7.6v12.8A1.6 1.6 0 0 0 4.6 22h9.8"/>',
  copy: '<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  activity: '<polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/>',
  link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  alert: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>',
  info: '<circle cx="12" cy="12" r="9"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  plus: '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>',
  refresh: '<polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  home: '<path d="M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1Z"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>',
  grip: '<circle cx="9" cy="6" r="1"/><circle cx="15" cy="6" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="18" r="1"/><circle cx="15" cy="18" r="1"/>',
  'align-left': '<line x1="17" y1="10" x2="3" y2="10"/><line x1="21" y1="6" x2="3" y2="6"/><line x1="21" y1="14" x2="3" y2="14"/><line x1="17" y1="18" x2="3" y2="18"/>',
  repo: '<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7"/><path d="M18 10.5c0 4-6 3-10.5 6.5"/>',
  building: '<rect x="4" y="3" width="16" height="18" rx="1"/><path d="M9 7h2M13 7h2M9 11h2M13 11h2M9 15h2M13 15h2"/>',
  pencil: '<path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41"/>',
  moon: '<path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z"/>',
  tag: '<path d="M12.586 2.586A2 2 0 0 0 11.172 2H4a2 2 0 0 0-2 2v7.172a2 2 0 0 0 .586 1.414l8.704 8.704a2.426 2.426 0 0 0 3.42 0l6.58-6.58a2.426 2.426 0 0 0 0-3.42z"/><circle cx="7.5" cy="7.5" r=".5"/>',
  github: '<path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"/><path d="M9 18c-4.51 2-5-2-7-2"/>',
  instagram: '<rect x="2" y="2" width="20" height="20" rx="5"/><circle cx="12" cy="12" r="4"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/>',
  // X's and LinkedIn's marks, filled in the text colour.
  'x-mark': '<g fill="currentColor" stroke="none" transform="translate(2 2) scale(0.8333)"><path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z"/></g>',
  linkedin: '<g fill="currentColor" stroke="none" transform="translate(2 2) scale(0.8333)"><path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.71 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 4.455v6.286zM5.337 7.433a2.064 2.064 0 1 1 0-4.128 2.064 2.064 0 0 1 0 4.128zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"/></g>',
  // Slack's mark, filled: four rounded bars, each with its dot, around a square; drawn in the text colour like the other tabs.
  slack: '<g fill="currentColor" stroke="none" transform="translate(2 2) scale(0.8333)"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zM6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313zM8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zM8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312zM18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zM17.688 8.834a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.165 0a2.528 2.528 0 0 1 2.523 2.522v6.312zM15.165 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.165 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zM15.165 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.313A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.313z"/></g>',
  key: '<circle cx="7.5" cy="15.5" r="5.5"/><path d="m21 2-9.6 9.6"/><path d="m15.5 7.5 3 3L22 7l-3-3"/>',
  // Brand marks: the g-* classes take the Google colors from the theme tokens.
  gmail: '<g class="brand-mark"><path class="g-blue" d="M2 7v11a1.5 1.5 0 0 0 1.5 1.5H6V10z"/><path class="g-green" d="M22 7v11a1.5 1.5 0 0 1-1.5 1.5H18V10z"/><path class="g-red" d="M6 10V5.27l6 4.5 6-4.5V10l-6 4.5z"/><path class="g-red" d="M2 7.25c0-2.05 2.34-3.22 3.98-1.99L6 5.27V10L2 7z"/><path class="g-yellow" d="M22 7.25c0-2.05-2.34-3.22-3.98-1.99L18 5.27V10l4-3z"/></g>',
  gcal: '<g class="brand-mark"><path class="g-blue" d="M3 6a3 3 0 0 1 3-3h12v3H6v12H3z"/><path class="g-blue" d="M18 3a3 3 0 0 1 3 3h-3z"/><path class="g-yellow" d="M18 6h3v12h-3z"/><path class="g-green" d="M6 18h12v3H6z"/><path class="g-blue" d="M3 18h3v3a3 3 0 0 1-3-3z"/><path class="g-red" d="M18 18h3l-3 3z"/><path class="g-blue" d="M8.5 8.5h7v2h-7zM8.5 12.5h4.5v2H8.5z"/></g>',
  // Resend: a tile with the R, drawn in the text and surface colors so it reads in both themes.
  resend: '<g class="brand-mark"><rect class="r-tile" x="2" y="2" width="20" height="20" rx="5"/><path class="r-letter" d="M9 17V7h3.5a3 3 0 0 1 0 6H9m3.5 0L16 17"/></g>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  coins: '<circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/>',
  cpu: '<rect x="4" y="4" width="16" height="16" rx="2"/><rect x="9" y="9" width="6" height="6"/><path d="M15 2v2M15 20v2M2 15h2M2 9h2M20 15h2M20 9h2M9 2v2M9 20v2"/>',
  bell: '<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/>',
  wrench: '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>',
  notion: '<rect x="3" y="3" width="18" height="18" rx="3"/><path d="M8 17V7l8 10V7"/>',
  send: '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/>',
  triangle: '<path d="M12 3.5 21.5 20h-19Z"/>',
  rocket: '<path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>',
  shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"/><path d="m9 12 2 2 4-4"/>',
  sparkle: '<path d="M12 3l1.9 5.8L20 10.7l-6.1 1.9L12 18.5l-1.9-5.9L4 10.7l6.1-1.9Z"/><path d="M19 3v4M17 5h4"/>',
  zap: '<polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>',
  star: '<polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>',
  bookmark: '<path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>',
  archive: '<rect x="2" y="3" width="20" height="5" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/>',
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  search: '<circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.65" y2="16.65"/>',
  'collapse-all': '<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/><line x1="11.5" y1="14.5" x2="17.5" y2="14.5"/>',
  'clear-all': '<line x1="3" y1="6" x2="17" y2="6"/><line x1="3" y1="12" x2="12" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/><line x1="15.5" y1="13.5" x2="21" y2="19"/><line x1="21" y1="13.5" x2="15.5" y2="19"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  clock: '<circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/>',
  chevron: '<polyline points="6 9 12 15 18 9"/>',
  list: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/>',
  cards: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  droplet: '<path d="M12 2.7s6 6.1 6 11a6 6 0 0 1-12 0c0-4.9 6-11 6-11z"/>',
  'chevron-left': '<polyline points="15 18 9 12 15 6"/>',
  'chevron-right': '<polyline points="9 18 15 12 9 6"/>',
  columns: '<rect x="3" y="3" width="5" height="18" rx="1"/><rect x="10" y="3" width="5" height="12" rx="1"/><rect x="17" y="3" width="4" height="15" rx="1"/>',
  'arrow-left': '<line x1="19" y1="12" x2="5" y2="12"/><polyline points="12 19 5 12 12 5"/>',
  'arrow-up': '<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>',
  'arrow-down': '<line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/>',
  'arrow-right': '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
  'git-pull-request': '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" y1="9" x2="6" y2="21"/>',
  'git-branch': '<line x1="6" y1="3" x2="6" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
  worktree: '<circle cx="6" cy="5" r="2.5"/><circle cx="18" cy="5" r="2.5"/><circle cx="12" cy="19" r="2.5"/><path d="M6 7.5V9a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V7.5"/><line x1="12" y1="12" x2="12" y2="16.5"/>',
  'git-commit':'<circle cx="12" cy="12" r="3"/><line x1="3" y1="12" x2="9" y2="12"/><line x1="15" y1="12" x2="21" y2="12"/>',
  diff: '<path d="M12 3v10"/><path d="M7 8h10"/><path d="M7 19h10"/>',
  minus: '<line x1="5" y1="12" x2="19" y2="12"/>',
  undo: '<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>',
  'arrow-left-right': '<path d="M8 3 4 7l4 4"/><path d="M4 7h16"/><path d="m16 21 4-4-4-4"/><path d="M20 17H4"/>',
  'pull-request': '<circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><path d="M13 6h3a2 2 0 0 1 2 2v7.5"/><path d="M6 8.5V21"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  filter: '<polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3"/>',
  landmark: '<line x1="3" y1="22" x2="21" y2="22"/><line x1="6" y1="18" x2="6" y2="11"/><line x1="10" y1="18" x2="10" y2="11"/><line x1="14" y1="18" x2="14" y2="11"/><line x1="18" y1="18" x2="18" y2="11"/><polygon points="12 2 20 7 4 7"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  image: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-3.09-3.09a2 2 0 0 0-2.82 0L6 21"/>',
  trash: '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
  palette: '<circle cx="13.5" cy="6.5" r=".5"/><circle cx="17.5" cy="10.5" r=".5"/><circle cx="8.5" cy="7.5" r=".5"/><circle cx="6.5" cy="12.5" r=".5"/><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10c.926 0 1.648-.746 1.648-1.688 0-.437-.18-.835-.437-1.125-.29-.289-.438-.652-.438-1.125a1.64 1.64 0 0 1 1.668-1.668h1.996c3.051 0 5.555-2.503 5.555-5.554C21.965 6.012 17.461 2 12 2z"/>',
  hash: '<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  smile: '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/>',
  message: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  leaf: '<path d="M11 20A7 7 0 0 1 9.8 6.1C15.5 5 17 4.48 19 2c1 2 2 4.18 2 8 0 5.5-4.78 10-10 10Z"/><path d="M2 21c0-3 1.85-5.36 5.08-6C9.5 14.52 12 13 13 12"/>',
  coffee: '<path d="M17 8h1a4 4 0 1 1 0 8h-1"/><path d="M3 8h14v9a4 4 0 0 1-4 4H7a4 4 0 0 1-4-4Z"/><line x1="6" y1="2" x2="6" y2="4"/><line x1="10" y1="2" x2="10" y2="4"/><line x1="14" y1="2" x2="14" y2="4"/>',
  trophy: '<path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/>',
  car: '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  lightbulb: '<path d="M15 14c.2-1 .7-1.7 1.5-2.5 1-.9 1.5-2.2 1.5-3.5A6 6 0 0 0 6 8c0 1 .2 2.2 1.5 3.5.7.7 1.3 1.5 1.5 2.5"/><path d="M9 18h6"/><path d="M10 22h4"/>',
  heart: '<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>',
  flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" y1="22" x2="4" y2="15"/>',
  'bell-off': '<path d="M8.7 3A6 6 0 0 1 18 8a21.3 21.3 0 0 0 .6 5"/><path d="M17 17H3s3-2 3-9a4.67 4.67 0 0 1 .3-1.7"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/><line x1="2" y1="2" x2="22" y2="22"/>',
};

// A value the user pastes elsewhere (a handle, a command, an address): one click copies it.
/** @param {string} text @param {{ label?: string }} [options] */
export function copyable(text, { label = text } = {}) {
  const mark = h('span', { class: 'copy-mark' }, icon('copy'));
  /** @type {HTMLButtonElement & { timer?: number }} */
  const btn = h('button', {
    type: 'button',
    class: 'copy-chip',
    title: 'Copy',
    'aria-label': `Copy ${label}`,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard blocked (no permission, not focused): select the text so Cmd/Ctrl+C still works.
        getSelection()?.selectAllChildren(/** @type {HTMLElement} */ (btn.querySelector('code')));
        return;
      }
      btn.classList.add('copied');
      mark.replaceChildren(icon('check'));
      clearTimeout(btn.timer);
      btn.timer = setTimeout(() => {
        btn.classList.remove('copied');
        mark.replaceChildren(icon('copy'));
      }, 1500);
    },
  }, h('code', null, label), mark);
  return btn;
}

// A snippet to paste elsewhere (a console line, a command), in a block of its own with a Copy button.
/** @param {string} text @param {{ label?: string }} [options] */
export function codeBox(text, { label = 'the code' } = {}) {
  const code = h('code', null, text);
  /** @type {HTMLButtonElement & { timer?: number }} */
  const btn = h('button', {
    type: 'button',
    class: 'btn-small code-box-copy',
    'aria-label': `Copy ${label}`,
    onclick: async () => {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // Clipboard blocked: select the text so Cmd/Ctrl+C still works.
        getSelection()?.selectAllChildren(code);
        return;
      }
      btn.classList.add('copied');
      btn.replaceChildren(icon('check'), 'Copied');
      clearTimeout(btn.timer);
      btn.timer = setTimeout(() => {
        btn.classList.remove('copied');
        btn.replaceChildren(icon('copy'), 'Copy');
      }, 1500);
    },
  }, icon('copy'), 'Copy');
  return h('div', { class: 'code-box' }, h('pre', null, code), btn);
}

/** @typedef {keyof typeof ICON_PATHS} IconName */

/** @param {IconName} name */
export function icon(name) {
  const span = document.createElement('span');
  span.className = 'icon';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICON_PATHS[name] ?? ''}</svg>`;
  return span;
}

// The refresh icon of a reload button; it spins while the load runs, so a click visibly does something.
/** @param {boolean} [busy] */
export const refreshIcon = (busy) => (busy ? h('span', { class: 'spin-icon' }, icon('refresh')) : icon('refresh'));
