// A colour picker for labels and projects: a swatch button that opens a popover with a curated palette, a hex
// field and the system picker for anything else. The popover previews the colour on the item's own pill, so
// the choice is seen as it will appear.
import { h, icon } from './ui.js';

// Mid-tone colours that read on light and dark backgrounds, both as a pill tint and as text.
export const SWATCHES = [
  '#2f6f4e', '#4d7c0f', '#2e8a8a', '#0f766e',
  '#3b6ea8', '#0369a1', '#4a5fb0', '#6d28d9',
  '#8a5a9e', '#be185d', '#b91c1c', '#a3432b',
  '#c2410c', '#b08416', '#57534e', '#475569',
];

const HEX = /^#?([0-9a-f]{6}|[0-9a-f]{3})$/i;

// "#abc" or "abc" to "#aabbcc"; null when the text is not a colour.
export function normalizeHex(text) {
  const m = HEX.exec(String(text ?? '').trim());
  if (!m) return null;
  const v = m[1].length === 3 ? [...m[1]].map((c) => c + c).join('') : m[1];
  return `#${v.toLowerCase()}`;
}

let open = null; // { el, anchor }

function close() {
  if (!open) return;
  open.el.remove();
  document.removeEventListener('pointerdown', onOutside, true);
  document.removeEventListener('keydown', onKey, true);
  const { anchor } = open;
  open = null;
  if (anchor.isConnected) anchor.focus();
}

function onOutside(e) {
  if (open && !open.el.contains(e.target) && !open.anchor.contains(e.target)) close();
}

function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation();
    close();
  }
}

function place(el, anchor) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.min(248, window.innerWidth - 16);
  el.style.width = `${width}px`;
  el.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
  const below = rect.bottom + 4;
  el.style.top = below + el.offsetHeight + 8 < window.innerHeight ? `${below}px` : `${Math.max(8, rect.top - 4 - el.offsetHeight)}px`;
}

function show(anchor, { value, name, onPick }) {
  close();
  let current = normalizeHex(value) ?? SWATCHES[0];
  const pick = (color) => {
    const v = normalizeHex(color);
    if (!v) return;
    close();
    if (v !== normalizeHex(value)) onPick(v);
  };

  const preview = h('span', { class: 'pill tone-custom' }, name || 'Preview');
  const hex = h('input', {
    class: 'cp-hex',
    value: current,
    maxlength: '7',
    spellcheck: false,
    autocomplete: 'off',
    'aria-label': 'Hex colour',
  });
  const native = h('input', { type: 'color', class: 'sr-only', value: current, 'aria-label': 'More colours' });
  const swatches = SWATCHES.map((c) =>
    h('button', {
      type: 'button',
      class: 'cp-swatch',
      style: { '--c': c },
      title: c,
      'aria-label': `Colour ${c}`,
      'aria-pressed': 'false',
      onclick: () => pick(c),
      onpointerenter: () => setPreview(c),
      onpointerleave: () => setPreview(current),
    }));

  function setPreview(color) {
    preview.style.setProperty('--c', color);
    for (const b of swatches) b.setAttribute('aria-pressed', String(b.title === current));
  }
  const setCurrent = (color) => {
    current = color;
    setPreview(color);
  };

  hex.addEventListener('input', () => {
    const v = normalizeHex(hex.value);
    hex.classList.toggle('invalid', !v);
    if (v) {
      setCurrent(v);
      native.value = v;
    }
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    pick(hex.value);
  });
  native.addEventListener('input', () => {
    hex.value = native.value;
    hex.classList.remove('invalid');
    setCurrent(native.value);
  });

  const el = h('div', { class: 'popover color-pop', role: 'dialog', 'aria-label': name ? `Colour of ${name}` : 'Choose a colour' },
    h('div', { class: 'cp-preview' }, preview),
    h('div', { class: 'cp-grid' }, swatches),
    h('div', { class: 'cp-custom' },
      h('label', { class: 'cp-more', title: 'More colours' }, icon('palette'), native),
      hex,
      h('button', { type: 'button', class: 'btn-small primary', onclick: () => pick(hex.value) }, 'Apply')));

  document.body.append(el);
  open = { el, anchor };
  setCurrent(current);
  place(el, anchor);
  (swatches.find((b) => b.title === current) ?? swatches[0]).focus();
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('keydown', onKey, true);
}

// The swatch button. `name` labels the preview pill and the button.
export function colorPicker({ value, name = '', onPick, className = '' }) {
  const btn = h('button', {
    type: 'button',
    class: `cp-button ${className}`.trim(),
    style: { '--c': value || SWATCHES[0] },
    title: 'Change the colour',
    'aria-label': name ? `Colour of ${name}` : 'Colour',
    'aria-haspopup': 'dialog',
    onclick: (e) => {
      e.stopPropagation();
      if (open?.anchor === btn) return close();
      show(btn, { value, name, onPick });
    },
  });
  return btn;
}
