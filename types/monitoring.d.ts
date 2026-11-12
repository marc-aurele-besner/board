// The Monitoring section's period, view and tables, shared by its tabs (js/modules/monitoring*.js).
import type { Child } from './ui';

// One bar of the period's charts: an hour when the period is one day, a day otherwise.
export interface PeriodBucket {
  start: number;
  end: number;
  label: string;
}

// The period shown, in local time (periodWindow() in js/modules/monitoring.js).
export interface PeriodWindow {
  start: number;
  end: number;
  items: PeriodBucket[];
  hourly: boolean;
}

// The sub-tab and period, and the website tabs' site and engine ('google' or 'bing').
export interface MonitoringView {
  tab: string;
  period: string;
  site: string;
  engine: string;
}

// A column of sortTable() in js/modules/monitoring-web.js.
export interface SortColumn<R> {
  label: string;
  num?: boolean;
  clip?: boolean;
  value(row: R): unknown;
  // Each column's format takes its own value type: `never` accepts any of them.
  format?: ((value: never, row: R) => Child) | null;
}
