// USD to CAD exchange rates, one per day. Weekends and holidays use the last published rate. A past day's rate
// never changes, so it is kept for good in fx.json: { days: { "YYYY-MM-DD": { rate, date } }, source }. Several free
// providers, none needing an account or key, answer the same question: the chosen one is asked first, and the others
// take over when it fails. The runners (tools/jobs/fx.js) ask them; the board reads fx.json, and asks the runners for
// days it does not hold. The choice of provider and a rate typed by hand are in settings.json `fx`.
import { runJob } from './runners.js';
/** @import { DataStore, Store, FxData, FxDay, FxSettings } from '../types/data' */

export const FX = 'fx';
/** @type {FxData} */
export const FX_DEFAULTS = { days: {}, source: null };
// Older versions kept these in the browser; they move to the data folder once.
const LEGACY = { day: 'board:fx:day:', manual: 'board:fx:manual', provider: 'board:fx:provider', fallback: 'board:fx:fallback' };

const DAY_MS = 86400000;
const iso = (/** @type {number} */ ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (/** @type {string} */ day, /** @type {number} */ n) => iso(Date.parse(day) + n * DAY_MS);

/** @type {Map<string, Promise<number>>} */
const inflight = new Map(); // "YYYY-MM-DD" -> Promise

/** @type {DataStore | null} */
let store = null;
// Whether this process asks the providers itself (the runners) or asks the runners (the board).
let direct = false;
const fxData = () => store?.get(FX) ?? FX_DEFAULTS;
const settingsOf = () => store?.get('settings').fx ?? {};
const saveSettings = (/** @type {FxSettings} */ patch) => store?.update('settings', (d) => {
  d.fx = { ...d.fx, ...patch };
});

// Gives fx.json's store to this module. `direct`: the runners, which fetch rates themselves.
/** @param {DataStore} next @param {{ direct?: boolean }} [options] */
export function useFxStore(next, { direct: own = false } = {}) {
  store = next;
  direct = own;
  if (!own) moveLegacy();
}

// Rates, provider and manual rate saved in the browser by earlier versions go to the data folder, then are removed.
function moveLegacy() {
  try {
    moveLegacyKeys();
  } catch {
    /* storage blocked: nothing to move */
  }
}

// Called once the board's store is set.
function moveLegacyKeys() {
  const keys = Object.keys(localStorage);
  /** @type {Record<string, FxDay>} */
  const days = {};
  for (const key of keys.filter((k) => k.startsWith(LEGACY.day))) {
    try {
      const entry = JSON.parse(/** @type {string} */ (localStorage.getItem(key)));
      if (Number.isFinite(entry?.rate)) days[key.slice(LEGACY.day.length)] = entry;
    } catch {
      /* unreadable: dropped */
    }
    localStorage.removeItem(key);
  }
  if (Object.keys(days).length) /** @type {DataStore} */ (store).save(FX, (d) => { d.days = { ...days, ...d.days }; });
  /** @type {FxSettings} */
  const patch = {};
  const manual = Number(localStorage.getItem(LEGACY.manual));
  if (manual) patch.manual = manual;
  if (localStorage.getItem(LEGACY.provider)) patch.provider = localStorage.getItem(LEGACY.provider);
  if (localStorage.getItem(LEGACY.fallback) === 'off') patch.fallback = false;
  if (Object.keys(patch).length && !/** @type {DataStore} */ (store).get('settings').fx) saveSettings(patch);
  for (const key of [LEGACY.manual, LEGACY.provider, LEGACY.fallback]) localStorage.removeItem(key);
}

/** @param {string} url @param {string} name @returns {Promise<any>} */ // any: each provider's answer is read field by field, every field checked
async function getJson(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} answered ${res.status}.`);
  return res.json();
}

// Each provider returns { "YYYY-MM-DD": rate } for the days it published between two dates.
/** @typedef {{ id: string, name: string, source: string, host: string, docs: string, range(from: string, to: string): Promise<Record<string, number>> }} FxProvider */
/** @type {FxProvider[]} */
export const PROVIDERS = [
  {
    id: 'frankfurter',
    name: 'Frankfurter',
    source: 'European Central Bank reference rates, published each business day.',
    host: 'api.frankfurter.dev',
    docs: 'https://frankfurter.dev',
    async range(from, to) {
      const data = await getJson(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=CAD`, 'Frankfurter');
      return Object.fromEntries(Object.entries(data.rates ?? {}).map(([d, /** @type {{ CAD?: unknown } | undefined} */ v]) => [d, Number(v?.CAD)]));
    },
  },
  {
    id: 'boc',
    name: 'Bank of Canada',
    source: 'The Bank of Canada daily average rate, through its Valet API.',
    host: 'www.bankofcanada.ca',
    docs: 'https://www.bankofcanada.ca/valet/docs',
    async range(from, to) {
      const data = await getJson(`https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?start_date=${from}&end_date=${to}`, 'Bank of Canada');
      return Object.fromEntries((data.observations ?? []).map((/** @type {{ d: string, FXUSDCAD?: { v?: string } }} */ o) => [o.d, Number(o.FXUSDCAD?.v)]));
    },
  },
  {
    id: 'currency-api',
    name: 'Currency API',
    source: 'Open daily rates gathered from several sources, served from the jsDelivr CDN.',
    host: 'cdn.jsdelivr.net',
    docs: 'https://github.com/fawazahmed0/exchange-api',
    // One file per day, so the days are fetched a few at a time.
    async range(from, to) {
      /** @type {string[]} */
      const list = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) list.push(iso(t));
      /** @type {Record<string, number>} */
      const out = {};
      for (let i = 0; i < list.length; i += 8) {
        await Promise.all(list.slice(i, i + 8).map(async (day) => {
          try {
            const data = await getJson(`https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${day}/v1/currencies/usd.min.json`, 'Currency API');
            out[day] = Number(data.usd?.cad);
          } catch {
            /* that day is missing: the day before it fills the gap */
          }
        }));
      }
      if (!Object.keys(out).length) throw new Error('Currency API returned no rate.');
      return out;
    },
  },
];

// The provider asked first, and whether the others are asked when it fails. Saved in settings.json.
/** @returns {string} */
export function providerId() {
  const saved = settingsOf().provider;
  return PROVIDERS.some((p) => p.id === saved) ? /** @type {string} */ (saved) : PROVIDERS[0].id;
}
export const setProvider = (/** @type {string} */ id) => saveSettings({ provider: id === PROVIDERS[0].id ? null : id });
export const fallbackOn = () => settingsOf().fallback !== false;
export const setFallback = (/** @type {boolean} */ on) => saveSettings({ fallback: on ? null : false });

// The providers in the order they are asked.
function order() {
  const first = /** @type {FxProvider} */ (PROVIDERS.find((p) => p.id === providerId())); // providerId() is one of them
  return fallbackOn() ? [first, ...PROVIDERS.filter((p) => p !== first)] : [first];
}

// The provider that answered last, shown in Settings.
export const lastSource = {
  get id() {
    return fxData().source ?? null;
  },
};

// Asks each provider in turn. Rejects with every provider's error when none answers.
/** @param {string} from @param {string} to @param {string | null} [only] @returns {Promise<Record<string, number>>} */
async function ask(from, to, only = null) {
  /** @type {string[]} */
  const errors = [];
  for (const p of only ? PROVIDERS.filter((x) => x.id === only) : order()) {
    try {
      const valid = Object.entries(await p.range(from, to)).filter(([, r]) => Number.isFinite(r) && r > 0);
      if (!valid.length) throw new Error(`${p.name} returned no CAD rate.`);
      if (!only) store?.save(FX, (d) => { d.source = p.id; });
      return Object.fromEntries(valid);
    } catch (err) {
      errors.push(/** @type {Error} */ (err).message);
    }
  }
  throw new Error(errors.join(' '));
}

// The latest rate from one provider, not cached. Settings uses it to check each provider.
/** @param {string} id */
export async function testProvider(id) {
  const today = iso(Date.now());
  const rates = await ask(addDays(today, -7), today, id);
  const date = /** @type {string} */ (Object.keys(rates).sort().at(-1)); // ask() rejects when there is none
  return { rate: rates[date], date };
}

// A rate typed in by hand. It replaces the daily rates for every day when set.
export function manualRate() {
  const v = Number(settingsOf().manual);
  return Number.isFinite(v) && v ? v : null;
}

export const setManualRate = (/** @type {unknown} */ value) => saveSettings({ manual: value ? Number(value) : null });

// The rate for a day if it is already known (manual or fx.json), else null.
/** @param {string} day @returns {number | null} */
export function knownRate(day) {
  const manual = manualRate();
  if (manual !== null) return manual;
  const entry = fxData().days?.[day];
  return entry && Number.isFinite(entry.rate) ? entry.rate : null;
}

/** @param {Record<string, FxDay>} entries */
function remember(entries) {
  store?.save(FX, (d) => {
    d.days = { ...d.days, ...entries };
  });
}

// The board asks the runners for the days it lacks, then reads fx.json again.
/** @param {string} from @param {string} to */
async function askRunners(from, to) {
  await runJob('fx', { from, to });
  await /** @type {Store | null} */ (store)?.sync(); // only the board, whose store syncs, asks the runners
}

// Days asked for in the same moment (Money asks for each day it shows) go to the runners as one range.
/** @typedef {{ days: Set<string>, promise?: Promise<void> }} DayBatch */
/** @type {DayBatch | null} */
let batch = null;
/** @param {string} day */
function askDay(day) {
  if (!batch) {
    /** @type {DayBatch} */
    const current = { days: new Set() };
    current.promise = Promise.resolve().then(() => {
      batch = null;
      const days = [...current.days].sort();
      return askRunners(days[0], /** @type {string} */ (days.at(-1)));
    });
    batch = current;
  }
  batch.days.add(day);
  return /** @type {Promise<void>} */ (batch.promise); // set when the batch was made
}

// Fetches the rate for one day. Concurrent requests for the same day share one request.
/** @param {string} day @returns {Promise<number>} */
export function fetchDayRate(day) {
  const known = knownRate(day);
  if (known !== null) return Promise.resolve(known);
  if (inflight.has(day)) return /** @type {Promise<number>} */ (inflight.get(day));
  // A week back covers weekends and holidays: the day takes the last rate published on or before it.
  const request = (direct
    ? ask(addDays(day, -7), day).then((rates) => {
        const last = Object.keys(rates).filter((d) => d <= day).sort().at(-1);
        if (!last) throw new Error('No rate was published for this day.');
        remember({ [day]: { rate: rates[last], date: last } });
      })
    : askDay(day))
    .then(() => {
      const rate = knownRate(day);
      if (rate === null) throw new Error('No rate was published for this day.');
      return rate;
    })
    .finally(() => inflight.delete(day));
  inflight.set(day, request);
  return request;
}

// Fetches every day's rate between two dates in one request. Weekends and holidays get the last published
// rate before them, so every day in the range is known afterwards. Ranges are capped by the caller.
/** @param {string} from @param {string} to */
export async function fetchRateRange(from, to) {
  if (!direct) return askRunners(from, to);
  // Starts a week early so the first days of the range have a published rate before them.
  const published = await ask(addDays(from, -7), to);
  /** @type {Record<string, FxDay>} */
  const entries = {};
  /** @type {FxDay | null} */
  let last = null;
  for (let t = Date.parse(addDays(from, -7)); t <= Date.parse(to); t += DAY_MS) {
    const day = iso(t);
    if (published[day]) last = { rate: published[day], date: day };
    if (last) entries[day] = published[day] ? { rate: published[day], date: day } : { ...last };
  }
  remember(entries);
}

// Reads the rates of every day from `from` to `to` that fx.json lacks, a year at a time. The runners' job.
/** @param {string} from @param {string} to */
export async function fillRates(from, to) {
  let missing = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) if (knownRate(iso(t)) === null) missing.push(iso(t));
  let read = 0;
  while (missing.length) {
    const start = missing[0];
    const end = /** @type {string} */ (missing.filter((d) => Date.parse(d) - Date.parse(start) < 365 * DAY_MS).at(-1)); // start itself at least
    await fetchRateRange(start, end);
    read += 1;
    missing = missing.filter((d) => d > end);
  }
  return read;
}

// Forgets every saved daily rate. Used by Settings when the user asks for a fresh start.
export function clearCachedRates() {
  store?.update(FX, (d) => {
    d.days = {};
  });
}

// Converts between USD and CAD with the rate of the day. null when no rate is known.
/** @param {number} amount @param {string} from @param {string} to @param {number | null | undefined} usdToCad @returns {number | null} */
export function convert(amount, from, to, usdToCad) {
  if (from === to) return amount;
  if (!usdToCad) return null;
  if (from === 'USD' && to === 'CAD') return amount * usdToCad;
  if (from === 'CAD' && to === 'USD') return amount / usdToCad;
  return null;
}
