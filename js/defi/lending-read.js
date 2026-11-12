// DeFi → Lending / Borrowing without the DOM: each wallet's Aave v3 supply, debt and health factor on every enabled
// chain that has Aave, saved in pools.json `lending: { <chainId>: { at, rows } }` and `lendingRead`.
import { CHAINS, chainSettings } from '../uniswap.js';
import { readLending, hasAave } from '../aave.js';
import { readEachChain } from './wallets-read.js';
/** @import { DataStore, UniswapSettings } from '../../types/data' */

/** @param {Partial<UniswapSettings>} cfg */
export const aaveChains = (cfg) => CHAINS.filter((c) => chainSettings(cfg, c).enabled && hasAave(c));

/** @param {DataStore} store */
export function readAllLending(store) {
  const cfg = store.get('settings').uniswap ?? {};
  return readEachChain(store, 'lending', aaveChains(cfg), (chain, node, wallets) => readLending(chain, node, wallets));
}
