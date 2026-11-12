// USD to CAD exchange rates, one per day. Weekends and holidays use the last published rate. A past day's rate
// never changes, so it is kept for good in fx.json: { days: { "YYYY-MM-DD": { rate, date } }, source }. Several free
// providers, none needing an account or key, answer the same question: the chosen one is asked first, and the others
// take over when it fails. The runners (tools/jobs/fx.js) ask them; the board reads fx.json, and asks the runners for
// days it does not hold. The choice of provider and a rate typed by hand are in settings.json `fx`.
import { runJob } from './runners.js';

export const FX = 'fx';
export const FX_DEFAULTS = { days: {}, source: null };
// Older versions kept these in the browser; they move to the data folder once.
const LEGACY = { day: 'board:fx:day:', manual: 'board:fx:manual', provider: 'board:fx:provider', fallback: 'board:fx:fallback' };

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => iso(Date.parse(day) + n * DAY_MS);

const inflight = new Map(); // "YYYY-MM-DD" -> Promise

let store = null;
// Whether this process asks the providers itself (the runners) or asks the runners (the board).
let direct = false;
const fxData = () => store?.get(FX) ?? FX_DEFAULTS;
const settingsOf = () => store?.get('settings').fx ?? {};
const saveSettings = (patch) => store?.update('settings', (d) => {
  d.fx = { ...d.fx, ...patch };
});

// Gives fx.json's store to this module. `direct`: the runners, which fetch rates themselves.
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

function moveLegacyKeys() {
  const keys = Object.keys(localStorage);
  const days = {};
  for (const key of keys.filter((k) => k.startsWith(LEGACY.day))) {
    try {
      const entry = JSON.parse(localStorage.getItem(key));
      if (Number.isFinite(entry?.rate)) days[key.slice(LEGACY.day.length)] = entry;
    } catch {
      /* unreadable: dropped */
    }
    localStorage.removeItem(key);
  }
  if (Object.keys(days).length) store.save(FX, (d) => { d.days = { ...days, ...d.days }; });
  const patch = {};
  const manual = Number(localStorage.getItem(LEGACY.manual));
  if (manual) patch.manual = manual;
  if (localStorage.getItem(LEGACY.provider)) patch.provider = localStorage.getItem(LEGACY.provider);
  if (localStorage.getItem(LEGACY.fallback) === 'off') patch.fallback = false;
  if (Object.keys(patch).length && !store.get('settings').fx) saveSettings(patch);
  for (const key of [LEGACY.manual, LEGACY.provider, LEGACY.fallback]) localStorage.removeItem(key);
}

async function getJson(url, name) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${name} answered ${res.status}.`);
  return res.json();
}

// Each provider returns { "YYYY-MM-DD": rate } for the days it published between two dates.
export const PROVIDERS = [
  {
    id: 'frankfurter',
    name: 'Frankfurter',
    source: 'European Central Bank reference rates, published each business day.',
    host: 'api.frankfurter.dev',
    docs: 'https://frankfurter.dev',
    async range(from, to) {
      const data = await getJson(`https://api.frankfurter.dev/v1/${from}..${to}?base=USD&symbols=CAD`, 'Frankfurter');
      return Object.fromEntries(Object.entries(data.rates ?? {}).map(([d, v]) => [d, Number(v?.CAD)]));
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
      return Object.fromEntries((data.observations ?? []).map((o) => [o.d, Number(o.FXUSDCAD?.v)]));
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
      const list = [];
      for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) list.push(iso(t));
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
export function providerId() {
  const saved = settingsOf().provider;
  return PROVIDERS.some((p) => p.id === saved) ? saved : PROVIDERS[0].id;
}
export const setProvider = (id) => saveSettings({ provider: id === PROVIDERS[0].id ? null : id });
export const fallbackOn = () => settingsOf().fallback !== false;
export const setFallback = (on) => saveSettings({ fallback: on ? null : false });

// The providers in the order they are asked.
function order() {
  const first = PROVIDERS.find((p) => p.id === providerId());
  return fallbackOn() ? [first, ...PROVIDERS.filter((p) => p !== first)] : [first];
}

// The provider that answered last, shown in Settings.
export const lastSource = {
  get id() {
    return fxData().source ?? null;
  },
};

// Asks each provider in turn. Rejects with every provider's error when none answers.
async function ask(from, to, only = null) {
  const errors = [];
  for (const p of only ? PROVIDERS.filter((x) => x.id === only) : order()) {
    try {
      const valid = Object.entries(await p.range(from, to)).filter(([, r]) => Number.isFinite(r) && r > 0);
      if (!valid.length) throw new Error(`${p.name} returned no CAD rate.`);
      if (!only) store?.save(FX, (d) => { d.source = p.id; });
      return Object.fromEntries(valid);
    } catch (err) {
      errors.push(err.message);
    }
  }
  throw new Error(errors.join(' '));
}

// The latest rate from one provider, not cached. Settings uses it to check each provider.
export async function testProvider(id) {
  const today = iso(Date.now());
  const rates = await ask(addDays(today, -7), today, id);
  const date = Object.keys(rates).sort().at(-1);
  return { rate: rates[date], date };
}

// A rate typed in by hand. It replaces the daily rates for every day when set.
export function manualRate() {
  const v = Number(settingsOf().manual);
  return Number.isFinite(v) && v ? v : null;
}

export const setManualRate = (value) => saveSettings({ manual: value ? Number(value) : null });

// The rate for a day if it is already known (manual or fx.json), else null.
export function knownRate(day) {
  const manual = manualRate();
  if (manual !== null) return manual;
  const entry = fxData().days?.[day];
  return entry && Number.isFinite(entry.rate) ? entry.rate : null;
}

function remember(entries) {
  store?.save(FX, (d) => {
    d.days = { ...d.days, ...entries };
  });
}

// The board asks the runners for the days it lacks, then reads fx.json again.
async function askRunners(from, to) {
  await runJob('fx', { from, to });
  await store?.sync();
}

// Days asked for in the same moment (Money asks for each day it shows) go to the runners as one range.
let batch = null;
function askDay(day) {
  if (!batch) {
    const current = { days: new Set() };
    current.promise = Promise.resolve().then(() => {
      batch = null;
      const days = [...current.days].sort();
      return askRunners(days[0], days.at(-1));
    });
    batch = current;
  }
  batch.days.add(day);
  return batch.promise;
}

// Fetches the rate for one day. Concurrent requests for the same day share one request.
export function fetchDayRate(day) {
  const known = knownRate(day);
  if (known !== null) return Promise.resolve(known);
  if (inflight.has(day)) return inflight.get(day);
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
export async function fetchRateRange(from, to) {
  if (!direct) return askRunners(from, to);
  // Starts a week early so the first days of the range have a published rate before them.
  const published = await ask(addDays(from, -7), to);
  const entries = {};
  let last = null;
  for (let t = Date.parse(addDays(from, -7)); t <= Date.parse(to); t += DAY_MS) {
    const day = iso(t);
    if (published[day]) last = { rate: published[day], date: day };
    if (last) entries[day] = published[day] ? { rate: published[day], date: day } : { ...last };
  }
  remember(entries);
}

// Reads the rates of every day from `from` to `to` that fx.json lacks, a year at a time. The runners' job.
export async function fillRates(from, to) {
  let missing = [];
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) if (knownRate(iso(t)) === null) missing.push(iso(t));
  let read = 0;
  while (missing.length) {
    const start = missing[0];
    const end = missing.filter((d) => Date.parse(d) - Date.parse(start) < 365 * DAY_MS).at(-1);
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
export function convert(amount, from, to, usdToCad) {
  if (from === to) return amount;
  if (!usdToCad) return null;
  if (from === 'USD' && to === 'CAD') return amount * usdToCad;
  if (from === 'CAD' && to === 'USD') return amount / usdToCad;
  return null;
}
