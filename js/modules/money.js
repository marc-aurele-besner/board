import { h, uid, now, todayISO, monthKey, money, empty, icon, notice, progress, CURRENCIES } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';
import { readPdf } from '../pdf-reader.js';
import { fetchUsdToCad, manualRate, setManualRate, convert } from '../fx.js';

const COLLECTION = 'finance';
const TYPES = [['expense', 'Expense'], ['income', 'Income']];
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DEFAULT_CURRENCY = 'USD'; // entries saved before currencies existed are treated as USD

// View state: the month shown, and the currency totals are shown in.
const view = { month: monthKey(todayISO()), currency: DEFAULT_CURRENCY };
// A bill is read into charges (the line items), a currency and a bill total. Only the charges become entries.
const receipt = { status: 'idle', items: [], total: null, currency: DEFAULT_CURRENCY, vendor: '', error: '', fileName: '', stage: '' };
// Monthly spending review (task 6).
const spend = { month: '', status: 'idle', text: '' };
// Exchange rate: the reference rate from the service, or null until it arrives.
const fx = { status: 'idle', rate: null, date: '', error: '' };

const round2 = (n) => Math.round(n * 100) / 100;
const formValues = (form) => Object.fromEntries(new FormData(form));
const entryCurrency = (e) => e.currency ?? DEFAULT_CURRENCY;
const currentRate = () => manualRate() ?? fx.rate;
// An entry's amount in the shown currency, or null when no rate can convert it.
const shownAmount = (e) => convert(e.amount, entryCurrency(e), view.currency, currentRate());

// Adds entries. Each carries its currency, optional project, and `source` naming the bill it came from.
function addEntries(store, list) {
  store.update(COLLECTION, (d) => {
    for (const e of list) {
      const category = e.category || 'Uncategorized';
      d.entries.push({
        id: uid(),
        date: e.date,
        type: e.type ?? 'expense',
        amount: round2(e.amount),
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

function addEntry(store, v) {
  const amount = round2(Number(v.amount));
  if (!(amount > 0)) return;
  const date = v.date || todayISO();
  view.month = monthKey(date); // show the month the entry landed in
  addEntries(store, [{
    date,
    type: v.type === 'income' ? 'income' : 'expense',
    amount,
    currency: v.currency,
    category: v.category.trim(),
    note: v.note.trim(),
  }]);
}

// Every change to an entry goes through here, so a new category is remembered too.
function updateEntry(store, id, patch) {
  store.update(COLLECTION, (d) => {
    const e = d.entries.find((x) => x.id === id);
    if (!e) return;
    Object.assign(e, patch);
    if (patch.category && !d.categories.some((c) => c.toLowerCase() === patch.category.toLowerCase())) d.categories.push(patch.category);
  });
}

function removeEntry(store, id) {
  store.update(COLLECTION, (d) => {
    d.entries = d.entries.filter((e) => e.id !== id);
  });
}

// --- Exchange rate ---

function loadRate(store) {
  if (fx.status === 'loading') return;
  fx.status = 'loading';
  store.refresh();
  fetchUsdToCad()
    .then((r) => {
      fx.rate = r.rate;
      fx.date = r.date;
      fx.status = 'ok';
      fx.error = '';
    })
    .catch((err) => {
      fx.status = 'error';
      fx.error = err.message;
    })
    .finally(() => store.refresh());
}

function rateLine(store) {
  const rate = currentRate();
  if (rate !== null) {
    const source = manualRate() !== null ? 'your rate' : `reference rate for ${fx.date}`;
    return h('p', { class: 'muted small rate-line' }, `1 USD = ${rate.toFixed(4)} CAD · ${source}`,
      manualRate() !== null
        ? h('button', { type: 'button', class: 'btn-small', onclick: () => { setManualRate(null); store.refresh(); } }, 'Use reference rate')
        : null);
  }
  if (fx.status === 'loading' || fx.status === 'idle') return h('p', { class: 'muted small rate-line' }, 'Loading the exchange rate…');
  return notice({
    text: `${fx.error || 'No exchange rate is available.'} Enter a USD → CAD rate to convert amounts.`,
    actions: [h('form', {
      class: 'row',
      onsubmit: (e) => {
        e.preventDefault();
        const v = Number(new FormData(e.currentTarget).get('rate'));
        if (v > 0) setManualRate(v);
        store.refresh();
      },
    },
      h('input', { name: 'rate', type: 'number', step: '0.0001', min: '0', placeholder: 'e.g. 1.37', inputmode: 'decimal', 'aria-label': 'USD to CAD rate' }),
      h('button', { type: 'button', class: 'btn-small primary', onclick: (e) => e.currentTarget.closest('form').requestSubmit() }, 'Use this rate'))],
  });
}

// --- Bills and screenshots ---

// The message parts for a dropped file. A PDF with a text layer is sent as text (any model can read it);
// a scanned PDF or an image is sent as images (needs a model that reads images).
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

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });

const receiptPrompt = (categories) => [
  'You read bills, invoices and receipts. Reply with JSON only, in this shape:',
  '{"vendor": string, "date": "YYYY-MM-DD", "currency": "USD" or "CAD" or the ISO code on the document, "items": [{"date": "YYYY-MM-DD", "description": string, "amount": number, "category": string}], "total": number}.',
  'Rules:',
  '- items: one object per charge line on the document, across every page. Amounts are positive numbers with cents, like 19.99.',
  '- Do NOT list subtotals, tax, totals, balances, credits or payments as items. Put the amount due on the document in "total".',
  '- If a line has no date of its own, use the document date.',
  `- category: pick from ${categories.join(', ') || 'none yet'} when one fits, otherwise a short new name.`,
  '- Do not summarize or group lines. Every charge line gets its own item.',
].join('\n');

async function readReceipt(store, file, categories) {
  receipt.status = 'loading';
  receipt.error = '';
  receipt.fileName = file.name;
  receipt.items = [];
  receipt.total = null;
  // Each step updates the loading bar's label, so the wait shows what is happening.
  const say = (stage) => {
    receipt.stage = stage;
    store.refresh();
  };
  say('Reading the file…');
  try {
    const content = await documentContent(file, say);
    say('Asking the model to read the charges…');
    const reply = await ask(store, 'task-receipt', [
      { role: 'system', content: receiptPrompt(categories) },
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
    receipt.items = (doc.items ?? [])
      .map((x) => ({
        key: uid(),
        date: DATE.test(x.date) ? x.date : documentDate,
        note: String(x.description ?? '').trim(),
        amount: round2(Math.abs(Number(x.amount))),
        category: String(x.category ?? '').trim() || 'Uncategorized',
        projectId: null,
      }))
      .filter((x) => x.amount > 0);
    receipt.status = receipt.items.length ? 'ok' : 'error';
    if (!receipt.items.length) receipt.error = 'No charges were found in that file.';
  } catch (err) {
    receipt.status = 'error';
    receipt.error = err.message;
  }
  store.refresh();
}

// The check at the top of the review: do the charges add up to the bill total?
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
  const projectOptions = [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, color: p.color }));
  const itemsTotal = round2(receipt.items.reduce((s, x) => s + x.amount, 0));
  const source = receipt.vendor || receipt.fileName;
  const cur = receipt.currency;

  return h('div', { class: 'panel-mini receipt' },
    h('div', { class: 'row between' },
      h('div', null,
        h('strong', null, `${receipt.items.length} charges from ${source}`),
        h('div', { class: 'muted small' }, 'Each charge can go to its own project and category. The bill total is only for checking.')),
      h('div', { class: 'row' },
        h('label', { class: 'inline' }, 'Currency',
          h('select', {
            value: cur,
            'aria-label': 'Bill currency',
            onchange: (e) => {
              receipt.currency = e.target.value;
              store.refresh();
            },
          }, CURRENCIES.map((c) => h('option', { value: c }, c)))),
        h('button', {
          type: 'button',
          class: 'btn-small primary',
          onclick: () => {
            addEntries(store, receipt.items.map((x) => ({
              date: x.date,
              type: 'expense',
              amount: x.amount,
              currency: cur,
              category: x.category,
              note: x.note,
              projectId: x.projectId,
              source,
            })));
            view.month = monthKey(receipt.items[0].date);
            receipt.status = 'idle';
            receipt.items = [];
            store.refresh();
          },
        }, `Add ${receipt.items.length} charges`),
        h('button', {
          type: 'button',
          class: 'btn-small',
          onclick: () => {
            receipt.status = 'idle';
            store.refresh();
          },
        }, 'Dismiss'))),

    totalCheck(itemsTotal),

    h('ul', { class: 'review-list' },
      h('li', { class: 'review-row review-head muted small' },
        h('span', null, 'Date'), h('span', null, 'Charge'), h('span', { class: 'num' }, `Amount (${cur})`),
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
              if (n > 0) x.amount = n;
              store.refresh();
            },
          })),
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
            title: 'Remove this charge',
            'aria-label': 'Remove this charge',
            onclick: () => {
              receipt.items.splice(i, 1);
              store.refresh();
            },
          }, icon('x')))),
    ),

    h('div', { class: 'row end muted small' },
      receipt.total === null ? null : h('span', null, `Bill total ${money(receipt.total, cur)}`),
      h('span', null, `Charges ${money(itemsTotal, cur)}`)));
}

function dropZone(store, categories) {
  const input = h('input', {
    type: 'file',
    accept: 'image/*,application/pdf',
    class: 'sr-only',
    'aria-label': 'Choose a bill or screenshot',
    onchange: (e) => {
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
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          input.click();
        }
      },
      ondragover: (e) => {
        e.preventDefault();
        e.currentTarget.classList.add('over');
      },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
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

// --- Spending review ---

async function reviewSpending(store, month, monthEntries) {
  spend.month = month;
  spend.status = 'loading';
  store.refresh();
  try {
    const byCategory = {};
    for (const e of monthEntries) {
      const key = `${e.type}:${e.category}`;
      const value = shownAmount(e);
      if (value !== null) byCategory[key] = round2((byCategory[key] ?? 0) + value);
    }
    spend.text = (await ask(store, 'task-budget', [
      {
        role: 'system',
        content: `You review a personal monthly budget. Amounts are in ${view.currency}. Given the month’s totals, totals by category and the entries as JSON, reply in plain text: the overall picture in two sentences, then the three things worth a second look, then one practical suggestion. Be concise and do not invent figures.`,
      },
      {
        role: 'user',
        content: JSON.stringify({
          month,
          currency: view.currency,
          byCategory,
          entries: monthEntries.slice(0, 80).map((e) => ({ date: e.date, type: e.type, amount: shownAmount(e), category: e.category, note: e.note })),
        }),
      },
    ])).trim();
    spend.status = 'ok';
  } catch (err) {
    spend.status = 'error';
    spend.text = err.message;
  }
  store.refresh();
}

function spendingBlock(store, month, monthEntries) {
  const button = h('button', {
    type: 'button',
    class: 'btn-small',
    disabled: spend.status === 'loading' || !monthEntries.length,
    onclick: () => reviewSpending(store, month, monthEntries),
  }, 'Review this month with AI');
  if (spend.month !== month || spend.status === 'idle') return h('div', { class: 'row' }, button);
  if (spend.status === 'loading') return h('div', { class: 'stack' }, button, h('p', { class: 'muted small' }, 'Reviewing the month…'));
  if (spend.status === 'error') return h('div', { class: 'stack' }, button, notice({ text: spend.text }));
  return h('div', { class: 'stack' }, button, h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, spend.text)));
}

// --- Page ---

function draw(root, store) {
  if (fx.status === 'idle') {
    // Load after this render finishes, so the refresh does not run inside it.
    setTimeout(() => loadRate(store), 0);
  }
  const { entries, categories } = store.get(COLLECTION);
  const projects = store.get('projects').projects;
  const projectOptions = [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, color: p.color }));
  const cur = view.currency;
  const monthEntries = entries
    .filter((e) => monthKey(e.date) === view.month)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));

  // Totals in the shown currency. Entries that cannot be converted yet are counted separately.
  let unconverted = 0;
  const total = (type) => {
    let sum = 0;
    for (const e of monthEntries) {
      if (e.type !== type) continue;
      const v = shownAmount(e);
      if (v === null) unconverted += 1;
      else sum += v;
    }
    return round2(sum);
  };
  const income = total('income');
  const expense = total('expense');
  const net = round2(income - expense);

  // Expense totals per category, largest first.
  const byCategory = new Map();
  for (const e of monthEntries) {
    const v = e.type === 'expense' ? shownAmount(e) : null;
    if (v !== null) byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + v);
  }
  const breakdown = [...byCategory].sort((a, b) => b[1] - a[1]);

  root.replaceChildren(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'row between head' },
        h('h2', null, 'Money'),
        h('div', { class: 'row' },
          h('label', { class: 'inline' }, 'Show in',
            h('select', {
              value: view.currency,
              'aria-label': 'Show totals in currency',
              onchange: (e) => {
                view.currency = e.target.value;
                store.refresh();
              },
            }, CURRENCIES.map((c) => h('option', { value: c }, c)))),
          h('input', {
            type: 'month',
            value: view.month,
            'aria-label': 'Month',
            onchange: (e) => {
              view.month = e.target.value || view.month;
              store.refresh();
            },
          }))),

      rateLine(store),

      dropZone(store, categories),
      receiptPanel(store),

      h('div', { class: 'summary' },
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Income'), h('strong', { class: 'income' }, money(income, cur))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Expenses'), h('strong', { class: 'expense' }, money(expense, cur))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Net'),
          h('strong', { class: net < 0 ? 'expense' : 'income' }, money(net, cur)))),
      unconverted
        ? h('p', { class: 'muted small' }, `${unconverted} ${unconverted === 1 ? 'entry' : 'entries'} in another currency ${unconverted === 1 ? 'is' : 'are'} left out until a rate is available.`)
        : null,

      spendingBlock(store, view.month, monthEntries),

      h('div', { class: 'split' },
        h('section', { class: 'card main-pane' },
          h('h3', null, 'Quick add'),
          h('form', {
            class: 'stack',
            onsubmit: (e) => {
              e.preventDefault();
              addEntry(store, formValues(e.currentTarget));
            },
          },
            h('div', { class: 'row' },
              h('select', { name: 'type', 'aria-label': 'Type' },
                h('option', { value: 'expense' }, 'Expense'),
                h('option', { value: 'income' }, 'Income')),
              h('input', { name: 'amount', type: 'number', step: '0.01', min: '0', placeholder: 'Amount', required: true, inputmode: 'decimal', 'aria-label': 'Amount' }),
              h('select', { name: 'currency', value: cur, 'aria-label': 'Currency' },
                CURRENCIES.map((c) => h('option', { value: c }, c)))),
            h('div', { class: 'row' },
              h('input', { name: 'category', list: 'finance-categories', placeholder: 'Category', 'aria-label': 'Category', autocomplete: 'off' }),
              h('input', { name: 'date', type: 'date', value: todayISO(), 'aria-label': 'Date' })),
            h('input', { name: 'note', placeholder: 'Note (optional)', 'aria-label': 'Note', autocomplete: 'off' }),
            h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Add entry')),
            h('datalist', { id: 'finance-categories' }, categories.map((c) => h('option', { value: c }))))),

        h('section', { class: 'card main-pane' },
          h('h3', null, `Expenses by category (${cur})`),
          breakdown.length
            ? h('ul', { class: 'bars' },
                breakdown.map(([name, amount]) =>
                  h('li', null,
                    h('div', { class: 'row between' }, h('span', null, name), h('span', null, money(amount, cur))),
                    h('div', { class: 'bar-track' },
                      h('div', { class: 'bar-fill', style: { width: `${expense ? (amount / expense) * 100 : 0}%` } })))))
            : empty('No expenses this month.'))),

      h('section', { class: 'card main-pane' },
        h('h3', null, 'Entries'),
        monthEntries.length
          ? h('ul', { class: 'entries' },
              monthEntries.map((e) => {
                const converted = shownAmount(e);
                const original = entryCurrency(e);
                return h('li', null,
                  editText({
                    value: e.date,
                    className: 'muted date',
                    onSave: (date) => {
                      if (DATE.test(date)) updateEntry(store, e.id, { date });
                      else store.refresh();
                    },
                  }),
                  h('span', { class: 'grow' },
                    editText({
                      value: e.category,
                      placeholder: 'Category',
                      onSave: (category) => updateEntry(store, e.id, { category }),
                    }),
                    editText({
                      value: e.note,
                      placeholder: 'Add a note',
                      allowEmpty: true,
                      className: 'muted',
                      onSave: (note) => updateEntry(store, e.id, { note }),
                    }),
                    e.source ? h('span', { class: 'muted small' }, `from ${e.source}`) : null),
                  pickChip({
                    value: e.projectId ?? null,
                    options: projectOptions,
                    nullable: true,
                    nullLabel: 'No project',
                    onPick: (projectId) => updateEntry(store, e.id, { projectId }),
                  }),
                  pickChip({
                    value: e.type,
                    options: TYPES.map(([v, l]) => ({ value: v, label: l, tone: v === 'income' ? 'done' : 'high' })),
                    onPick: (type) => updateEntry(store, e.id, { type }),
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
                    original !== cur && converted !== null
                      ? h('span', { class: 'muted small' }, `≈ ${money(converted, cur)}`)
                      : null),
                  h('button', {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Delete',
                    'aria-label': `Delete entry ${e.category} ${e.amount.toFixed(2)}`,
                    onclick: () => removeEntry(store, e.id),
                  }, icon('x')));
              }))
          : empty('No entries for this month.'))));
}

export default {
  id: 'money',
  title: 'Money',
  icon: 'wallet',
  collection: COLLECTION,
  defaults: { entries: [], categories: [] },
  render: draw,
  serialize: () => ({ month: view.month, cur: view.currency }),
  restore: (p = {}) => {
    view.month = /^\d{4}-\d{2}$/.test(p.month ?? '') ? p.month : monthKey(todayISO());
    view.currency = CURRENCIES.includes(p.cur) ? p.cur : DEFAULT_CURRENCY;
  },
};
