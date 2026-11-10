// USD and CAD exchange rate. Fetched from the Frankfurter service (ECB reference rates, no key needed),
// cached in the browser for 12 hours. A rate typed in by hand takes precedence when set.
const URL = 'https://api.frankfurter.app/latest?from=USD&to=CAD';
const CACHE_KEY = 'board:fx:usd-cad';
const MANUAL_KEY = 'board:fx:manual';
const TTL_MS = 12 * 3600 * 1000;

let memory = null; // { rate, date, at }

function readJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null');
  } catch {
    return null;
  }
}

// The rate fetched from the service: 1 USD in CAD, with the date the rate is for.
export async function fetchUsdToCad() {
  if (memory && Date.now() - memory.at < TTL_MS) return memory;
  const cached = readJson(CACHE_KEY);
  if (cached && Date.now() - cached.at < TTL_MS) return (memory = cached);

  const res = await fetch(URL);
  if (!res.ok) throw new Error(`The exchange rate service returned ${res.status}.`);
  const data = await res.json();
  const rate = Number(data.rates?.CAD);
  if (!Number.isFinite(rate)) throw new Error('The exchange rate service did not return a CAD rate.');
  memory = { rate, date: data.date, at: Date.now() };
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(memory));
  } catch {
    /* storage blocked: keep the rate for this page only */
  }
  return memory;
}

// A rate typed in by hand, or null.
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

// Converts an amount between USD and CAD with a 1 USD = `usdToCad` CAD rate. null when no rate is known.
export function convert(amount, from, to, usdToCad) {
  if (from === to) return amount;
  if (!usdToCad) return null;
  if (from === 'USD' && to === 'CAD') return amount * usdToCad;
  if (from === 'CAD' && to === 'USD') return amount / usdToCad;
  return null;
}
