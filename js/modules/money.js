import { h, uid, now, todayISO, monthKey, money, empty } from '../ui.js';

const COLLECTION = 'finance';

// View state: the month being shown (YYYY-MM).
const view = { month: monthKey(todayISO()) };

const round2 = (n) => Math.round(n * 100) / 100;
const formValues = (form) => Object.fromEntries(new FormData(form));

function addEntry(store, v) {
  const amount = round2(Number(v.amount));
  if (!(amount > 0)) return;
  const category = v.category.trim() || 'Uncategorized';
  const date = v.date || todayISO();
  view.month = monthKey(date); // show the month the entry landed in
  store.update(COLLECTION, (d) => {
    d.entries.push({
      id: uid(),
      date,
      type: v.type === 'income' ? 'income' : 'expense',
      amount,
      category,
      note: v.note.trim(),
      created: now(),
    });
    if (!d.categories.some((c) => c.toLowerCase() === category.toLowerCase())) d.categories.push(category);
  });
}

function removeEntry(store, id) {
  store.update(COLLECTION, (d) => {
    d.entries = d.entries.filter((e) => e.id !== id);
  });
}

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

      h('div', { class: 'summary' },
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Income'), h('strong', { class: 'income' }, money(income))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Expenses'), h('strong', { class: 'expense' }, money(expense))),
        h('div', { class: 'card stat' }, h('span', { class: 'muted' }, 'Net'),
          h('strong', { class: net < 0 ? 'expense' : 'income' }, money(net)))),

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
                  h('span', { class: 'muted date' }, e.date),
                  h('span', { class: 'grow' }, e.category, e.note ? h('span', { class: 'muted' }, ` · ${e.note}`) : null),
                  h('span', { class: e.type === 'income' ? 'income' : 'expense' },
                    `${e.type === 'income' ? '+' : '−'}${money(e.amount)}`),
                  h('button', {
                    type: 'button',
                    class: 'icon-btn',
                    title: 'Delete',
                    'aria-label': `Delete entry ${e.category} ${money(e.amount)}`,
                    onclick: () => removeEntry(store, e.id),
                  }, '×'))))
          : empty('No entries for this month.'))));
}

export default {
  id: 'money',
  title: 'Money',
  icon: '💶',
  collection: COLLECTION,
  defaults: { entries: [], categories: [] },
  render: draw,
};
