import { h, uid, now, todayISO, monthKey, money, empty, icon } from '../ui.js';
import { editText, pickChip } from '../inline.js';
import { ask, parseJson } from '../ai.js';

const COLLECTION = 'finance';
const TYPES = [['expense', 'Expense'], ['income', 'Income']];

// View state: the month being shown (YYYY-MM).
const view = { month: monthKey(todayISO()) };
// Bill reading: a file is read, the proposed entries are reviewed, then added.
const receipt = { status: 'idle', items: [], error: '', fileName: '' };
// Monthly spending review (task 6).
const spend = { month: '', status: 'idle', text: '' };

const round2 = (n) => Math.round(n * 100) / 100;
const formValues = (form) => Object.fromEntries(new FormData(form));

function addEntries(store, list) {
  store.update(COLLECTION, (d) => {
    for (const e of list) {
      const category = e.category || 'Uncategorized';
      d.entries.push({ id: uid(), date: e.date, type: e.type, amount: e.amount, category, note: e.note || '', created: now() });
      if (!d.categories.some((c) => c.toLowerCase() === category.toLowerCase())) d.categories.push(category);
    }
  });
}

function addEntry(store, v) {
  const amount = round2(Number(v.amount));
  if (!(amount > 0)) return;
  const date = v.date || todayISO();
  view.month = monthKey(date); // show the month the entry landed in
  addEntries(store, [{ date, type: v.type === 'income' ? 'income' : 'expense', amount, category: v.category.trim(), note: v.note.trim() }]);
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

// --- Bills and screenshots (task 7) ---

const receiptPrompt = (categories) => [
  'You read bills, receipts and bank screenshots.',
  'Reply with JSON only: an array of objects {"date":"YYYY-MM-DD","type":"expense" or "income","amount":number,"category":string,"note":string}.',
  'One object per line item, or one for the total when there are no lines. Amounts are positive numbers.',
  `Use the date printed on the document, or ${todayISO()} if there is none.`,
  `Prefer these categories when they fit: ${categories.join(', ') || 'none yet'}. Otherwise suggest a short new one.`,
].join(' ');

const readAsDataUrl = (file) =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsDataURL(file);
  });

async function readReceipt(store, file, categories) {
  receipt.status = 'loading';
  receipt.error = '';
  receipt.fileName = file.name;
  receipt.items = [];
  store.refresh();
  try {
    if (!file.type.startsWith('image/')) {
      throw new Error('Drop an image or screenshot (PNG, JPG or WebP). For a PDF, take a screenshot of the page.');
    }
    const url = await readAsDataUrl(file);
    const reply = await ask(store, 'task-receipt', [
      { role: 'system', content: receiptPrompt(categories) },
      { role: 'user', content: [{ type: 'text', text: 'Here is the bill or screenshot.' }, { type: 'image_url', image_url: { url } }] },
    ]);
    const parsed = parseJson(reply);
    const list = Array.isArray(parsed) ? parsed : parsed.entries ?? [parsed];
    receipt.items = list
      .map((x) => ({
        date: /^\d{4}-\d{2}-\d{2}$/.test(x.date) ? x.date : todayISO(),
        type: x.type === 'income' ? 'income' : 'expense',
        amount: round2(Math.abs(Number(x.amount))),
        category: String(x.category ?? '').trim() || 'Uncategorized',
        note: String(x.note ?? '').trim(),
      }))
      .filter((x) => x.amount > 0);
    receipt.status = receipt.items.length ? 'ok' : 'error';
    if (!receipt.items.length) receipt.error = 'No amounts found in that file.';
  } catch (err) {
    receipt.status = 'error';
    receipt.error = err.message;
  }
  store.refresh();
}

function receiptPanel(store) {
  if (receipt.status === 'idle') return null;
  if (receipt.status === 'loading') return h('div', { class: 'panel-mini' }, `Reading ${receipt.fileName}…`);
  if (receipt.status === 'error') {
    return h('div', { class: 'panel-mini error', role: 'alert' }, receipt.error, ' ',
      h('button', { type: 'button', class: 'btn-small', onclick: () => { receipt.status = 'idle'; store.refresh(); } }, 'Dismiss'));
  }
  const first = receipt.items[0];
  return h('div', { class: 'panel-mini' },
    h('div', { class: 'row between' },
      h('strong', null, `${receipt.items.length} proposed from ${receipt.fileName}. Check them, then add.`),
      h('div', { class: 'row' },
        h('button', {
          type: 'button',
          class: 'btn-small primary',
          onclick: () => {
            addEntries(store, receipt.items);
            view.month = monthKey(first.date);
            receipt.status = 'idle';
            receipt.items = [];
            store.refresh();
          },
        }, 'Add all'),
        h('button', { type: 'button', class: 'btn-small', onclick: () => { receipt.status = 'idle'; store.refresh(); } }, 'Dismiss'))),
    h('ul', { class: 'review-list' },
      receipt.items.map((x, i) => h('li', { class: 'review-row' },
        h('span', { class: 'muted small' }, editText({
          value: x.date,
          onSave: (v) => {
            if (/^\d{4}-\d{2}-\d{2}$/.test(v)) x.date = v;
            store.refresh();
          },
        })),
        pickChip({
          value: x.type,
          options: TYPES.map(([v, l]) => ({ value: v, label: l, tone: v === 'income' ? 'done' : 'high' })),
          onPick: (v) => {
            x.type = v;
            store.refresh();
          },
        }),
        editText({
          value: String(x.amount),
          onSave: (v) => {
            const n = round2(Number(v));
            if (n > 0) x.amount = n;
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
        editText({
          value: x.note,
          placeholder: 'Note',
          allowEmpty: true,
          onSave: (v) => {
            x.note = v;
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
    ));
}

function dropZone(store, categories) {
  const input = h('input', {
    type: 'file',
    accept: 'image/*',
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
      h('strong', null, 'Drop a bill or screenshot'),
      h('span', { class: 'muted small' }, 'Entries are proposed for you to check before they are added.')));
}

// --- Spending review (task 6) ---

async function reviewSpending(store, month, monthEntries) {
  spend.month = month;
  spend.status = 'loading';
  store.refresh();
  try {
    const byCategory = {};
    for (const e of monthEntries) {
      const key = `${e.type}:${e.category}`;
      byCategory[key] = round2((byCategory[key] ?? 0) + e.amount);
    }
    spend.text = (await ask(store, 'task-budget', [
      {
        role: 'system',
        content: 'You review a personal monthly budget. Given the month’s totals, totals by category and the entries as JSON, reply in plain text: the overall picture in two sentences, then the three things worth a second look, then one practical suggestion. Be concise and do not invent figures.',
      },
      {
        role: 'user',
        content: JSON.stringify({
          month,
          income: round2(monthEntries.filter((e) => e.type === 'income').reduce((s, e) => s + e.amount, 0)),
          expenses: round2(monthEntries.filter((e) => e.type === 'expense').reduce((s, e) => s + e.amount, 0)),
          byCategory,
          entries: monthEntries.slice(0, 80).map((e) => ({ date: e.date, type: e.type, amount: e.amount, category: e.category, note: e.note })),
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
  if (spend.status === 'error') return h('div', { class: 'stack' }, button, h('p', { class: 'error small', role: 'alert' }, spend.text));
  return h('div', { class: 'stack' }, button, h('div', { class: 'card-inset' }, h('pre', { class: 'ai-text' }, spend.text)));
}

// --- Page ---

function draw(root, store) {
  const { entries, categories } = store.get(COLLECTION);
  const monthEntries = entries
    .filter((e) => monthKey(e.date) === view.month)
    .sort((a, b) => b.date.localeCompare(a.date) || b.created.localeCompare(a.created));

  const total = (type) => round2(monthEntries.filter((e) => e.type === type).reduce((s, e) => s + e.amount, 0));
  const income = total('income');
  const expense = total('expense');
  const net = round2(income - expense);

  // Expense totals per category, largest first.
  const byCategory = new Map();
  for (const e of monthEntries) {
    if (e.type === 'expense') byCategory.set(e.category, (byCategory.get(e.category) ?? 0) + e.amount);
  }
  const breakdown = [...byCategory].sort((a, b) => b[1] - a[1]);

  root.replaceChildren(
    h('div', { class: 'stack-lg' },
      h('div', { class: 'row between' },
        h('h2', null, 'Money'),
        h('input', {
          type: 'month',
          value: view.month,
          'aria-label': 'Month',
          onchange: (e) => {
            view.month = e.target.value || view.month;
            store.refresh();
          },
        })),

      dropZone(store, categories),
      receiptPanel(store),

      h('div', { class: 'summary' },
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Income'), h('strong', { class: 'income' }, money(income))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Expenses'), h('strong', { class: 'expense' }, money(expense))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Net'),
          h('strong', { class: net < 0 ? 'expense' : 'income' }, money(net)))),

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
              h('input', { name: 'amount', type: 'number', step: '0.01', min: '0', placeholder: 'Amount', required: true, inputmode: 'decimal', 'aria-label': 'Amount' })),
            h('div', { class: 'row' },
              h('input', { name: 'category', list: 'finance-categories', placeholder: 'Category', 'aria-label': 'Category', autocomplete: 'off' }),
              h('input', { name: 'date', type: 'date', value: todayISO(), 'aria-label': 'Date' })),
            h('input', { name: 'note', placeholder: 'Note (optional)', 'aria-label': 'Note', autocomplete: 'off' }),
            h('div', { class: 'row end' }, h('button', { class: 'primary', type: 'submit' }, 'Add entry')),
            h('datalist', { id: 'finance-categories' }, categories.map((c) => h('option', { value: c }))))),

        h('section', { class: 'card main-pane' },
          h('h3', null, 'Expenses by category'),
          breakdown.length
            ? h('ul', { class: 'bars' },
                breakdown.map(([name, amount]) =>
                  h('li', null,
                    h('div', { class: 'row between' }, h('span', null, name), h('span', null, money(amount))),
                    h('div', { class: 'bar-track' },
                      h('div', { class: 'bar-fill', style: { width: `${(amount / expense) * 100}%` } })))))
            : empty('No expenses this month.'))),

      h('section', { class: 'card main-pane' },
        h('h3', null, 'Entries'),
        monthEntries.length
          ? h('ul', { class: 'entries' },
              monthEntries.map((e) =>
                h('li', null,
                  editText({
                    value: e.date,
                    className: 'muted date',
                    onSave: (date) => {
                      if (/^\d{4}-\d{2}-\d{2}$/.test(date)) updateEntry(store, e.id, { date });
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
                    })),
                  pickChip({
                    value: e.type,
                    options: TYPES.map(([v, l]) => ({ value: v, label: l, tone: v === 'income' ? 'done' : 'high' })),
                    onPick: (type) => updateEntry(store, e.id, { type }),
                  }),
                  editText({
                    value: String(e.amount),
                    className: e.type === 'income' ? 'income' : 'expense',
                    onSave: (v) => {
                      const n = round2(Number(v));
                      if (n > 0) updateEntry(store, e.id, { amount: n });
                      else store.refresh();
                    },
                  }),
                  h('button', {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Delete',
                    'aria-label': `Delete entry ${e.category} ${money(e.amount)}`,
                    onclick: () => removeEntry(store, e.id),
                  }, icon('x')))))
          : empty('No entries for this month.'))));
}

export default {
  id: 'money',
  title: 'Money',
  icon: 'wallet',
  collection: COLLECTION,
  defaults: { entries: [], categories: [] },
  render: draw,
  serialize: () => ({ month: view.month }),
  restore: (p = {}) => {
    view.month = /^\d{4}-\d{2}$/.test(p.month ?? '') ? p.month : monthKey(todayISO());
  },
};
