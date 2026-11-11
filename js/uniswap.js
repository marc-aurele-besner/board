// Uniswap v3 and v4 liquidity positions, read straight from each chain's node. Read-only: only public addresses are used,
// never keys. Token prices come from DefiLlama's public price endpoint.
import { keccak256 } from './keccak.js';

// Chain logos from Trust Wallet's asset repository. Unichain and Robinhood Chain are not in it; both pay gas in ETH,
// so they use ETH's logo.
const trustLogo = (folder) => `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/info/logo.png`;
const ETH_LOGO = trustLogo('ethereum');

// The chains the LP tab reads. Each address is Uniswap's own deployment on that chain, checked on-chain.
// The same address is not used on every chain, so every chain carries its own.
// v4 is left out on a chain Uniswap has not deployed v4 to. etherscan: false marks a chain Etherscan's API does not cover.
// v4.start is the first block worth searching for v4 positions (the deployment, or a day before it).
// span is the widest block range the default node accepts in one log search.
const ETH = { symbol: 'ETH', coingecko: 'ethereum', logo: ETH_LOGO };
export const CHAINS = [
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum.publicnode.com', span: 10000, prices: 'ethereum', app: 'ethereum', logo: ETH_LOGO, native: ETH, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    v4: { positions: '0xbd216513d74c8cf14cf4747e6aaa6420ff64ee9e', stateView: '0x7ffe42c4a5deea5b0fec41c94c136cf115597227', start: 21689089 } },
  { id: 8453, name: 'Base', rpc: 'https://base.publicnode.com', span: 50000, prices: 'base', app: 'base', logo: trustLogo('base'), native: ETH, factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', positions: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1',
    v4: { positions: '0x7c5f5a4bbd8fd63184577525326123b519429bdc', stateView: '0xa3c0c9b65bad0b08107aa264b0f3db444b867a71', start: 25350993 } },
  { id: 42161, name: 'Arbitrum One', rpc: 'https://arbitrum-one-rpc.publicnode.com', span: 10000, prices: 'arbitrum', app: 'arbitrum', logo: trustLogo('arbitrum'), native: ETH, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    v4: { positions: '0xd88f38f930b7952f2db2432cb002e7abbf3dd869', stateView: '0x76fd297e2d437cd7f76d50f01afe6160f86e9990', start: 298179155 } },
  { id: 10, name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com', span: 10000, prices: 'optimism', app: 'optimism', logo: trustLogo('optimism'), native: ETH, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    v4: { positions: '0x3c3ea4b57a46241e54610e5f022e5c45859a1017', stateView: '0xc18a3169788f4f75a170290584eca6395c75ecdb', start: 130947681 } },
  { id: 137, name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', span: 10000, prices: 'polygon', app: 'polygon', logo: trustLogo('polygon'), native: { symbol: 'POL', coingecko: 'polygon-ecosystem-token', logo: trustLogo('polygon') }, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88',
    v4: { positions: '0x1ec2ebf4f37e7363fdfe3551602425af0b3ceef9', stateView: '0x5ea1bd7974c8a611cbab0bdcafcb1d9cc9b3ba5a', start: 66980394 } },
  { id: 56, name: 'BNB Chain', rpc: 'https://bsc-rpc.publicnode.com', span: 50000, prices: 'bsc', app: 'bnb', logo: trustLogo('smartchain'), native: { symbol: 'BNB', coingecko: 'binancecoin', logo: trustLogo('smartchain') }, factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', positions: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613',
    v4: { positions: '0x7a4a5c919ae2541aed11041a1aeee68f1287f95b', stateView: '0xd13dd3d6e93f276fafc9db9e6bb47c1180aee0c4', start: 45996818 } },
  { id: 43114, name: 'Avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', span: 50000, prices: 'avax', app: 'avalanche', logo: trustLogo('avalanchec'), native: { symbol: 'AVAX', coingecko: 'avalanche-2', logo: trustLogo('avalanchec') }, factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD', positions: '0x655C406EBFa14EE2006250925e54ec43AD184f8B',
    v4: { positions: '0xb74b1f14d2754acfcbbe1a221023a5cf50ab8acd', stateView: '0xc3c9e198c735a4b97e3e683f391ccbdd60b69286', start: 56203165 } },
  { id: 130, name: 'Unichain', rpc: 'https://unichain-rpc.publicnode.com', span: 10000, prices: 'unichain', app: 'unichain', logo: ETH_LOGO, native: ETH, factory: '0x1f98400000000000000000000000000000000003', positions: '0x943e6e07a7e8e791dafc44083e54041d743c46e9',
    v4: { positions: '0x4529a01c7a0410167c5740c487a8de60232617bf', stateView: '0x86e8631a016f9068c3f085faf484ee3f5fdee8f2', start: 6819679 } },
  { id: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', span: 10000000, prices: 'robinhood', app: 'robinhood', logo: ETH_LOGO, native: ETH, factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', positions: '0x73991a25c818bf1f1128deaab1492d45638de0d3',
    v4: { positions: '0x58daec3116aae6d93017baaea7749052e8a04fa7', stateView: '0xf3334192d15450cdd385c8b70e03f9a6bd9e673b', start: 9506 } },
  { id: 324, name: 'ZKsync Era', rpc: 'https://mainnet.era.zksync.io', span: 50000, prices: 'era', app: 'zksync', logo: trustLogo('zksync'), native: ETH, factory: '0x8FdA5a7a8dCA67BBcDd10F02Fa0649A937215422', positions: '0x0616e5762c1E7Dc3723c50663dF10a162D690a86', etherscan: false },
];

// v4 pools hold the chain's native coin directly, as the zero address.
export const NATIVE = '0x0000000000000000000000000000000000000000';
export const isNative = (address) => String(address).toLowerCase() === NATIVE;

// Token logos from Uniswap's default token list, one file per chain on GitHub (which allows browser reads),
// keyed "chainId:address" in lowercase. Fetched once; a token the list does not carry gets a monogram instead.
const TOKEN_LIST_DIR = 'https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens';
const TOKEN_LIST_FILE = { 1: 'mainnet', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 56: 'bnb', 43114: 'avalanche', 130: 'unichain', 4663: 'robinhood', 324: 'zksync' };
let logos = null;
export function tokenLogos() {
  logos ??= Promise.allSettled(Object.values(TOKEN_LIST_FILE).map(async (file) => {
    const res = await fetch(`${TOKEN_LIST_DIR}/${file}.json`);
    if (!res.ok) throw new Error(String(res.status));
    return res.json();
  })).then((results) => new Map(results
    .filter((r) => r.status === 'fulfilled')
    .flatMap((r) => r.value)
    .filter((t) => t.logoURI)
    .map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t.logoURI])
    .concat(CHAINS.map((c) => [`${c.id}:${NATIVE}`, c.native.logo]))));
  return logos;
}

const SEL = {
  name: '0x06fdde03',
  balanceOf: '0x70a08231',
  tokenOfOwnerByIndex: '0x2f745c59',
  positions: '0x99fbab88',
  getPool: '0x1698ee82',
  slot0: '0x3850c7bd',
  symbol: '0x95d89b41',
  decimals: '0x313ce567',
  ownerOf: '0x6352211e',
  getPoolAndPositionInfo: '0x7ba03aad',
  getPositionLiquidity: '0x1efeed33',
  getSlot0: '0xc815641c',
  getFeeGrowthInside: '0x53e9c1fb',
  getPositionInfo: '0xdacf1d2f',
  collect: '0xfc6f7865',
  poolManager: '0xdc4c90d3',
};
// Swap(address,address,int256,int256,uint160,uint128,int24) on a v3 pool, and
// Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24) on v4's pool manager.
const SWAP_V3 = '0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67';
const SWAP_V4 = '0x40e9cecb9f5f1f1c5b9c97dec2917b7ee92e57ba5563708daca94dd84ad7112f';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const MAX_POSITIONS = 40;
const Q96 = 2 ** 96;

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const padInt = (n) => pad((n < 0 ? 2n ** 256n + BigInt(n) : BigInt(n)).toString(16));
const words = (hex) => {
  const s = String(hex ?? '').replace(/^0x/, '');
  const out = [];
  for (let i = 0; i < s.length; i += 64) out.push(s.slice(i, i + 64));
  return out;
};
const big = (w) => BigInt('0x' + (w || '0'));
const signed = (w) => {
  const v = big(w);
  return v >= 2n ** 255n ? v - 2n ** 256n : v;
};
const addressOf = (w) => `0x${w.slice(24)}`;
const ascii = (hex) => {
  let s = '';
  for (let i = 0; i < hex.length; i += 2) {
    const c = parseInt(hex.slice(i, i + 2), 16);
    if (c > 0) s += String.fromCharCode(c);
  }
  return s;
};
const shortAddress = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(String(s ?? '').trim());

// The node a chain is read from as saved in Settings, or '' when the default public node is used.
// Ethereum's node was saved before the chains list existed, so it falls back to that field.
export function savedNode(cfg, chain) {
  return cfg?.chains?.[chain.id]?.node || (chain.id === 1 ? cfg?.node : '') || '';
}

// Whether a chain is read, and the node it is read from.
export function chainSettings(cfg, chain) {
  return { enabled: cfg?.chains?.[chain.id]?.enabled !== false, node: savedNode(cfg, chain) || chain.rpc };
}

// One JSON-RPC request to a chain's node.
// A node that says "too many requests" is asked once more after a pause.
async function rpc(node, method, params, retry = true) {
  const res = await fetch(node, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  if (res.status === 429 && retry) {
    await new Promise((resolve) => setTimeout(resolve, 1000 + Math.random() * 1000));
    return rpc(node, method, params, false);
  }
  if (!res.ok) throw new Error(`The node answered ${res.status}.`);
  const json = await res.json();
  if (json.error) {
    const err = new Error(`The node refused the call: ${json.error.message ?? 'error'}.`);
    err.refused = true; // the node answered and said no, unlike a network error, which may pass
    throw err;
  }
  return json.result;
}

// One read-only call to a contract. from: the caller, for a call that checks who sends it.
export async function rpcCall(node, to, data, from) {
  return (await rpc(node, 'eth_call', [from ? { from, to, data } : { to, data }, 'latest'])) ?? '0x';
}

// A v3 position's unclaimed fees. positions() only holds the fees credited at the last poke or collect, so a
// collect of everything is simulated as the owner, which credits the fees earned since. Falls back to the
// stored amounts when the node refuses the call.
const MAX_U128 = (2n ** 128n - 1n).toString(16);
async function withFees(chain, node, p) {
  try {
    const call = SEL.collect + pad(BigInt(p.tokenId).toString(16)) + pad(p.owner) + pad(MAX_U128) + pad(MAX_U128);
    const w = words(await rpcCall(node, chain.positions, call, p.owner));
    if (w.length >= 2) return { ...p, owed0: big(w[0]), owed1: big(w[1]), feesFull: true };
  } catch {}
  return p;
}

// Decodes a string returned by a contract. Some tokens return the symbol as a bytes32 instead.
function decodeString(hex) {
  const w = words(hex);
  if (w.length >= 2) {
    const len = Number(big(w[1]));
    if (len > 0 && len < 64) return ascii(w.slice(2).join('').slice(0, len * 2));
  }
  return ascii(w[0] ?? '');
}

// Every position a public address owns on a chain (up to MAX_POSITIONS), closed ones included.
export async function readPositions(chain, node, owner) {
  const ownerWord = pad(owner);
  const count = Number(big(words(await rpcCall(node, chain.positions, SEL.balanceOf + ownerWord))[0]));
  const indexes = Array.from({ length: Math.min(count, MAX_POSITIONS) }, (_, i) => i);
  const ids = await Promise.all(indexes.map(async (i) => big(words(await rpcCall(node, chain.positions, SEL.tokenOfOwnerByIndex + ownerWord + pad(i.toString(16))))[0])));
  const raw = await Promise.all(ids.map((id) => rpcCall(node, chain.positions, SEL.positions + pad(id.toString(16)))));
  // A closed position (no liquidity, nothing owed) earns nothing, so its fees need no simulated collect.
  return Promise.all(raw
    .map((hex, i) => decodeV3(chain, ids[i].toString(), owner, hex))
    .map((p) => (isClosed(p) ? { ...p, feesFull: true } : withFees(chain, node, p))));
}

// No liquidity and nothing owed: the position was emptied but its token not burned.
export const isClosed = (p) => BigInt(p.liquidity) === 0n && BigInt(p.owed0) === 0n && BigInt(p.owed1) === 0n;

// A v3 position as the position manager returns it.
function decodeV3(chain, tokenId, owner, hex) {
  const w = words(hex);
  return {
    version: 'v3',
    chainId: chain.id,
    tokenId,
    owner,
    token0: addressOf(w[2]),
    token1: addressOf(w[3]),
    fee: Number(big(w[4])),
    tickLower: Number(signed(w[5])),
    tickUpper: Number(signed(w[6])),
    liquidity: big(w[7]),
    owed0: big(w[10]),
    owed1: big(w[11]),
  };
}

// One v3 position by its number, whoever owns it. null when the token was burned.
export async function readV3Position(chain, node, tokenId) {
  const id = pad(BigInt(tokenId).toString(16));
  try {
    const [owner, hex] = await Promise.all([
      rpcCall(node, chain.positions, SEL.ownerOf + id),
      rpcCall(node, chain.positions, SEL.positions + id),
    ]);
    const p = decodeV3(chain, String(tokenId), addressOf(words(owner)[0]), hex);
    return isClosed(p) ? { ...p, feesFull: true } : withFees(chain, node, p);
  } catch (err) {
    if (err.refused) return null; // both calls revert for a burned token
    throw err;
  }
}

// The pool a position is in: its current price (sqrt, as a float) and tick. null when the pool does not exist.
export async function poolState(chain, node, p) {
  const pool = addressOf(words(await rpcCall(node, chain.factory, SEL.getPool + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16))))[0]);
  if (/^0x0+$/.test(pool)) return null;
  const s = words(await rpcCall(node, pool, SEL.slot0));
  return { pool, sqrtPrice: Number(big(s[0])) / Q96, tick: Number(signed(s[1])) };
}

// A token's symbol and decimals. Falls back to the short address when the token does not answer.
export async function tokenMeta(node, address, chain) {
  if (isNative(address)) return { symbol: chain.native.symbol, decimals: 18 };
  try {
    const [sym, dec] = await Promise.all([rpcCall(node, address, SEL.symbol), rpcCall(node, address, SEL.decimals)]);
    return { symbol: decodeString(sym) || shortAddress(address), decimals: Number(big(words(dec)[0])) || 18 };
  } catch {
    return { symbol: shortAddress(address), decimals: 18 };
  }
}

// USD price of each token address on a chain, keyed by lowercase address, from DefiLlama: one request for all of
// them, where CoinGecko's free tier now takes one address per request. Tokens it does not know are left out.
// The native coin has no contract, so it is asked for by its CoinGecko id.
export async function usdPrices(chain, addresses) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!list.length) return {};
  const keyOf = (a) => (isNative(a) ? `coingecko:${chain.native.coingecko}` : `${chain.prices}:${a}`);
  const res = await fetch(`https://coins.llama.fi/prices/current/${list.map(keyOf).join(',')}`);
  if (!res.ok) throw new Error(`The price service answered ${res.status}.`);
  const coins = (await res.json()).coins ?? {};
  const out = {};
  for (const a of list) {
    const usd = coins[keyOf(a)]?.price;
    if (usd) out[a] = usd;
  }
  return out;
}

// The same, at a past time (unix seconds): the value of a collect when it was made.
export async function usdPricesAt(chain, addresses, time) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!list.length) return {};
  const keyOf = (a) => (isNative(a) ? `coingecko:${chain.native.coingecko}` : `${chain.prices}:${a}`);
  const res = await fetch(`https://coins.llama.fi/prices/historical/${Math.floor(time)}/${list.map(keyOf).join(',')}`);
  if (!res.ok) throw new Error(`The price service answered ${res.status}.`);
  const coins = (await res.json()).coins ?? {};
  return Object.fromEntries(list.filter((a) => coins[keyOf(a)]?.price).map((a) => [a, coins[keyOf(a)].price]));
}

// Uniswap v4 positions are plain ERC-721 tokens with no way to list an owner's tokens, so they are found from the
// Transfer events into a wallet. Public nodes only search a limited window, and most refuse old blocks, so the
// search keeps where it got to: it reads new blocks on every load and walks back toward the deployment while the
// node allows it. A node that keeps history finds every position; with the default nodes, older positions are
// added by hand in Settings.
const MIN_SPAN = 1000;
const SCAN_CALLS = 24; // log searches per wallet, chain and load

async function transfersTo(chain, node, owner, from, to) {
  const logs = await rpc(node, 'eth_getLogs', [{
    address: chain.v4.positions,
    fromBlock: `0x${from.toString(16)}`,
    toBlock: `0x${to.toString(16)}`,
    topics: [TRANSFER, null, `0x${pad(owner)}`],
  }]);
  return (logs ?? []).map((l) => big(String(l.topics[3]).replace(/^0x/, '')).toString());
}

// Searches one block range, narrowing it while the node refuses. Returns the ids found and the range searched.
// When nothing works, refused says whether the node said no to every width (it will not search this far back)
// or a request failed (busy or offline: worth trying again on the next load).
async function searchFrom(chain, node, owner, start, end, span, forward) {
  for (let width = span; width >= MIN_SPAN; width = Math.floor(width / 2)) {
    const from = forward ? start : Math.max(start, end - width + 1);
    const to = forward ? Math.min(end, start + width - 1) : end;
    try {
      return { ids: await transfersTo(chain, node, owner, from, to), from, to, span: width };
    } catch (err) {
      if (!err.refused) return { ids: null, refused: false };
    }
  }
  return { ids: null, refused: true };
}

// Extends a wallet's saved search on a chain. prev is what the last load saved: { node, from, to, span, ids, done }.
// done means the search reached the deployment or the node refused to go further back.
export async function scanV4(chain, node, owner, prev) {
  const head = Number(await rpc(node, 'eth_blockNumber', []));
  const fresh = !prev || prev.node !== node;
  const s = fresh ? { node, from: head + 1, to: head, span: chain.span, ids: [], done: false } : { ...prev, ids: [...prev.ids] };
  const found = new Set(s.ids);
  let calls = SCAN_CALLS;

  // New blocks first, so a position opened since the last load shows up. A gap too long for this load's
  // budget skips its oldest part rather than falling behind for good.
  let cursor = Math.max(s.to + 1, head - s.span * (SCAN_CALLS / 2) + 1);
  while (cursor <= head && calls > 0) {
    calls--;
    const r = await searchFrom(chain, node, owner, cursor, head, s.span, true);
    if (!r.ids) break;
    r.ids.forEach((id) => found.add(id));
    s.span = r.span;
    s.to = r.to;
    cursor = r.to + 1;
  }

  // Then older blocks, while the node keeps them.
  while (!s.done && calls > 0) {
    if (s.from <= chain.v4.start) {
      s.done = true;
      break;
    }
    calls--;
    const r = await searchFrom(chain, node, owner, chain.v4.start, s.from - 1, s.span, false);
    if (!r.ids) {
      s.done = r.refused;
      break;
    }
    r.ids.forEach((id) => found.add(id));
    s.span = r.span;
    s.from = r.from;
  }
  s.ids = [...found];
  return s;
}

// A position's own history, read from events. v3's position manager logs IncreaseLiquidity and DecreaseLiquidity
// (tokenId, liquidity, amount0, amount1) and Collect (tokenId, recipient, amount0, amount1). A collect pays out the
// fees and any liquidity removed before it, so the removals tell the two apart. v4's pool manager logs
// ModifyLiquidity (pool, sender, tickLower, tickUpper, liquidityDelta, salt = the position number) with no amounts:
// a change of zero is a fee collect, and the amounts are read from the transaction (collectTx).
const INCREASE_V3 = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
const DECREASE_V3 = '0x26f6a048ee9138f2c0ce266f322cb99228e8d619ae2bff30c67f8dcf9d2377b4';
const COLLECT_V3 = '0x40d0efd1a53d60ecbf40971b9daf7dc90178c3aadc7aab1765632738fa8b8f01';
const MODIFY_V4 = '0xf208f4912782fd25c7f114ca3723a2d5dd6f3bcc3ac8db5af63baa85f711d5ec';
const HISTORY_CALLS = 12; // log searches per position and load
const KIND = { [INCREASE_V3]: 'add', [DECREASE_V3]: 'remove', [COLLECT_V3]: 'collect' };
const idWord = (tokenId) => pad(BigInt(tokenId).toString(16));

// What a log search for a position asks for, and how each log reads. Amounts stay text, for JSON.
async function historyQuery(chain, node, pos) {
  if (pos.version === 'v3') {
    return {
      filter: { address: chain.positions, topics: [[INCREASE_V3, DECREASE_V3, COLLECT_V3], `0x${idWord(pos.tokenId)}`] },
      read: (l) => {
        const w = words(l.data);
        const kind = KIND[String(l.topics[0]).toLowerCase()];
        // Collect's first word is the recipient, the others' is the liquidity.
        return { kind, liq: kind === 'collect' ? '0' : big(w[0]).toString(), a0: big(w[1]).toString(), a1: big(w[2]).toString() };
      },
    };
  }
  return {
    filter: { address: await managerOf(chain, node), topics: [MODIFY_V4, `0x${pad(pos.pool)}`, `0x${pad(chain.v4.positions)}`] },
    read: (l) => {
      const w = words(l.data);
      if (w[3] !== idWord(pos.tokenId)) return null; // another position in the same pool
      const delta = signed(w[2]);
      return { kind: delta > 0n ? 'add' : delta < 0n ? 'remove' : 'collect', liq: (delta < 0n ? -delta : delta).toString() };
    },
  };
}

// One block range of a position's events, narrowing it while the node refuses.
async function historyIn(node, query, start, end, span, forward) {
  for (let width = span; width >= MIN_SPAN; width = Math.floor(width / 2)) {
    const from = forward ? start : Math.max(start, end - width + 1);
    const to = forward ? Math.min(end, start + width - 1) : end;
    try {
      const logs = await rpc(node, 'eth_getLogs', [{ ...query.filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
      const events = (logs ?? []).map((l) => {
        const e = query.read(l);
        return e && { ...e, block: Number(l.blockNumber), index: Number(l.logIndex), tx: l.transactionHash };
      }).filter(Boolean);
      return { events, from, to, span: width };
    } catch (err) {
      if (!err.refused) return { events: null, refused: false };
    }
  }
  return { events: null, refused: true };
}

// Whether the oldest event read is the position's opening: undoing every event read from today's liquidity
// leaves none before it.
function reachedMint(events, liquidity) {
  if (!events.length) return false;
  const sorted = [...events].sort((a, b) => a.block - b.block || a.index - b.index);
  let l = BigInt(liquidity);
  for (const e of sorted) l += e.kind === 'add' ? -BigInt(e.liq) : e.kind === 'remove' ? BigInt(e.liq) : 0n;
  return sorted[0].kind === 'add' && l <= 0n;
}

// Extends a position's saved history. pos: { version, tokenId, liquidity, pool (v4: the pool id) }. prev is what
// the last load saved: { node, from, to, span, done, events }. Like the v4 search: new blocks first, then back
// toward the opening while the node keeps the blocks. done means the opening was reached, or the node will not
// search further back. Collects get their block's time.
export async function positionHistory(chain, node, pos, prev) {
  const head = Number(await rpc(node, 'eth_blockNumber', []));
  const query = await historyQuery(chain, node, pos);
  const floor = pos.version === 'v4' ? chain.v4.start : 0;
  const fresh = !prev || prev.node !== node;
  const s = fresh
    ? { node, from: head + 1, to: head, span: chain.span, done: false, events: [] }
    : { ...prev, events: [...prev.events] };
  const have = new Set(s.events.map((e) => `${e.tx}:${e.index}`));
  const add = (list) => list.forEach((e) => {
    if (!have.has(`${e.tx}:${e.index}`)) {
      have.add(`${e.tx}:${e.index}`);
      s.events.push(e);
    }
  });
  let calls = HISTORY_CALLS;

  // A gap too long for this load skips its oldest part rather than falling behind for good.
  let cursor = Math.max(s.to + 1, head - s.span * (HISTORY_CALLS / 2) + 1);
  while (cursor <= head && calls > 0) {
    calls--;
    const r = await historyIn(node, query, cursor, head, s.span, true);
    if (!r.events) break;
    add(r.events);
    s.span = r.span;
    s.to = r.to;
    cursor = r.to + 1;
  }
  while (!s.done && calls > 0) {
    if (s.from <= floor || reachedMint(s.events, pos.liquidity)) {
      s.done = true;
      break;
    }
    calls--;
    const r = await historyIn(node, query, floor, s.from - 1, s.span, false);
    if (!r.events) {
      s.done = r.refused;
      break;
    }
    add(r.events);
    s.span = r.span;
    s.from = r.from;
  }

  const blocks = [...new Set(s.events.filter((e) => e.kind !== 'add' && !e.time).map((e) => e.block))];
  const times = new Map(await Promise.all(blocks.map(async (b) => [b, await blockTime(nodeSource(node), b)])));
  s.events = s.events.map((e) => (times.get(e.block) ? { ...e, time: times.get(e.block) } : e));
  return s;
}

// The fees in each collect, in raw token units: what it paid out, less the liquidity removed and not yet paid.
export function collectFees(events) {
  let owed0 = 0n;
  let owed1 = 0n;
  const out = [];
  for (const e of [...events].sort((a, b) => a.block - b.block || a.index - b.index)) {
    if (e.kind === 'remove') {
      owed0 += BigInt(e.a0);
      owed1 += BigInt(e.a1);
    } else if (e.kind === 'collect') {
      const p0 = BigInt(e.a0) < owed0 ? BigInt(e.a0) : owed0;
      const p1 = BigInt(e.a1) < owed1 ? BigInt(e.a1) : owed1;
      owed0 -= p0;
      owed1 -= p1;
      out.push({ ...e, f0: BigInt(e.a0) - p0, f1: BigInt(e.a1) - p1 });
    }
  }
  return out;
}

// ---- Collect transactions: what each one paid, read from the node or from Etherscan ----

const hexBlock = (n) => `0x${n.toString(16)}`;
const lower = (a) => String(a ?? '').toLowerCase();
const topicOf = (l, i) => lower(l.topics?.[i]).replace(/^0x/, '');

// Where a transaction is read from. Both answer the same JSON-RPC calls; Etherscan keeps every block, where most
// public nodes keep only recent ones, and it also knows the native coin paid inside a transaction.
export const nodeSource = (node) => ({ kind: 'node', call: (method, params) => rpc(node, method, params) });

const ETHERSCAN = 'https://api.etherscan.io/v2/api';
let etherscanQueue = Promise.resolve();
// Etherscan's free plan takes about 5 calls a second, so calls go one at a time with a short pause.
function etherscan(key, chainId, params) {
  const run = async () => {
    const res = await fetch(`${ETHERSCAN}?${new URLSearchParams({ chainid: String(chainId), ...params, apikey: key })}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
    if (!res.ok) throw new Error(`Etherscan answered ${res.status}.`);
    const json = await res.json();
    const fail = (text) => Object.assign(new Error(`Etherscan: ${text}`), { refused: true });
    if (json.error) throw fail(json.error.message ?? 'error');
    if (params.module === 'proxy') {
      if (typeof json.result === 'string' && json.status === '0') throw fail(json.result);
      return json.result;
    }
    if (json.status === '0' && !/no (transactions|records) found/i.test(`${json.message} ${json.result}`)) {
      throw fail(typeof json.result === 'string' ? json.result : json.message);
    }
    return Array.isArray(json.result) ? json.result : [];
  };
  const p = etherscanQueue.then(run, run);
  etherscanQueue = p.catch(() => {});
  return p;
}

export function etherscanSource(key, chainId) {
  const proxy = (action, params) => etherscan(key, chainId, { module: 'proxy', action, ...params });
  return {
    kind: 'etherscan',
    call: (method, params) => {
      if (method === 'eth_getTransactionReceipt') return proxy(method, { txhash: params[0] });
      if (method === 'eth_getBlockByNumber') return proxy(method, { tag: params[0], boolean: 'false' });
      if (method === 'eth_call') return proxy(method, { to: params[0].to, data: params[0].data, tag: params[1] });
      throw new Error(`Etherscan is not asked for ${method}.`);
    },
    // A v4 pool's swaps in a block range, for its price when no node will read past state.
    swaps: (manager, poolId, from, to) => etherscan(key, chainId, { module: 'logs', action: 'getLogs', address: manager, fromBlock: String(from), toBlock: String(to), topic0: SWAP_V4, topic1: `0x${pad(poolId)}`, topic0_1_opr: 'and', page: '1', offset: '1000' }),
    // The native coin paid to `to` inside a transaction, in wei. It leaves no log, but Etherscan traces it.
    native: async (tx, to) => (await etherscan(key, chainId, { module: 'account', action: 'txlistinternal', txhash: tx }))
      .filter((t) => lower(t.to) === lower(to) && t.isError !== '1')
      .reduce((s, t) => s + BigInt(t.value), 0n),
  };
}

export async function blockTime(src, block) {
  return Number((await src.call('eth_getBlockByNumber', [hexBlock(block), false]))?.timestamp ?? 0);
}

// A wallet's transactions to a chain's Uniswap position managers, oldest first, from a block on. Etherscan sends
// up to 1000 transactions a call; last is the newest block it sent, and more says whether there are more after it.
export async function walletPositionTxs(key, chain, wallet, startblock) {
  const list = await etherscan(key, chain.id, { module: 'account', action: 'txlist', address: wallet, startblock: String(startblock), endblock: '999999999', sort: 'asc', page: '1', offset: '1000' });
  const managers = new Set([chain.positions, chain.v4?.positions].filter(Boolean).map(lower));
  return {
    txs: list.filter((t) => managers.has(lower(t.to)) && t.isError === '0').map((t) => ({ tx: t.hash, block: Number(t.blockNumber), time: Number(t.timeStamp) })),
    last: list.length ? Number(list[list.length - 1].blockNumber) : null,
    more: list.length >= 1000,
  };
}

// The positions a transaction collected from: v3 Collect events and v4 liquidity changes made through the
// position manager that did not add liquidity.
export async function positionsInReceipt(chain, node, receipt) {
  const out = [];
  const logs = receipt?.logs ?? [];
  for (const l of logs) {
    if (lower(l.address) === lower(chain.positions) && lower(l.topics?.[0]) === COLLECT_V3) out.push({ version: 'v3', tokenId: big(topicOf(l, 1)).toString() });
  }
  if (chain.v4 && logs.some((l) => lower(l.topics?.[0]) === MODIFY_V4)) {
    const manager = lower(await managerOf(chain, node));
    for (const l of logs) {
      if (lower(l.address) !== manager || lower(l.topics?.[0]) !== MODIFY_V4 || topicOf(l, 2) !== pad(chain.v4.positions)) continue;
      if (signed(words(l.data)[2]) <= 0n) out.push({ version: 'v4', tokenId: big(words(l.data)[3]).toString() });
    }
  }
  return [...new Map(out.map((p) => [`${p.version}:${p.tokenId}`, p])).values()];
}

// A v4 pool's price (sqrt, as a float) just before a transaction: its state one block back, from the source or
// the node, else the last swap before it, from Etherscan's log search. null when none of them answers.
async function priceBefore(chain, src, node, manager, poolId, block, txIndex) {
  const call = { to: chain.v4.stateView, data: SEL.getSlot0 + pad(poolId) };
  for (const s of [src, nodeSource(node)]) {
    try {
      const w = words(await s.call('eth_call', [call, hexBlock(block - 1)]));
      if (w.length && big(w[0]) > 0n) return Number(big(w[0])) / Q96;
    } catch {
      // Most public nodes refuse past state: try the next way.
    }
  }
  if (!src.swaps) return null;
  for (const back of [200, 5000, 50000]) {
    try {
      const before = (await src.swaps(manager, poolId, Math.max(0, block - back), block))
        .filter((l) => Number(l.blockNumber) < block || (Number(l.blockNumber) === block && Number(l.transactionIndex) < txIndex));
      if (before.length) return Number(big(words(before[before.length - 1].data)[2])) / Q96;
    } catch {
      return null;
    }
  }
  return null;
}

// What one transaction paid a position in fees, in raw token units (as numbers), or null when it collected
// nothing for it. pos: { version, tokenId, owner, token0, token1 }. node is used for the v4 pool manager's
// address and, without Etherscan, for the native coin.
// level ranks how sure the reading is: 3 every amount comes from the transaction; 2 liquidity was removed in it,
// worked out from the pool's price just before; 1 the native coin part could not be read (left at 0).
// A collect sends value only as fees and liquidity removed, so what the wallet gained in the native coin, plus the
// gas it paid, is that part.
export async function collectTx(chain, src, node, tx, pos, given = null) {
  const receipt = given ?? await src.call('eth_getTransactionReceipt', [tx]);
  if (!receipt || receipt.status !== '0x1') return null;
  const block = Number(receipt.blockNumber);
  const id = idWord(pos.tokenId);
  const logs = receipt.logs ?? [];

  if (pos.version === 'v3') {
    const mine = (sig) => logs.filter((l) => lower(l.address) === lower(chain.positions) && lower(l.topics?.[0]) === sig && topicOf(l, 1) === id);
    const sum = (list) => list.reduce(([x, y], l) => [x + big(words(l.data)[1]), y + big(words(l.data)[2])], [0n, 0n]);
    const collects = mine(COLLECT_V3);
    if (!collects.length) return null;
    const [c0, c1] = sum(collects);
    const [d0, d1] = sum(mine(DECREASE_V3));
    return { block, f0: Number(c0 > d0 ? c0 - d0 : 0n), f1: Number(c1 > d1 ? c1 - d1 : 0n), level: 3 };
  }

  const manager = lower(await managerOf(chain, node));
  const mods = logs.filter((l) => lower(l.address) === manager && lower(l.topics?.[0]) === MODIFY_V4
    && topicOf(l, 2) === pad(chain.v4.positions) && words(l.data)[3] === id);
  if (!mods.length) return null;
  const delta = mods.reduce((s, l) => s + signed(words(l.data)[2]), 0n);
  if (delta > 0n) return null; // liquidity added: the fees went back into the position

  let level = 3;
  // Liquidity removed in the same transaction is paid out with the fees: take it off at the price just before.
  let p0 = 0;
  let p1 = 0;
  if (delta < 0n) {
    const w = words(mods[0].data);
    const sqrt = await priceBefore(chain, src, node, manager, topicOf(mods[0], 1), block, Number(receipt.transactionIndex));
    if (sqrt == null) return null; // without the price, fees cannot be told from the liquidity removed
    const amt = positionAmounts({ liquidity: -delta, tickLower: Number(signed(w[0])), tickUpper: Number(signed(w[1])) }, sqrt);
    p0 = amt.a0;
    p1 = amt.a1;
    level = 2;
  }

  const owner = pad(pos.owner);
  const amountOf = async (token) => {
    if (!isNative(token)) {
      return Number(logs.filter((l) => lower(l.address) === lower(token) && lower(l.topics?.[0]) === TRANSFER && topicOf(l, 1) === pad(manager) && topicOf(l, 2) === owner)
        .reduce((s, l) => s + big(words(l.data)[0]), 0n));
    }
    try {
      if (src.native) return Number(await src.native(tx, pos.owner));
      const n = nodeSource(node);
      const [after, before] = await Promise.all([block, block - 1].map((b) => n.call('eth_getBalance', [pos.owner, hexBlock(b)])));
      // Rollups such as Base also charge a fee for posting the transaction to Ethereum (l1Fee).
      const gas = lower(receipt.from) === lower(pos.owner) ? BigInt(receipt.gasUsed) * BigInt(receipt.effectiveGasPrice ?? 0) + BigInt(receipt.l1Fee ?? 0) : 0n;
      const gained = BigInt(after) - BigInt(before) + gas;
      return Number(gained > 0n ? gained : 0n);
    } catch {
      level = 1;
      return 0;
    }
  };
  const a0 = await amountOf(pos.token0);
  const a1 = await amountOf(pos.token1);
  return { block, f0: Math.max(0, a0 - p0), f1: Math.max(0, a1 - p1), level };
}

// Fee APR over a past window comes from the pool's swaps in it, read from logs: public nodes refuse to read
// past state, but keep logs. Each pool's swaps stay in memory, so a longer window or the next load only reads
// the blocks not yet read.
const SWAP_CALLS = 40; // log searches per pool and load
const swapCache = new Map(); // "chainId:version:pool" -> { node, from, to, swaps }
const managers = new Map(); // chainId -> v4 pool manager address, which emits every v4 pool's swaps

// The head block, its time (unix seconds), and the average seconds per block over the last 10,000 blocks.
export async function chainClock(node) {
  const head = Number(await rpc(node, 'eth_blockNumber', []));
  const back = Math.max(0, head - 10000);
  const [a, b] = await Promise.all([head, back].map((n) => rpc(node, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])));
  const perBlock = (Number(a.timestamp) - Number(b.timestamp)) / Math.max(1, head - back);
  return { head, time: Number(a.timestamp), perBlock: perBlock > 0 ? perBlock : 1 };
}

async function managerOf(chain, node) {
  if (!managers.has(chain.id)) managers.set(chain.id, addressOf(words(await rpcCall(node, chain.v4.positions, SEL.poolManager))[0]));
  return managers.get(chain.id);
}

// One swap, kept small: the block, the tick and active liquidity after it, the amount paid in of each token and,
// on v4, the fee charged (v4 fees can change per swap). v3 amounts are the pool's side, so paid in is positive;
// v4 amounts are the swapper's, so paid in is negative.
function parseSwap(log, version) {
  const w = words(log.data);
  const side = version === 'v3' ? 1n : -1n;
  const a0 = signed(w[0]) * side;
  const a1 = signed(w[1]) * side;
  return { block: Number(log.blockNumber), tick: Number(signed(w[4])), liq: big(w[3]), in0: a0 > 0n ? a0 : 0n, in1: a1 > 0n ? a1 : 0n, fee: version === 'v4' ? Number(big(w[5])) : null };
}

// Swaps in one block range, narrowing it while the node refuses (too wide, or too many results). null on failure.
async function swapsIn(node, filter, version, start, end, span, forward) {
  for (let width = span; width >= MIN_SPAN; width = Math.floor(width / 2)) {
    const from = forward ? start : Math.max(start, end - width + 1);
    const to = forward ? Math.min(end, start + width - 1) : end;
    try {
      const logs = await rpc(node, 'eth_getLogs', [{ ...filter, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
      return { swaps: (logs ?? []).map((l) => parseSwap(l, version)), from, to, span: width };
    } catch (err) {
      if (!err.refused) return null;
    }
  }
  return null;
}

// A pool's swaps from block `from` to `head`, adding to what was already read: new blocks first, then older ones
// back to `from`. Stops at the call budget, so on a fast chain a long window may be covered only in part; the
// returned `from` is the oldest block read. pool is the v3 pool address or the v4 pool id.
export async function poolSwaps(chain, node, version, pool, from, head) {
  const key = `${chain.id}:${version}:${pool}`;
  let c = swapCache.get(key);
  // A gap too long to close in one load starts over, so the swaps read are always one unbroken range.
  if (!c || c.node !== node || head - c.to > chain.span * (SWAP_CALLS / 2)) c = { node, from: head + 1, to: head, swaps: [] };
  const filter = version === 'v3' ? { address: pool, topics: [SWAP_V3] } : { address: await managerOf(chain, node), topics: [SWAP_V4, pool] };
  let span = chain.span;
  let calls = SWAP_CALLS;
  while (c.to < head && calls > 0) {
    calls--;
    const r = await swapsIn(node, filter, version, c.to + 1, head, span, true);
    if (!r) break;
    c.swaps.push(...r.swaps);
    span = r.span;
    c.to = r.to;
  }
  if (c.to < head) c = { node, from: head + 1, to: head, swaps: [] };
  while (c.from > from && calls > 0) {
    calls--;
    const r = await swapsIn(node, filter, version, from, c.from - 1, span, false);
    if (!r) break;
    c.swaps.push(...r.swaps);
    span = r.span;
    c.from = r.from;
  }
  swapCache.set(key, c);
  return c;
}

// The fees a position earned from swaps since a block, in raw token units: each swap that ended inside its range
// pays it the fee times its share of the active liquidity. An estimate: a swap that crosses ticks is counted at
// where it ended, and a hook can change what is paid.
export function swapFees(swaps, fromBlock, p) {
  let e0 = 0n;
  let e1 = 0n;
  for (const s of swaps) {
    if (s.block < fromBlock) continue;
    const [f0, f1] = swapEarn(s, p);
    e0 += f0;
    e1 += f1;
  }
  return { e0, e1 };
}

// What one swap paid a position, in raw units of each token. p.liquidity may be text.
export function swapEarn(s, p) {
  if (s.tick < p.tickLower || s.tick >= p.tickUpper || s.liq === 0n) return [0n, 0n];
  const L = BigInt(p.liquidity);
  const share = L < s.liq ? L : s.liq;
  const pips = BigInt(s.fee ?? p.fee);
  return [(s.in0 * pips * share) / (1000000n * s.liq), (s.in1 * pips * share) / (1000000n * s.liq)];
}

// The id Uniswap v4 gives a pool: the hash of its key.
const poolIdOf = (key) => keccak256(pad(key.currency0) + pad(key.currency1) + pad(key.fee.toString(16)) + padInt(key.tickSpacing) + pad(key.hooks));
const DYNAMIC_FEE = 0x800000;
const Q128 = 2n ** 128n;
const U256 = 2n ** 256n;

// One v4 position: its owner, pool, range, liquidity and unclaimed fees, and the pool's current price.
// null when the token was burned. The fees are what the pool owes the position; a hook can change what is paid.
export async function readV4Position(chain, node, tokenId) {
  const id = pad(BigInt(tokenId).toString(16));
  let ownerHex;
  try {
    ownerHex = await rpcCall(node, chain.v4.positions, SEL.ownerOf + id);
  } catch (err) {
    if (err.refused) return null; // ownerOf reverts for a burned token
    throw err;
  }
  const [info, liq] = await Promise.all([
    rpcCall(node, chain.v4.positions, SEL.getPoolAndPositionInfo + id),
    rpcCall(node, chain.v4.positions, SEL.getPositionLiquidity + id),
  ]);
  const w = words(info);
  const key = { currency0: addressOf(w[0]), currency1: addressOf(w[1]), fee: Number(big(w[2])), tickSpacing: Number(signed(w[3])), hooks: addressOf(w[4]) };
  const packed = big(w[5]);
  const int24 = (v) => (v >= 2n ** 23n ? Number(v - 2n ** 24n) : Number(v));
  const tickLower = int24((packed >> 8n) & 0xffffffn);
  const tickUpper = int24((packed >> 32n) & 0xffffffn);
  const liquidity = big(words(liq)[0]);
  const poolId = poolIdOf(key);

  const pid = pad(poolId);
  const range = padInt(tickLower) + padInt(tickUpper);
  const [slot0, inside, last] = await Promise.all([
    rpcCall(node, chain.v4.stateView, SEL.getSlot0 + pid),
    rpcCall(node, chain.v4.stateView, SEL.getFeeGrowthInside + pid + range),
    rpcCall(node, chain.v4.stateView, SEL.getPositionInfo + pid + pad(chain.v4.positions) + range + id),
  ]);
  const s0 = words(slot0);
  const g = words(inside);
  const l = words(last);
  const owed = (now, then) => (((big(now) - big(then) + U256) % U256) * liquidity) / Q128;
  return {
    position: {
      version: 'v4',
      chainId: chain.id,
      tokenId: String(tokenId),
      owner: addressOf(words(ownerHex)[0]),
      token0: key.currency0,
      token1: key.currency1,
      fee: key.fee === DYNAMIC_FEE ? Number(big(s0[3])) : key.fee,
      hooks: key.hooks,
      tickLower,
      tickUpper,
      liquidity,
      owed0: owed(g[0], l[1]),
      owed1: owed(g[1], l[2]),
      feesFull: true,
    },
    pool: { pool: poolId, sqrtPrice: Number(big(s0[0])) / Q96, tick: Number(signed(s0[1])) },
  };
}

// Positions added by hand, for those the board does not find: a v3 position held by an address that is not in the
// wallet list, or a v4 position older than the node's history. v4ids came first, so each version has its own list.
export const addedPositions = (cfg) => [
  ...(cfg?.v3ids ?? []).map((x) => ({ ...x, version: 'v3' })),
  ...(cfg?.v4ids ?? []).map((x) => ({ ...x, version: 'v4' })),
];
export const addedListOf = (version) => (version === 'v3' ? 'v3ids' : 'v4ids');

// Whether the board reads positions of this Uniswap version on the chain.
export const hasVersion = (chain, version) => version === 'v3' || (version === 'v4' && Boolean(chain.v4));

// Reads a Uniswap app link (…/positions/<v3|v4>/<chain>/<id>), which names its chain, version and number.
// Returns null for text that is not such a link, and { slug } alone when the link names a chain the board does not read.
export function readLink(text) {
  const m = String(text ?? '').trim().match(/positions\/(v3|v4)\/([a-z0-9_-]+)\/(\d+)/i);
  if (!m) return null;
  const slug = m[2].toLowerCase();
  const chain = CHAINS.find((c) => c.app === slug);
  const version = m[1].toLowerCase();
  return chain && hasVersion(chain, version) ? { chainId: chain.id, version, tokenId: m[3], slug } : { slug, version };
}

// Reads what was typed to add a position: a Uniswap app link, or a plain number, which takes the chain and version
// picked beside it.
export function parsePosition(text, chainId, version) {
  const link = readLink(text);
  if (link) return link.chainId ? { chainId: link.chainId, version: link.version, tokenId: link.tokenId } : null;
  const s = String(text ?? '').trim();
  const chain = CHAINS.find((c) => c.id === chainId);
  return /^\d+$/.test(s) && chain && hasVersion(chain, version) ? { chainId, version, tokenId: s } : null;
}

// Adds a parsed position to the settings. Returns an error message, or '' when it was added.
export function addPosition(store, entry) {
  const cfg = store.get('settings').uniswap ?? {};
  if (addedPositions(cfg).some((x) => x.version === entry.version && x.chainId === entry.chainId && String(x.tokenId) === entry.tokenId)) {
    return 'That position is already in the list.';
  }
  const list = addedListOf(entry.version);
  store.update('settings', (d) => {
    d.uniswap = { wallets: [], chains: {}, ...d.uniswap, [list]: [...(d.uniswap?.[list] ?? []), { chainId: entry.chainId, tokenId: entry.tokenId }] };
  });
  return '';
}

// The amounts of both tokens a position holds at the pool's current price (raw units, floats).
export function positionAmounts(p, sqrtPrice) {
  const L = Number(p.liquidity);
  const sa = Math.pow(1.0001, p.tickLower / 2);
  const sb = Math.pow(1.0001, p.tickUpper / 2);
  if (sqrtPrice <= sa) return { a0: (L * (sb - sa)) / (sa * sb), a1: 0 };
  if (sqrtPrice < sb) return { a0: (L * (sb - sqrtPrice)) / (sqrtPrice * sb), a1: L * (sqrtPrice - sa) };
  return { a0: 0, a1: L * (sb - sa) };
}

// The price of token1 in token0 at a tick, in human units.
export const priceAtTick = (tick, dec0, dec1) => Math.pow(1.0001, tick) * Math.pow(10, dec0 - dec1);
