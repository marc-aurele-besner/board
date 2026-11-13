// Slack's message markup (mrkdwn) as DOM: ```code```, `code`, > quotes, *bold*, _italic_, ~strike~, :emoji:,
// <@user>, <#channel|name>, <!here> and <https://…|label>. Built with nodes only, so nothing in a message runs.
import { h } from './ui.js';
/** @import { Child } from '../types/ui' */

/**
 * @typedef {{ user: (id: string) => string, me: string, emoji: (name: string) => Child }} MarkupContext
 */

const INLINE = /`([^`\n]+)`|<([^<>\s][^<>]*)>|(?<![\w*])\*(?!\s)([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?!\s)([^_\n]+?)_(?![\w_])|(?<![\w~])~(?!\s)([^~\n]+?)~(?![\w~])|:([a-z0-9_+'-]+(?:::skin-tone-\d)?):/g;

// Slack escapes only these three.
/** @param {string} s */
export const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/** @param {string} url */
const safeUrl = (url) => (/^(https?:|mailto:)/i.test(url) ? url : '');

// One <…> of Slack: a person, a channel, a broadcast, a date or a link.
/** @param {string} inner @param {MarkupContext} ctx */
function entity(inner, ctx) {
  const [target, label] = [inner.split('|')[0], inner.split('|').slice(1).join('|')];
  if (target.startsWith('@')) {
    const id = target.slice(1);
    return h('span', { class: id === ctx.me ? 'slack-mention me' : 'slack-mention' }, `@${label || ctx.user(id)}`);
  }
  if (target.startsWith('#')) return h('span', { class: 'slack-mention' }, `#${label || target.slice(1)}`);
  if (target.startsWith('!')) {
    const word = target.slice(1);
    if (/^(here|channel|everyone)$/.test(word)) return h('span', { class: 'slack-mention me' }, `@${word}`);
    if (word.startsWith('subteam^')) return h('span', { class: 'slack-mention' }, label || '@group');
    return decode(label || word);
  }
  const url = safeUrl(decode(target));
  return url ? h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, decode(label || target)) : decode(inner);
}

/** @param {string} text @param {MarkupContext} ctx @returns {Child[]} */
function inline(text, ctx) {
  /** @type {Child[]} */
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push(decode(text.slice(last, at)));
    const [, code, ent, bold, italic, strike, emoji] = m;
    if (code !== undefined) out.push(h('code', null, decode(code)));
    else if (ent !== undefined) out.push(entity(ent, ctx));
    else if (bold !== undefined) out.push(h('strong', null, inline(bold, ctx)));
    else if (italic !== undefined) out.push(h('em', null, inline(italic, ctx)));
    else if (strike !== undefined) out.push(h('s', null, inline(strike, ctx)));
    else out.push(ctx.emoji(emoji));
    last = at + m[0].length;
  }
  if (last < text.length) out.push(decode(text.slice(last)));
  return out;
}

// Lines, with runs of quoted lines (> or &gt;) gathered into one quote.
/** @param {string} text @param {MarkupContext} ctx @returns {Child[]} */
function lines(text, ctx) {
  /** @type {Child[]} */
  const out = [];
  /** @type {string[]} */
  let quote = [];
  const flush = () => {
    if (quote.length) out.push(h('blockquote', null, lines(quote.join('\n'), ctx)));
    quote = [];
  };
  const all = text.split('\n');
  all.forEach((line, i) => {
    const q = /^(?:&gt;|>) ?(.*)$/.exec(line);
    if (q) return void quote.push(q[1]);
    flush();
    out.push(...inline(line, ctx));
    if (i < all.length - 1) out.push(h('br'));
  });
  flush();
  return out;
}

// A message's text as nodes.
/** @param {string} text @param {MarkupContext} ctx */
export function markup(text, ctx) {
  /** @type {Child[]} */
  const out = [];
  const parts = text.split(/```/);
  parts.forEach((part, i) => {
    // Odd parts sit between fences; a fence left open is plain text.
    if (i % 2 === 1 && i < parts.length - 1) return void out.push(h('pre', null, decode(part.replace(/^\n|\n$/g, ''))));
    let t = i % 2 === 1 ? `\`\`\`${part}` : part;
    // The line breaks around a code block are the block's own.
    if (i > 0 && i % 2 === 0) t = t.replace(/^\n/, '');
    if (i < parts.length - 1) t = t.replace(/\n$/, '');
    if (t) out.push(...lines(t, ctx));
  });
  return h('div', { class: 'slack-text' }, out);
}
