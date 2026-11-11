// What each DeFi wallet holds on a chain: its native coin and every ERC-20 on the chain's token list, plus the
// tokens added by hand. Read from the chain's node through Multicall3; only public addresses are used.
import { NATIVE, tokenList, usdPrices } from './uniswap.js';
import { multicall, nativeBalanceCall } from './multicall.js';

const pad = (hex) => hex.replace(/^0x/, '').toLowerCase().padStart(64, '0');
const balanceCall = (token, wallet) => ({ to: token, data: `0x70a08231${pad(wallet)}` });

export const tokenRef = (chainId, address) => `${chainId}:${String(address).toLowerCase()}`;

// The tokens checked on a chain: the native coin first, then the list's, then those added by hand, once each.
export async function chainTokens(chain, added = []) {
  const listed = (await tokenList()).filter((t) => t.chainId === chain.id);
  const out = new Map([[NATIVE, { address: NATIVE, symbol: chain.native.symbol, decimals: 18, logo: chain.native.logo }]]);
  for (const t of [...listed, ...added.filter((t) => t.chainId === chain.id)]) {
    const address = t.address.toLowerCase();
    if (!out.has(address)) out.set(address, { address, symbol: t.symbol, decimals: Number(t.decimals) || 0, logo: t.logoURI ?? '' });
  }
  return [...out.values()];
}

// Every non-zero balance of the wallets on a chain, priced in USD where DefiLlama knows the token.
// Rows: { ref, chainId, wallet, label, token, symbol, decimals, logo, raw, amount, price, value }.
export async function readBalances(chain, node, wallets, tokens) {
  const calls = wallets.flatMap((w) => tokens.map((t) => (t.address === NATIVE ? nativeBalanceCall(w.address) : balanceCall(t.address, w.address))));
  const answers = await multicall(node, calls);
  const rows = [];
  wallets.forEach((w, i) => tokens.forEach((t, j) => {
    const hex = answers[i * tokens.length + j];
    if (!hex) return;
    const raw = BigInt(hex.slice(0, 66));
    if (raw === 0n) return;
    rows.push({
      ref: tokenRef(chain.id, t.address),
      chainId: chain.id,
      wallet: w.address.toLowerCase(),
      label: w.label || '',
      token: t.address,
      symbol: t.symbol,
      decimals: t.decimals,
      logo: t.logo,
      raw: raw.toString(),
      amount: Number(raw) / 10 ** t.decimals,
      price: null,
      value: null,
    });
  }));
  if (!rows.length) return rows;
  // A price failure leaves the amounts, unpriced, rather than losing the read.
  let prices = {};
  try {
    prices = await usdPrices(chain, rows.map((r) => r.token));
  } catch {}
  for (const r of rows) {
    r.price = prices[r.token] ?? null;
    r.value = r.price === null ? null : r.amount * r.price;
  }
  return rows;
}
