// pools.json: DeFi → Positions (Uniswap v3/v4 liquidity), Wallets and Lending. Written by the board's tab and by the
// runners (js/defi/*.js, tools/jobs/defi.js). Most maps are keyed by chain id, "<chainId>:<version>" or a position ref.

// One Uniswap position as last read (buildRow in js/defi/positions-read.js).
export interface PoolRow {
  version: string; // 'v3' | 'v4'
  // "<chainId>:<tokenId>" for v3, "<chainId>:<version>:<tokenId>" otherwise.
  ref: string;
  chain: string; // the chain's name
  chainId: number;
  tokenId: string;
  wallet: string; // lowercase owner address
  // Set when the values use saved prices (pricesAt) or the row is from an earlier read (staleAt); ms.
  pricesAt: number | null;
  staleAt: number | null;
  owner: string; // the wallet's label
  addr0: string;
  addr1: string;
  pair: string; // "SYM0 / SYM1"
  sym0: string;
  sym1: string;
  feePct: number;
  // Emptied but not burned.
  closed: boolean;
  inRange: boolean;
  full: boolean;
  // Range and current price in token1 per token0. max is Infinity in memory, null on disk for an open-ended range.
  min: number;
  max: number | null;
  current: number;
  // Where the price sits in the range, 0 to 100 on a log scale.
  marker: number | null;
  a0: number;
  a1: number;
  // Unclaimed fees in tokens.
  fee0: number;
  fee1: number;
  // USD prices of the two tokens.
  p0: number | null;
  p1: number | null;
  value: number | null;
  fees: number | null;
  // Fees read by a simulated collect rather than the lagging stored amounts.
  feesFull: boolean;
  share0: number | null; // share of the value in token0, 0 to 1
  url: string | null;
  tickLower: number;
  tickUpper: number;
  liq: string; // liquidity as a decimal string
  pool: string; // pool address (v3) or pool id (v4)
  feePips: number;
  dec0: number;
  dec1: number;
}

// One read of a chain and version: cache["<chainId>:<version>"].
export interface PoolCachePart {
  at: number;
  rows: PoolRow[];
}

// Token USD prices of a chain, keyed by lowercase token address.
export interface ChainPrices {
  at: number;
  usd: Record<string, number>;
}

// How far a wallet's v4 position search on a chain got (scanV4 in js/uniswap.js).
export interface V4Scan {
  node: string; // the node URL(s) searched
  from: number;
  to: number;
  span: number;
  ids: string[];
  // The search reached v4's deployment or the node refused older blocks.
  done: boolean;
}

// A position's fee baseline: unclaimed fees in tokens when counting started.
export interface FeeBaseline {
  at: number;
  f0: number;
  f1: number;
  v?: number; // baseline version; v3 baselines without v 2 are restarted
}

// What a position earned per unix hour: [raw token0, raw token1] as decimal strings (a pair; string[] as JSON widens it).
export type EarnedHours = Record<string, string[]>;

// One fee collection in the log.
export interface CollectEntry {
  id: string;
  at: string; // ISO time
  source: string; // 'chain' | 'etherscan' | 'auto' | 'manual'
  // How sure the reading is (4 = v3 events). Older chain entries lack it.
  level?: number;
  tx?: string;
  // Manual entries keep only the pair name, and those not tied to a position none of these.
  ref?: string;
  pair?: string;
  chain?: string;
  chainId?: number;
  tokenId?: string;
  a0?: number;
  a1?: number;
  sym0?: string;
  sym1?: string;
  addr0?: string;
  addr1?: string;
  usd: number | null;
  // 'auto' entries: the read before the collect, which bounds when it happened.
  since?: string;
  note?: string;
}

// An event of a position's history read from the node.
export interface PositionEvent {
  kind: string; // 'add' | 'remove' | 'collect'
  block: number;
  index: number;
  tx: string;
  liq: string;
  // v3 only: amounts as decimal strings.
  a0?: string;
  a1?: string;
  time?: number; // unix seconds, read for removes and collects
}

// A position's history search (positionHistory in js/uniswap.js).
export interface PositionHistory {
  node: string;
  from: number;
  to: number;
  span: number;
  done: boolean;
  events: PositionEvent[];
  // Every block back to the opening was searched.
  reached: boolean;
  floor: number;
  // v4: transactions already read that collected nothing.
  checked?: string[];
}

// A wallet's Etherscan collect search on a chain.
export interface EtherscanScan {
  block: number;
  checked: string[];
  caughtUp: boolean;
  at: number;
}

// What a saved AI insight keeps of a position, prices as shown (after a flip).
export interface PoolInsightPosition {
  pair: string;
  chain: string;
  feePct: number;
  tokenId: string;
  url: string;
  inRange: boolean;
  full: boolean;
  sym0: string;
  sym1: string;
  unit: string;
  base: string;
  min: number;
  max: number | null;
  current: number;
}

export interface PoolInsightItem {
  ref: string;
  action: string;
  headline: string;
  reason: string;
  range: { min: number; max: number } | null;
  pos: PoolInsightPosition;
}

// One AI insights run (js/pool-insights.js).
export interface PoolInsightRun {
  id: string;
  at: number;
  key: string; // which positions it read
  summary: string;
  items: PoolInsightItem[];
}

// One token balance of a wallet (readBalances in js/balances.js).
export interface WalletBalance {
  ref: string; // "<chainId>:<lowercase token address>"
  chainId: number;
  wallet: string;
  label: string;
  token: string; // token address, or the native placeholder address
  symbol: string;
  decimals: number;
  logo: string;
  raw: string; // raw amount as a decimal string
  amount: number;
  price: number | null;
  value: number | null;
}

// A token added by hand on DeFi → Wallets.
export interface AddedToken {
  chainId: number;
  address: string;
  symbol: string;
  decimals: number;
}

export interface LendingAsset {
  asset: string;
  symbol: string;
  supplied: number;
  borrowed: number;
  suppliedUsd: number;
  borrowedUsd: number;
  supplyApy: number | null;
  borrowApy: number | null;
  collateral: boolean; // used as collateral
}

// A wallet's Aave v3 account on a chain (readLending in js/aave.js). USD amounts.
export interface LendingAccount {
  chainId: number;
  wallet: string;
  collateral: number;
  debt: number;
  available: number;
  threshold: number; // liquidation threshold, 0 to 1
  ltv: number;
  health: number | null; // null with no debt
  assets: LendingAsset[];
}

// The last good read of a chain: balances[chainId] or lending[chainId].
export interface ChainRead<Row> {
  at: number;
  rows: Row[];
}

// A chain that failed in the last balances or lending read; at is its last good read (0 for none).
export interface ChainReadFailure {
  name: string;
  error: string;
  at: number;
}

// The state of the last balances or lending read.
export interface ChainReadState {
  failed: ChainReadFailure[];
  pending: string[]; // chain names
  at?: number;
}

// The state of the last positions read.
export interface PositionsReadState {
  at?: number;
  // Keyed by "<chainId>:<version>".
  warnings: Record<string, string>;
  stale: Record<string, number>;
  // Chain names whose v4 search did not reach the deployment.
  shallow: string[];
  pending: string[];
}

// Fee APR over a window: aprs["<window>|<ref>"].
export interface AprEntry {
  apr: number;
  secs: number; // seconds covered
  full: boolean;
  prev: number | null; // the window before
  prevSecs: number;
  at: number;
}

export interface PoolsData {
  cache: Record<string, PoolCachePart>;
  prices: Record<string, ChainPrices>;
  // chainId -> lowercase wallet -> search.
  scan: Record<string, Record<string, V4Scan>>;
  // ref -> baseline.
  fees: Record<string, FeeBaseline>;
  earned: Record<string, EarnedHours>;
  collected: CollectEntry[];
  history: Record<string, PositionHistory>;
  // Keys "<ref>|<tx>" of collects the user removed.
  hidden: string[];
  // chainId -> lowercase wallet -> search.
  etherscan: Record<string, Record<string, EtherscanScan>>;
  // "SYM0/SYM1" -> prices shown flipped. The runners' defaults lack it and insights.
  flip?: Record<string, boolean>;
  insights?: PoolInsightRun[];
  balances: Record<string, ChainRead<WalletBalance>>;
  tokens: AddedToken[];
  // Token refs hidden on DeFi → Wallets.
  hiddenTokens: string[];
  lending: Record<string, ChainRead<LendingAccount>>;
  read?: PositionsReadState;
  aprs?: Record<string, AprEntry>;
  // The APR window picked on the page, such as '24h'.
  aprWindow?: string;
  balancesRead?: ChainReadState;
  lendingRead?: ChainReadState;
  // Chain name -> error.
  etherscanErrors?: Record<string, string>;
  schemaVersion?: number;
}
