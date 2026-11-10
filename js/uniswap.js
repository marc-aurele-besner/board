// Uniswap v3 liquidity positions, read straight from each chain's node. Read-only: only public addresses are used,
// never keys. Token prices come from CoinGecko's public price endpoint.
// Uniswap v4 is not read yet: its position manager is a plain ERC-721, so positions cannot be listed with a call.

// Chain logos from Trust Wallet's asset repository. Unichain and Robinhood Chain are not in it; both pay gas in ETH,
// so they use ETH's logo.
const trustLogo = (folder) => `https://raw.githubusercontent.com/trustwallet/assets/master/blockchains/${folder}/info/logo.png`;
const ETH_LOGO = trustLogo('ethereum');

// The chains the LP tab reads. Each address is Uniswap's own v3 deployment on that chain, checked on-chain.
// The same address is not used on every chain, so every chain carries its own.
export const CHAINS = [
  { id: 1, name: 'Ethereum', rpc: 'https://ethereum.publicnode.com', coingecko: 'ethereum', app: 'ethereum', logo: ETH_LOGO, factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  { id: 8453, name: 'Base', rpc: 'https://base.publicnode.com', coingecko: 'base', app: 'base', logo: trustLogo('base'), factory: '0x33128a8fC17869897dcE68Ed026d694621f6FDfD', positions: '0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1' },
  { id: 42161, name: 'Arbitrum One', rpc: 'https://arbitrum-one-rpc.publicnode.com', coingecko: 'arbitrum-one', app: 'arbitrum', logo: trustLogo('arbitrum'), factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  { id: 10, name: 'Optimism', rpc: 'https://optimism-rpc.publicnode.com', coingecko: 'optimistic-ethereum', app: 'optimism', logo: trustLogo('optimism'), factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  { id: 137, name: 'Polygon', rpc: 'https://polygon-bor-rpc.publicnode.com', coingecko: 'polygon-pos', app: 'polygon', logo: trustLogo('polygon'), factory: '0x1F98431c8aD98523631AE4a59f267346ea31F984', positions: '0xC36442b4a4522E871399CD717aBDD847Ab11FE88' },
  { id: 56, name: 'BNB Chain', rpc: 'https://bsc-rpc.publicnode.com', coingecko: 'binance-smart-chain', app: 'bnb', logo: trustLogo('smartchain'), factory: '0xdB1d10011AD0Ff90774D0C6Bb92e5C5c8b4461F7', positions: '0x7b8A01B39D58278b5DE7e48c8449c9f4F5170613' },
  { id: 43114, name: 'Avalanche', rpc: 'https://avalanche-c-chain-rpc.publicnode.com', coingecko: 'avalanche', app: 'avalanche', logo: trustLogo('avalanchec'), factory: '0x740b1c1de25031C31FF4fC9A62f554A55cdC1baD', positions: '0x655C406EBFa14EE2006250925e54ec43AD184f8B' },
  { id: 130, name: 'Unichain', rpc: 'https://unichain-rpc.publicnode.com', coingecko: 'unichain', app: 'unichain', logo: ETH_LOGO, factory: '0x1f98400000000000000000000000000000000003', positions: '0x943e6e07a7e8e791dafc44083e54041d743c46e9' },
  { id: 4663, name: 'Robinhood Chain', rpc: 'https://rpc.mainnet.chain.robinhood.com', coingecko: 'robinhood', app: null, logo: ETH_LOGO, factory: '0x1f7d7550b1b028f7571e69a784071f0205fd2efa', positions: '0x73991a25c818bf1f1128deaab1492d45638de0d3' },
];

// Token logos from Uniswap's default token list, one file per chain on GitHub (which allows browser reads),
// keyed "chainId:address" in lowercase. Fetched once; a token the list does not carry gets a monogram instead.
const TOKEN_LIST_DIR = 'https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens';
const TOKEN_LIST_FILE = { 1: 'mainnet', 8453: 'base', 42161: 'arbitrum', 10: 'optimism', 137: 'polygon', 56: 'bnb', 43114: 'avalanche', 130: 'unichain', 4663: 'robinhood' };
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
    .map((t) => [`${t.chainId}:${t.address.toLowerCase()}`, t.logoURI])));
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
};
const MAX_POSITIONS = 40;
const Q96 = 2 ** 96;

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
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

// One read-only call to a chain's node.
export async function rpcCall(node, to, data) {
  const res = await fetch(node, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`The node answered ${res.status}.`);
  const json = await res.json();
  if (json.error) throw new Error(`The node refused the call: ${json.error.message ?? 'error'}.`);
  return json.result ?? '0x';
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

// Every position with liquidity or unclaimed fees that a public address owns on a chain (up to MAX_POSITIONS).
export async function readPositions(chain, node, owner) {
  const ownerWord = pad(owner);
  const count = Number(big(words(await rpcCall(node, chain.positions, SEL.balanceOf + ownerWord))[0]));
  const indexes = Array.from({ length: Math.min(count, MAX_POSITIONS) }, (_, i) => i);
  const ids = await Promise.all(indexes.map(async (i) => big(words(await rpcCall(node, chain.positions, SEL.tokenOfOwnerByIndex + ownerWord + pad(i.toString(16))))[0])));
  const raw = await Promise.all(ids.map((id) => rpcCall(node, chain.positions, SEL.positions + pad(id.toString(16)))));
  return raw
    .map((hex, i) => {
      const w = words(hex);
      return {
        chainId: chain.id,
        tokenId: ids[i].toString(),
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
    })
    .filter((p) => p.liquidity > 0n || p.owed0 > 0n || p.owed1 > 0n);
}

// The pool a position is in: its current price (sqrt, as a float) and tick. null when the pool does not exist.
export async function poolState(chain, node, p) {
  const pool = addressOf(words(await rpcCall(node, chain.factory, SEL.getPool + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16))))[0]);
  if (/^0x0+$/.test(pool)) return null;
  const s = words(await rpcCall(node, pool, SEL.slot0));
  return { pool, sqrtPrice: Number(big(s[0])) / Q96, tick: Number(signed(s[1])) };
}

// A token's symbol and decimals. Falls back to the short address when the token does not answer.
export async function tokenMeta(node, address) {
  try {
    const [sym, dec] = await Promise.all([rpcCall(node, address, SEL.symbol), rpcCall(node, address, SEL.decimals)]);
    return { symbol: decodeString(sym) || shortAddress(address), decimals: Number(big(words(dec)[0])) || 18 };
  } catch {
    return { symbol: shortAddress(address), decimals: 18 };
  }
}

// USD price of each token address on a chain, keyed by lowercase address, from CoinGecko.
// Tokens it does not know are left out.
export async function usdPrices(chain, addresses) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!list.length) return {};
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/${chain.coingecko}?contract_addresses=${list.join(',')}&vs_currencies=usd`);
  if (!res.ok) throw new Error(`The price service answered ${res.status}.`);
  const data = await res.json();
  const out = {};
  for (const [address, value] of Object.entries(data)) {
    if (value?.usd) out[address.toLowerCase()] = value.usd;
  }
  return out;
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
