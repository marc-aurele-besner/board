// Uniswap v3 liquidity positions, read straight from an Ethereum node. Read-only: only public addresses are used,
// never keys. Token prices come from CoinGecko's public price endpoint.
const DEFAULT_RPC = 'https://ethereum.publicnode.com';
const POSITION_MANAGER = '0xC36442b4a4522E871399CD717aBDD847Ab11FE88';
const FACTORY = '0x1F98431c8aD98523631AE4a59f267346ea31F984';
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

export const DEFAULT_NODE = DEFAULT_RPC;

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

// One read-only call to an Ethereum node.
export async function rpcCall(node, to, data) {
  const res = await fetch(node || DEFAULT_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to, data }, 'latest'] }),
  });
  if (!res.ok) throw new Error(`The Ethereum node answered ${res.status}.`);
  const json = await res.json();
  if (json.error) throw new Error(`The Ethereum node refused the call: ${json.error.message ?? 'error'}.`);
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

// The node's name for the position manager: a quick check that the node and the contract are reachable.
export async function checkNode(node) {
  return decodeString(await rpcCall(node, POSITION_MANAGER, SEL.name));
}

// Every position with liquidity or unclaimed fees that a public address owns (up to MAX_POSITIONS).
export async function readPositions(node, owner) {
  const ownerWord = pad(owner);
  const count = Number(big(words(await rpcCall(node, POSITION_MANAGER, SEL.balanceOf + ownerWord))[0]));
  const indexes = Array.from({ length: Math.min(count, MAX_POSITIONS) }, (_, i) => i);
  const ids = await Promise.all(indexes.map(async (i) => big(words(await rpcCall(node, POSITION_MANAGER, SEL.tokenOfOwnerByIndex + ownerWord + pad(i.toString(16))))[0])));
  const raw = await Promise.all(ids.map((id) => rpcCall(node, POSITION_MANAGER, SEL.positions + pad(id.toString(16)))));
  return raw
    .map((hex, i) => {
      const w = words(hex);
      return {
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
export async function poolState(node, p) {
  const pool = addressOf(words(await rpcCall(node, FACTORY, SEL.getPool + pad(p.token0) + pad(p.token1) + pad(p.fee.toString(16))))[0]);
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

// USD price of each token address, from CoinGecko. Tokens it does not know are left out.
export async function usdPrices(addresses) {
  const list = [...new Set(addresses.map((a) => a.toLowerCase()))];
  if (!list.length) return {};
  const res = await fetch(`https://api.coingecko.com/api/v3/simple/token_price/ethereum?contract_addresses=${list.join(',')}&vs_currencies=usd`);
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
