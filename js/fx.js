// USD to CAD exchange rates, one per day. Weekends and holidays use the last published rate. A past day's rate
// never changes, so it is cached in the browser for good. Several free providers, none needing an account or
// key, answer the same question: the chosen one is asked first, and the others take over when it fails.
const CACHE_PREFIX = 'board:fx:day:';
const MANUAL_KEY = 'board:fx:manual';
const PROVIDER_KEY = 'board:fx:provider';
const FALLBACK_KEY = 'board:fx:fallback'; // 'off' asks only the chosen provider

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const addDays = (day, n) => iso(Date.parse(day) + n * DAY_MS);

const days = new Map(); // "YYYY-MM-DD" -> { rate, date }
const inflight = new Map(); // "YYYY-MM-DD" -> Promise

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

function readSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeSetting(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* storage blocked */
  }
}

// The provider asked first, and whether the others are asked when it fails. Saved in this browser.
export function providerId() {
  const saved = readSetting(PROVIDER_KEY);
  return PROVIDERS.some((p) => p.id === saved) ? saved : PROVIDERS[0].id;
}
export const setProvider = (id) => writeSetting(PROVIDER_KEY, id === PROVIDERS[0].id ? null : id);
export const fallbackOn = () => readSetting(FALLBACK_KEY) !== 'off';
export const setFallback = (on) => writeSetting(FALLBACK_KEY, on ? null : 'off');

// The providers in the order they are asked.
function order() {
  const first = PROVIDERS.find((p) => p.id === providerId());
  return fallbackOn() ? [first, ...PROVIDERS.filter((p) => p !== first)] : [first];
}

// The provider that answered last, shown in Settings.
export const lastSource = { id: null };

// Asks each provider in turn. Rejects with every provider's error when none answers.
async function ask(from, to, only = null) {
  const errors = [];
  for (const p of only ? PROVIDERS.filter((x) => x.id === only) : order()) {
    try {
      const valid = Object.entries(await p.range(from, to)).filter(([, r]) => Number.isFinite(r) && r > 0);
      if (!valid.length) throw new Error(`${p.name} returned no CAD rate.`);
      if (!only) lastSource.id = p.id;
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

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

// A rate typed in by hand. It replaces the daily rates for every day when set.
export function manualRate() {
  const v = readJson(MANUAL_KEY);
  return Number.isFinite(Number(v)) && v ? Number(v) : null;
}

export function setManualRate(value) {
  try {
    if (value) localStorage.setItem(MANUAL_KEY, JSON.stringify(Number(value)));
    else localStorage.removeItem(MANUAL_KEY);
  } catch {
    /* storage blocked */
  }
}

// The rate for a day if it is already known (manual, memory or browser cache), else null.
export function knownRate(day) {
  const manual = manualRate();
  if (manual !== null) return manual;
  if (days.has(day)) return days.get(day).rate;
  const cached = readJson(CACHE_PREFIX + day);
  if (cached && Number.isFinite(cached.rate)) {
    days.set(day, cached);
    return cached.rate;
  }
  return null;
}

function remember(day, entry) {
  days.set(day, entry);
  try {
    localStorage.setItem(CACHE_PREFIX + day, JSON.stringify(entry));
  } catch {
    /* storage blocked: the rate is kept for this page only */
  }
}

// Fetches the rate for one day. Concurrent requests for the same day share one request.
export function fetchDayRate(day) {
  const known = knownRate(day);
  if (known !== null) return Promise.resolve(known);
  if (inflight.has(day)) return inflight.get(day);
  // A week back covers weekends and holidays: the day takes the last rate published on or before it.
  const request = ask(addDays(day, -7), day)
    .then((rates) => {
      const last = Object.keys(rates).filter((d) => d <= day).sort().at(-1);
      if (!last) throw new Error('No rate was published for this day.');
      remember(day, { rate: rates[last], date: last });
      return rates[last];
    })
    .finally(() => inflight.delete(day));
  inflight.set(day, request);
  return request;
}

// Fetches every day's rate between two dates in one request. Weekends and holidays get the last published
// rate before them, so every day in the range is known afterwards. Ranges are capped by the caller.
export async function fetchRateRange(from, to) {
  // Starts a week early so the first days of the range have a published rate before them.
  const published = await ask(addDays(from, -7), to);
  for (const [day, rate] of Object.entries(published)) remember(day, { rate, date: day });
  let last = null;
  for (let t = Date.parse(addDays(from, -7)); t <= Date.parse(to); t += DAY_MS) {
    const day = iso(t);
    if (days.has(day)) last = days.get(day);
    else if (last) remember(day, { rate: last.rate, date: last.date });
  }
}

// Forgets every cached daily rate. Used by Settings when the user asks for a fresh start.
export function clearCachedRates() {
  days.clear();
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(CACHE_PREFIX)) localStorage.removeItem(key);
    }
  } catch {
    /* storage blocked */
  }
}

// Converts between USD and CAD with the rate of the day. null when no rate is known.
export function convert(amount, from, to, usdToCad) {
  if (from === to) return amount;
  if (!usdToCad) return null;
  if (from === 'USD' && to === 'CAD') return amount * usdToCad;
  if (from === 'CAD' && to === 'USD') return amount / usdToCad;
  return null;
}
