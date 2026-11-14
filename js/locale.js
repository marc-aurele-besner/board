// Settings → Appearance's date, time, number and week choices, saved in this browser. Every date or number shown
// is formatted with dateLocale() or numberLocale(); week groupings start on weekStart(). The board's words stay
// English: a choice picks an English locale whose dates read that way. No DOM at load: the runners format with it
// too, with the browser's own defaults.

export const DATE_FORMAT_KEY = 'board:date-format';
export const CLOCK_KEY = 'board:clock';
export const NUMBER_FORMAT_KEY = 'board:number-format';
export const WEEK_START_KEY = 'board:week-start';

// [stored value, label]; '' follows the browser.
/** @type {[string, string][]} */
export const DATE_FORMATS = [['', 'System'], ['iso', '2026-11-14'], ['day', '14 Nov 2026'], ['month', 'Nov 14, 2026']];
/** @type {[string, string][]} */
export const CLOCKS = [['', 'System'], ['24', '24-hour'], ['12', '12-hour']];
/** @type {[string, string][]} */
export const NUMBER_FORMATS = [['', 'System'], ['comma', '1,234.56'], ['space', '1 234,56'], ['dot', '1.234,56']];
/** @type {[string, string][]} */
export const WEEK_STARTS = [['1', 'Monday'], ['0', 'Sunday'], ['6', 'Saturday']];

const DATE_LOCALES = /** @type {Record<string, string>} */ ({ iso: 'en-CA', day: 'en-GB', month: 'en-US' });
const NUMBER_LOCALES = /** @type {Record<string, string>} */ ({ comma: 'en-US', space: 'fr-FR', dot: 'de-DE' });

/** @param {string} key */
export function readChoice(key) {
  try {
    return typeof window === 'undefined' ? '' : window.localStorage.getItem(key) ?? '';
  } catch {
    return '';
  }
}

/** @param {string} key @param {string} value '' goes back to the default */
export function saveChoice(key, value) {
  try {
    if (value) window.localStorage.setItem(key, value);
    else window.localStorage.removeItem(key);
  } catch {
    // Storage may be blocked; the choice then lasts until the page is left.
  }
}

const browserLocale = () => Intl.DateTimeFormat().resolvedOptions().locale;

// The locale dates and times are written in; undefined follows the browser.
/** @returns {string | undefined} */
export function dateLocale() {
  const base = DATE_LOCALES[readChoice(DATE_FORMAT_KEY)];
  const clock = readChoice(CLOCK_KEY);
  if (!base && !clock) return undefined;
  return clock ? `${base ?? browserLocale()}-u-hc-${clock === '12' ? 'h12' : 'h23'}` : base;
}

// The locale numbers (and amounts of money) are written in; undefined follows the browser.
/** @returns {string | undefined} */
export const numberLocale = () => NUMBER_LOCALES[readChoice(NUMBER_FORMAT_KEY)];

// The day weeks start on, as Date.getDay() counts (0 is Sunday); Monday unless Appearance says otherwise.
export function weekStart() {
  const day = Number(readChoice(WEEK_START_KEY) || '1');
  return day === 0 || day === 6 ? day : 1;
}

// How many days a date is past the start of its week.
/** @param {Date} d */
export const daysIntoWeek = (d) => (d.getDay() - weekStart() + 7) % 7;
