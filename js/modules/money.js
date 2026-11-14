import { h, uid, now, todayISO, money, empty, icon, notice, progress, CURRENCIES } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';
import { systemPrompt } from '../prompts.js';
import { readPdf } from '../pdf-reader.js';
import { overBudget, nextRecurringDue, dueDates } from '../money-core.js';
import { knownRate, fetchDayRate, fetchRateRange, manualRate, setManualRate, convert } from '../fx.js';
import { setupBanner, hasOpenRouter } from '../integrations.js';
import { projectIcon } from './projects.js';
import { barChart, legend } from '../chart.js';
import { openDialog } from '../modal.js';
import { toast } from '../toast.js';
import { dateLocale, daysIntoWeek } from '../locale.js';
import { removeWithUndo } from '../remove.js';
/** @import { Store, FinanceEntry, Recurring, AiContentPart } from '../../types/data' */
/** @import { PickOption } from '../inline.js' */


const COLLECTION = 'finance';
const TYPES = [['expense', 'Expense'], ['income', 'Income']];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CURRENCY = 'USD'; // entries saved before currencies existed are treated as USD
const DAY = 86400000;
const RANGES = [
  ['month', 'This month'],
  ['lastmonth', 'Last month'],
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7', '7 days'],
  ['30', '30 days'],
  ['90', '90 days'],
  ['year', 'Last year'],
  ['all', 'All'],
];
const GROUPS = [['day', 'Day'], ['week', 'Week'], ['month', 'Month'], ['year', 'Year']];
const KINDS = [['all', 'All'], ['fixed', 'Fixed'], ['flex', 'Flex']];

// View state: the currency totals are shown in, the period, and how it is grouped in the chart.
// range: a RANGES key, or one month as 'YYYY-MM' (reached with the month stepper). query: the search in the entries list.
const view = { currency: DEFAULT_CURRENCY, range: 'month', group: 'day', kind: 'all', query: '' };
// A bill is read into charges (the line items), a currency and a bill total. Only the charges become entries.
// taxes: tax lines printed on the document as totals (GST, QST, ...), not attached to one charge.
// original: the bill file itself, kept with the entries so it can be opened later.
/**
 * @typedef {{ key: string, date: string, note: string, amount: number, tax: number, category: string, projectId: string | null }} BillLine
 * @typedef {{ key: string, note: string, amount: number, projectId?: string | null }} BillTax
 * @typedef {{ name: string, type: string, blob?: Blob, file?: string, dataUrl?: string }} Original a bill's file: being read (blob) or saved (file, or dataUrl in older bills)
 * @typedef {{ status: string, items: BillLine[], taxes: BillTax[], total: number | null, date: string, currency: string, vendor: string, error: string, fileName: string, stage: string, original: Original | null }} BillRead
 */
/** @type {BillRead} */
const receipt = { status: 'idle', items: [], taxes: [], total: null, date: '', currency: DEFAULT_CURRENCY, vendor: '', error: '', fileName: '', stage: '', original: null };
// Spending review (task 6): the text for the period it was asked for.
const spend = { range: '', status: 'idle', text: '' };
// Rates: days asked for, days still loading, and days that failed with the reason.
/** @type {{ requested: Set<string>, pending: number, failed: Map<string, string> }} */
const fx = { requested: new Set(), pending: 0, failed: new Map() };
/** @type {string[]} */
let shownDays = []; // days whose rates the page needs

// --- Dates ---

const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
const ymd = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseYmd = (/** @type {string} */ s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const startOfDay = (/** @type {Date} */ d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const addDays = (/** @type {Date} */ d, /** @type {number} */ n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const round2 = (/** @type {number} */ n) => Math.round(n * 100) / 100;
// Categories are saved with a capital first letter, so "hosting" and "Hosting" are the same category.
const capitalize = (/** @type {unknown} */ s) => {
  const t = String(s ?? '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
};
// The forms here have text fields only, so every value is a string.
const formValues = (/** @type {HTMLFormElement} */ form) => /** @type {Record<string, string>} */ (Object.fromEntries(new FormData(form)));
const entryCurrency = (/** @type {FinanceEntry} */ e) => e.currency ?? DEFAULT_CURRENCY;
// An entry's amount in the shown currency, at the rate of the entry's own day. null when that rate is not known yet.
const shownAmount = (/** @type {FinanceEntry} */ e) => convert(e.amount, entryCurrency(e), view.currency, knownRate(e.date));

const monthKeyOf = (/** @type {Date} */ d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const isMonthKey = (/** @type {string} */ range) => /^\d{4}-\d{2}$/.test(range);
// The month a range covers, when it covers exactly one: this month, last month, or a picked month. Otherwise null.
/** @param {string} range */
function shownMonth(range) {
  const today = new Date();
  if (range === 'month') return monthKeyOf(today);
  if (range === 'lastmonth') return monthKeyOf(new Date(today.getFullYear(), today.getMonth() - 1, 1));
  return isMonthKey(range) ? range : null;
}
// The range one month before or after the shown one. The current month is always the 'month' range.
/** @param {string} range @param {number} delta */
function stepMonth(range, delta) {
  const [y, m] = (shownMonth(range) ?? monthKeyOf(new Date())).split('-').map(Number);
  const next = monthKeyOf(new Date(y, m - 1 + delta, 1));
  return next === monthKeyOf(new Date()) ? 'month' : next;
}

// The period as dates: from (inclusive) to (exclusive).
/** @param {string} range @param {FinanceEntry[]} entries */
function windowFor(range, entries) {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  if (isMonthKey(range)) {
    const [y, m] = range.split('-').map(Number);
    return { from: new Date(y, m - 1, 1), to: new Date(y, m, 1) };
  }
  if (range === 'today') return { from: today, to: tomorrow };
  if (range === 'yesterday') return { from: addDays(today, -1), to: today };
  if (range === 'month') return { from: new Date(today.getFullYear(), today.getMonth(), 1), to: new Date(today.getFullYear(), today.getMonth() + 1, 1) };
  if (range === 'lastmonth') return { from: new Date(today.getFullYear(), today.getMonth() - 1, 1), to: new Date(today.getFullYear(), today.getMonth(), 1) };
  if (range === 'year') return { from: new Date(today.getFullYear() - 1, 0, 1), to: new Date(today.getFullYear(), 0, 1) };
  if (range === 'all') {
    const first = entries.map((e) => e.date).sort()[0];
    return { from: first ? parseYmd(first) : today, to: tomorrow };
  }
  return { from: addDays(today, -(Number(range) - 1)), to: tomorrow };
}

// The key of the chart bucket a day falls into, for the chosen grouping.
/** @param {Date} date @param {string} group */
function bucketKey(date, group) {
  if (group === 'day') return ymd(date);
  if (group === 'week') return ymd(addDays(date, -daysIntoWeek(date))); // weeks start on Appearance's day
  if (group === 'month') return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
  return String(date.getFullYear());
}

/** @param {string} key @param {string} group */
function bucketLabel(key, group) {
  if (group === 'day' || group === 'week') {
    const d = parseYmd(key);
    return group === 'week' ? `W ${d.getMonth() + 1}/${d.getDate()}` : `${d.getMonth() + 1}/${d.getDate()}`;
  }
  if (group === 'month') {
    const [y, m] = key.split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString(dateLocale(), { month: 'short', year: '2-digit' });
  }
  return key;
}

// Every bucket between the two dates, in order, so empty periods still show as empty bars.
/** @param {Date} from @param {Date} to @param {string} group */
function bucketKeys(from, to, group) {
  /** @type {string[]} */
  const keys = [];
  for (let d = from; d < to; d = addDays(d, 1)) {
    const k = bucketKey(d, group);
    if (!keys.includes(k)) keys.push(k);
  }
  return keys;
}

// --- Entries ---

/**
 * @typedef {{ date: string, type?: string, amount: number, tax?: number, billId?: string, currency: string, category?: string,
 *   note?: string, projectId?: string | null, source?: string }} NewEntry
 */
/** @param {Store} store @param {NewEntry[]} list */
export function addEntries(store, list) {
  store.update(COLLECTION, (d) => {
    for (const e of list) {
      const category = capitalize(e.category) || 'Uncategorized';
      d.entries.push({
        id: uid(),
        date: e.date,
        type: e.type ?? 'expense',
        amount: round2(e.amount),
        tax: round2(e.tax || 0),
        billId: e.billId ?? '',
        currency: CURRENCIES.includes(e.currency) ? e.currency : DEFAULT_CURRENCY,
        category,
        note: e.note || '',
        projectId: e.projectId ?? null,
        source: e.source || '',
        created: now(),
      });
      if (!d.categories.some((c) => c.toLowerCase() === category.toLowerCase())) d.categories.push(category);
    }
  });
}

/** @param {Store} store @param {Record<string, string>} v the form's values */
function addEntry(store, v) {
  const amount = round2(Number(v.amount));
  if (!(amount > 0)) return;
  addEntries(store, [{
    date: v.date || todayISO(),
    type: v.type === 'income' ? 'income' : 'expense',
    amount,
    tax: Number(v.tax) || 0,
    currency: v.currency,
    category: v.category.trim(),
    note: v.note.trim(),
  }]);
}

// Every change to an entry goes through here, so a new category is remembered too.
/** @param {Store} store @param {string} id @param {Partial<FinanceEntry>} patch */
function updateEntry(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const e = d.entries.find((x) => x.id === id);
    if (!e) return;
    if (patch.category !== undefined) patch = { ...patch, category: capitalize(patch.category) || patch.category };
    Object.assign(e, patch);
    if (patch.category && !d.categories.some((c) => c.toLowerCase() === /** @type {string} */ (patch.category).toLowerCase())) d.categories.push(patch.category);
  });
}

// Deleting is immediate, with a few seconds to take it back.
/** @param {Store} store @param {string} id */
function removeEntry(store, id) {
  const removed = store.get(COLLECTION).entries.find((e) => e.id === id);
  if (!removed) return;
  store.update(COLLECTION, (d) => {
    d.entries = d.entries.filter((e) => e.id !== id);
  });
  toast('Entry deleted', { undo: () => store.update(COLLECTION, (d) => d.entries.push(removed)) });
}


// --- Exchange rates, one per day ---

// Asks for the rates of the given days that are not known yet. Long spans are fetched in one request.
/** @param {Store} store @param {string[]} dayList */
function scheduleRates(store, dayList) {
  const missing = [...new Set(dayList)].filter((d) => knownRate(d) === null && !fx.requested.has(d)).sort();
  if (!missing.length) return;
  for (const d of missing) fx.requested.add(d);
  fx.pending += missing.length;
  store.refresh();
  const span = (Date.parse(/** @type {string} */ (missing.at(-1))) - Date.parse(missing[0])) / DAY;
  const work = span <= 400
    ? fetchRateRange(missing[0], /** @type {string} */ (missing.at(-1)))
    : Promise.all(missing.map((d) => fetchDayRate(d)));
  work
    .then(() => {
      for (const d of missing) {
        if (knownRate(d) !== null) fx.failed.delete(d);
        else fx.failed.set(d, 'No rate was published for this day.');
      }
    }, (err) => {
      for (const d of missing) if (knownRate(d) === null) fx.failed.set(d, err.message);
    })
    .finally(() => {
      fx.pending = Math.max(0, fx.pending - missing.length);
      store.refresh();
    });
}

// Forgets the failed days and asks for them again.
/** @param {Store} store */
function retryRates(store) {
  for (const d of fx.failed.keys()) fx.requested.delete(d);
  fx.failed.clear();
  setTimeout(() => scheduleRates(store, shownDays), 0);
  store.refresh();
}

// The line under the header when the rates need attention (manual rate, loading, failed); nothing otherwise.
/** @param {Store} store */
function fxBanner(store) {
  const manual = manualRate();
  if (manual !== null) {
    return h('p', { class: 'muted small rate-line' },
      `Using your rate for every day: 1 USD = ${manual.toFixed(4)} CAD.`,
      h('button', { type: 'button', class: 'btn-small', onclick: () => { setManualRate(null); store.refresh(); } }, 'Use daily rates'));
  }
  if (fx.failed.size) {
    const count = fx.failed.size;
    const [[, message]] = fx.failed;
    return setupBanner('exchange', `Exchange rates could not be loaded for ${count} day${count > 1 ? 's' : ''}. ${message} Totals that need them are left out until they load.`, {
      tone: 'error',
      actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => retryRates(store) }, 'Try again')],
    });
  }
  if (fx.pending) {
    return h('p', { class: 'muted small rate-line' }, `Loading exchange rates for ${fx.pending} day${fx.pending > 1 ? 's' : ''}…`);
  }
  return null;
}

// --- Bills and screenshots ---

// The message parts for a dropped file. A PDF with a text layer is sent as text (any model can read it);
// a scanned PDF or an image is sent as images (needs a model that reads images).
/** @param {File} file @param {(stage: string) => void} say @returns {Promise<AiContentPart[]>} */
async function documentContent(file, say) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if (isPdf) {
    say('Reading the PDF pages…');
    const pdf = await readPdf(file);
    const note = pdf.truncated ? ` Only the first ${pdf.images.length} pages are included; the document has ${pdf.pages}.` : '';
    if (pdf.text) {
      return [{ type: 'text', text: `Text from a PDF bill or invoice (all ${pdf.pages} pages).\n\n${pdf.text.slice(0, 60000)}` }];
    }
    return [
      { type: 'text', text: `Scanned pages from a PDF bill or invoice.${note}` },
      ...pdf.images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  }
  if (!file.type.startsWith('image/')) {
    throw new Error('That file type is not supported. Drop an image (PNG, JPG or WebP) or a PDF.');
  }
  const url = await readAsDataUrl(file);
  return [{ type: 'text', text: 'Here is the bill or screenshot.' }, { type: 'image_url', image_url: { url } }];
}

const readAsDataUrl = (/** @type {Blob} */ file) =>
  /** @type {Promise<string>} */ (new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(/** @type {string} */ (reader.result)); // readAsDataURL gives a string
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  }));

/** @param {Store} store @param {File} file @param {string[]} categories */
async function readReceipt(store, file, categories) {
  receipt.status = 'loading';
  receipt.error = '';
  receipt.fileName = file.name;
  receipt.items = [];
  receipt.total = null;
  // Each step updates the loading bar's label, so the wait shows what is happening.
  const say = (/** @type {string} */ stage) => {
    receipt.stage = stage;
    store.refresh();
  };
  say('Reading the file…');
  try {
    receipt.original = { name: file.name, type: file.type, blob: file, dataUrl: '' };
    const content = await documentContent(file, say);
    say('Asking the model to read the charges…');
    const reply = await ask(store, 'task-receipt', [
      { role: 'system', content: systemPrompt(store, 'receipt', { categories: categories.join(', ') || 'none yet' }) },
      { role: 'user', content },
    ]);
    say('Checking the charges against the total…');
    const parsed = parseJson(reply);
    const doc = Array.isArray(parsed) ? { items: parsed } : parsed;
    const documentDate = DATE.test(doc.date) ? doc.date : todayISO();
    const docCurrency = String(doc.currency ?? '').toUpperCase();
    receipt.currency = CURRENCIES.includes(docCurrency) ? docCurrency : view.currency;
    receipt.vendor = String(doc.vendor ?? '').trim();
    receipt.total = Number.isFinite(Number(doc.total)) ? round2(Math.abs(Number(doc.total))) : null;
    receipt.date = documentDate;
    receipt.taxes = (doc.taxes ?? [])
      .map((/** @type {{ name?: string, amount?: unknown }} */ t) => ({ key: uid(), note: String(t.name ?? 'Tax').trim() || 'Tax', amount: round2(Math.abs(Number(t.amount))) }))
      .filter((/** @type {BillTax} */ t) => t.amount > 0);
    receipt.items = (doc.items ?? [])
      // The model's JSON: DATE.test() turns away a date that is missing or not a date.
      .map((/** @type {{ date: string, description?: string, amount?: unknown, tax?: unknown, category?: string }} */ x) => ({
        key: uid(),
        date: DATE.test(x.date) ? x.date : documentDate,
        note: String(x.description ?? '').trim(),
        amount: round2(Math.abs(Number(x.amount))),
        tax: round2(Math.abs(Number(x.tax) || 0)),
        category: String(x.category ?? '').trim() || 'Uncategorized',
        projectId: null,
      }))
      .filter((/** @type {BillLine} */ x) => x.amount > 0);
    // A tax is counted once. When the document prints its taxes as totals and those add up to the bill total,
    // the taxes on the lines are the same money, so they are dropped. Without that, the lines keep their taxes.
    const netSum = round2(receipt.items.reduce((s, x) => s + x.amount, 0));
    const docTaxSum = round2(receipt.taxes.reduce((s, t) => s + t.amount, 0));
    const lineTaxSum = round2(receipt.items.reduce((s, x) => s + x.tax, 0));
    const docAddsUp = receipt.total !== null && Math.abs(round2(netSum + docTaxSum) - receipt.total) < 0.01;
    if (docTaxSum > 0 && lineTaxSum > 0 && (docAddsUp || receipt.total === null)) {
      receipt.items.forEach((x) => {
        x.tax = 0;
      });
    }
    receipt.status = receipt.items.length ? 'ok' : 'error';
    if (!receipt.items.length) receipt.error = 'No charges were found in that file.';
  } catch (err) {
    receipt.status = 'error';
    receipt.error = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

// The check at the top of the review: do the charges add up to the bill total?
/** @param {number} itemsTotal */
function totalCheck(itemsTotal) {
  const cur = receipt.currency;
  if (receipt.total === null) {
    return notice({ tone: 'info', text: `Charges add up to ${money(itemsTotal, cur)}. The bill total could not be read, so there is nothing to check against.` });
  }
  const diff = round2(itemsTotal - receipt.total);
  if (Math.abs(diff) < 0.01) {
    return notice({ tone: 'ok', text: `Charges add up to the bill total of ${money(receipt.total, cur)}.` });
  }
  return notice({
    tone: 'error',
    text: `The charges add up to ${money(itemsTotal, cur)}, but the bill total is ${money(receipt.total, cur)} (a difference of ${money(diff, cur)}). Check for missing or extra charges before adding.`,
  });
}

// The original bill is kept as a file in the data folder (bills/), and the bill links to it.
// Bills saved before that kept a copy inside the JSON; those still open.
/** @param {Store} store @param {Original} original */
async function addBill(store, original) {
  const id = uid();
  const safeName = original.name.replace(/[^\w.-]+/g, '_');
  const file = original.blob ? await store.files.write(`bills/${id}-${safeName}`, original.blob) : '';
  store.update(COLLECTION, (d) => {
    d.bills.push({ id, name: original.name, type: original.type, file, dataUrl: file ? '' : /** @type {string} */ (original.dataUrl), created: now() });
  });
  return id;
}

// Opens an original bill: an image, or a PDF shown in a frame. It is read from the data folder when it is a file.
/** @param {Store} store @param {Original} original */
async function showOriginal(store, original) {
  let url = original.dataUrl || '';
  if (original.file) url = URL.createObjectURL(await store.files.read(original.file));
  else if (!url && original.blob) url = URL.createObjectURL(original.blob);
  const body = url
    ? original.type.startsWith('image/')
      ? h('img', { class: 'bill-img', src: url, alt: original.name })
      : h('iframe', { class: 'bill-frame', src: url, title: original.name })
    : empty('The original file is not available.');
  openDialog({ title: original.name, wide: true, body });
}

/** @param {Store} store @param {string} billId */
function showBill(store, billId) {
  const bill = store.get(COLLECTION).bills.find((b) => b.id === billId);
  if (bill) showOriginal(store, bill);
}

// The review of a bill: each charge with its net amount, its tax and the total, then the document-level taxes.
/** @param {Store} store */
function receiptPanel(store) {
  if (receipt.status === 'idle') return null;
  if (receipt.status === 'loading') {
    return h('div', { class: 'panel-mini' },
      h('strong', null, receipt.fileName),
      progress(receipt.stage || 'Reading…'));
  }
  if (receipt.status === 'error') {
    return notice({
      text: receipt.error,
      actions: [h('button', { type: 'button', class: 'btn-small', onclick: () => { receipt.status = 'idle'; store.refresh(); } }, 'Dismiss')],
    });
  }

  const projects = store.get('projects').projects;
  // Projects on a bill show their icon and name, not a coloured pill.
  const projectOptions = [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }));
  const cur = receipt.currency;
  const source = receipt.vendor || receipt.fileName;
  const netTotal = round2(receipt.items.reduce((s, x) => s + x.amount, 0));
  const taxTotal = round2(receipt.items.reduce((s, x) => s + x.tax, 0) + receipt.taxes.reduce((s, t) => s + t.amount, 0));
  const grandTotal = round2(netTotal + taxTotal);

  const addAll = async () => {
    const billId = receipt.original ? await addBill(store, receipt.original) : '';
    addEntries(store, [
      ...receipt.items.map((x) => ({
        date: x.date,
        type: 'expense',
        amount: round2(x.amount + x.tax),
        tax: x.tax,
        currency: cur,
        category: x.category,
        note: x.note,
        projectId: x.projectId,
        source,
        billId,
      })),
      ...receipt.taxes.map((t) => ({
        date: receipt.date,
        type: 'expense',
        amount: t.amount,
        tax: t.amount,
        currency: cur,
        category: 'Taxes',
        note: t.note,
        projectId: t.projectId ?? null,
        source,
        billId,
      })),
    ]);
    receipt.status = 'idle';
    receipt.items = [];
    receipt.taxes = [];
    store.refresh();
  };

  return h('section', { class: 'card stack receipt' },
    h('div', { class: 'row between' },
      h('div', null,
        h('strong', null, `${receipt.items.length + receipt.taxes.length} lines from ${source}`),
        h('div', { class: 'muted small' }, 'Each line can go to its own project and category. Taxes are kept as their own amounts.')),
      h('div', { class: 'row' },
        h('label', { class: 'inline' }, 'Currency',
          h('select', {
            value: cur,
            'aria-label': 'Bill currency',
            onchange: (/** @type {Event & { target: HTMLSelectElement }} */ e) => {
              receipt.currency = e.target.value;
              store.refresh();
            },
          }, CURRENCIES.map((c) => h('option', { value: c }, c)))),
        receipt.original
          ? h('button', { type: 'button', class: 'btn-small', onclick: () => showOriginal(store, /** @type {Original} */ (receipt.original)) }, 'View original')
          : null,
        h('button', { type: 'button', class: 'btn-small primary', onclick: addAll }, `Add ${receipt.items.length + receipt.taxes.length} lines`),
        h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            receipt.status = 'idle';
            store.refresh();
          },
        }, 'Dismiss'))),

    billLabelRow(store, projectOptions),
    totalCheck(grandTotal),

    h('ul', { class: 'review-list' },
      h('li', { class: 'review-row review-head muted small' },
        h('span', null, 'Date'), h('span', null, 'Charge'), h('span', { class: 'num' }, `Net (${cur})`),
        h('span', { class: 'num' }, 'Tax'), h('span', { class: 'num' }, 'Total'),
        h('span', null, 'Project'), h('span', null, 'Category'), h('span', null)),
      receipt.items.map((x, i) =>
        h('li', { class: 'review-row' },
          editText({
            value: x.date,
            onSave: (v) => {
              if (DATE.test(v)) x.date = v;
              store.refresh();
            },
          }),
          editText({
            value: x.note,
            placeholder: 'Charge description',
            allowEmpty: true,
            onSave: (v) => {
              x.note = v;
              store.refresh();
            },
          }),
          h('span', { class: 'num' }, editText({
            value: x.amount.toFixed(2),
            onSave: (v) => {
              const n = round2(Number(v));
              if (n >= 0) x.amount = n;
              store.refresh();
            },
          })),
          h('span', { class: 'num' }, editText({
            value: x.tax.toFixed(2),
            placeholder: '0.00',
            onSave: (v) => {
              const n = round2(Number(v));
              if (n >= 0) x.tax = n;
              store.refresh();
            },
          })),
          h('span', { class: 'num total' }, money(round2(x.amount + x.tax), cur)),
          pickChip({
            value: x.projectId,
            options: projectOptions,
            nullable: true,
            nullLabel: 'No project',
            onPick: (v) => {
              x.projectId = v;
              store.refresh();
            },
          }),
          editText({
            value: x.category,
            placeholder: 'Category',
            onSave: (v) => {
              x.category = v;
              store.refresh();
            },
          }),
          h('button', {
            type: 'button',
            class: 'icon-btn',
            title: 'Remove this line',
            'aria-label': 'Remove this line',
            onclick: () => {
              receipt.items.splice(i, 1);
              store.refresh();
            },
          }, icon('x')))),
      receipt.taxes.map((t, i) =>
        h('li', { class: 'review-row review-tax' },
          h('span', { class: 'muted small' }, receipt.date),
          editText({
            value: t.note,
            placeholder: 'Tax name',
            onSave: (v) => {
              t.note = v;
              store.refresh();
            },
          }),
          h('span'),
          h('span', { class: 'num' }, editText({
            value: t.amount.toFixed(2),
            onSave: (v) => {
              const n = round2(Number(v));
              if (n > 0) t.amount = n;
              store.refresh();
            },
          })),
          h('span', { class: 'num total' }, money(t.amount, cur)),
          pickChip({
            value: t.projectId ?? null,
            options: projectOptions,
            nullable: true,
            nullLabel: 'No project',
            onPick: (v) => {
              t.projectId = v;
              store.refresh();
            },
          }),
          h('span', { class: 'muted small' }, 'Taxes'),
          h('button', {
            type: 'button',
            class: 'icon-btn',
            title: 'Remove this tax',
            'aria-label': 'Remove this tax',
            onclick: () => {
              receipt.taxes.splice(i, 1);
              store.refresh();
            },
          }, icon('x')))),
    ),

    h('div', { class: 'row end muted small receipt-sums' },
      receipt.total === null ? null : h('span', null, `Bill total ${money(receipt.total, cur)}`),
      h('span', null, `Net ${money(netTotal, cur)}`),
      h('span', null, `Tax ${money(taxTotal, cur)}`),
      h('span', { class: 'strong' }, `Total ${money(grandTotal, cur)}`)));
}

/** @param {Store} store @param {string[]} categories */
function dropZone(store, categories) {
  const input = h('input', {
    type: 'file',
    accept: 'image/*,application/pdf',
    class: 'sr-only',
    'aria-label': 'Choose a bill or screenshot',
    onchange: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (file) readReceipt(store, file, categories);
    },
  });
  return h('div', null,
    input,
    h('div', {
      class: 'dropzone',
      role: 'button',
      tabindex: '0',
      'aria-label': 'Drop a bill or screenshot here, or click to choose one',
      onclick: () => input.click(),
      onkeydown: (/** @type {KeyboardEvent} */ e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.click();
        }
      },
      ondragover: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => {
        e.preventDefault();
        e.currentTarget.classList.add('over');
      },
      ondragleave: (/** @type {DragEvent & { currentTarget: HTMLElement }} */ e) => e.currentTarget.classList.remove('over'),
      ondrop: (/** @type {DragEvent & { currentTarget: HTMLElement, dataTransfer: DataTransfer }} */ e) => {
        e.preventDefault();
        e.currentTarget.classList.remove('over');
        const file = e.dataTransfer.files?.[0];
        if (file) readReceipt(store, file, categories);
      },
    },
      icon('plus'),
      h('strong', null, 'Drop a bill, invoice or screenshot'),
      h('span', { class: 'muted small' }, 'Images or PDFs. Each charge is proposed for you to assign before it is added.')));
}

// --- Spending review (AI) ---

/** @param {Store} store @param {string} range @param {FinanceEntry[]} periodEntries */
async function reviewSpending(store, range, periodEntries) {
  spend.range = range;
  spend.status = 'loading';
  store.refresh();
  try {
    /** @type {Record<string, number>} */
    const byCategory = {};
    for (const e of periodEntries) {
      const key = `${e.type}:${e.category}`;
      const value = shownAmount(e);
      if (value !== null) byCategory[key] = round2((byCategory[key] ?? 0) + value);
    }
    spend.text = (await ask(store, 'task-budget', [
      {
        role: 'system',
        content: systemPrompt(store, 'budget', { currency: view.currency, period: range }),
      },
      {
        role: 'user',
        content: JSON.stringify({
          period: range,
          currency: view.currency,
          byCategory,
          entries: periodEntries.slice(0, 80).map((e) => ({ date: e.date, type: e.type, amount: shownAmount(e), category: e.category, note: e.note })),
        }),
      },
    ])).trim();
    spend.status = 'ok';
  } catch (err) {
    spend.status = 'error';
    spend.text = /** @type {Error} */ (err).message;
  }
  store.refresh();
}

/** @param {Store} store @param {string} range @param {FinanceEntry[]} periodEntries */
function spendingBlock(store, range, periodEntries) {
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: spend.status === 'loading' || !periodEntries.length || !hasOpenRouter(store),
    onclick: () => reviewSpending(store, range, periodEntries),
  }, icon('activity'), 'Review this period with AI');
  if (!hasOpenRouter(store)) return setupBanner('openrouter', 'The spending review needs an OpenRouter key.');
  if (spend.range !== range || spend.status === 'idle') return button;
  if (spend.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Reviewing…'));
  if (spend.status === 'error') return h('div', { class: 'stack' }, button, notice({ text: spend.text }));
  return h('div', { class: 'stack' }, button, h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, spend.text)));
}

// --- Entries: one line per bill (its charges open underneath), one line per entry otherwise ---

/** @type {Set<string>} */
const openBills = new Set(); // ids of the bills whose charges are shown

// Sets fields on every charge of a bill at once: the bill's category or project.
/** @param {Store} store @param {string} billId @param {Partial<FinanceEntry>} patch */
function updateBill(store, billId, patch) {
  if (patch.category !== undefined) patch = { ...patch, category: capitalize(patch.category) || patch.category };
  store.update(COLLECTION, (d) => {
    for (const e of d.entries) {
      if (e.billId === billId) Object.assign(e, patch);
    }
    if (patch.category && !d.categories.some((c) => c.toLowerCase() === /** @type {string} */ (patch.category).toLowerCase())) d.categories.push(patch.category);
  });
}

// Deletes a bill with all its charges, with a few seconds to take it back. The original file stays in bills/.
/** @param {Store} store @param {string} billId */
function removeBill(store, billId) {
  const { entries, bills } = store.get(COLLECTION);
  const charges = entries.filter((e) => e.billId === billId);
  const bill = bills.find((b) => b.id === billId);
  store.update(COLLECTION, (d) => {
    d.entries = d.entries.filter((e) => e.billId !== billId);
    d.bills = d.bills.filter((b) => b.id !== billId);
  });
  toast(`Bill and ${charges.length} charge${charges.length === 1 ? '' : 's'} deleted`, {
    undo: () => store.update(COLLECTION, (d) => {
      d.entries.push(...charges);
      if (bill) d.bills.push(bill);
    }),
  });
}

// Every known category: the saved list plus any an entry uses, so none is missing from the picker.
/** @param {Store} store */
function categoryOptions(store) {
  const { entries, categories, categoryColors = {} } = store.get(COLLECTION);
  // The saved list is in the order set in Settings → Labels; names only an entry uses follow, A to Z.
  const extra = [...new Set(entries.map((e) => e.category).filter((c) => c && !categories.includes(c)))].sort((a, b) => a.localeCompare(b));
  return [...categories, ...extra].map((c) => ({ value: c, label: c, color: categoryColors[c] }));
}

// Category picker: a searchable list of categories, with “Create” for a new one.
/** @param {Store} store @param {string | null} value @param {string} placeholder @param {(category: string) => void} onPick */
function categoryChip(store, value, placeholder, onPick) {
  return pickChip({
    value: value || null,
    options: categoryOptions(store),
    placeholder,
    allowCreate: true,
    className: 'entry-cat',
    onPick,
    onCreate: onPick,
  });
}

// One entry as a single line. Charges of a bill use the same line, indented.
/** @param {Store} store @param {FinanceEntry} e @param {PickOption<string>[]} projectOptions @param {string} cur @param {boolean} [child] */
function entryRow(store, e, projectOptions, cur, child = false) {
  const converted = shownAmount(e);
  const original = entryCurrency(e);
  return h('li', { class: child ? 'entry-row child' : 'entry-row' },
    h('span', { class: 'entry-toggle' }),
    editText({
      value: e.date,
      className: 'muted date',
      onSave: (date) => {
        if (DATE.test(date)) updateEntry(store, e.id, { date });
        else store.refresh();
      },
    }),
    h('span', { class: 'entry-main grow' },
      editText({
        value: e.note,
        placeholder: e.category || 'Add a description',
        allowEmpty: true,
        onSave: (note) => updateEntry(store, e.id, { note }),
      }),
      e.tax ? h('span', { class: 'muted small' }, `incl. tax ${money(e.tax, original)}`) : null),
    categoryChip(store, e.category, 'Category', (category) => updateEntry(store, e.id, { category })),
    pickChip({
      value: e.projectId ?? null,
      options: projectOptions,
      nullable: true,
      nullLabel: 'No project',
      onPick: (projectId) => updateEntry(store, e.id, { projectId }),
    }),
    h('span', { class: 'amount' },
      editText({
        value: e.amount.toFixed(2),
        className: e.type === 'income' ? 'income' : 'expense',
        onSave: (v) => {
          const n = round2(Number(v));
          if (n > 0) updateEntry(store, e.id, { amount: n });
          else store.refresh();
        },
      }),
      pickChip({
        value: original,
        options: CURRENCIES.map((c) => ({ value: c, label: c })),
        onPick: (currency) => updateEntry(store, e.id, { currency }),
      }),
      original !== cur && converted !== null ? h('span', { class: 'muted small' }, `≈ ${money(converted, cur)}`) : null),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Delete',
      'aria-label': `Delete entry ${e.category} ${e.amount.toFixed(2)}`,
      onclick: () => removeEntry(store, e.id),
    }, icon('x')));
}

// A bill as one line: its total, with its category and project for the whole bill. Expands to its charges.
/** @param {Store} store @param {FinanceEntry[]} items charges of one bill @param {PickOption<string>[]} projectOptions @param {string} cur */
function billGroup(store, items, projectOptions, cur) {
  const first = items[0];
  const billId = /** @type {string} */ (first.billId);
  const open = openBills.has(billId);
  const sameCategory = items.every((i) => i.category === first.category) ? first.category : null;
  const sameProject = items.every((i) => (i.projectId ?? null) === (first.projectId ?? null)) ? (first.projectId ?? null) : undefined;
  const total = items.reduce((s, i) => {
    const v = shownAmount(i);
    return v === null || s === null ? null : s + v;
  }, /** @type {number | null} */ (0));
  const tax = round2(items.reduce((s, i) => s + (i.tax || 0), 0));

  const head = h('div', { class: 'entry-row group-head' },
    h('button', {
      type: 'button',
      class: open ? 'icon-btn chevron open' : 'icon-btn chevron',
      title: open ? 'Hide charges' : 'Show charges',
      'aria-label': open ? 'Hide charges' : 'Show charges',
      'aria-expanded': String(open),
      onclick: () => {
        if (open) openBills.delete(billId);
        else openBills.add(billId);
        store.refresh();
      },
    }, icon('chevron-down')),
    h('span', { class: 'muted date' }, first.date),
    h('span', { class: 'entry-main grow' },
      h('strong', null, first.source || 'Bill'),
      h('span', { class: 'muted small' }, `${items.length} charge${items.length === 1 ? '' : 's'}${tax ? ` · tax ${money(tax, cur)}` : ''}`,
        // The original file opens from here, since the row has no spare column for another button.
        store.get(COLLECTION).bills.some((b) => b.id === billId)
          ? [' · ', h('button', { type: 'button', class: 'btn-link-inline', onclick: () => showBill(store, billId) }, 'View original')]
          : null)),
    categoryChip(store, sameCategory, sameCategory === null ? 'Mixed categories' : 'Category', (category) => updateBill(store, billId, { category })),
    pickChip({
      value: sameProject === undefined ? null : sameProject,
      options: projectOptions,
      nullable: true,
      nullLabel: sameProject === undefined ? 'Mixed projects' : 'No project',
      onPick: (projectId) => updateBill(store, billId, { projectId }),
    }),
    h('span', { class: 'amount' }, total === null ? '—' : money(total, cur)),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Delete bill',
      'aria-label': 'Delete bill and its charges',
      onclick: () => removeBill(store, billId),
    }, icon('x')));

  return h('li', { class: 'entry-group' },
    head,
    open ? h('ul', { class: 'entry-children' }, items.map((i) => entryRow(store, i, projectOptions, cur, true))) : null);
}

/** @param {Store} store @param {FinanceEntry[]} inPeriod @param {PickOption<string>[]} projectOptions @param {string} cur */
function entriesSection(store, inPeriod, projectOptions, cur) {
  const list = h('div');
  const count = h('span', { class: 'muted small' });
  // Only the list refills while typing, so the search box keeps focus. The totals above stay those of the period.
  const fill = () => {
    const q = view.query.trim().toLowerCase();
    const shown = q ? inPeriod.filter((e) => `${e.note ?? ''} ${e.category ?? ''} ${e.source ?? ''}`.toLowerCase().includes(q)) : inPeriod;
    /** @type {({ single: FinanceEntry, items?: undefined } | { single?: undefined, items: FinanceEntry[] })[]} */
    const rows = [];
    /** @type {Map<string, { items: FinanceEntry[] }>} */
    const groups = new Map();
    for (const e of shown) {
      if (!e.billId) {
        rows.push({ single: e });
        continue;
      }
      if (!groups.has(e.billId)) {
        /** @type {{ items: FinanceEntry[] }} */
        const group = { items: [] };
        groups.set(e.billId, group);
        rows.push(group);
      }
      /** @type {{ items: FinanceEntry[] }} */ (groups.get(e.billId)).items.push(e);
    }
    count.textContent = `${shown.length} line${shown.length === 1 ? '' : 's'}`;
    list.replaceChildren(rows.length
      ? h('ul', { class: 'entries' },
          rows.map((r) => (r.single
            ? entryRow(store, r.single, projectOptions, cur)
            : billGroup(store, r.items, projectOptions, cur))))
      : empty(q ? 'No entries match.' : 'No entries in this period.'));
  };
  fill();
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' },
      h('h3', null, 'Entries'),
      count),
    h('input', {
      type: 'search',
      placeholder: 'Search entries by note, category or vendor',
      'aria-label': 'Search entries',
      value: view.query,
      oninput: (/** @type {Event & { target: HTMLInputElement }} */ e) => {
        view.query = e.target.value;
        fill();
      },
    }),
    list);
}

// Labels for the whole bill, set as soon as it is read: vendor, project and category. Each applies to every charge.
/** @param {Store} store @param {PickOption<string>[]} projectOptions */
function billLabelRow(store, projectOptions) {
  const items = receipt.items;
  // The bill's project covers its tax lines too: they are saved as entries of the same bill.
  const lines = [...receipt.items, ...receipt.taxes];
  const projectIds = [...new Set(lines.map((x) => x.projectId ?? null))];
  const categories = [...new Set(items.map((x) => x.category))];
  const sameProject = projectIds.length === 1 ? projectIds[0] : undefined;
  const sameCategory = categories.length === 1 ? categories[0] : null;
  return h('div', { class: 'bill-label-row' },
    h('div', { class: 'bill-field' },
      h('span', { class: 'muted small' }, 'Vendor'),
      editText({
        value: receipt.vendor,
        placeholder: receipt.fileName,
        onSave: (vendor) => {
          receipt.vendor = vendor;
          store.refresh();
        },
      })),
    h('div', { class: 'bill-field' },
      h('span', { class: 'muted small' }, 'Project for all charges'),
      pickChip({
        value: sameProject === undefined ? null : sameProject,
        options: projectOptions,
        nullable: true,
        nullLabel: sameProject === undefined ? 'Mixed' : 'No project',
        onPick: (projectId) => {
          lines.forEach((x) => {
            x.projectId = projectId;
          });
          store.refresh();
        },
      })),
    h('div', { class: 'bill-field' },
      h('span', { class: 'muted small' }, 'Category for all charges'),
      editText({
        value: sameCategory ?? '',
        placeholder: sameCategory === null ? 'Mixed' : 'Category',
        onSave: (category) => {
          items.forEach((x) => {
            x.category = category || 'Uncategorized';
          });
          store.refresh();
        },
      })));
}

// --- Recurring expenses ---

export { overBudget, nextRecurringDue };

// Adds an entry for every due date up to today that has none yet. Each date is recorded on its expense,
// so an entry the user deletes is not added again.
/** @param {Store} store */
function syncRecurring(store) {
  const today = ymd(startOfDay(new Date()));
  /** @type {[string, string][]} */
  const missing = [];
  for (const item of store.get(COLLECTION).recurring) {
    const done = new Set(item.generated);
    for (const key of dueDates(item, today)) if (!done.has(key)) missing.push([item.id, key]);
  }
  if (!missing.length) return;
  store.update(COLLECTION, (d) => {
    for (const [id, key] of missing) {
      const item = d.recurring.find((r) => r.id === id);
      if (!item || item.generated.includes(key)) continue;
      item.generated.push(key);
      d.entries.push({
        id: uid(),
        date: key,
        type: 'expense',
        amount: item.amount,
        tax: 0,
        billId: '',
        currency: item.currency,
        category: item.category,
        note: item.name,
        projectId: item.projectId ?? null,
        source: 'Recurring',
        recurringId: item.id,
        created: now(),
      });
      if (!d.categories.some((c) => c.toLowerCase() === item.category.toLowerCase())) d.categories.push(item.category);
    }
  });
}

const KIND_OPTIONS = [{ value: 'fixed', label: 'Fixed' }, { value: 'flex', label: 'Flex' }];
const CADENCE_OPTIONS = [{ value: 'monthly', label: 'Monthly' }, { value: 'yearly', label: 'Yearly' }];

/** @param {Store} store @param {Record<string, string>} values the form's values */
function addRecurring(store, values) {
  const name = String(values.name ?? '').trim();
  const amount = round2(Number(values.amount));
  if (!name || !(amount > 0)) return false;
  const category = capitalize(values.category) || 'Uncategorized';
  store.update(COLLECTION, (d) => {
    d.recurring.push({
      id: uid(),
      name,
      amount,
      currency: CURRENCIES.includes(values.currency) ? values.currency : DEFAULT_CURRENCY,
      category,
      projectId: null,
      cadence: values.cadence === 'yearly' ? 'yearly' : 'monthly',
      kind: values.kind === 'flex' ? 'flex' : 'fixed',
      startDate: DATE.test(values.startDate) ? values.startDate : todayISO(),
      generated: [],
      created: now(),
    });
    if (!d.categories.some((c) => c.toLowerCase() === category.toLowerCase())) d.categories.push(category);
  });
  return true;
}

/** @param {Store} store @param {string} id @param {Partial<Recurring>} patch */
function updateRecurring(store, id, patch) {
  if (patch.category !== undefined) patch = { ...patch, category: capitalize(patch.category) || 'Uncategorized' };
  store.update(COLLECTION, (d) => {
    const item = d.recurring.find((r) => r.id === id);
    if (!item) return;
    Object.assign(item, patch);
    if (patch.category && !d.categories.some((c) => c.toLowerCase() === /** @type {string} */ (patch.category).toLowerCase())) d.categories.push(patch.category);
  });
}

// Stops future entries. The entries it already added stay, as one-off lines.
/** @param {Store} store @param {string} id */
function removeRecurring(store, id) {
  removeWithUndo(store, {
    ask: 'Stop this recurring expense? The entries it already added stay in Money.',
    done: 'Recurring expense stopped',
    collections: ['finance'],
    run: () => {
      store.update(COLLECTION, (d) => {
        d.recurring = d.recurring.filter((r) => r.id !== id);
      });
    },
  });
}

/** @param {Store} store @param {Recurring} r */
function recurringRow(store, r) {
  const today = todayISO();
  const next = dueDates(r, ymd(addDays(startOfDay(new Date()), 400))).find((k) => k > today);
  return h('li', { class: 'recurring-row' },
    h('div', { class: 'recurring-main' },
      editText({ value: r.name, onSave: (name) => updateRecurring(store, r.id, { name }) }),
      h('span', { class: 'muted small' }, `Next due ${next ?? '—'}`)),
    h('div', { class: 'recurring-amount' },
      editText({
        value: r.amount.toFixed(2),
        className: 'expense',
        onSave: (v) => {
          const n = round2(Number(v));
          if (n > 0) updateRecurring(store, r.id, { amount: n });
          else store.refresh();
        },
      }),
      pickChip({
        value: r.currency,
        options: CURRENCIES.map((c) => ({ value: c, label: c })),
        onPick: (currency) => updateRecurring(store, r.id, { currency }),
      })),
    pickChip({ value: r.cadence, options: CADENCE_OPTIONS, onPick: (cadence) => updateRecurring(store, r.id, { cadence }) }),
    pickChip({ value: r.kind, options: KIND_OPTIONS, onPick: (kind) => updateRecurring(store, r.id, { kind }) }),
    categoryChip(store, r.category, 'Category', (category) => updateRecurring(store, r.id, { category })),
    h('button', {
      type: 'button',
      class: 'icon-btn',
      title: 'Stop',
      'aria-label': `Stop ${r.name}`,
      onclick: () => removeRecurring(store, r.id),
    }, icon('x')));
}

/** @param {Store} store @param {string} cur */
function recurringForm(store, cur) {
  return h('form', {
    class: 'stack',
    onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
      e.preventDefault();
      if (addRecurring(store, formValues(e.currentTarget))) e.currentTarget.reset();
      store.refresh();
    },
  },
    h('div', { class: 'row' },
      h('input', { name: 'name', placeholder: 'Name, e.g. Rent', required: true, 'aria-label': 'Name', autocomplete: 'off' }),
      h('input', { name: 'amount', type: 'number', step: '0.01', min: '0', placeholder: 'Amount', required: true, inputmode: 'decimal', 'aria-label': 'Amount' })),
    h('div', { class: 'row' },
      h('select', { name: 'kind', 'aria-label': 'Fixed or flex' },
        KIND_OPTIONS.map((o) => h('option', { value: o.value }, o.label))),
      h('select', { name: 'cadence', 'aria-label': 'How often' },
        CADENCE_OPTIONS.map((o) => h('option', { value: o.value }, o.label))),
      h('select', { name: 'currency', value: cur, 'aria-label': 'Currency' },
        CURRENCIES.map((c) => h('option', { value: c }, c)))),
    h('div', { class: 'row' },
      h('input', { name: 'category', list: 'finance-categories', placeholder: 'Category', 'aria-label': 'Category', autocomplete: 'off' }),
      h('input', { name: 'startDate', type: 'date', value: todayISO(), 'aria-label': 'Start date' })),
    h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Add recurring expense')));
}

// Fixed and flex expenses, each as a monthly amount in the shown currency, then the list to edit.
/** @param {Store} store @param {string} cur */
function recurringCard(store, cur) {
  const { recurring } = store.get(COLLECTION);
  const today = todayISO();
  const perMonth = { fixed: 0, flex: 0 };
  let uncounted = 0;
  for (const r of recurring) {
    const monthly = r.cadence === 'yearly' ? r.amount / 12 : r.amount;
    const v = convert(round2(monthly), r.currency ?? DEFAULT_CURRENCY, cur, knownRate(today));
    if (v === null) uncounted += 1;
    else perMonth[r.kind === 'flex' ? 'flex' : 'fixed'] += v;
  }
  return h('section', { class: 'card stack' },
    h('div', { class: 'row between' },
      h('h3', null, 'Recurring'),
      h('span', { class: 'muted small' }, `Fixed ${money(round2(perMonth.fixed), cur)} · Flex ${money(round2(perMonth.flex), cur)} a month`)),
    h('p', { class: 'muted small' }, 'Fixed costs stay the same each time. Flex costs change. Each due date adds an entry on its own.'),
    recurring.length
      ? h('ul', { class: 'recurring-list' }, recurring.map((r) => recurringRow(store, r)))
      : empty('No recurring expenses yet.'),
    uncounted ? h('p', { class: 'muted small' }, `${uncounted} ${uncounted === 1 ? 'expense is' : 'expenses are'} left out of the monthly totals until its rate loads.`) : null,
    recurringForm(store, cur));
}

// --- Page ---

// One row of a breakdown: its share of the total, filled in the colour of its category when it has one.
/** @type {(label: string, amount: number, total: number, cur: string, color?: string) => HTMLLIElement} */
const bar = (label, amount, total, cur, color) =>
  h('li', null,
    h('div', { class: 'row between' }, h('span', null, label), h('span', null, `${money(amount, cur)} · ${total ? Math.round((amount / total) * 100) : 0}%`)),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: color ? { width: `${total ? (amount / total) * 100 : 0}%`, background: color } : { width: `${total ? (amount / total) * 100 : 0}%` } })));

// A monthly budget is saved with the currency it was typed in. An empty or zero value removes it.
/** @param {Store} store @param {string} category @param {string} text @param {string} currency */
function setBudget(store, category, text, currency) {
  const amount = round2(Number(text));
  store.update(COLLECTION, (d) => {
    d.budgets = { ...(d.budgets ?? {}) };
    if (amount > 0) d.budgets[category] = { amount, currency };
    else delete d.budgets[category];
  });
}

// A category's spending. When the period is one month, it is measured against the category's budget, which is edited here.
/** @param {Store} store @param {string} name @param {number} amount @param {number} total @param {string} cur @param {string | undefined} color @param {boolean} monthly */
function categoryBar(store, name, amount, total, cur, color, monthly) {
  const saved = (store.get(COLLECTION).budgets ?? {})[name];
  const budget = monthly && saved ? convert(saved.amount, saved.currency, cur, knownRate(todayISO())) : null;
  const over = budget !== null && amount > budget;
  const share = `${money(amount, cur)} · ${total ? Math.round((amount / total) * 100) : 0}%`;
  const width = `${Math.min(100, budget ? (amount / budget) * 100 : total ? (amount / total) * 100 : 0)}%`;
  return h('li', null,
    h('div', { class: 'row between' },
      h('span', null, name),
      h('span', null, share, budget !== null ? h('span', { class: over ? 'expense' : 'muted' }, ` · ${Math.round((amount / budget) * 100)}% of ${money(budget, cur)}`) : null)),
    h('div', { class: 'bar-track' }, h('div', { class: 'bar-fill', style: { width, ...(over ? { background: 'var(--danger)' } : color ? { background: color } : {}) } })),
    monthly
      ? h('div', { class: 'row budget-line muted small' }, 'Monthly budget',
          editText({
            value: saved ? String(saved.amount) : '',
            placeholder: 'set one',
            allowEmpty: true,
            onSave: (v) => setBudget(store, name, v, cur),
          }),
          saved ? saved.currency : null)
      : null);
}

/** @param {HTMLElement} root @param {Store} store */
function draw(root, store) {
  const { entries, categories, categoryColors = {} } = store.get(COLLECTION);
  const projects = store.get('projects').projects;
  const projectById = new Map(projects.map((p) => [p.id, p]));
  // Projects show their icon and name, without a pill.
  const projectOptions = [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) }));
  const cur = view.currency;
  // Recurring entries are added after this render, so the change does not run inside it.
  setTimeout(() => syncRecurring(store), 0);
  // Fixed or flex: an entry takes the kind of its recurring expense. Other entries are one-off.
  const kindById = new Map(store.get(COLLECTION).recurring.map((r) => [r.id, r.kind]));
  const kindOf = (/** @type {FinanceEntry} */ e) => (e.recurringId ? kindById.get(e.recurringId) ?? 'one-off' : 'one-off');

  const w = windowFor(view.range, entries);
  const fromKey = ymd(w.from);
  const toKey = ymd(w.to);
  const inPeriod = entries
    .filter((e) => e.date >= fromKey && e.date < toKey && (view.kind === 'all' || kindOf(e) === view.kind))
    .sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));

  // Rates for the days on screen, asked for after this render.
  shownDays = inPeriod.map((e) => e.date).concat(todayISO());
  setTimeout(() => scheduleRates(store, shownDays), 0);

  // Totals, buckets and breakdowns in the shown currency. Entries whose rate is not known yet are counted apart.
  let unconverted = 0;
  const keys = bucketKeys(w.from, w.to, view.group);
  const incomeByBucket = new Map(keys.map((k) => [k, 0]));
  const expenseByBucket = new Map(keys.map((k) => [k, 0]));
  /** @type {Map<string, number>} */
  const byCategory = new Map();
  /** @type {Map<string, number>} */
  const byProject = new Map();
  let income = 0;
  let expense = 0;
  for (const e of inPeriod) {
    const v = shownAmount(e);
    if (v === null) {
      unconverted += 1;
      continue;
    }
    const key = bucketKey(parseYmd(e.date), view.group);
    if (e.type === 'income') {
      income += v;
      incomeByBucket.set(key, (incomeByBucket.get(key) ?? 0) + v);
    } else {
      expense += v;
      expenseByBucket.set(key, (expenseByBucket.get(key) ?? 0) + v);
      byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + v);
      const name = projectById.get(/** @type {string} */ (e.projectId))?.name ?? 'No project'; // null finds none
      byProject.set(name, (byProject.get(name) ?? 0) + v);
    }
  }
  income = round2(income);
  expense = round2(expense);
  const net = round2(income - expense);
  const categoryRows = [...byCategory].sort((a, b) => b[1] - a[1]);
  const projectRows = [...byProject].sort((a, b) => b[1] - a[1]);

  const labels = keys.map((k) => bucketLabel(k, view.group));
  const series = [
    { name: 'Income', color: 'var(--income)', values: keys.map((k) => round2(incomeByBucket.get(k) ?? 0)) },
    { name: 'Expenses', color: 'var(--expense)', values: keys.map((k) => round2(expenseByBucket.get(k) ?? 0)) },
  ];
  const month = shownMonth(view.range);
  const monthName = month ? parseYmd(`${month}-01`).toLocaleDateString(dateLocale(), { month: 'long', year: 'numeric' }) : '';
  const rangeLabel = RANGES.find(([k]) => k === view.range)?.[1] ?? monthName;
  const stepTo = (/** @type {number} */ delta) => () => {
    view.range = stepMonth(view.range, delta);
    store.refresh();
  };

  root.replaceChildren(
    h('div', { class: 'money stack-lg' },
      fxBanner(store),
      receiptPanel(store),

      // The page has no header: the controls come first, the currency with them, and the count of entries is
      // in the month's tooltip.
      h('div', { class: 'money-controls' },
        h('div', { class: 'row' },
          h('div', { class: 'month-step', role: 'group', 'aria-label': 'Month' },
            h('button', { type: 'button', class: 'icon-btn', title: 'Previous month', 'aria-label': 'Previous month', onclick: stepTo(-1) }, icon('chevron-left')),
            h('strong', { title: `${rangeLabel} · ${entries.length} entries` }, monthName || rangeLabel),
            h('button', { type: 'button', class: 'icon-btn', title: 'Next month', 'aria-label': 'Next month', disabled: !month || month >= monthKeyOf(new Date()), onclick: stepTo(1) }, icon('chevron-right'))),
          h('div', { class: 'period', role: 'group', 'aria-label': 'Show totals in' },
            CURRENCIES.map((c) =>
              h('button', {
                type: 'button',
                class: c === cur ? 'period-btn active' : 'period-btn',
                'aria-pressed': String(c === cur),
                onclick: () => {
                  view.currency = c;
                  store.refresh();
                },
              }, c)))),
        h('div', { class: 'period', role: 'group', 'aria-label': 'Period' },
          RANGES.map(([k, l]) =>
            h('button', {
              type: 'button',
              class: view.range === k ? 'period-btn active' : 'period-btn',
              'aria-pressed': String(view.range === k),
              onclick: () => {
                view.range = k;
                store.refresh();
              },
            }, l))),
        h('div', { class: 'period', role: 'group', 'aria-label': 'Expense type' },
          KINDS.map(([k, l]) =>
            h('button', {
              type: 'button',
              class: view.kind === k ? 'period-btn active' : 'period-btn',
              'aria-pressed': String(view.kind === k),
              onclick: () => {
                view.kind = k;
                store.refresh();
              },
            }, l))),
        h('div', { class: 'period', role: 'group', 'aria-label': 'Group by' },
          GROUPS.map(([k, l]) =>
            h('button', {
              type: 'button',
              class: view.group === k ? 'period-btn active' : 'period-btn',
              'aria-pressed': String(view.group === k),
              onclick: () => {
                view.group = k;
                store.refresh();
              },
            }, l)))),

      h('div', { class: 'money-grid' },
        h('div', { class: 'money-main stack-lg' },
          h('div', { class: 'summary money-stats' },
            h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Income'), h('strong', { class: 'income' }, money(income, cur))),
            h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Expenses'), h('strong', { class: 'expense' }, money(expense, cur))),
            h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Net'),
              h('strong', { class: net < 0 ? 'expense' : 'income' }, money(net, cur))),
            h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Average per day'),
              h('strong', null, money(round2(expense / Math.max(1, keys.length)), cur)),
              h('span', { class: 'muted small' }, 'spent'))),

          unconverted
            ? h('p', { class: 'muted small' }, `${unconverted} ${unconverted === 1 ? 'entry' : 'entries'} ${unconverted === 1 ? 'is' : 'are'} left out until its rate loads.`)
            : null,

          h('section', { class: 'card stack' },
            h('div', { class: 'row between' },
              h('h3', null, 'Income and expenses'),
              legend(series)),
            inPeriod.length
              ? barChart(labels, series, { grouped: true, format: (v) => money(v, cur) })
              : empty('No entries in this period.')),

          h('div', { class: 'split-2' },
            h('section', { class: 'card stack' },
              h('h3', null, 'Expenses by category'),
              categoryRows.length
                ? h('ul', { class: 'bars' }, categoryRows.map(([name, v]) => categoryBar(store, name, v, expense, cur, categoryColors[name], Boolean(month))))
                : empty('No expenses in this period.')),
            h('section', { class: 'card stack' },
              h('h3', null, 'Expenses by project'),
              projectRows.length
                ? h('ul', { class: 'bars' }, projectRows.map(([name, v]) => bar(name, v, expense, cur)))
                : empty('No expenses in this period.'))),

          entriesSection(store, inPeriod, projectOptions, cur)),
        h('aside', { class: 'money-side stack-lg' },
          h('section', { class: 'card stack' },
            h('h3', null, 'Add a bill or screenshot'),
            hasOpenRouter(store) ? null : setupBanner('openrouter', 'Reading bills needs an OpenRouter key.'),
            dropZone(store, categories)),

          h('section', { class: 'card stack' },
            h('h3', null, 'Add an entry'),
            h('form', {
              class: 'stack',
              onsubmit: (/** @type {SubmitEvent & { currentTarget: HTMLFormElement }} */ e) => {
                e.preventDefault();
                addEntry(store, formValues(e.currentTarget));
              },
            },
              h('div', { class: 'row' },
                h('select', { name: 'type', 'aria-label': 'Type' },
                  h('option', { value: 'expense' }, 'Expense'),
                  h('option', { value: 'income' }, 'Income')),
                h('input', { name: 'amount', type: 'number', step: '0.01', min: '0', placeholder: 'Amount', required: true, inputmode: 'decimal', 'aria-label': 'Amount' }),
                h('input', { name: 'tax', type: 'number', step: '0.01', min: '0', placeholder: 'Tax (in amount)', inputmode: 'decimal', 'aria-label': 'Tax included in the amount' }),
                h('select', { name: 'currency', value: cur, 'aria-label': 'Currency' },
                  CURRENCIES.map((c) => h('option', { value: c }, c)))),
              h('div', { class: 'row' },
                h('input', { name: 'category', list: 'finance-categories', placeholder: 'Category', 'aria-label': 'Category', autocomplete: 'off' }),
                h('input', { name: 'date', type: 'date', value: todayISO(), 'aria-label': 'Date' })),
              h('input', { name: 'note', placeholder: 'Note (optional)', 'aria-label': 'Note', autocomplete: 'off' }),
              h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Add entry')),
              h('datalist', { id: 'finance-categories' }, categories.map((c) => h('option', { value: c }))))),

          recurringCard(store, cur),

          h('section', { class: 'card stack' },
            h('h3', null, 'Review'),
            spendingBlock(store, view.range, inPeriod))))));
}

export default /** @satisfies {import('../../types/data').Module} */ ({
  id: 'money',
  title: 'Money',
  icon: 'wallet',
  collection: COLLECTION,
  defaults: { entries: [], categories: [], bills: [], categoryColors: {}, recurring: [], budgets: {} },
  render: draw,
  serialize: () => ({ cur: view.currency, range: view.range === 'month' ? '' : view.range, group: view.group === 'day' ? '' : view.group, kind: view.kind === 'all' ? '' : view.kind }),
  restore: (/** @type {Record<string, string>} */ p = {}) => {
    view.currency = CURRENCIES.includes(p.cur) ? p.cur : DEFAULT_CURRENCY;
    view.range = RANGES.some(([k]) => k === p.range) || isMonthKey(p.range ?? '') ? p.range : 'month';
    view.group = GROUPS.some(([k]) => k === p.group) ? p.group : 'day';
    view.kind = KINDS.some(([k]) => k === p.kind) ? p.kind : 'all';
  },
});
