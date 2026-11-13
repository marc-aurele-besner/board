// Shapes shared by the DeFi reads (js/defi/*.js) and the DeFi sections, beyond the stored data in types/data/pools.d.ts.
import type { PoolRow } from './data/pools';
import type { Child } from './ui';

// A built-in chain of the DeFi tabs (CHAINS in js/uniswap.js).
export type { Chain } from './uniswap';

// A position row in memory (cachedRows() in js/defi/positions-read.js): an open-ended range's max is Infinity again.
export interface PositionRow extends Omit<PoolRow, 'max'> {
  max: number;
}

// The LP totals DeFi → Summary shows (lpSummary() in js/modules/positions.js).
export interface LpSummary {
  value: number;
  fees: number;
  count: number;
  inRange: number;
  out: PositionRow[];
  top: PositionRow[];
  collected30: number;
  reading: boolean;
  firstRead: boolean;
  failed: string[];
}

// The DeFi section's helpers handed to the tabs drawn by their own module (drawOwnTab() in js/modules/positions.js).
export interface DefiUi {
  cash(n: number): string;
  logo(src: string | null | undefined, label: string, cls?: string): HTMLElement;
  logoOf(chainId: number, address: string): string | null;
  refresh(): void;
  // For the Summary tab.
  lp(): LpSummary | null;
  loadLp(): void;
  go(tab: string, filter?: string): void;
  openPosition(ref: string): void;
}

// What such a tab draws inside the section's header and tab bar.
export interface DefiTab {
  subtitle: string;
  actions: Child[];
  // Shown as pills at the right of the tab bar (noticePills() in js/ui.js), not above the body.
  notices?: (DefiNotice | null)[];
  body: Child;
}

// A notice of a DeFi tab: as notice() in js/ui.js takes it.
export interface DefiNotice {
  tone?: 'error' | 'ok' | 'info';
  text: Child;
  actions?: Child[];
}
