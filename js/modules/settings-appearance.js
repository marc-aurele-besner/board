// Settings → Appearance: how the board looks, opens and reads dates and numbers, and whether a removal asks first.
// Every choice is saved in this browser (js/appearance.js, js/locale.js) and applies as it is picked.
import { h, icon } from '../ui.js';
import { pickChip } from '../inline.js';
import { keepAwakeOn, keepAwakeSupported, setKeepAwake } from '../wake-lock.js';
import {
  ACCENTS, ACCENT_KEY, CONFIRM_KEY, DENSITY_KEY, LINKS_KEY, MOTION_KEY, START_KEY, TEXT_KEY, THEME_KEY,
  applyAppearance, hiddenSections, readChoice, saveChoice, setSectionHidden,
} from '../appearance.js';
import {
  CLOCKS, CLOCK_KEY, DATE_FORMATS, DATE_FORMAT_KEY, NUMBER_FORMATS, NUMBER_FORMAT_KEY, WEEK_STARTS, WEEK_START_KEY,
  dateLocale, numberLocale, weekStart,
} from '../locale.js';
/** @import { Store, Module } from '../../types/data' */
/** @import { Child } from '../../types/ui' */

/**
 * A row: its name and what it does on the left, the control on the right.
 * @param {string} label @param {string} about @param {Child} control
 */
const row = (label, about, control) => h('div', { class: 'appearance-row' },
  h('div', { class: 'grow' }, h('strong', null, label), about ? h('p', { class: 'muted small' }, about) : null),
  control);

/**
 * Buttons side by side, one of them on.
 * @param {Store} store @param {string} label @param {string} key @param {[string, string][]} options @param {string} [fallback]
 */
function segmented(store, label, key, options, fallback = '') {
  const current = readChoice(key) || fallback;
  return h('div', { class: 'segmented app-seg', role: 'radiogroup', 'aria-label': label },
    options.map(([value, text]) => h('button', {
      type: 'button',
      role: 'radio',
      class: current === value ? 'seg active' : 'seg',
      'aria-checked': String(current === value),
      onclick: () => {
        saveChoice(key, value === fallback ? '' : value);
        applyAppearance();
        store.refresh();
      },
    }, text)));
}

/** @param {Store} store @param {string} label @param {boolean} on @param {(on: boolean) => void} set @param {boolean} [disabled] */
const toggle = (store, label, on, set, disabled = false) => h('label', { class: 'check' },
  h('input', {
    type: 'checkbox',
    role: 'switch',
    checked: on,
    disabled,
    'aria-label': label,
    onchange: (/** @type {{ target: HTMLInputElement }} */ e) => {
      set(e.target.checked);
      store.refresh();
    },
  }),
  on ? 'On' : 'Off');

/** @param {string} title @param {...Child} rows */
const group = (title, ...rows) => h('div', { class: 'svc-section appearance-group' }, h('h3', null, title), ...rows);

// The sections, read once: the registry imports this page's module, so it is loaded after, not at the top.
/** @type {Module[] | null} */
let sectionList = null;

/** @param {Store} store */
export function appearanceCard(store) {
  if (!sectionList) {
    import('./index.js').then((m) => {
      sectionList = m.modules;
      store.refresh();
    });
  }
  const sections = (sectionList ?? []).filter((m) => !m.hidden);
  const hidden = hiddenSections();
  const accent = readChoice(ACCENT_KEY);
  const sample = new Date(2026, 10, 14, 9, 41);
  const preview = [
    sample.toLocaleDateString(dateLocale(), { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }),
    sample.toLocaleDateString(dateLocale()),
    sample.toLocaleTimeString(dateLocale(), { hour: 'numeric', minute: '2-digit' }),
    (1234.56).toLocaleString(numberLocale(), { minimumFractionDigits: 2 }),
    `weeks start on ${WEEK_STARTS.find(([d]) => Number(d) === weekStart())?.[1]}`,
  ].join(' · ');

  return h('section', { class: 'card panel' },
    h('header', { class: 'panel-head' },
      h('div', null,
        h('h2', null, 'Appearance'),
        h('p', { class: 'muted' }, 'How the board looks and reads on this computer. Saved in this browser, and changes apply as you pick them.'))),

    group('Look',
      row('Theme', 'System follows your computer’s setting.', segmented(store, 'Theme', THEME_KEY, [['', 'System'], ['light', 'Light'], ['dark', 'Dark']])),
      row('Accent colour', 'Buttons, links and what is selected.',
        h('div', { class: 'accent-swatches', role: 'radiogroup', 'aria-label': 'Accent colour' },
          ACCENTS.map(([value, name]) => h('button', {
            type: 'button',
            role: 'radio',
            class: `accent-swatch${accent === value ? ' active' : ''}`,
            'data-swatch': value || 'blue',
            'aria-checked': String(accent === value),
            'aria-label': name,
            title: name,
            onclick: () => {
              saveChoice(ACCENT_KEY, value);
              applyAppearance();
              store.refresh();
            },
          })))),
      row('Density', 'Compact tightens the rows in tasks, projects and the board.', segmented(store, 'Density', DENSITY_KEY, [['', 'Comfortable'], ['compact', 'Compact']])),
      row('Text size', 'Everything on the page grows or shrinks with it.', segmented(store, 'Text size', TEXT_KEY, [['small', 'Small'], ['', 'Default'], ['large', 'Large']]))),

    group('Navigation',
      row('Start page', 'What the board opens on when the address names no section.',
        pickChip({
          value: readChoice(START_KEY) || 'home',
          options: sections.map((m) => ({ value: m.id, label: m.title, plainIcon: () => icon(m.icon) })),
          className: 'field-pick',
          onPick: (v) => {
            saveChoice(START_KEY, v && v !== 'home' ? v : '');
            store.refresh();
          },
        })),
      h('div', { class: 'appearance-row is-wide' },
        h('div', null, h('strong', null, 'Top bar'), h('p', { class: 'muted small' }, 'Switch off the sections you do not use. A hidden section still opens from a link, search or its shortcut, and shows in the bar while it is open.')),
        h('div', { class: 'nav-chips' },
          sections.map((m) => {
            const on = !hidden.has(m.id);
            return h('button', {
              type: 'button',
              role: 'switch',
              class: on ? 'nav-chip active' : 'nav-chip',
              'aria-checked': String(on),
              onclick: () => {
                setSectionHidden(m.id, on);
                store.refresh();
              },
            }, icon(m.icon), m.short ?? m.title);
          })))),

    group('Dates & numbers',
      h('p', { class: 'appearance-preview', 'aria-live': 'polite' }, h('span', { class: 'muted small' }, 'Shown as '), h('strong', null, preview)),
      row('Week starts on', 'Calendar’s weeks and months, the weekly groups in Money and Liquidity Pools, Cron’s day lists.', segmented(store, 'Week starts on', WEEK_START_KEY, WEEK_STARTS, '1')),
      row('Date format', 'System follows your browser’s language.', segmented(store, 'Date format', DATE_FORMAT_KEY, DATE_FORMATS)),
      row('Time format', '', segmented(store, 'Time format', CLOCK_KEY, CLOCKS)),
      row('Number format', 'Counts and amounts of money.', segmented(store, 'Number format', NUMBER_FORMAT_KEY, NUMBER_FORMATS))),

    group('Behaviour',
      row('Reduce motion', 'System follows your computer’s setting.', segmented(store, 'Reduce motion', MOTION_KEY, [['', 'System'], ['reduce', 'On'], ['full', 'Off']])),
      row('Keep the screen awake', keepAwakeSupported()
        ? 'Keeps the screen from dimming or sleeping while the board is open in front.'
        : 'This browser cannot keep the screen awake. Chrome and Edge can.',
      toggle(store, 'Keep the screen awake', keepAwakeOn(), setKeepAwake, !keepAwakeSupported())),
      row('Open links in a new tab', 'Links to GitHub, Vercel, Notion and other sites. Off: they open in this tab.',
        toggle(store, 'Open links in a new tab', readChoice(LINKS_KEY) !== 'same', (on) => saveChoice(LINKS_KEY, on ? '' : 'same'))),
      row('Ask before removing', 'A project, a project label, a contact, an AI task, a recurring expense or a Slack workspace. Off: removed at once, with Undo for a few seconds. Files, worktrees and terminals always ask.',
        toggle(store, 'Ask before removing', readChoice(CONFIRM_KEY) !== 'undo', (on) => saveChoice(CONFIRM_KEY, on ? '' : 'undo')))));
}
