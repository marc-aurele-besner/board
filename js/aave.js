// @ts-check
// Aave v3 lending and borrowing positions of the DeFi wallets, read straight from each chain's node: the account
// totals and health factor from the Pool, and each asset's supply and debt from Aave's data provider. Read-only.
import { encodeCall, decodeArgs } from './abi.js';
import { rpcCall } from './uniswap.js';
import { multicall } from './multicall.js';
/** @import { Fn, Param, AbiValue } from '../types/abi' */
/** @import { Chain } from '../types/uniswap' */
/** @import { Wallet, LendingAccount } from '../types/data' */

// Aave v3's Pool on each chain, checked on-chain. Everything else is found from it: its addresses provider names the
// data provider and the price oracle, which Aave moves between versions.
/** @type {Record<number, string>} */
export const AAVE_POOLS = {
  1: '0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2',
  8453: '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5',
  42161: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  10: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  137: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  43114: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
  56: '0x6807dc923806fE8Fd134338EABCA509979a7e0cB',
  324: '0x78e30497a3c7527d953c6B1E3541b021A98Ac43c',
};
export const hasAave = (/** @type {{ id: number }} */ chain) => Boolean(AAVE_POOLS[chain.id]);

const fn = (/** @type {string} */ name, /** @type {string[]} */ inputs = []) => ({ name, inputs: inputs.map((type) => ({ type })) });
const uints = (/** @type {number} */ n) => Array(n).fill({ type: 'uint256' });
const F = {
  provider: fn('ADDRESSES_PROVIDER'),
  dataProvider: fn('getPoolDataProvider'),
  oracle: fn('getPriceOracle'),
  account: fn('getUserAccountData', ['address']),
  reserves: fn('getAllReservesTokens'),
  config: fn('getReserveConfigurationData', ['address']),
  reserve: fn('getReserveData', ['address']),
  user: fn('getUserReserveData', ['address', 'address']),
  prices: fn('getAssetsPrices', ['address[]']),
};
const ADDRESS = [{ type: 'address' }];
const ACCOUNT = uints(6);
const RESERVES = [{ type: 'tuple[]', components: [{ type: 'string' }, { type: 'address' }] }];
const CONFIG = uints(10); // decimals, ltv, threshold, bonus, reserve factor, then flags read as numbers
const RESERVE = uints(12); // [5] liquidityRate, [6] variableBorrowRate (rays)
const USER = uints(9); // [0] aToken balance, [1] stable debt, [2] variable debt, [8] used as collateral
const PRICES = [{ type: 'uint256[]' }];

const BASE = 1e8; // Aave v3 counts USD with 8 decimals
const RAY = 1e27;
const YEAR = 365 * 24 * 3600;
const DUST = 0.01; // USD
// Aave's rates are yearly rates compounded every second; this is the yearly yield they make.
const apy = (/** @type {bigint} */ rate) => (1 + Number(rate) / RAY / YEAR) ** YEAR - 1;

const call = async (/** @type {string} */ node, /** @type {string} */ to, /** @type {Fn} */ f, /** @type {AbiValue[]} */ args = []) => rpcCall(node, to, encodeCall(f, args));

// Per chain, found once: the data provider, the price oracle and the reserves with their decimals.
/** @typedef {{ pool: string, dataProvider: string, oracle: string, reserves: { symbol: string, asset: string, decimals: number }[] }} Market */
/** @type {Map<number, Promise<Market>>} */
const markets = new Map();
/** @param {Chain} chain @param {string} node @returns {Promise<Market>} */
async function market(chain, node) {
  if (!markets.has(chain.id)) {
    const load = (async () => {
      const pool = AAVE_POOLS[chain.id];
      const [provider] = decodeArgs(ADDRESS, await call(node, pool, F.provider));
      const [[dataProvider], [oracle]] = (await Promise.all([call(node, provider, F.dataProvider), call(node, provider, F.oracle)])).map((hex) => decodeArgs(ADDRESS, hex));
      const [list] = decodeArgs(RESERVES, await call(node, dataProvider, F.reserves));
      const configs = await multicall(node, list.map((/** @type {[string, string]} */ [, asset]) => ({ to: dataProvider, data: encodeCall(F.config, [asset]) })));
      const reserves = list.map((/** @type {[string, string]} */ [symbol, asset], /** @type {number} */ i) => ({ symbol, asset: asset.toLowerCase(), decimals: configs[i] ? Number(decodeArgs(CONFIG, configs[i])[0]) : 18 }));
      return { pool, dataProvider, oracle, reserves };
    })();
    markets.set(chain.id, load);
    load.catch(() => markets.delete(chain.id)); // a failed lookup is tried again on the next read
  }
  return /** @type {Promise<Market>} */ (markets.get(chain.id));
}

// Every wallet with Aave v3 supply or debt on a chain. Rows: { chainId, wallet, collateral, debt, available,
// threshold, ltv, health (null with no debt), assets: [{ asset, symbol, supplied, borrowed, suppliedUsd,
// borrowedUsd, supplyApy, borrowApy, collateral }] }. USD amounts are Aave's own oracle prices.
/** @param {Chain} chain @param {string} node @param {Wallet[]} wallets @returns {Promise<LendingAccount[]>} */
export async function readLending(chain, node, wallets) {
  const m = await market(chain, node);
  const accounts = await multicall(node, wallets.map((w) => ({ to: m.pool, data: encodeCall(F.account, [w.address]) })));
  /** @type {LendingAccount[]} */
  const open = [];
  wallets.forEach((w, i) => {
    if (!accounts[i]) return;
    const [collateral, debt, available, threshold, ltv, health] = decodeArgs(ACCOUNT, /** @type {string} */ (accounts[i]));
    if (collateral === 0n && debt === 0n) return;
    open.push({
      chainId: chain.id,
      wallet: w.address.toLowerCase(),
      collateral: Number(collateral) / BASE,
      debt: Number(debt) / BASE,
      available: Number(available) / BASE,
      threshold: Number(threshold) / 1e4,
      ltv: Number(ltv) / 1e4,
      health: debt === 0n ? null : Number(health) / 1e18,
      assets: [],
    });
  });
  if (!open.length) return open;

  // Only wallets with a position cost the per-asset reads: rates and prices once, then each wallet's reserves.
  const assets = m.reserves.map((r) => r.asset);
  const [rates, priceHex, ...users] = await Promise.all([
    multicall(node, assets.map((a) => ({ to: m.dataProvider, data: encodeCall(F.reserve, [a]) }))),
    call(node, m.oracle, F.prices, [assets]),
    ...open.map((row) => multicall(node, assets.map((a) => ({ to: m.dataProvider, data: encodeCall(F.user, [a, row.wallet]) })))),
  ]);
  const [prices] = decodeArgs(PRICES, priceHex);
  open.forEach((row, k) => {
    m.reserves.forEach((r, i) => {
      if (!users[k][i]) return;
      const u = decodeArgs(USER, /** @type {string} */ (users[k][i]));
      const scale = 10 ** r.decimals;
      const supplied = Number(u[0]) / scale;
      const borrowed = Number(u[1] + u[2]) / scale;
      const price = Number(prices[i] ?? 0n) / BASE;
      // Interest leaves crumbs behind after a full repay or withdraw, worth less than a cent.
      if ((supplied + borrowed) * price < DUST) return;
      const rate = rates[i] ? decodeArgs(RESERVE, rates[i]) : null;
      row.assets.push({
        asset: r.asset,
        symbol: r.symbol,
        supplied,
        borrowed,
        suppliedUsd: supplied * price,
        borrowedUsd: borrowed * price,
        supplyApy: rate ? apy(rate[5]) : null,
        borrowApy: rate ? apy(rate[6]) : null,
        collateral: u[8] !== 0n,
      });
    });
  });
  return open.filter((row) => row.assets.length);
}
