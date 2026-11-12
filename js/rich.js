// @ts-check
// Shows a description the way Notion does: links become link chips, "- " lines become bullets,
// and "[ ]" / "[x]" lines become checkboxes. The text itself is never changed; the view is only rendered.
import { h, icon } from './ui.js';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]]+$/; // punctuation after a link is not part of it

// A link as a chip: the site name, then the path if there is one. Clicking opens it in a new tab.
/** @param {string} raw */
function linkChip(raw) {
  const url = raw.replace(TRAILING, '');
  const tail = raw.slice(url.length);
  let host = url;
  let path = '';
  try {
    const u = new URL(url);
    host = u.host.replace(/^www\./, '');
    path = u.pathname === '/' ? '' : u.pathname;
  } catch {
    /* keep the raw text as the label */
  }
  if (path.length > 30) path = `${path.slice(0, 29)}…`;
  const chip = h('a', {
    href: url,
    target: '_blank',
    rel: 'noopener noreferrer',
    class: 'rich-link',
    title: url,
  },
    icon('link'),
    h('span', { class: 'rich-host' }, host),
    path ? h('span', { class: 'rich-path' }, path) : null);
  return tail ? [chip, tail] : [chip];
}

// Text with its links turned into chips.
/** @param {string} text */
function inline(text) {
  /** @type {(HTMLElement | string)[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(...linkChip(m[0]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length ? out : [' '];
}

// The rendered description, one row per line of the text.
/** @param {unknown} [text] */
export function richText(text = '') {
  return String(text).split('\n').map((line) => {
    const task = line.match(/^\s*\[( |x|X)\]\s+(.*)$/);
    if (task) {
      return h('div', { class: 'rich-line task' },
        h('input', { type: 'checkbox', checked: task[1].toLowerCase() === 'x', disabled: true, class: 'rich-check' }),
        h('span', { class: task[1].toLowerCase() === 'x' ? 'rich-done' : '' }, inline(task[2])));
    }
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      return h('div', { class: 'rich-line bullet' }, h('span', { class: 'rich-bullet', 'aria-hidden': 'true' }, '•'), h('span', null, inline(bullet[1])));
    }
    return h('div', { class: 'rich-line' }, inline(line));
  });
}
