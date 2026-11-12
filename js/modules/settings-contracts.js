// Settings → Smart contracts: the contracts Tools reads and writes and Monitoring follows, each with its chain,
// address and ABI.
import { h, icon, notice, copyable, uid } from '../ui.js';
import { allChains, chainById, explorerUrl } from '../chains.js';
import { parseAbi, readsOf, writesOf, eventsOf } from '../abi.js';
import { contractsOf, etherscanKey, fetchAbi } from '../contracts.js';
import { logo } from './positions.js';
import { projectIcon } from './projects.js';
import { pickChip } from '../inline.js';
/** @import { Store, Settings, Contract, AbiItem } from '../../types/data' */

const COLLECTION = 'settings';
// editing: the contract in the form ('' for a new one, null when the form is closed). busy: an ABI fetch running.
// draft: what the form holds, kept here because a redraw (a pick, an error, a fetch) would otherwise reset it.
/** @typedef {{ label: string, address: string, chainId: number, projectId: string, abi: string }} ContractDraft */
/** @type {{ editing: string | null, message: string, ok: boolean | null, busy: boolean, draft: ContractDraft }} */
const contractsView = { editing: null, message: '', ok: null, busy: false, draft: /** @type {ContractDraft} */ ({}) }; // edit() fills it before the form opens
const draftOf = (/** @type {Contract | undefined} */ c) => ({ label: c?.label ?? '', address: c?.address ?? '', chainId: c?.chainId ?? 1, projectId: c?.projectId ?? '', abi: c?.abi?.length ? JSON.stringify(c.abi, null, 2) : '' });
const keep = (/** @type {'label' | 'address' | 'abi'} */ key) => (/** @type {Event & { currentTarget: HTMLInputElement | HTMLTextAreaElement }} */ e) => {
  contractsView.draft[key] = e.currentTarget.value;
};

const say = (/** @type {Store} */ store, /** @type {boolean | null} */ ok, /** @type {string} */ message) => {
  Object.assign(contractsView, { ok, message });
  store.refresh();
};

const counts = (/** @type {AbiItem[]} */ abi) => {
  const parts = /** @type {[number, string][]} */ ([[readsOf(abi).length, 'read'], [writesOf(abi).length, 'write'], [eventsOf(abi).length, 'event']])
    .filter(([n]) => n)
    .map(([n, what]) => `${n} ${what}${n === 1 ? '' : 's'}`);
  return parts.length ? parts.join(' · ') : 'No ABI';
};

/** @param {Store} store @param {Settings} settings */
function contractForm(store, settings) {
  const editing = contractsOf(settings).find((c) => c.id === contractsView.editing) ?? null;
  const draft = contractsView.draft;
  const chains = allChains(settings);
  const projects = store.get('projects').projects ?? [];

  const save = (/** @type {SubmitEvent} */ e) => {
    e.preventDefault();
    const label = draft.label.trim();
    const address = draft.address.trim();
    const chainId = Number(draft.chainId);
    const abiText = draft.abi.trim();
    if (!label) return say(store, false, 'Give the contract a name.');
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return say(store, false, 'That is not a contract address. It starts with 0x and has 40 hex characters.');
    /** @type {AbiItem[]} */
    let abi = [];
    if (abiText) {
      try {
        abi = parseAbi(abiText);
      } catch (err) {
        return say(store, false, `The ABI is not valid JSON: ${/** @type {Error} */ (err).message}`);
      }
    }
    const dupe = contractsOf(settings).find((c) => c.id !== editing?.id && c.chainId === chainId && c.address.toLowerCase() === address.toLowerCase());
    if (dupe) return say(store, false, `That contract is already saved, as ${dupe.label}.`);
    const entry = { id: editing?.id ?? uid(), label, chainId, address, projectId: draft.projectId, abi };
    store.update(COLLECTION, (d) => {
      const list = contractsOf(d);
      d.contracts = editing ? list.map((c) => (c.id === editing.id ? entry : c)) : [...list, entry];
    });
    contractsView.editing = null;
    say(store, true, editing ? `${label} saved.` : `${label} added. Open Tools → Contracts to use it.`);
  };

  // Fills the ABI field from Etherscan, for the chain and address typed in the form.
  const fetchInto = async () => {
    const address = draft.address.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return say(store, false, 'Type the contract address first.');
    contractsView.busy = true;
    say(store, true, 'Fetching the ABI from Etherscan…');
    try {
      const abi = await fetchAbi(etherscanKey(settings), Number(draft.chainId), address);
      draft.abi = JSON.stringify(abi, null, 2);
      contractsView.busy = false;
      say(store, true, `ABI fetched: ${counts(abi)}. Save to keep it.`);
    } catch (err) {
      contractsView.busy = false;
      say(store, false, /** @type {Error} */ (err).message);
    }
  };

  return h('form', { class: 'stack contract-form', onsubmit: save },
    h('h3', null, editing ? `Edit ${editing.label}` : 'Add a contract'),
    h('div', { class: 'row' },
      h('input', { name: 'label', value: draft.label, oninput: keep('label'), placeholder: 'Name', 'aria-label': 'Contract name' }),
      pickChip({
        value: draft.chainId,
        className: 'field-pick',
        placeholder: 'Chain',
        options: chains.map((c) => ({ value: c.id, label: c.name, plainIcon: () => logo(c.logo, c.name, 'xs') })),
        onPick: (id) => {
          draft.chainId = id;
          store.refresh();
        },
      }),
      pickChip({
        value: draft.projectId || null,
        className: 'field-pick',
        nullable: true,
        nullLabel: 'No project',
        options: [...projects].sort((a, b) => a.name.localeCompare(b.name)).map((p) => ({ value: p.id, label: p.name, plainIcon: () => projectIcon(p) })),
        onPick: (id) => {
          draft.projectId = id ?? '';
          store.refresh();
        },
      })),
    h('input', { name: 'address', value: draft.address, oninput: keep('address'), placeholder: 'Contract address 0x…', spellcheck: false, 'aria-label': 'Contract address' }),
    h('textarea', { name: 'abi', rows: 8, spellcheck: false, placeholder: 'ABI as JSON: [{"type":"function","name":"balanceOf",…}]. A Hardhat or Foundry artifact works too.', 'aria-label': 'Contract ABI', oninput: keep('abi') },
      draft.abi),
    h('div', { class: 'row' },
      h('button', { type: 'submit', class: 'btn-small primary' }, editing ? 'Save contract' : 'Add contract'),
      h('button', { type: 'button', class: 'btn-small', disabled: contractsView.busy, title: 'Needs the Etherscan API key set in Settings → Blockchains', onclick: fetchInto }, contractsView.busy ? 'Fetching…' : 'Fetch ABI from Etherscan'),
      h('button', { type: 'button', class: 'btn-small', onclick: () => {
        contractsView.editing = null;
        say(store, null, '');
      } }, 'Cancel')));
}

/** @param {Store} store */
export function contractsCard(store) {
  const settings = store.get(COLLECTION);
  const list = contractsOf(settings);
  const projects = new Map((store.get('projects').projects ?? []).map((p) => [p.id, p.name]));

  const remove = (/** @type {Contract} */ c) => {
    store.update(COLLECTION, (d) => {
      d.contracts = contractsOf(d).filter((x) => x.id !== c.id);
    });
    if (contractsView.editing === c.id) contractsView.editing = null;
    say(store, true, `${c.label} removed.`);
  };
  const edit = (/** @type {string} */ id) => {
    const c = list.find((x) => x.id === id);
    Object.assign(contractsView, { editing: id, draft: draftOf(c) });
    say(store, null, '');
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Smart contracts'),
    h('p', { class: 'muted small' }, 'Contracts to read and write in Tools → Contracts, and to follow in Monitoring → Contracts. Reads go through the chain\'s node, set in Blockchains. Writes are signed by your browser wallet, which asks before every transaction; the board never holds a key. Paste the ABI, or fetch a verified one from Etherscan with the key set in Blockchains.'),
    list.length
      ? h('ul', { class: 'contract-list' }, list.map((c) => {
        const chain = chainById(settings, c.chainId);
        const url = explorerUrl(chain, 'address', c.address);
        return h('li', { class: 'contract-item' },
          h('span', { class: 'chain-who' },
            logo(chain?.logo, chain?.name ?? String(c.chainId), 'sm'),
            h('span', { class: 'chain-label' },
              h('strong', null, c.label),
              h('span', { class: 'muted small' }, [chain?.name ?? `Chain ${c.chainId} (not set up)`, projects.get(c.projectId), counts(c.abi ?? [])].filter(Boolean).join(' · ')))),
          h('span', { class: 'contract-address' }, copyable(c.address, { label: `${c.address.slice(0, 6)}…${c.address.slice(-4)}` })),
          h('span', { class: 'chain-tools' },
            url ? h('a', { class: 'icon-btn', href: url, target: '_blank', rel: 'noopener', title: 'Open in the block explorer', 'aria-label': `Open ${c.label} in the block explorer` }, icon('globe')) : null,
            h('button', { type: 'button', class: 'icon-btn', title: 'Edit', 'aria-label': `Edit ${c.label}`, onclick: () => edit(c.id) }, icon('pencil')),
            h('button', { type: 'button', class: 'icon-btn', title: 'Remove', 'aria-label': `Remove ${c.label}`, onclick: () => remove(c) }, icon('trash'))));
      }))
      : h('p', { class: 'muted small' }, 'No contracts yet.'),
    contractsView.editing === null
      ? h('div', null, h('button', { type: 'button', class: 'btn-small', onclick: () => edit('') }, icon('plus'), 'Add contract'))
      : contractForm(store, settings),
    contractsView.message ? notice({ tone: contractsView.ok === false ? 'error' : 'info', text: contractsView.message }) : null);
}
