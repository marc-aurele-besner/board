// @ts-check
// Every chain the board knows: the built-in ones (the chains the LP tab reads) and the ones added in
// Settings → Blockchains. Built-in nodes stay saved under settings.uniswap.chains, where they were first kept.
import { CHAINS, chainSettings, savedNode, rpc, nodeUrls } from './uniswap.js';
/** @import { Settings } from '../types/data' */

// The Etherscan API key, set in Settings → Blockchains. Keys saved before then sit under settings.uniswap.
export const etherscanKey = (/** @type {Settings | undefined} */ settings) => String(settings?.blockchains?.etherscan ?? settings?.uniswap?.etherscan ?? '').trim();

// Block explorers of the built-in chains. A chain without one gets no links.
/** @type {Record<number, string>} */
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

export const customChains = (/** @type {Settings | undefined} */ settings) => settings?.blockchains?.custom ?? [];

// A chain's explorers, saved like its nodes: one line of addresses separated by spaces. The first is the one linked to.
/** @template {object} C @param {C} chain @param {string} saved */
const withExplorers = (chain, saved) => {
  const explorers = nodeUrls(saved).map((u) => u.replace(/\/+$/, ''));
  return { ...chain, explorers, explorer: explorers[0] ?? '' };
};

// One shape for both kinds. node: the addresses actually read from; saved: the ones typed in Settings, or ''.
// A built-in chain's explorers are its own unless Settings replaced them (defaultExplorer is what it goes back to).
/** @param {Settings | undefined} settings */
export function allChains(settings) {
  const uni = settings?.uniswap;
  const builtin = CHAINS.map((c) => {
    const s = chainSettings(uni, c);
    const defaultExplorer = EXPLORERS[c.id] ?? '';
    return withExplorers({ id: c.id, name: c.name, logo: c.logo, symbol: c.native.symbol, defaultExplorer, rpc: c.rpc, saved: savedNode(uni, c), node: s.node, lp: s.enabled, builtin: true },
      uni?.chains?.[c.id]?.explorer || defaultExplorer);
  });
  const custom = customChains(settings).map((c) => withExplorers({ id: c.id, name: c.name, logo: '', symbol: c.symbol || 'ETH', defaultExplorer: '', rpc: c.rpc, saved: c.rpc, node: c.rpc, lp: false, builtin: false }, c.explorer));
  return [...builtin, ...custom];
}

/** @typedef {ReturnType<typeof allChains>[number]} BoardChain a chain as allChains() lists it */
export const chainById = (/** @type {Settings | undefined} */ settings, /** @type {unknown} */ id) => allChains(settings).find((c) => c.id === Number(id)) ?? null;

export const explorerUrl = (/** @type {{ explorer?: string } | null | undefined} */ chain, /** @type {string} */ kind, /** @type {unknown} */ id, explorer = chain?.explorer) => (explorer && id ? `${explorer}/${kind}/${id}` : null);

const isUrl = (/** @type {string} */ s) => /^https?:\/\/\S+$/i.test(s);
// One address, or several separated by spaces or commas.
export const isNodeUrl = (/** @type {unknown} */ s) => nodeUrls(s).length > 0 && nodeUrls(s).every(isUrl);
export const isExplorerUrl = (/** @type {unknown} */ s) => isUrl(String(s ?? '').trim());

// Asks a node which chain it serves, and how far it has got. Given several, the first that answers says.
/** @param {string} node */
export async function testNode(node) {
  const [id, head] = await Promise.all([rpc(node, 'eth_chainId', []), rpc(node, 'eth_blockNumber', [])]);
  return { chainId: Number(id), block: Number(head) };
}

// Tests every node of a list on its own: { url, chainId, block, ms } or { url, error }.
export const testNodes = (/** @type {string} */ node) => Promise.all(nodeUrls(node).map(async (url) => {
  const start = performance.now();
  try {
    return { url, ...(await testNode(url)), ms: Math.round(performance.now() - start) };
  } catch (err) {
    return { url, error: /** @type {Error} */ (err).message || 'No answer' };
  }
}));
