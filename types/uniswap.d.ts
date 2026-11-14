// What js/uniswap.js reads and returns, shared by the DeFi readers (js/defi/*.js, js/balances.js, js/aave.js) and
// the chain settings.

// A chain's native coin: its symbol, its CoinGecko id (for its price) and its logo.
export interface NativeCoin {
  symbol: string;
  coingecko: string;
  logo: string;
}

// Uniswap v4's contracts on a chain, and the first block worth searching for positions.
export interface V4Deployment {
  positions: string;
  stateView: string;
  start: number;
}

// A chain the LP tab reads (CHAINS in js/uniswap.js).
export interface Chain {
  id: number;
  name: string;
  // Its nodes, separated by spaces.
  rpc: string;
  // The widest block range the default node accepts in one log search.
  span: number;
  // DefiLlama's name for the chain.
  prices: string;
  // The chain's name in Uniswap app links.
  app: string;
  logo: string;
  native: NativeCoin;
  // Uniswap v3's factory and position manager.
  factory: string;
  positions: string;
  // Uniswap v2's factory. Missing where Uniswap has no v2.
  v2?: string;
  // Set on another exchange's deployment on the chain (pancakeOf in js/uniswap.js), which puts its own contracts in
  // place of Uniswap's: its id ('pancakeswap'), its farm, its v3 Swap event, its v2 fee and what liquidity keeps of
  // it (pips), and its v2 pair token's symbol.
  dex?: string;
  chef?: string;
  v3swap?: string;
  v2fee?: number;
  v2lp?: number;
  v2symbol?: string;
  // Missing where Uniswap has no v4.
  v4?: V4Deployment;
  // false where Etherscan's API does not cover the chain.
  etherscan?: boolean;
}

// A number that BigInt() takes: amounts are bigints in memory and decimal strings in JSON.
export type BigIntish = bigint | string | number;

// A position as read from the chain (readV2Pair, decodeV3 and readV4Position in js/uniswap.js). Amounts are raw bigints.
export interface Position {
  version: string; // 'v2' | 'v3' | 'v4'
  chainId: number;
  // v2: the pair's address, in lowercase. A v2 position is a wallet's balance of the pair's token.
  tokenId: string;
  owner: string;
  token0: string;
  token1: string;
  fee: number;
  hooks?: string; // v4
  tickLower: number;
  tickUpper: number;
  // v2: the balance of the pair's token.
  liquidity: bigint;
  // v2 only: the pair's token supply, the share of each reserve the balance stands for, and the part of a swap
  // liquidity keeps, in pips (the fee less the protocol's cut).
  supply?: bigint;
  amount0?: bigint;
  amount1?: bigint;
  lpFee?: number;
  owed0: bigint;
  owed1: bigint;
  // The fees include those earned since the last poke (a simulated collect).
  feesFull?: boolean;
  // Staked in a farm: the farm holding the token, the reward it can harvest (raw) and the reward token.
  via?: string;
  reward?: bigint;
  rewardToken?: string;
}

// A pool's current price (sqrt, as a float) and tick; pool is the v2 pair or v3 pool address, or the v4 pool id.
export interface PoolState {
  pool: string;
  sqrtPrice: number;
  tick: number;
  // PancakeSwap: what liquidity keeps of each swap fee, in pips, once the protocol's share is taken.
  lpFee?: number;
}

// One swap, kept small (parseSwap in js/uniswap.js).
export interface Swap {
  block: number;
  tick: number;
  // The active liquidity after it. 0 on v2, where the pair's supply stands in.
  liq: bigint;
  in0: bigint;
  in1: bigint;
  // v4 only: the fee charged, in pips.
  fee: number | null;
}

// A token on Uniswap's default token list, as far as the board reads it.
export interface ListedToken {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
  logoURI?: string;
}

// A log as eth_getLogs and receipts return it, as far as the board reads it.
export interface RpcLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: string;
  logIndex: string;
  transactionHash: string;
  transactionIndex?: string;
}

// A transaction receipt, as far as collectTx() reads it.
export interface Receipt {
  status: string;
  blockNumber: string;
  transactionIndex: string;
  from: string;
  gasUsed: string;
  effectiveGasPrice?: string;
  // Rollups such as Base: the fee for posting the transaction to Ethereum.
  l1Fee?: string;
  logs?: RpcLog[];
}

// Where a transaction is read from: a node, or Etherscan, which also reads a v4 pool's swaps and native transfers.
export interface TxSource {
  kind: string; // 'node' | 'etherscan'
  call(method: string, params: unknown[]): Promise<any>; // any: the answer's shape depends on the JSON-RPC method
  swaps?(manager: string, poolId: string, from: number, to: number): Promise<RpcLog[]>;
  native?(tx: string, to: string): Promise<bigint>;
}
