// Every chain the board knows: the built-in ones (the chains the LP tab reads) and the ones added in
// Settings → Blockchains. Built-in nodes stay saved under settings.uniswap.chains, where they were first kept.
import { CHAINS, chainSettings, savedNode, rpc } from './uniswap.js';

// Block explorers of the built-in chains. A chain without one gets no links.
export const EXPLORERS = {
  1: 'https://etherscan.io',
  8453: 'https://basescan.org',
  42161: 'https://arbiscan.io',
  10: 'https://optimistic.etherscan.io',
  137: 'https://polygonscan.com',
  56: 'https://bscscan.com',
  43114: 'https://snowtrace.io',
  130: 'https://uniscan.xyz',
  4663: 'https://robinhoodchain.blockscout.com',
  324: 'https://era.zksync.network',
};

export const customChains = (settings) => settings?.blockchains?.custom ?? [];

// One shape for both kinds. node: the address actually read from; saved: the one typed in Settings, or ''.
export function allChains(settings) {
  const uni = settings?.uniswap;
  const builtin = CHAINS.map((c) => {
    const s = chainSettings(uni, c);
    return { id: c.id, name: c.name, logo: c.logo, symbol: c.native.symbol, explorer: EXPLORERS[c.id] ?? '', rpc: c.rpc, saved: savedNode(uni, c), node: s.node, lp: s.enabled, builtin: true };
  });
  const custom = customChains(settings).map((c) => ({ id: c.id, name: c.name, logo: '', symbol: c.symbol || 'ETH', explorer: c.explorer || '', rpc: c.rpc, saved: c.rpc, node: c.rpc, lp: false, builtin: false }));
  return [...builtin, ...custom];
}

export const chainById = (settings, id) => allChains(settings).find((c) => c.id === Number(id)) ?? null;

export const explorerUrl = (chain, kind, id) => (chain?.explorer && id ? `${chain.explorer.replace(/\/+$/, '')}/${kind}/${id}` : null);

export const isNodeUrl = (s) => /^https?:\/\/\S+$/i.test(String(s ?? '').trim());

// Asks a node which chain it serves, and how far it has got.
export async function testNode(node) {
  const [id, head] = await Promise.all([rpc(node, 'eth_chainId', []), rpc(node, 'eth_blockNumber', [])]);
  return { chainId: Number(id), block: Number(head) };
}
