// fx.json: USD to CAD rates, one per day (js/fx.js). Written by the runners (tools/jobs/fx.js); the board reads it.

// A day's rate. date is the day the rate was published: a weekend or holiday takes the last one before it.
export interface FxDay {
  rate: number; // CAD per USD
  date: string; // YYYY-MM-DD
}

export interface FxData {
  // "YYYY-MM-DD" -> rate.
  days: Record<string, FxDay>;
  // The provider id that answered last ('frankfurter', 'boc', 'currency-api'), null before any.
  source: string | null;
  schemaVersion?: number;
}
