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

/** @returns {string[]} the names picked lately, newest first */
function recent() {
  try {
    const list = JSON.parse(read(RECENT_KEY) ?? '[]');
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

/** @param {string} name */
function remember(name) {
  write(RECENT_KEY, JSON.stringify([name, ...recent().filter((n) => n !== name)].slice(0, RECENT_MAX)));
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
 * workspace's own emoji names.
 * @param {{ title?: string, custom: string[], render: (name: string) => Child, onPick: (name: string) => void }} options
 */
export function pickEmoji({ title = 'Add a reaction', custom, render, onPick }) {
  let tone = Number(read(TONE_KEY)) || 1;
  /** @param {string} name */
  const toned = (name) => (tone > 1 && takesSkinTone(name) ? `${name}::skin-tone-${tone}` : name);

  const sections = [
    { id: 'frequent', label: 'Frequently used', names: [...new Set([...recent(), ...QUICK_REACTIONS])].slice(0, RECENT_MAX) },
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
    remember(name);
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
