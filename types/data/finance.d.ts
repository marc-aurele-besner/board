// finance.json: the Money section (js/modules/money.js, js/money-core.js).

// One income or expense line. A bill adds one entry per charge (and per document-level tax), all with its billId.
export interface FinanceEntry {
  id: string;
  // YYYY-MM-DD
  date: string;
  // 'expense' | 'income'
  type: string;
  // Gross amount, tax included.
  amount: number;
  // The tax part of amount.
  tax?: number;
  // The bill the entry came from, or '' when typed by hand.
  billId?: string;
  // 'USD' | 'CAD'. Entries saved before currencies existed have none and count as USD.
  currency?: string;
  category: string;
  note: string;
  projectId: string | null;
  // Where it came from: a vendor or file name, 'Recurring', or ''.
  source?: string;
  // Set on entries a recurring expense added.
  recurringId?: string;
  created: string;
}

// The original file of a bill. Newer bills live in the data folder (bills/); older ones kept a data: URL inline.
export interface Bill {
  id: string;
  name: string;
  // MIME type of the original.
  type: string;
  // Path in the data folder, or '' when the copy is inline.
  file?: string;
  // data: URL, or '' when the original is a file.
  dataUrl: string;
  created: string;
}

// A recurring expense that adds an entry on each due date.
export interface Recurring {
  id: string;
  name: string;
  amount: number;
  currency: string;
  category: string;
  projectId: string | null;
  // 'monthly' | 'yearly'
  cadence: string;
  // 'fixed' | 'flex'
  kind: string;
  // YYYY-MM-DD; also gives the day of the month it is due.
  startDate: string;
  // Due dates (YYYY-MM-DD) that already have an entry, so a deleted entry is not added again.
  generated: string[];
  created: string;
}

// A monthly budget for one category.
export interface Budget {
  amount: number;
  currency: string;
}

export interface FinanceData {
  entries: FinanceEntry[];
  // Category names, in the order Settings shows them.
  categories: string[];
  bills: Bill[];
  // Category name -> CSS colour.
  categoryColors: Record<string, string>;
  recurring: Recurring[];
  // Category name -> budget.
  budgets: Record<string, Budget>;
  // Written by the store on save.
  schemaVersion?: number;
}
