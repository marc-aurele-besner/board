// Shows a description as rendered Markdown, the way Notion does: headings, bold, italic, inline code, code blocks,
// quotes, numbered and bulleted lists, "[ ]" / "[x]" checkboxes and tables. Bare links become link chips. The text
// itself is never changed; the view is only rendered.
import { h, icon } from './ui.js';
import { highlight, languageOf } from './highlight.js';

const URL_RE = /https?:\/\/[^\s<>"']+/g;
const TRAILING = /[.,;:!?)\]*_~`]+$/; // punctuation after a link is not part of it

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

// Inline Markdown, first match wins: `code`, [text](url), **bold**, __bold__, ~~strike~~, *italic*, _italic_, a bare link.
const INLINE_RE = new RegExp([
  /`([^`\n]+)`/.source,
  /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/.source,
  /\*\*(?!\s)(.+?)\*\*/.source,
  /(?<![\w])__(?!\s)(.+?)__(?![\w])/.source,
  /~~(?!\s)(.+?)~~/.source,
  /(?<![\w*])\*(?![\s*])(.+?)(?<![\s\\])\*(?!\*)/.source,
  /(?<![\w])_(?![\s_])(.+?)(?<!\s)_(?![\w])/.source,
  URL_RE.source,
].join('|'), 'g');

// Text with its Markdown marks drawn and its links turned into chips.
/** @param {string} text @returns {(HTMLElement | string)[]} */
function inlineParts(text) {
  /** @type {(HTMLElement | string)[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE_RE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const [all, code, label, href, bold, bold2, strike, em, em2] = m;
    if (code !== undefined) out.push(h('code', { class: 'rich-code-inline' }, code));
    else if (label !== undefined) out.push(h('a', { href, target: '_blank', rel: 'noopener noreferrer', class: 'rich-a', title: href }, inlineParts(label)));
    else if (bold !== undefined || bold2 !== undefined) out.push(h('strong', null, inlineParts(bold ?? bold2)));
    else if (strike !== undefined) out.push(h('s', null, inlineParts(strike)));
    else if (em !== undefined || em2 !== undefined) out.push(h('em', null, inlineParts(em ?? em2)));
    else out.push(...linkChip(all));
    last = m.index + all.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

// One line of text, wrapped so the row's flex gap does not split its words and marks apart.
/** @param {string} text @param {string} [cls] */
function inline(text, cls = '') {
  const parts = inlineParts(text);
  return h('span', { class: `rich-text ${cls}`.trim() }, parts.length ? parts : ' ');
}

// A fenced code block, coloured like the Dev file reader when its language is known.
/** @param {string[]} lines @param {string} lang */
function codeBlock(lines, lang) {
  const runs = highlight(lines.join('\n'), languageOf(`x.${lang.toLowerCase()}`));
  return h('pre', { class: 'rich-code' },
    h('code', null, runs.map((line, i) => [
      i ? '\n' : '',
      line.map(([cls, t]) => (cls ? h('span', { class: `tok-${cls}` }, t) : t)),
    ])));
}

// A Markdown table row's cells, without the outer pipes.
/** @param {string} line */
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
const TABLE_RULE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

/** @param {string[]} rows */
function table(rows) {
  const [head, , ...body] = rows;
  return h('div', { class: 'rich-table-wrap' },
    h('table', { class: 'rich-table' },
      h('thead', null, h('tr', null, cells(head).map((c) => h('th', null, inlineParts(c))))),
      h('tbody', null, body.map((r) => h('tr', null, cells(r).map((c) => h('td', null, inlineParts(c))))))));
}

// How far a list line is indented, in nesting steps of two spaces (a tab counts as one step).
/** @param {string} lead */
const depth = (lead) => Math.min(6, Math.floor(lead.replace(/\t/g, '  ').length / 2));

// The rendered description, one row per line of the text, except code blocks and tables, which take several.
/** @param {unknown} [text] */
export function richText(text = '') {
  const lines = String(text).split('\n');
  /** @type {HTMLElement[]} */
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const fence = line.match(/^\s*(`{3,}|~{3,})\s*([\w+#.-]*)/);
    if (fence) {
      const close = new RegExp(`^\\s*${fence[1][0] === '`' ? '`' : '~'}{${fence[1].length},}\\s*$`);
      const body = [];
      while (++i < lines.length && !close.test(lines[i])) body.push(lines[i]);
      out.push(codeBlock(body, fence[2]));
      continue;
    }

    if (line.includes('|') && TABLE_RULE.test(lines[i + 1] ?? '') && lines[i + 1].includes('-')) {
      const rows = [line, lines[i + 1]];
      i += 2;
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(lines[i++]);
      i--;
      out.push(table(rows));
      continue;
    }

    const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (heading) {
      out.push(h('div', { class: `rich-line rich-h rich-h${Math.min(heading[1].length, 4)}`, role: 'heading', 'aria-level': String(heading[1].length) }, inline(heading[2])));
      continue;
    }

    if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(h('hr', { class: 'rich-hr' }));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      out.push(h('div', { class: 'rich-line rich-quote' }, inline(quote[1])));
      continue;
    }

    const task = line.match(/^(\s*)(?:[-*+]\s+)?\[( |x|X)\]\s+(.*)$/);
    if (task) {
      const done = task[2].toLowerCase() === 'x';
      out.push(h('div', { class: 'rich-line task', style: { '--depth': depth(task[1]) } },
        h('input', { type: 'checkbox', checked: done, disabled: true, class: 'rich-check' }),
        inline(task[3], done ? 'rich-done' : '')));
      continue;
    }

    const bullet = line.match(/^(\s*)[-*+]\s+(.*)$/);
    if (bullet) {
      out.push(h('div', { class: 'rich-line bullet', style: { '--depth': depth(bullet[1]) } },
        h('span', { class: 'rich-bullet', 'aria-hidden': 'true' }, depth(bullet[1]) % 2 ? '◦' : '•'), inline(bullet[2])));
      continue;
    }

    const numbered = line.match(/^(\s*)(\d{1,9})[.)]\s+(.*)$/);
    if (numbered) {
      out.push(h('div', { class: 'rich-line bullet numbered', style: { '--depth': depth(numbered[1]) } },
        h('span', { class: 'rich-num' }, `${numbered[2]}.`), inline(numbered[3])));
      continue;
    }

    out.push(h('div', { class: 'rich-line' }, inline(line)));
  }
  return out;
}
