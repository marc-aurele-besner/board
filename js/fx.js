// USD to CAD exchange rates, one per day. The rate for a date is the ECB reference rate published for that
// day (weekends and holidays use the last published rate). Source: Frankfurter, no account or key needed.
// A past day's rate never changes, so it is cached in the browser for good.
const API = 'https://api.frankfurter.dev/v1';
const CACHE_PREFIX = 'board:fx:day:';
const MANUAL_KEY = 'board:fx:manual';

const days = new Map(); // "YYYY-MM-DD" -> { rate, date }
const inflight = new Map(); // "YYYY-MM-DD" -> Promise

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

// Fetches the rate for one day. Concurrent requests for the same day share one request.
export function fetchDayRate(day) {
  const known = knownRate(day);
  if (known !== null) return Promise.resolve(known);
  if (inflight.has(day)) return inflight.get(day);
  const request = fetch(`${API}/${day}?base=USD&symbols=CAD`)
    .then((res) => {
      if (!res.ok) throw new Error(`The exchange rate service answered ${res.status}.`);
      return res.json();
    })
    .then((data) => {
      const rate = Number(data.rates?.CAD);
      if (!Number.isFinite(rate)) throw new Error('The exchange rate service returned no CAD rate.');
      const entry = { rate, date: data.date ?? day };
      days.set(day, entry);
      try {
        localStorage.setItem(CACHE_PREFIX + day, JSON.stringify(entry));
      } catch {
        /* storage blocked: the rate is kept for this page only */
      }
      return rate;
    })
    .finally(() => inflight.delete(day));
  inflight.set(day, request);
  return request;
}

const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

function remember(day, entry) {
  days.set(day, entry);
  try {
    localStorage.setItem(CACHE_PREFIX + day, JSON.stringify(entry));
  } catch {
    /* storage blocked: the rate is kept for this page only */
  }
}

// Fetches every day's rate between two dates in one request. Weekends and holidays get the last published
// rate before them, so every day in the range is known afterwards. Ranges are capped by the caller.
export async function fetchRateRange(from, to) {
  const res = await fetch(`${API}/${from}..${to}?base=USD&symbols=CAD`);
  if (!res.ok) throw new Error(`The exchange rate service answered ${res.status}.`);
  const data = await res.json();
  const published = data.rates ?? {};
  for (const [day, value] of Object.entries(published)) {
    const rate = Number(value?.CAD);
    if (Number.isFinite(rate)) remember(day, { rate, date: day });
  }
  let last = null;
  for (let t = Date.parse(from); t <= Date.parse(to); t += DAY_MS) {
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
