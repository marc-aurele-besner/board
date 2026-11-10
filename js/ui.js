// Small DOM and formatting helpers. No framework.

export const CURRENCY = 'USD'; // change to your currency code, e.g. 'CAD' or 'EUR'

// Build an element: h('button', { class: 'primary', onclick: fn }, 'Save')
// Attributes with null/undefined/false are skipped. `value` and `checked` are set after children exist.
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  const props = [];
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style') Object.assign(el.style, value);
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key === 'value' || key === 'checked') props.push([key, value]);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  for (const [key, value] of props) el[key] = value;
  return el;
}

export const uid = () =>
  globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;

export const now = () => new Date().toISOString();

// Local date as YYYY-MM-DD (toISOString alone would shift to UTC).
export function todayISO() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

export const monthKey = (isoDate) => isoDate.slice(0, 7); // YYYY-MM

const currencyFormat = new Intl.NumberFormat(undefined, { style: 'currency', currency: CURRENCY });
export const money = (n) => currencyFormat.format(n);

export const empty = (text) => h('p', { class: 'empty' }, text);
