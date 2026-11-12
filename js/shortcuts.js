// Keyboard shortcuts that work outside a field, and the sheet that lists them ("?").
import { h } from './ui.js';
import { openDialog } from './modal.js';

// "g" then one of these letters jumps to a section.
export const JUMPS = [
  ['h', 'home', 'Board'],
  ['t', 'todos', 'Tasks'],
  ['a', 'calendar', 'Calendar'],
  ['p', 'projects', 'Projects'],
  ['k', 'kitchen', 'Kitchen'],
  ['m', 'money', 'Money'],
  ['l', 'positions', 'Liquidity Pools'],
  ['i', 'inbox', 'Inbox'],
  ['o', 'monitoring', 'Monitoring'],
  ['u', 'tools', 'Tools'],
  ['d', 'dev', 'Dev'],
  ['c', 'cron', 'Cron'],
  ['s', 'settings', 'Settings'],
];

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
/** @type {{ close: () => void } | null} */
let sheet = null;

/** @param {...string} names */
const keys = (...names) => h('span', { class: 'keys' }, names.map((k) => h('kbd', null, k)));
/** @param {HTMLElement} combo @param {string} text */
const row = (combo, text) => h('li', null, combo, h('span', null, text));

export function openShortcuts() {
  sheet?.close();
  sheet = openDialog({
    title: 'Keyboard shortcuts',
    body: h('div', { class: 'stack' },
      h('ul', { class: 'shortcut-list' },
        row(keys(isMac ? '⌘' : 'Ctrl', 'K'), 'Search, jump, or capture'),
        row(keys('/'), 'The same, when not typing in a field'),
        row(keys('n'), 'New task: opens the search box, type it and press Enter'),
        row(keys('?'), 'This list'),
        row(keys('Esc'), 'Close a dialog, the search box or the notifications')),
      h('h3', null, 'Go to'),
      h('ul', { class: 'shortcut-list' }, JUMPS.map(([key, , title]) => row(keys('g', key), title))),
      h('p', { class: 'muted small' }, 'Press g, then the letter within a second and a half. Shortcuts wait while you type in a field.')),
  });
}
