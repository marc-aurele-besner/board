// Tools → Contracts: call a saved contract's view functions through the chain's node, and send its other functions
// as transactions through the browser wallet.
import { h, icon, empty, notice, copyable } from '../ui.js';
import { chainById, explorerUrl } from '../chains.js';
import { readsOf, writesOf, parseInput, parseUnits, show, signature, isPayable } from '../abi.js';
import { contractsOf, readFunction, sendFunction, waitForReceipt, wallets, walletAccount, connectedWallet, connectWallet, disconnectWallet, onWalletChange } from '../contracts.js';
import { logo } from './positions.js';
import { numberLocale } from '../locale.js';
/** @import { Store, Settings, Contract, AbiItem } from '../../types/data' */
/** @import { AbiValue } from '../../types/abi' */
/** @import { Eip6963ProviderInfo } from '../../types/wallet' */
/** @import { BoardChain } from '../chains.js' */

// contract: the one shown. results: "contractId:signature" -> { busy, ok, value | error | hash, receipt }.
// inputs: what was typed in each function's fields when it was last run, so a failed call keeps them.
// picking: the wallet list is open, when several wallets are installed.
/** @typedef {{ busy?: boolean, ok?: boolean, value?: AbiValue[], error?: string, hash?: string, note?: string }} FnResult */
/** @typedef {HTMLFormElement & { elements: HTMLFormControlsCollection & Record<string, HTMLInputElement | undefined> }} FnForm a function's form: its fields by name */
/** @type {{ contract: string, results: Record<string, FnResult>, inputs: Record<string, Record<string, string>>, walletError: string, picking: boolean }} */
const view = { contract: '', results: {}, inputs: {}, walletError: '', picking: false };

const short = (/** @type {string} */ a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const keyOf = (/** @type {Contract} */ c, /** @type {AbiItem} */ fn) => `${c.id}:${signature(fn)}`;

// Keeps a function's typed fields, then reads them as arguments.
/** @param {string} key @param {FnForm} form */
function remember(key, form) {
  // Its controls are inputs and buttons, which all have a name and a value.
  view.inputs[key] = Object.fromEntries([.../** @type {Iterable<HTMLInputElement | HTMLButtonElement>} */ (form.elements)].filter((el) => el.name).map((el) => [el.name, el.value]));
}

/** @param {Store} store @param {string} key @param {FnResult} result */
function setResult(store, key, result) {
  view.results[key] = result;
  store.refresh();
}

// The inputs of a function, read from its form. Throws with the first field that does not parse.
/** @param {FnForm} form @param {AbiItem} fn */
function argsOf(form, fn) {
  return (fn.inputs ?? []).map((p, i) => parseInput(p, form.elements[`arg-${i}`]?.value));
}

/** @param {Store} store @param {Settings} settings @param {Contract} c @param {AbiItem} fn @param {FnForm} form */
async function call(store, settings, c, fn, form) {
  const key = keyOf(c, fn);
  remember(key, form);
  let args;
  try {
    args = argsOf(form, fn);
  } catch (err) {
    return setResult(store, key, { ok: false, error: /** @type {Error} */ (err).message });
  }
  setResult(store, key, { busy: true });
  try {
    const value = await readFunction(settings, c, fn, args);
    setResult(store, key, { ok: true, value });
  } catch (err) {
    setResult(store, key, { ok: false, error: /** @type {Error} */ (err).message });
  }
}

/** @param {Store} store @param {Settings} settings @param {Contract} c @param {AbiItem} fn @param {FnForm} form */
async function send(store, settings, c, fn, form) {
  const key = keyOf(c, fn);
  remember(key, form);
  let args;
  let value = 0n;
  try {
    args = argsOf(form, fn);
    if (isPayable(fn)) value = parseUnits(form.elements.value?.value);
  } catch (err) {
    return setResult(store, key, { ok: false, error: /** @type {Error} */ (err).message });
  }
  setResult(store, key, { busy: true, note: 'Confirm in your wallet…' });
  try {
    const hash = await sendFunction(settings, c, fn, args, value);
    setResult(store, key, { busy: true, hash, note: 'Sent. Waiting for it to land…' });
    const receipt = await waitForReceipt(settings, c, hash);
    setResult(store, key, receipt ? { ok: receipt.ok, hash, note: receipt.ok ? `Confirmed in block ${receipt.block.toLocaleString(numberLocale())}.` : `Reverted in block ${receipt.block.toLocaleString(numberLocale())}.` } : { ok: true, hash, note: 'Sent. Not landed after five minutes; check the explorer.' });
  } catch (err) {
    // A wallet's refusal carries an EIP-1193 code.
    setResult(store, key, { ok: false, error: /** @type {{ code?: number } | undefined} */ (err)?.code === 4001 ? 'Rejected in the wallet.' : /** @type {Error} */ (err).message });
  }
}

// One labelled value per output; a single unnamed output shows bare.
/** @param {AbiItem} fn @param {AbiValue[]} value */
function outputView(fn, value) {
  const outs = fn.outputs ?? [];
  if (outs.length === 1 && !outs[0].name) return h('code', { class: 'fn-value' }, show(value[0]));
  return h('dl', { class: 'fn-outputs' }, outs.map((o, i) => [
    h('dt', null, o.name || `#${i}`, h('span', { class: 'muted' }, ` ${o.type}`)),
    h('dd', null, h('code', { class: 'fn-value' }, show(value[i]))),
  ]));
}

/** @param {BoardChain | null} chain @param {AbiItem} fn @param {FnResult | undefined} r */
function resultView(chain, fn, r) {
  if (!r) return null;
  const tx = r.hash ? explorerUrl(chain, 'tx', r.hash) : null;
  return h('div', { class: `fn-result ${r.ok === false ? 'bad' : ''}` },
    r.busy && !r.hash ? h('span', { class: 'muted small' }, r.note ?? 'Calling…') : null,
    r.error ? h('span', { class: 'small' }, r.error) : null,
    r.value ? outputView(fn, r.value) : null,
    r.hash ? h('span', { class: 'small' }, r.note, ' ', tx ? h('a', { href: tx, target: '_blank', rel: 'noopener' }, short(r.hash)) : copyable(r.hash, { label: short(r.hash) })) : null);
}

/** @param {Store} store @param {Settings} settings @param {Contract} c @param {BoardChain | null} chain @param {AbiItem} fn @param {boolean} write */
function fnCard(store, settings, c, chain, fn, write) {
  const key = keyOf(c, fn);
  const r = view.results[key];
  const typed = view.inputs[key] ?? {};
  const inputs = fn.inputs ?? [];
  const payable = write && isPayable(fn);
  const outs = (fn.outputs ?? []).map((o) => o.type).join(', ');
  return h('details', { class: 'fn-card', open: Boolean(r) || (!write && !inputs.length) ? true : null },
    h('summary', null,
      h('span', { class: 'fn-name' }, fn.name),
      h('span', { class: 'muted small' }, `(${inputs.map((p) => `${p.type}${p.name ? ` ${p.name}` : ''}`).join(', ')})`, outs ? ` → ${outs}` : '', payable ? ' · payable' : '')),
    h('form', {
      class: 'stack fn-form',
      onsubmit: (/** @type {SubmitEvent & { currentTarget: FnForm }} */ e) => {
        e.preventDefault();
        (write ? send : call)(store, settings, c, fn, e.currentTarget);
      },
    },
    inputs.map((p, i) => h('label', null,
      h('span', null, p.name || `#${i}`, h('span', { class: 'muted' }, ` ${p.type}`)),
      h('input', { name: `arg-${i}`, value: typed[`arg-${i}`] ?? '', placeholder: /\[|tuple/.test(p.type) ? 'JSON, like [1, 2]' : p.type, spellcheck: false, autocomplete: 'off' }))),
    payable ? h('label', null, h('span', null, `Value in ${chain?.symbol ?? 'ETH'}`), h('input', { name: 'value', value: typed.value ?? '', placeholder: '0.0', inputmode: 'decimal', autocomplete: 'off' })) : null,
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: write ? 'btn-small primary' : 'btn-small', disabled: r?.busy || (write && !walletAccount()), title: write && !walletAccount() ? 'Connect a wallet to send' : null }, write ? 'Send' : inputs.length ? 'Call' : 'Read'),
      resultView(chain, fn, r))));
}

// Wallet extensions announce themselves after the page loads, and an account can change in the wallet, so the
// tab redraws on either while its writes are shown.
let watching = false;
/** @param {Store} store */
function watchWallets(store) {
  if (watching) return;
  watching = true;
  onWalletChange(() => {
    if (document.querySelector('.fn-writes')) store.refresh();
  });
}

/** @param {Store} store @param {BoardChain | null} chain */
function walletBar(store, chain) {
  watchWallets(store);
  const list = wallets();
  if (!list.length) return notice({ tone: 'info', text: 'Writes need a browser wallet, such as MetaMask, Rabby, Coinbase Wallet or Brave Wallet. Reads work without one.' });
  const account = walletAccount();
  const connect = async (/** @type {string} */ uuid) => {
    view.picking = false;
    try {
      await connectWallet(uuid);
      view.walletError = '';
    } catch (err) {
      view.walletError = /** @type {{ code?: number } | undefined} */ (err)?.code === 4001 ? 'Connection rejected in the wallet.' : /** @type {Error} */ (err).message;
    }
    store.refresh();
  };
  const disconnect = () => {
    disconnectWallet();
    store.refresh();
  };
  const pick = () => {
    view.picking = !view.picking;
    view.walletError = '';
    store.refresh();
  };
  const info = connectedWallet();
  return h('div', { class: 'stack' },
    h('div', { class: 'row wallet-connect' },
      info ? logo(info.icon, info.name, 'xs') : icon('wallet'),
      account
        ? h('span', { class: 'small' }, `${/** @type {Eip6963ProviderInfo} */ (info).name} `, copyable(account, { label: short(account) }), ` · writes are sent on ${chain?.name ?? 'the contract\'s chain'}, and the wallet asks before each one.`)
        : h('span', { class: 'small muted' }, 'Connect a wallet to send writes.'),
      account
        ? h('button', { type: 'button', class: 'btn-small', onclick: disconnect }, 'Disconnect')
        : h('button', { type: 'button', class: 'btn-small primary', 'aria-expanded': list.length > 1 ? String(Boolean(view.picking)) : null, onclick: () => (list.length > 1 ? pick() : connect(list[0].info.uuid)) }, view.picking ? 'Cancel' : 'Connect wallet'),
      view.walletError ? h('span', { class: 'small bad' }, view.walletError) : null),
    !account && view.picking
      ? h('div', { class: 'chips wallet-pick', role: 'group', 'aria-label': 'Wallet' }, list.map((w) => h('button', { type: 'button', class: 'chip', onclick: () => connect(w.info.uuid) }, logo(w.info.icon, w.info.name, 'xs'), w.info.name)))
      : null);
}

/** @param {Store} store */
export function contractsTab(store) {
  const settings = store.get('settings');
  const list = contractsOf(settings);
  if (!list.length) {
    return h('div', { class: 'card stack' },
      empty('No smart contracts yet. Add one with its chain, address and ABI in Settings.'),
      h('div', null, h('a', { href: '#/settings?section=contracts', class: 'btn-link' }, 'Open Settings → Smart contracts')));
  }
  const c = list.find((x) => x.id === view.contract) ?? list[0];
  const chain = chainById(settings, c.chainId);
  const reads = readsOf(c.abi ?? []);
  const writes = writesOf(c.abi ?? []);
  const url = explorerUrl(chain, 'address', c.address);
  const readAll = () => {
    for (const form of /** @type {NodeListOf<HTMLFormElement>} */ (document.querySelectorAll('.fn-reads .fn-form'))) if (!form.querySelector('input')) form.requestSubmit();
  };

  return h('div', { class: 'stack-lg' },
    list.length > 1
      ? h('div', { class: 'chips', role: 'group', 'aria-label': 'Contract' }, list.map((x) => {
        const xc = chainById(settings, x.chainId);
        return h('button', {
          type: 'button',
          class: x.id === c.id ? 'chip active' : 'chip',
          'aria-pressed': String(x.id === c.id),
          onclick: () => {
            view.contract = x.id;
            store.refresh();
          },
        }, logo(xc?.logo, xc?.name ?? String(x.chainId), 'xs'), x.label);
      }))
      : null,
    h('section', { class: 'card stack' },
      h('header', { class: 'row between' },
        h('div', { class: 'chain-who' },
          logo(chain?.logo, chain?.name ?? String(c.chainId), 'sm'),
          h('span', { class: 'chain-label' },
            h('strong', null, c.label),
            h('span', { class: 'muted small' }, chain?.name ?? `Chain ${c.chainId} is not set up in Settings → Blockchains`, ' · ', copyable(c.address, { label: short(c.address) })))),
        h('div', { class: 'row' },
          url ? h('a', { class: 'btn-small', href: url, target: '_blank', rel: 'noopener' }, icon('globe'), 'Explorer') : null,
          h('a', { class: 'btn-small', href: '#/settings?section=contracts' }, icon('pencil'), 'Edit'))),
      writes.length ? walletBar(store, chain) : null),
    !(c.abi ?? []).length ? notice({ tone: 'info', text: 'This contract has no ABI yet. Add one in Settings → Smart contracts to read and write it.' }) : null,
    reads.length
      ? h('section', { class: 'card stack fn-reads' },
        h('header', { class: 'row between' },
          h('h3', null, `Read · ${reads.length}`),
          reads.some((f) => !(f.inputs ?? []).length) ? h('button', { type: 'button', class: 'btn-small', onclick: readAll }, icon('refresh'), 'Read all') : null),
        reads.map((fn) => fnCard(store, settings, c, chain, fn, false)))
      : null,
    writes.length
      ? h('section', { class: 'card stack fn-writes' },
        h('h3', null, `Write · ${writes.length}`),
        writes.map((fn) => fnCard(store, settings, c, chain, fn, true)))
      : null);
}

export const contractsSerialize = () => view.contract;
export const contractsRestore = (/** @type {string | undefined} */ id) => {
  view.contract = id || '';
};
