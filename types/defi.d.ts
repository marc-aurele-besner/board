// Shapes shared by the DeFi reads (js/defi/*.js) and the DeFi sections, beyond the stored data in types/data/pools.d.ts.
import type { PoolRow } from './data/pools';

// A built-in chain of the DeFi tabs (CHAINS in js/uniswap.js).
export type Chain = (typeof import('../js/uniswap.js').CHAINS)[number];

// A position row in memory (cachedRows() in js/defi/positions-read.js): an open-ended range's max is Infinity again.
export interface PositionRow extends Omit<PoolRow, 'max'> {
  max: number;
}
