// The emoji picker, laid out like Slack's: a search field, a tab per category, every emoji in one scrolling list with
// a heading per category, the hovered emoji's name at the bottom and a skin tone choice. Frequently used comes first,
// the workspace's own emoji last.

import { h, icon } from './ui.js';
/** @import { Child } from '../types/ui' */
/** @import { IconName } from './ui.js' */
import { openDialog } from './modal.js';
import { EMOJI_CATEGORIES, QUICK_REACTIONS, takesSkinTone } from './emoji.js';

const RECENT_KEY = 'board:emoji-recent';
const TONE_KEY = 'board:emoji-tone';
const RECENT_MAX = 24;

/** @type {Record<string, IconName>} */
const TAB_ICONS = {
  frequent: 'clock', people: 'smile', nature: 'leaf', food: 'coffee', activity: 'trophy',
  travel: 'car', objects: 'lightbulb', symbols: 'heart', flags: 'flag', custom: 'sparkle',
};

// The raised hand in each tone, for the tone buttons.
const TONE_HANDS = ['✋', '✋🏻', '✋🏼', '✋🏽', '✋🏾', '✋🏿'];

// Browser storage may be off (a private window, blocked site data): the picker works without it.
/** @param {string} key */
function read(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}
/** @param {string} key @param {string} value */
function write(key, value) {
  try { localStorage.setItem(key, value); } catch { /* not kept */ }
}

/** @typedef {{ n: string, c: number, t: number }} Use an emoji's name, times used and last use */

// Read once: the Slack tab asks for every message it draws. rememberEmoji() keeps it current.
/** @type {Use[] | null} */
let cache = null;

/** @returns {Use[]} a copy, safe to sort and change */
function uses() {
  cache ??= load();
  return cache.map((u) => ({ ...u }));
}

/** @returns {Use[]} */
function load() {
  try {
    const list = JSON.parse(read(RECENT_KEY) ?? '[]');
    if (!Array.isArray(list)) return [];
    // The first version kept bare names, newest first.
    return list.map((u, i) => (typeof u === 'string' ? { n: u, c: 1, t: -i } : u))
      .filter((u) => u && typeof u.n === 'string' && typeof u.c === 'number' && typeof u.t === 'number');
  } catch {
    return [];
  }
}

const DAY = 86_400_000;

// Like Slack's frequently used: how often, worth less the longer ago it was last used.
/** @param {Use} u @param {number} now */
const frecency = (u, now) => u.c / (1 + Math.max(0, now - u.t) / (7 * DAY));

/**
 * The emoji used most lately, best first, filled up with Slack's usual ones.
 * @param {number} [count]
 */
export function frequentEmoji(count = RECENT_MAX) {
  const now = Date.now();
  const mine = uses().sort((a, b) => frecency(b, now) - frecency(a, now)).map((u) => u.n);
  return [...new Set([...mine, ...QUICK_REACTIONS])].slice(0, count);
}

// Counts a use of an emoji (a reaction added, however it was added).
/** @param {string} name */
export function rememberEmoji(name) {
  const now = Date.now();
  const list = uses();
  const u = list.find((x) => x.n === name);
  if (u) { u.c++; u.t = now; } else list.push({ n: name, c: 1, t: now });
  // Keep the best ones, so a long tail of one-offs does not grow forever.
  list.sort((a, b) => frecency(b, now) - frecency(a, now));
  cache = list.slice(0, 60);
  write(RECENT_KEY, JSON.stringify(cache));
}

// How well a name matches the search: lower is better, -1 when it does not.
/** @param {string} name @param {string} q */
function score(name, q) {
  if (name === q) return 0;
  if (name.startsWith(q)) return 1;
  if (name.includes(`_${q}`) || name.includes(`-${q}`)) return 2;
  return name.includes(q) ? 3 : -1;
}

/**
 * Opens the picker. `render` draws one emoji by name (a character, or a custom emoji's image); `custom` lists the
 * workspace's own emoji names. The caller counts a pick it uses with rememberEmoji().
 * @param {{ title?: string, custom: string[], render: (name: string) => Child, onPick: (name: string) => void }} options
 */
export function pickEmoji({ title = 'Add a reaction', custom, render, onPick }) {
  let tone = Number(read(TONE_KEY)) || 1;
  /** @param {string} name */
  const toned = (name) => (tone > 1 && takesSkinTone(name) ? `${name}::skin-tone-${tone}` : name);

  const sections = [
    { id: 'frequent', label: 'Frequently used', names: frequentEmoji() },
    ...EMOJI_CATEGORIES.map((c) => ({ id: c.id, label: c.label, names: c.emoji.map((e) => e.names[0]) })),
    ...(custom.length ? [{ id: 'custom', label: 'Custom', names: [...custom].sort() }] : []),
  ];
  // Every name a search looks through: an emoji matches by any of its aliases, and shows by its first name.
  const searchable = [
    ...EMOJI_CATEGORIES.flatMap((c) => c.emoji.map((e) => ({ name: e.names[0], names: e.names }))),
    ...custom.map((n) => ({ name: n, names: [n] })),
  ];

  const previewChar = h('span', { class: 'emoji-picker-preview-char' });
  const previewName = h('span', { class: 'emoji-picker-preview-name muted' });
  /** @param {string} [name] */
  const preview = (name) => {
    previewChar.replaceChildren(h('span', null, name ? render(name) : ''));
    previewName.textContent = name ? `:${name}:` : 'Hover an emoji to see its name';
  };

  /** @param {string} name */
  const pick = (name) => {
    dialog.close();
    onPick(name);
  };
  /** @param {string} base */
  const choice = (base) => {
    const name = toned(base);
    return h('button', {
      type: 'button',
      class: 'emoji-picker-choice',
      title: `:${name}:`,
      'aria-label': `:${name}:`,
      onclick: () => pick(name),
      onpointerenter: () => preview(name),
      onfocus: () => preview(name),
    }, render(name));
  };

  const scroller = h('div', { class: 'emoji-picker-scroll', onscroll: () => syncTab() });
  /** @type {Map<string, HTMLElement>} */
  const sectionEls = new Map();
  /** @type {Map<string, HTMLElement>} */
  const tabEls = new Map();

  const drawAll = () => {
    sectionEls.clear();
    scroller.replaceChildren(...sections.map((s) => {
      const el = h('section', { class: 'emoji-picker-section' },
        h('h3', { class: 'emoji-picker-head' }, s.label),
        h('div', { class: 'emoji-picker-grid' }, s.names.map(choice)));
      sectionEls.set(s.id, el);
      return el;
    }));
  };

  /** @type {string[]} */
  let results = [];
  /** @param {string} raw */
  const search = (raw) => {
    const q = raw.trim().toLowerCase().replace(/^:+|:+$/g, '').replace(/\s+/g, '_');
    tabs.hidden = !!q;
    if (!q) {
      results = [];
      drawAll();
      scroller.scrollTop = 0;
      syncTab();
      return;
    }
    results = searchable
      .map((e, i) => ({ name: e.name, i, s: Math.min(...e.names.map((n) => score(n, q)).map((s) => (s < 0 ? 9 : s))) }))
      .filter((e) => e.s < 9)
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .slice(0, 300)
      .map((e) => e.name);
    scroller.replaceChildren(results.length
      ? h('section', { class: 'emoji-picker-section' },
          h('h3', { class: 'emoji-picker-head' }, 'Search results'),
          h('div', { class: 'emoji-picker-grid' }, results.map(choice)))
      : h('p', { class: 'muted small emoji-picker-empty' }, `No emoji match “${raw.trim()}”.`));
    scroller.scrollTop = 0;
  };

  // The tab of the category at the top of the list.
  const syncTab = () => {
    let current = sections[0].id;
    for (const [id, el] of sectionEls) if (el.offsetTop <= scroller.scrollTop + 8) current = id;
    for (const [id, tab] of tabEls) tab.classList.toggle('active', id === current);
  };

  const tabs = h('nav', { class: 'emoji-picker-tabs', 'aria-label': 'Emoji categories' }, sections.map((s) => {
    const tab = h('button', {
      type: 'button',
      class: 'emoji-picker-tab',
      title: s.label,
      'aria-label': s.label,
      onclick: () => {
        const el = sectionEls.get(s.id);
        if (el) scroller.scrollTop = el.offsetTop;
      },
    }, icon(TAB_ICONS[s.id] ?? 'smile'));
    tabEls.set(s.id, tab);
    return tab;
  }));

  const input = h('input', {
    type: 'search',
    class: 'emoji-picker-search',
    placeholder: 'Search all emoji',
    'aria-label': 'Search all emoji',
    oninput: () => search(input.value),
    /** @param {KeyboardEvent} e */
    onkeydown: (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const first = results[0] ?? (input.value.trim() ? '' : sections[0].names[0]);
      if (first) pick(toned(first));
    },
  });

  const toneButtons = TONE_HANDS.map((hand, i) => h('button', {
    type: 'button',
    class: 'emoji-picker-tone',
    title: i ? `Skin tone ${i + 1}` : 'Default skin tone',
    'aria-label': i ? `Skin tone ${i + 1}` : 'Default skin tone',
    'aria-pressed': String(tone === i + 1),
    onclick: () => {
      tone = i + 1;
      write(TONE_KEY, String(tone));
      toneButtons.forEach((b, j) => b.setAttribute('aria-pressed', String(j === i)));
      const top = scroller.scrollTop;
      search(input.value);
      scroller.scrollTop = top;
      input.focus();
    },
  }, hand));

  drawAll();
  preview();
  const dialog = openDialog({
    title,
    body: h('div', { class: 'emoji-picker' },
      h('div', { class: 'emoji-picker-search-row' }, icon('search'), input),
      tabs,
      scroller,
      h('footer', { class: 'emoji-picker-foot' },
        h('span', { class: 'emoji-picker-preview' }, previewChar, previewName),
        h('span', { class: 'emoji-picker-tones', role: 'group', 'aria-label': 'Skin tone' }, toneButtons))),
  });
  input.focus();
  syncTab();
}
