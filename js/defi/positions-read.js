// Liquidity Pools positions as of the last saved read, without the DOM: Cron's gather step reads them in the runners.
// Nothing is read from a chain here; pools.json `cache` holds what DeFi → Positions read last.
import { CHAINS, chainSettings, addedPositions, isAddressSymbol } from '../uniswap.js';

const refOf = (version, chainId, tokenId) => (version === 'v3' ? `${chainId}:${tokenId}` : `${chainId}:${version}:${tokenId}`);
const cacheKeys = (chains) => chains.flatMap((c) => (c.v4 ? [`${c.id}:v3`, `${c.id}:v4`] : [`${c.id}:v3`]));
const enabledChains = (cfg) => CHAINS.filter((chain) => chainSettings(cfg, chain).enabled);

// A symbol saved as an address while it could not be read, from another row of the same token that has it.
function symbolFrom(rows, chainId, sym, addr) {
  if (!isAddressSymbol(sym) || !addr) return sym;
  const a = String(addr).toLowerCase();
  for (const r of rows) {
    if (r.chainId !== chainId) continue;
    if (String(r.addr0).toLowerCase() === a && !isAddressSymbol(r.sym0)) return r.sym0;
    if (String(r.addr1).toLowerCase() === a && !isAddressSymbol(r.sym1)) return r.sym1;
  }
  return sym;
}

// Open positions of the wallets and positions set in Settings, on the enabled chains.
export function openPositions(store) {
  const cfg = store.get('settings').uniswap ?? {};
  const cache = store.get('pools')?.cache ?? {};
  const wallets = new Set((cfg.wallets ?? []).map((w) => w.address.toLowerCase()));
  const manual = new Set(addedPositions(cfg).map((x) => refOf(x.version, x.chainId, x.tokenId)));
  const rows = cacheKeys(enabledChains(cfg)).flatMap((key) => (cache[key]?.rows ?? [])
    .filter((r) => wallets.has(r.wallet) || manual.has(r.ref))
    .map((r) => ({ ...r, max: r.max ?? Infinity, staleAt: cache[key].at })));
  return rows
    .map((r) => {
      const sym0 = symbolFrom(rows, r.chainId, r.sym0, r.addr0);
      const sym1 = symbolFrom(rows, r.chainId, r.sym1, r.addr1);
      return { ...r, sym0, sym1, pair: `${sym0} / ${sym1}` };
    })
    .filter((r) => !r.closed);
}
