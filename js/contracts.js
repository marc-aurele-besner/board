// Smart contracts saved in Settings → Smart contracts: reading them through the chain's node, sending
// transactions through the browser wallet (the board never holds a key), and reading their recent activity.
import { rpc, rpcCall, etherscan, nodeUrls } from './uniswap.js';
import { chainById, etherscanKey } from './chains.js';
import { encodeCall, decodeArgs, decodeLog, eventsOf, functionsOf, selector, parseAbi } from './abi.js';

export const contractsOf = (settings) => settings?.contracts ?? [];
export { etherscanKey };

// The verified ABI from Etherscan, which covers most chains by their ID.
export async function fetchAbi(key, chainId, address) {
  if (!key) throw new Error('Set an Etherscan API key in Settings → Blockchains to fetch ABIs.');
  return parseAbi(await etherscan(key, chainId, { module: 'contract', action: 'getabi', address }));
}

// One view function, called through the chain's node.
export async function readFunction(settings, contract, fn, args) {
  const chain = chainById(settings, contract.chainId);
  if (!chain) throw new Error(`Chain ${contract.chainId} is not in Settings → Blockchains.`);
  const out = await rpcCall(chain.node, contract.address, encodeCall(fn, args));
  if (out === '0x' && (fn.outputs ?? []).length) throw new Error('The call returned nothing. Is the address a contract on this chain?');
  return decodeArgs(fn.outputs ?? [], out);
}

// --- Browser wallets (EIP-1193, found through EIP-6963) ---

// Each wallet extension announces itself (EIP-6963), so several can sit side by side, each with its own name and
// icon. window.ethereum is only a fallback for a wallet that announces nothing: whichever extension set it is often
// one of the announced ones behind a proxy, and some (Phantom among them) set isMetaMask too, so listing it next to
// them showed an icon-less "MetaMask" that opened another wallet. uuid -> { info: { uuid, name, icon, rdns }, provider }.
const found = new Map();
const listeners = new Set();
const changed = () => listeners.forEach((fn) => fn());

// Wallets that also set isMetaMask are checked first.
function legacyName(p) {
  if (p.isPhantom) return 'Phantom';
  if (p.isRabby) return 'Rabby';
  if (p.isOkxWallet) return 'OKX Wallet';
  if (p.isTrust || p.isTrustWallet) return 'Trust Wallet';
  if (p.isCoinbaseWallet) return 'Coinbase Wallet';
  if (p.isBraveWallet) return 'Brave Wallet';
  if (p.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

if (globalThis.window?.addEventListener) {
  window.addEventListener('eip6963:announceProvider', (e) => {
    const { info, provider } = e.detail ?? {};
    if (!info?.uuid || !provider?.request) return;
    found.set(info.uuid, { info, provider });
    changed();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}

export function wallets() {
  const list = [...found.values()];
  const legacy = globalThis.ethereum;
  if (!list.length && legacy?.request) {
    list.push({ info: { uuid: 'injected', name: legacyName(legacy), icon: '', rdns: '' }, provider: legacy });
  }
  return list;
}

// Calls fn when a wallet is found or the connection changes. Returns the unsubscribe.
export function onWalletChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

// The wallet and account connected with the button, for this page load. Nothing asks a wallet before that click.
let current = null; // { info, provider, account }
export const walletAccount = () => current?.account ?? '';
export const connectedWallet = () => current?.info ?? null;
const wallet = () => current?.provider ?? null;

function onAccounts(accounts) {
  if (!current) return;
  if (accounts?.[0]) current.account = accounts[0];
  else disconnectWallet();
  changed();
}

export async function connectWallet(uuid) {
  const list = wallets();
  const w = list.find((x) => x.info.uuid === uuid) ?? (list.length === 1 ? list[0] : null);
  if (!w) throw new Error(list.length ? 'Pick a wallet to connect.' : 'No browser wallet found. Install one, such as MetaMask or Rabby, and reload.');
  const account = (await w.provider.request({ method: 'eth_requestAccounts' }))?.[0] ?? '';
  if (!account) throw new Error(`${w.info.name} shared no account.`);
  disconnectWallet();
  current = { info: w.info, provider: w.provider, account };
  w.provider.on?.('accountsChanged', onAccounts);
  changed();
  return account;
}

// Forgets the connection on the board's side; the wallet keeps its own permission until it is revoked there.
export function disconnectWallet() {
  current?.provider.removeListener?.('accountsChanged', onAccounts);
  current = null;
}

// Moves the wallet to the contract's chain, and adds the chain to it when it does not know it.
async function onChain(chain) {
  const chainId = `0x${chain.id.toString(16)}`;
  if ((await wallet().request({ method: 'eth_chainId' })) === chainId) return;
  try {
    await wallet().request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  } catch (err) {
    if (err?.code !== 4902) throw err;
    await wallet().request({
      method: 'wallet_addEthereumChain',
      params: [{ chainId, chainName: chain.name, rpcUrls: nodeUrls(chain.node), nativeCurrency: { name: chain.symbol, symbol: chain.symbol, decimals: 18 }, blockExplorerUrls: chain.explorer ? [chain.explorer] : undefined }],
    });
  }
}

// Sends one transaction; the wallet shows it and asks before signing. Returns its hash.
export async function sendFunction(settings, contract, fn, args, value = 0n) {
  const chain = chainById(settings, contract.chainId);
  if (!chain) throw new Error(`Chain ${contract.chainId} is not in Settings → Blockchains.`);
  if (!wallet()) throw new Error('Connect a wallet first.');
  const from = walletAccount();
  await onChain(chain);
  const tx = { from, to: contract.address, data: encodeCall(fn, args) };
  if (value) tx.value = `0x${value.toString(16)}`;
  return wallet().request({ method: 'eth_sendTransaction', params: [tx] });
}

// Waits for a sent transaction to land, reading the node every few seconds for up to five minutes.
export async function waitForReceipt(settings, contract, hash) {
  const { node } = chainById(settings, contract.chainId);
  for (let i = 0; i < 100; i++) {
    const receipt = await rpc(node, 'eth_getTransactionReceipt', [hash]).catch(() => null);
    if (receipt) return { ok: receipt.status === '0x1', block: Number(receipt.blockNumber) };
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return null;
}

// --- Activity ---

const METHOD_NAMES = new WeakMap();
// selector -> function name, for a contract's ABI.
function methodNames(abi) {
  if (!METHOD_NAMES.has(abi)) METHOD_NAMES.set(abi, new Map(functionsOf(abi).map((f) => [selector(f), f.name])));
  return METHOD_NAMES.get(abi);
}

// How far back events are searched, how many blocks each search starts with, and how many events are kept.
// Public nodes refuse wide ranges and long answers, so a refused search is retried on fewer blocks; a busy
// contract stops at MAX_EVENTS, and eventsFrom says how far back that reached.
const MAX_BLOCKS = 100000;
const CHUNK = 5000;
const MAX_EVENTS = 2000;

// Transactions sent to the contract (from Etherscan, with a key) and the events it emitted (from the node, as far
// back as MAX_BLOCKS), inside [start, end). Event times are estimated from the block number.
export async function loadActivity(settings, contract, start, end) {
  const chain = chainById(settings, contract.chainId);
  if (!chain) throw new Error(`Chain ${contract.chainId} is not in Settings → Blockchains.`);
  const abi = contract.abi ?? [];
  const out = { txs: null, events: [], eventsFrom: null, errors: [] };

  const key = etherscanKey(settings);
  if (key) {
    try {
      const names = methodNames(abi);
      const rows = await etherscan(key, chain.id, { module: 'account', action: 'txlist', address: contract.address, startblock: '0', endblock: '99999999', page: '1', offset: '1000', sort: 'desc' });
      out.txs = rows
        .map((t) => ({
          hash: t.hash,
          from: t.from,
          at: Number(t.timeStamp) * 1000,
          method: names.get(String(t.input).slice(0, 10)) || t.functionName?.split('(')[0] || (t.input === '0x' ? 'transfer' : String(t.input).slice(0, 10)),
          failed: t.isError === '1',
        }))
        .filter((t) => t.at >= start && t.at < end);
    } catch (err) {
      out.errors.push(`Transactions: ${err.message}`);
    }
  }

  const events = eventsOf(abi);
  if (!events.length) return out;
  try {
    const head = Number(await rpc(chain.node, 'eth_blockNumber', []));
    const back = Math.max(0, head - 1000);
    const [a, b] = await Promise.all([head, back].map((n) => rpc(chain.node, 'eth_getBlockByNumber', [`0x${n.toString(16)}`, false])));
    const headAt = Number(a.timestamp) * 1000;
    const perBlock = Math.max(1, (headAt - Number(b.timestamp) * 1000) / Math.max(1, head - back));
    const timeOf = (n) => headAt - (head - n) * perBlock;
    const want = Math.max(0, head - Math.ceil((Date.now() - start) / perBlock));
    const floor = Math.max(want, head - MAX_BLOCKS);
    let to = head;
    let chunk = CHUNK;
    while (to >= floor && out.events.length < MAX_EVENTS) {
      const from = Math.max(floor, to - chunk + 1);
      let logs;
      try {
        logs = await rpc(chain.node, 'eth_getLogs', [{ address: contract.address, fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
      } catch (err) {
        if (!err.refused || chunk === 1) throw err;
        chunk = Math.max(1, Math.floor(chunk / 5));
        continue;
      }
      for (const log of logs) {
        const at = timeOf(Number(log.blockNumber));
        if (at < start || at >= end) continue;
        let decoded = null;
        try {
          decoded = decodeLog(events, log);
        } catch {
          /* a log that does not match its ABI entry shows by its topic */
        }
        out.events.push({ at, block: Number(log.blockNumber), hash: log.transactionHash, name: decoded?.event.name ?? `${String(log.topics?.[0]).slice(0, 10)}…`, decoded });
      }
      out.eventsFrom = timeOf(from);
      to = from - 1;
    }
    out.events.sort((x, y) => y.block - x.block);
    // One search can return far more than the cap; keep the newest, and say the rest was not counted.
    if (out.events.length > MAX_EVENTS) {
      out.events.length = MAX_EVENTS;
      out.eventsFrom = out.events.at(-1).at;
    }
  } catch (err) {
    out.errors.push(`Events: ${err.message}`);
  }
  return out;
}
