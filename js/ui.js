// Small DOM and formatting helpers. No framework.
import { numberLocale } from './locale.js';
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
  // One formatter per number format and currency: Appearance can change the format while the page is open.
  const locale = numberLocale();
  const key = `${locale ?? ''}:${currency}`;
  if (!formatters.has(key)) formatters.set(key, new Intl.NumberFormat(locale, { style: 'currency', currency }));
  return /** @type {Intl.NumberFormat} */ (formatters.get(key)).format(n);
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

// Notices folded into pills for a toolbar, one per tone with its count, as the Inbox does with its read errors:
// banners pushed the page down. A pill opens the full notices, with their actions, under it. Which pills are
// open is kept by key, so a redraw (a chain landing) does not fold them; a click elsewhere or Escape does.
/** @typedef {{ tone?: 'error' | 'ok' | 'info', text: Child, actions?: Child[] }} NoticeOptions */
/** @type {[NonNullable<NoticeOptions['tone']>, IconName, string, string][]} */
const PILL_TONES = [['error', 'alert', 'alert', 'Alerts'], ['info', 'info', 'note', 'Notes'], ['ok', 'check', 'update', 'Updates']];
/** @type {Set<string>} */
const openPills = new Set();
let pillsWatched = false;
/** @param {string} key @param {(NoticeOptions | null | false | undefined)[]} list */
export function noticePills(key, list) {
  const items = /** @type {NoticeOptions[]} */ (list.filter(Boolean));
  if (!items.length) return null;
  if (!pillsWatched) {
    pillsWatched = true;
    const close = (/** @type {Event} */ e) => {
      for (const box of document.querySelectorAll('details.notice-pill[open]')) {
        if (e instanceof KeyboardEvent ? e.key === 'Escape' : !box.contains(/** @type {Node} */ (e.target))) /** @type {HTMLDetailsElement} */ (box).open = false;
      }
    };
    document.addEventListener('pointerdown', close, true);
    document.addEventListener('keydown', close, true);
  }
  return PILL_TONES.map(([tone, iconName, noun, head]) => {
    const mine = items.filter((n) => (n.tone ?? 'error') === tone);
    if (!mine.length) return null;
    const id = `${key}:${tone}`;
    const count = `${mine.length} ${noun}${mine.length === 1 ? '' : 's'}`;
    return h('details', {
      class: `notice-pill ${tone}`,
      open: openPills.has(id),
      ontoggle: (/** @type {Event} */ ev) => {
        if (/** @type {HTMLDetailsElement} */ (ev.currentTarget).open) openPills.add(id);
        else openPills.delete(id);
      },
    },
      h('summary', { title: count, 'aria-label': count }, icon(iconName), h('span', null, String(mine.length))),
      h('div', { class: 'notice-pill-pop', role: tone === 'error' ? 'alert' : 'status' },
        h('p', { class: 'notice-pill-head' }, head),
        h('ul', null, mine.map((n) => h('li', null,
          h('p', null, n.text),
          n.actions?.length ? h('div', { class: 'notice-actions' }, n.actions) : null)))));
  });
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
  eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>',
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
  // AI providers' and coding harnesses' logos (LobeHub icons, MIT), filled in the text colour.
  'ai-claude': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M4.709 15.955l4.72-2.647.08-.23-.08-.128H9.2l-.79-.048-2.698-.073-2.339-.097-2.266-.122-.571-.121L0 11.784l.055-.352.48-.321.686.06 1.52.103 2.278.158 1.652.097 2.449.255h.389l.055-.157-.134-.098-.103-.097-2.358-1.596-2.552-1.688-1.336-.972-.724-.491-.364-.462-.158-1.008.656-.722.881.06.225.061.893.686 1.908 1.476 2.491 1.833.365.304.145-.103.019-.073-.164-.274-1.355-2.446-1.446-2.49-.644-1.032-.17-.619a2.97 2.97 0 01-.104-.729L6.283.134 6.696 0l.996.134.42.364.62 1.414 1.002 2.229 1.555 3.03.456.898.243.832.091.255h.158V9.01l.128-1.706.237-2.095.23-2.695.08-.76.376-.91.747-.492.584.28.48.685-.067.444-.286 1.851-.559 2.903-.364 1.942h.212l.243-.242.985-1.306 1.652-2.064.73-.82.85-.904.547-.431h1.033l.76 1.129-.34 1.166-1.064 1.347-.881 1.142-1.264 1.7-.79 1.36.073.11.188-.02 2.856-.606 1.543-.28 1.841-.315.833.388.091.395-.328.807-1.969.486-2.309.462-3.439.813-.042.03.049.061 1.549.146.662.036h1.622l3.02.225.79.522.474.638-.079.485-1.215.62-1.64-.389-3.829-.91-1.312-.329h-.182v.11l1.093 1.068 2.006 1.81 2.509 2.33.127.578-.322.455-.34-.049-2.205-1.657-.851-.747-1.926-1.62h-.128v.17l.444.649 2.345 3.521.122 1.08-.17.353-.608.213-.668-.122-1.374-1.925-1.415-2.167-1.143-1.943-.14.08-.674 7.254-.316.37-.729.28-.607-.461-.322-.747.322-1.476.389-1.924.315-1.53.286-1.9.17-.632-.012-.042-.14.018-1.434 1.967-2.18 2.945-1.726 1.845-.414.164-.717-.37.067-.662.401-.589 2.388-3.036 1.44-1.882.93-1.086-.006-.158h-.055L4.132 18.56l-1.13.146-.487-.456.061-.746.231-.243 1.908-1.312-.006.006z"></path></g>',
  'ai-openai': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M21.55 10.004a5.416 5.416 0 00-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0010.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 001.76 7.496a5.487 5.487 0 00.691 6.5 5.416 5.416 0 00.477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0013.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 003.715-2.66 5.488 5.488 0 00-.693-6.497v.001zm-8.381 11.558a4.199 4.199 0 01-2.675-.954c.034-.018.093-.05.132-.074l4.44-2.53a.71.71 0 00.364-.623v-6.176l1.877 1.069c.02.01.033.029.036.05v5.115c-.003 2.274-1.87 4.118-4.174 4.123zM4.192 17.78a4.059 4.059 0 01-.498-2.763c.032.02.09.055.131.078l4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138a.068.068 0 01-.027.057L9.9 19.288c-1.999 1.136-4.552.46-5.707-1.51h-.001zM3.023 8.216A4.15 4.15 0 015.198 6.41l-.002.151v5.06a.711.711 0 00.364.624l5.42 3.087-1.876 1.07a.067.067 0 01-.063.005l-4.489-2.559c-1.995-1.14-2.679-3.658-1.53-5.63h.001zm15.417 3.54l-5.42-3.088L14.896 7.6a.067.067 0 01.063-.006l4.489 2.557c1.998 1.14 2.683 3.662 1.529 5.633a4.163 4.163 0 01-2.174 1.807V12.38a.71.71 0 00-.363-.623zm1.867-2.773a6.04 6.04 0 00-.132-.078l-4.44-2.53a.731.731 0 00-.729 0l-5.42 3.088V7.325a.068.068 0 01.027-.057L14.1 4.713c2-1.137 4.555-.46 5.707 1.513.487.833.664 1.809.499 2.757h.001zm-11.741 3.81l-1.877-1.068a.065.065 0 01-.036-.051V6.559c.001-2.277 1.873-4.122 4.181-4.12.976 0 1.92.338 2.671.954-.034.018-.092.05-.131.073l-4.44 2.53a.71.71 0 00-.365.623l-.003 6.173v.002zm1.02-2.168L12 9.25l2.414 1.375v2.75L12 14.75l-2.415-1.375v-2.75z"></path></g>',
  'ai-gemini': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M20.616 10.835a14.147 14.147 0 01-4.45-3.001 14.111 14.111 0 01-3.678-6.452.503.503 0 00-.975 0 14.134 14.134 0 01-3.679 6.452 14.155 14.155 0 01-4.45 3.001c-.65.28-1.318.505-2.002.678a.502.502 0 000 .975c.684.172 1.35.397 2.002.677a14.147 14.147 0 014.45 3.001 14.112 14.112 0 013.679 6.453.502.502 0 00.975 0c.172-.685.397-1.351.677-2.003a14.145 14.145 0 013.001-4.45 14.113 14.113 0 016.453-3.678.503.503 0 000-.975 13.245 13.245 0 01-2.003-.678z"></path></g>',
  'ai-minimax': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M16.278 2c1.156 0 2.093.927 2.093 2.07v12.501a.74.74 0 00.744.709.74.74 0 00.743-.709V9.099a2.06 2.06 0 012.071-2.049A2.06 2.06 0 0124 9.1v6.561a.649.649 0 01-.652.645.649.649 0 01-.653-.645V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v7.472a2.037 2.037 0 01-2.048 2.026 2.037 2.037 0 01-2.048-2.026v-12.5a.785.785 0 00-.788-.753.785.785 0 00-.789.752l-.001 15.904A2.037 2.037 0 0113.441 22a2.037 2.037 0 01-2.048-2.026V18.04c0-.356.292-.645.652-.645.36 0 .652.289.652.645v1.934c0 .263.142.506.372.638.23.131.514.131.744 0a.734.734 0 00.372-.638V4.07c0-1.143.937-2.07 2.093-2.07zm-5.674 0c1.156 0 2.093.927 2.093 2.07v11.523a.648.648 0 01-.652.645.648.648 0 01-.652-.645V4.07a.785.785 0 00-.789-.78.785.785 0 00-.789.78v14.013a2.06 2.06 0 01-2.07 2.048 2.06 2.06 0 01-2.071-2.048V9.1a.762.762 0 00-.766-.758.762.762 0 00-.766.758v3.8a2.06 2.06 0 01-2.071 2.049A2.06 2.06 0 010 12.9v-1.378c0-.357.292-.646.652-.646.36 0 .653.29.653.646V12.9c0 .418.343.757.766.757s.766-.339.766-.757V9.099a2.06 2.06 0 012.07-2.048 2.06 2.06 0 012.071 2.048v8.984c0 .419.343.758.767.758.423 0 .766-.339.766-.758V4.07c0-1.143.937-2.07 2.093-2.07z"></path></g>',
  'ai-qwen': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z"></path></g>',
  'ai-deepseek': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M23.748 4.482c-.254-.124-.364.113-.512.234-.051.039-.094.09-.137.136-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.156-.708-.311-.955-.65-.172-.241-.219-.51-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.093.172.187.129.323-.082.28-.18.552-.266.833-.055.179-.137.217-.329.14a5.526 5.526 0 01-1.736-1.18c-.857-.828-1.631-1.742-2.597-2.458a11.365 11.365 0 00-.689-.471c-.985-.957.13-1.743.388-1.836.27-.098.093-.432-.779-.428-.872.004-1.67.295-2.687.684a3.055 3.055 0 01-.465.137 9.597 9.597 0 00-2.883-.102c-1.885.21-3.39 1.102-4.497 2.623C.082 8.606-.231 10.684.152 12.85c.403 2.284 1.569 4.175 3.36 5.653 1.858 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.133-.284 4.994-1.86.47.234.962.327 1.78.397.63.059 1.236-.03 1.705-.128.735-.156.684-.837.419-.961-2.155-1.004-1.682-.595-2.113-.926 1.096-1.296 2.746-2.642 3.392-7.003.05-.347.007-.565 0-.845-.004-.17.035-.237.23-.256a4.173 4.173 0 001.545-.475c1.396-.763 1.96-2.015 2.093-3.517.02-.23-.004-.467-.247-.588zM11.581 18c-2.089-1.642-3.102-2.183-3.52-2.16-.392.024-.321.471-.235.763.09.288.207.486.371.739.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.167-1.361-.802-2.5-1.86-3.301-3.307-.774-1.393-1.224-2.887-1.298-4.482-.02-.386.093-.522.477-.592a4.696 4.696 0 011.529-.039c2.132.312 3.946 1.265 5.468 2.774.868.86 1.525 1.887 2.202 2.891.72 1.066 1.494 2.082 2.48 2.914.348.292.625.514.891.677-.802.09-2.14.11-3.054-.614zm1-6.44a.306.306 0 01.415-.287.302.302 0 01.2.288.306.306 0 01-.31.307.303.303 0 01-.304-.308zm3.11 1.596c-.2.081-.399.151-.59.16a1.245 1.245 0 01-.798-.254c-.274-.23-.47-.358-.552-.758a1.73 1.73 0 01.016-.588c.07-.327-.008-.537-.239-.727-.187-.156-.426-.199-.688-.199a.559.559 0 01-.254-.078c-.11-.054-.2-.19-.114-.358.028-.054.16-.186.192-.21.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.391.451.462.576.685.914.176.265.336.537.445.848.067.195-.019.354-.25.452z"></path></g>',
  'ai-openrouter': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path d="M16.804 1.957l7.22 4.105v.087L16.73 10.21l.017-2.117-.821-.03c-1.059-.028-1.611.002-2.268.11-1.064.175-2.038.577-3.147 1.352L8.345 11.03c-.284.195-.495.336-.68.455l-.515.322-.397.234.385.23.53.338c.476.314 1.17.796 2.701 1.866 1.11.775 2.083 1.177 3.147 1.352l.3.045c.694.091 1.375.094 2.825.033l.022-2.159 7.22 4.105v.087L16.589 22l.014-1.862-.635.022c-1.386.042-2.137.002-3.138-.162-1.694-.28-3.26-.926-4.881-2.059l-2.158-1.5a21.997 21.997 0 00-.755-.498l-.467-.28a55.927 55.927 0 00-.76-.43C2.908 14.73.563 14.116 0 14.116V9.888l.14.004c.564-.007 2.91-.622 3.809-1.124l1.016-.58.438-.274c.428-.28 1.072-.726 2.686-1.853 1.621-1.133 3.186-1.78 4.881-2.059 1.152-.19 1.974-.213 3.814-.138l.02-1.907z"></path></g>',
  'ai-mistral': '<g fill="currentColor" fill-rule="evenodd" stroke="none"><path clip-rule="evenodd" d="M3.428 3.4h3.429v3.428h3.429v3.429h-.002 3.431V6.828h3.427V3.4h3.43v13.714H24v3.429H13.714v-3.428h-3.428v-3.429h-3.43v3.428h3.43v3.429H0v-3.429h3.428V3.4zm10.286 13.715h3.428v-3.429h-3.427v3.429z"></path></g>',
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
  plug: '<path d="M12 22v-5"/><path d="M9 8V2"/><path d="M15 8V2"/><path d="M18 8v5a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4V8Z"/>',
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
  'pr-merged': '<circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><path d="M6 21V8.5a9.5 9.5 0 0 0 9.5 9.5"/>',
  'pr-closed': '<circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><path d="M6 8.5V21"/><path d="M18 11v4.5"/><path d="m15.5 3.5 5 5"/><path d="m20.5 3.5-5 5"/>',
  repeat: '<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  terminal: '<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>',
  maximize: '<polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/>',
  minimize: '<polyline points="4 14 10 14 10 20"/><polyline points="20 10 14 10 14 4"/><line x1="14" y1="10" x2="21" y2="3"/><line x1="3" y1="21" x2="10" y2="14"/>',
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
