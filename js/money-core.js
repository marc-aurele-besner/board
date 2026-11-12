// Money without the DOM: budgets gone over and recurring due dates. The Money section and the runners'
// monitoring job (budgets, recurring-bill tasks) both read them.
import { convert, knownRate, fetchDayRate } from './fx.js';
/** @import { DataStore, FinanceEntry, Recurring } from '../types/data' */

const COLLECTION = 'finance';
const DEFAULT_CURRENCY = 'USD'; // entries saved before currencies existed are treated as USD

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ymd = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (/** @type {string} */ s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const startOfDay = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (/** @type {Date} */ d, /** @type {number} */ n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
const entryCurrency = (/** @type {FinanceEntry} */ e) => e.currency ?? DEFAULT_CURRENCY;
const monthKeyOf = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

// This month's expenses in a category, with what each budget is in.
const monthExpenses = (/** @type {DataStore} */ store, /** @type {string} */ category) => {
  const month = monthKeyOf(new Date());
  return store.get(COLLECTION).entries.filter((e) => e.type === 'expense' && e.category === category && e.date.startsWith(month));
};

// Categories that went over their monthly budget this month, each in its budget's currency.
// An entry in another currency whose rate is not loaded yet is left out, so nothing is flagged on a guess.
/** @param {DataStore} store */
export function overBudget(store) {
  const { budgets = {} } = store.get(COLLECTION);
  return Object.entries(budgets)
    .map(([category, b]) => {
      const spent = monthExpenses(store, category)
        .reduce((s, e) => s + (convert(e.amount, entryCurrency(e), b.currency, knownRate(e.date)) ?? 0), 0);
      return { category, spent: round2(spent), budget: b.amount, currency: b.currency };
    })
    .filter((r) => r.spent > r.budget);
}

// Loads the rates overBudget needs: those of this month's entries in another currency than their budget.
// The board loads them as Money shows; the runners have no page, so they ask before checking.
/** @param {DataStore} store */
export async function loadBudgetRates(store) {
  const { budgets = {} } = store.get(COLLECTION);
  const days = new Set();
  for (const [category, b] of Object.entries(budgets)) {
    for (const e of monthExpenses(store, category)) if (entryCurrency(e) !== b.currency && knownRate(e.date) === null) days.add(e.date);
  }
  for (const day of days) await fetchDayRate(day).catch(() => null);
}

// Due dates of a recurring expense, from its start date up to a day (inclusive), as YYYY-MM-DD.
// A day past the month's end (the 31st in April) falls on the last day of that month.
/** @param {Pick<Recurring, 'startDate' | 'cadence'>} item @param {string} untilKey @returns {string[]} */
export function dueDates(item, untilKey) {
  const start = parseYmd(item.startDate);
  const step = item.cadence === 'yearly' ? 12 : 1;
  /** @type {string[]} */
  const dates = [];
  for (let i = 0; i < 5000; i += 1) {
    const first = new Date(start.getFullYear(), start.getMonth() + i * step, 1);
    const lastDay = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const key = ymd(new Date(first.getFullYear(), first.getMonth(), Math.min(start.getDate(), lastDay)));
    if (key > untilKey) break;
    dates.push(key);
  }
  return dates;
}

// The next date a recurring expense is due, or '' when none falls within about a year. The automation rules read it too.
/** @param {Pick<Recurring, 'startDate' | 'cadence'>} item */
export function nextRecurringDue(item) {
  const today = ymd(startOfDay(new Date()));
  return dueDates(item, ymd(addDays(startOfDay(new Date()), 400))).find((k) => k > today) ?? '';
}
