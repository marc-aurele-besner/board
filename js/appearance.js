// Settings → Appearance, saved in this browser: how the board looks (theme, accent, density, text size, motion), where
// it opens, which sections the top bar shows, how links open, and whether a removal asks first. index.html applies
// the look before the first paint; applyAppearance() does it again whenever a choice changes.
import { readChoice, saveChoice } from './locale.js';

export const THEME_KEY = 'board:theme'; // '' follows the system; 'light' or 'dark'
export const DENSITY_KEY = 'board:density'; // '' comfortable; 'compact'
export const ACCENT_KEY = 'board:accent'; // '' the board's blue
export const TEXT_KEY = 'board:text-size'; // '' default; 'small' or 'large'
export const MOTION_KEY = 'board:motion'; // '' follows the system; 'reduce' or 'full'
export const START_KEY = 'board:start'; // '' Home; a section's id
export const NAV_HIDDEN_KEY = 'board:nav-hidden'; // section ids, comma separated
export const LINKS_KEY = 'board:links'; // '' a new tab; 'same' this tab
export const CONFIRM_KEY = 'board:confirm-remove'; // '' ask; 'undo' remove at once with Undo

/** @type {[string, string][]} */
export const ACCENTS = [['', 'Blue'], ['teal', 'Teal'], ['green', 'Green'], ['amber', 'Amber'], ['rose', 'Rose'], ['violet', 'Violet']];

export { readChoice, saveChoice };

// Sets the look on <html> (theme, accent, text size, motion) and the density on <body>.
export function applyAppearance() {
  const root = document.documentElement;
  /** @param {string} name @param {string} value */
  const attr = (name, value) => {
    if (value) root.dataset[name] = value;
    else delete root.dataset[name];
  };
  attr('theme', readChoice(THEME_KEY));
  attr('accent', readChoice(ACCENT_KEY));
  attr('text', readChoice(TEXT_KEY));
  attr('motion', readChoice(MOTION_KEY));
  document.body.classList.toggle('compact', readChoice(DENSITY_KEY) === 'compact');
}

// The section the board opens on when the address names none.
export const startSection = () => readChoice(START_KEY) || 'home';

/** @returns {Set<string>} */
export const hiddenSections = () => new Set(readChoice(NAV_HIDDEN_KEY).split(',').filter(Boolean));

/** @param {string} id @param {boolean} hidden */
export function setSectionHidden(id, hidden) {
  const ids = hiddenSections();
  if (hidden) ids.add(id);
  else ids.delete(id);
  saveChoice(NAV_HIDDEN_KEY, [...ids].join(','));
}

export const linksInNewTab = () => readChoice(LINKS_KEY) !== 'same';

export const askBeforeRemoving = () => readChoice(CONFIRM_KEY) !== 'undo';
