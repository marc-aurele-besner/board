// @ts-check
// DeFi → Wallets without the DOM: native and token balances of the wallets on every enabled chain, saved in
// pools.json `balances: { <chainId>: { at, rows } }`, the last good read of each chain, and `balancesRead: { at,
// pending, failed: [{ name, error, at }] }`, the state of the last read. The page and the runners both call it.
import { CHAINS, chainSettings, isAddress } from '../uniswap.js';
import { chainTokens, readBalances } from '../balances.js';
/** @import { DataStore, UniswapSettings, Wallet, PoolsData, ChainReadState } from '../../types/data' */
/** @import { Chain } from '../../types/defi' */

const COLLECTION = 'pools';
/** @type {Set<string>} */
const busy = new Set();
/** @param {string} field */
export const readingChains = (field) => busy.has(field);

/** @param {DataStore} store */
export const walletsOf = (store) => (store.get('settings').uniswap?.wallets ?? []).filter((w) => isAddress(w.address));
/** @param {Partial<UniswapSettings>} cfg */
export const enabledChains = (cfg) => CHAINS.filter((c) => chainSettings(cfg, c).enabled);

// Reads every chain at once with `read(chain, node, wallets)`, saving each as it lands in pools.json `field`, and the
// read's state in `<field>Read`. A chain that fails keeps its last good read. Null when this field is already read.
/**
 * @template {'balances' | 'lending'} F
 * @param {DataStore} store
 * @param {F} field
 * @param {Chain[]} chains
 * @param {(chain: Chain, node: string, wallets: Wallet[]) => Promise<PoolsData[F][string]['rows']>} read
 * @returns {Promise<ChainReadState | null | undefined>}
 */
export async function readEachChain(store, field, chains, read) {
  if (busy.has(field)) return null;
  busy.add(field);
  /** @type {'balancesRead' | 'lendingRead'} */
  const state = `${field}Read`;
  const cfg = store.get('settings').uniswap ?? {};
  const wallets = walletsOf(store);
  /** @param {(s: Partial<ChainReadState>) => Partial<ChainReadState>} patch */
  const setState = (patch) => store.update(COLLECTION, (d) => {
    d[state] = { failed: [], pending: [], ...d[state], ...patch(d[state] ?? {}) };
  });
  try {
    setState(() => ({ pending: chains.map((c) => c.name), failed: [] }));
    await Promise.all(chains.map(async (chain) => {
      try {
        const rows = await read(chain, chainSettings(cfg, chain).node, wallets);
        store.update(COLLECTION, (d) => {
          d[field] = { ...d[field], [chain.id]: { at: Date.now(), rows } };
        });
      } catch (err) {
        const at = store.get(COLLECTION)?.[field]?.[chain.id]?.at ?? 0;
        setState((s) => ({ failed: [...(s.failed ?? []), { name: chain.name, error: /** @type {Error} */ (err).message, at }] }));
      } finally {
        setState((s) => ({ pending: (s.pending ?? []).filter((n) => n !== chain.name) }));
      }
    }));
    setState(() => ({ at: Date.now(), pending: [] }));
    return store.get(COLLECTION)?.[state];
  } finally {
    busy.delete(field);
  }
}

// Every wallet's balances on every enabled chain, with the tokens added by hand.
/** @param {DataStore} store */
export function readWallets(store) {
  const cfg = store.get('settings').uniswap ?? {};
  const added = store.get(COLLECTION)?.tokens ?? [];
  return readEachChain(store, 'balances', enabledChains(cfg), async (chain, node, wallets) => readBalances(chain, node, wallets, await chainTokens(chain, added)));
}

// Rows saved by the last read of `field`, for the wallets and chains still chosen.
/**
 * @template {'balances' | 'lending'} F
 * @param {DataStore} store
 * @param {F} field
 * @param {{ id: number }[]} chains
 * @param {Wallet[]} wallets
 * @returns {PoolsData[F][string]['rows']}
 */
export function savedChainRows(store, field, chains, wallets) {
  const cache = store.get(COLLECTION)?.[field] ?? {};
  const keep = new Set(wallets.map((w) => w.address.toLowerCase()));
  // The rows of one field are all of one kind, which flatMap cannot tell.
  return /** @type {PoolsData[F][string]['rows']} */ (chains.flatMap((c) => (cache[c.id]?.rows ?? []).filter((r) => keep.has(r.wallet))));
}
