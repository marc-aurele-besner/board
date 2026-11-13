// A "/" typed in a text field lists Claude Code's skills under the caret, as claude's own prompt does: typing
// narrows the list, the arrows move through it, Enter or Tab writes the skill's name, Escape closes it.
import { h } from './ui.js';

/** @typedef {{ name: string, description: string, hint?: string }} SlashItem */

const MAX_ROWS = 40;

// The "/word" the caret is at the end of: at the start of a line or after a space, so a path or a link is left alone.
/** @param {string} before the text up to the caret */
export function slashToken(before) {
  const m = /(?:^|\s)\/([\w:.-]*)$/.exec(before);
  return m ? { query: m[1], start: before.length - m[1].length - 1 } : null;
}

// The items a query keeps: names starting with it, then names holding it, then descriptions holding it.
/** @param {SlashItem[]} items @param {string} query */
export function slashMatches(items, query) {
  const q = query.toLowerCase();
  if (!q) return items;
  const rank = (/** @type {SlashItem} */ s) => {
    const name = s.name.toLowerCase();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    return s.description.toLowerCase().includes(q) ? 2 : 3;
  };
  return items.map((s) => ({ s, r: rank(s) })).filter((x) => x.r < 3).sort((a, b) => a.r - b.r).map((x) => x.s);
}

// Where the caret is on screen: the field's text up to it is laid out in a hidden copy of the field.
/** @param {HTMLTextAreaElement | HTMLInputElement} field @param {number} at */
function caretPoint(field, at) {
  const style = getComputedStyle(field);
  const copy = h('div', { 'aria-hidden': 'true' });
  for (const p of ['boxSizing', 'width', 'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight', 'textTransform', 'tabSize',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth']) {
    copy.style.setProperty(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`), style.getPropertyValue(p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)));
  }
  const multiline = field instanceof HTMLTextAreaElement;
  Object.assign(copy.style, { position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', borderStyle: 'solid', overflow: 'hidden',
    whiteSpace: multiline ? 'pre-wrap' : 'pre', overflowWrap: multiline ? 'break-word' : 'normal' });
  const mark = h('span', null, '​');
  copy.append(field.value.slice(0, at), mark);
  document.body.append(copy);
  const rect = field.getBoundingClientRect();
  const point = { left: rect.left + mark.offsetLeft - field.scrollLeft, top: rect.top + mark.offsetTop - field.scrollTop, height: mark.offsetHeight };
  copy.remove();
  return point;
}

// Lists `load()`'s items under the caret of `field` while a "/word" is being typed. The list is asked for on the
// first "/"; a load that fails or finds nothing shows no list.
/** @param {HTMLTextAreaElement | HTMLInputElement} field @param {() => Promise<SlashItem[]>} load */
export function slashComplete(field, load) {
  /** @type {HTMLElement | null} */
  let pop = null;
  /** @type {SlashItem[]} */
  let rows = [];
  let at = 0;
  let start = 0;
  // Each keystroke asks again; only the answer to the last one is drawn.
  let asked = 0;

  /** @param {PointerEvent} e */
  const onOutside = (e) => {
    if (pop && !pop.contains(/** @type {Node} */ (e.target)) && e.target !== field) close();
  };
  function close() {
    asked++;
    if (!pop) return;
    pop.remove();
    pop = null;
    document.removeEventListener('pointerdown', onOutside, true);
  }

  /** @param {SlashItem} s */
  function pick(s) {
    const end = field.selectionStart ?? field.value.length;
    const after = field.value.slice(end);
    // One space after the name, where its arguments go.
    field.setRangeText(`/${s.name}${/^\s/.test(after) ? '' : ' '}`, start, end, 'end');
    close();
    field.focus();
  }

  function draw() {
    if (!pop) {
      pop = h('div', { class: 'popover slash-pop', role: 'listbox', 'aria-label': 'Skills' });
      document.body.append(pop);
      document.addEventListener('pointerdown', onOutside, true);
    }
    pop.replaceChildren(...rows.map((s, i) => h('button', {
      type: 'button',
      class: i === at ? 'pop-item slash-item cursor' : 'pop-item slash-item',
      role: 'option',
      'aria-selected': String(i === at),
      title: s.description,
      // The field keeps the focus: losing it would end the edit.
      onpointerdown: (/** @type {Event} */ e) => e.preventDefault(),
      onclick: () => pick(s),
    },
      h('span', { class: 'slash-name' }, `/${s.name}`),
      s.description ? h('span', { class: 'slash-desc muted' }, s.description) : null,
      s.hint ? h('span', { class: 'slash-hint muted' }, s.hint) : null)));
    const caret = caretPoint(field, start);
    const width = Math.min(420, window.innerWidth - 16);
    pop.style.width = `${width}px`;
    pop.style.left = `${Math.max(8, Math.min(caret.left, window.innerWidth - width - 8))}px`;
    const below = caret.top + caret.height + 4;
    const height = pop.offsetHeight;
    pop.style.top = below + height + 8 <= window.innerHeight || caret.top - 4 - height < 8 ? `${below}px` : `${caret.top - 4 - height}px`;
    pop.querySelector('.cursor')?.scrollIntoView({ block: 'nearest' });
  }

  async function update() {
    const caret = field.selectionStart ?? 0;
    const token = field.selectionEnd === caret ? slashToken(field.value.slice(0, caret)) : null;
    if (!token) return close();
    const mine = ++asked;
    const items = await load().catch(() => /** @type {SlashItem[]} */ ([]));
    if (mine !== asked || !field.isConnected) return;
    const next = slashMatches(items, token.query).slice(0, MAX_ROWS);
    if (!next.length) return close();
    // The highlight follows its skill while the list narrows, and starts at the top otherwise.
    const kept = rows[at] ? next.findIndex((s) => s.name === rows[at].name) : -1;
    rows = next;
    at = pop && kept >= 0 ? kept : 0;
    start = token.start;
    draw();
  }

  field.addEventListener('input', update);
  // A click or an arrow that moves the caret off the "/word" closes the list.
  field.addEventListener('click', () => pop && update());
  field.addEventListener('keyup', (e) => {
    if (pop && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(/** @type {KeyboardEvent} */ (e).key)) update();
  });
  field.addEventListener('blur', close);
  field.addEventListener('keydown', (event) => {
    const e = /** @type {KeyboardEvent} */ (event);
    if (!pop || e.isComposing) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      at = (at + (e.key === 'ArrowDown' ? 1 : rows.length - 1)) % rows.length;
      draw();
    } else if ((e.key === 'Enter' && !e.metaKey && !e.ctrlKey) || e.key === 'Tab') {
      pick(rows[at]);
    } else if (e.key === 'Escape') {
      close();
    } else {
      return;
    }
    // The field's own keys (Enter saves, Escape cancels the edit) are not for the list's.
    e.preventDefault();
    e.stopImmediatePropagation();
  });
}
