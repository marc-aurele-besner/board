// Settings → Blockchains: the chains the board reads, the nodes and explorers of each, and chains added by hand.
import { h, icon, notice } from '../ui.js';
import { allChains, customChains, isNodeUrl, isExplorerUrl, testNode, testNodes, etherscanKey } from '../chains.js';
import { nodeUrls } from '../uniswap.js';
import { logo } from './positions.js';

const COLLECTION = 'settings';
// The last message, each chain's last node test (chainId -> { ok, text }, busy while it runs), and the address
// fields changed but not saved yet (field name -> values).
const chainsView = { message: '', ok: null, tests: {}, drafts: {} };

const say = (ok, message) => Object.assign(chainsView, { ok, message });

// Tests each node of the chain on its own, so one that does not answer, or serves another chain, is named.
async function runTest(store, chain, node) {
  chainsView.tests[chain.id] = { busy: true, text: 'Testing…' };
  store.refresh();
  const results = await testNodes(node);
  const problem = (r) => (r.error ? r.error : r.chainId !== chain.id ? `serves chain ${r.chainId}, not ${chain.id}` : '');
  const good = results.filter((r) => !problem(r));
  const block = Math.max(0, ...good.map((r) => r.block));
  const fastest = good.reduce((a, r) => (!a || r.ms < a.ms ? r : a), null);
  const head = good.length
    ? `${results.length > 1 ? `${good.length} of ${results.length} nodes answer · ` : ''}Block ${block.toLocaleString()}${results.length > 1 ? ` · fastest ${fastest.ms} ms` : ''}`
    : results.length > 1 ? 'No node answers' : problem(results[0]);
  chainsView.tests[chain.id] = {
    ok: good.length === results.length,
    text: head,
    failed: results.length > 1 ? results.filter(problem).map((r) => `${r.url}: ${problem(r)}`) : [],
  };
  store.refresh();
}

// Saved as one line of addresses separated by spaces. Explorers lose a trailing slash, as links add their own.
const nodeList = (values) => nodeUrls([values].flat().join(' ')).join(' ');
const explorerList = (values) => nodeUrls([values].flat().join(' ')).map((u) => u.replace(/\/+$/, '')).join(' ');

// One field per address, a remove button beside each and an add button under them. Fields are added and removed
// in place, and what they hold is kept in chainsView.drafts, so a re-render (a test, a background save) keeps them.
function urlGroup({ name, values, label, what, placeholder, link = false }) {
  const group = h('div', { class: 'url-group', role: 'group', 'aria-label': label });
  const remember = () => {
    chainsView.drafts[name] = [...group.querySelectorAll('input')].map((input) => input.value);
  };
  const field = (value) => {
    const open = link ? h('a', { class: 'icon-btn', target: '_blank', rel: 'noopener', title: `Open this ${what}`, 'aria-label': `Open this ${what}` }, icon('globe')) : null;
    const point = (v) => {
      if (!open) return;
      const url = String(v ?? '').trim();
      open.hidden = !isExplorerUrl(url);
      open.href = open.hidden ? '#' : url;
    };
    const input = h('input', { name, value, placeholder, spellcheck: false, 'aria-label': label, oninput: (e) => {
      point(e.currentTarget.value);
      remember();
    } });
    point(value);
    const row = h('div', { class: 'url-field' }, input, open,
      h('button', { type: 'button', class: 'icon-btn', title: `Remove this ${what}`, 'aria-label': `Remove this ${what}`, onclick: () => {
        // The last field is emptied rather than removed, so there is always one to type in.
        if (group.querySelectorAll('.url-field').length > 1) row.remove();
        else {
          input.value = '';
          point('');
        }
        remember();
      } }, icon('x')));
    return row;
  };
  const add = h('button', { type: 'button', class: 'btn-small add-url', onclick: () => {
    const row = field('');
    add.before(row);
    remember();
    row.querySelector('input').focus();
  } }, icon('plus'), ` Add ${what}`);
  const shown = chainsView.drafts[name] ?? values;
  group.append(h('span', { class: 'url-group-label small' }, label), ...(shown.length ? shown : ['']).map(field), add);
  return group;
}

export function chainsCard(store) {
  const settings = store.get(COLLECTION);
  const chains = allChains(settings);

  // Built-in nodes, explorers and LP switches go where the LP tab reads them; a custom chain keeps its own on its entry.
  // A built-in chain left on its public nodes or its own explorer saves nothing, so it keeps following them.
  const saveAll = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const nodes = (c) => nodeList(form.getAll(`node-${c.id}`));
    const explorers = (c) => explorerList(form.getAll(`explorer-${c.id}`));
    const badNodes = chains.filter((c) => (nodes(c) ? !isNodeUrl(nodes(c)) : !c.builtin));
    const badExplorers = chains.filter((c) => explorers(c) && !isNodeUrl(explorers(c)));
    if (badNodes.length || badExplorers.length) {
      const names = [...new Set([...badNodes, ...badExplorers].map((c) => c.name))];
      say(false, `Addresses start with https://, and every added chain needs a node. Check: ${names.join(', ')}.`);
      store.refresh();
      return;
    }
    store.update(COLLECTION, (d) => {
      const lp = {};
      for (const c of chains.filter((x) => x.builtin)) {
        const node = nodes(c);
        const explorer = explorers(c);
        lp[c.id] = {
          enabled: form.get(`on-${c.id}`) === 'on',
          node: node === nodeList(c.rpc) ? '' : node,
          explorer: explorer === explorerList(c.defaultExplorer) ? '' : explorer,
        };
      }
      // node: '' drops the Ethereum-only field kept from before the chains list.
      d.uniswap = { wallets: [], ...d.uniswap, chains: lp, node: '' };
      d.blockchains = { ...d.blockchains, custom: customChains(d).map((c) => ({ ...c, rpc: nodes(c) || c.rpc, explorer: explorers(c) })) };
    });
    chainsView.drafts = {};
    say(true, 'Chains saved.');
    store.refresh();
  };

  // A chain added by hand. Its ID is read from the nodes when left empty, and checked against them otherwise.
  const addChain = async (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const name = String(form.get('name') ?? '').trim();
    const rpc = nodeList(form.getAll('rpc'));
    const explorer = explorerList(form.getAll('explorer'));
    const symbol = String(form.get('symbol') ?? '').trim().toUpperCase();
    let id = Number(String(form.get('id') ?? '').trim() || 0);
    const fail = (text) => {
      say(false, text);
      store.refresh();
    };
    if (!name) return fail('Give the chain a name.');
    if (!isNodeUrl(rpc)) return fail('Add at least one node. Node addresses start with https://.');
    if (explorer && !isNodeUrl(explorer)) return fail('Explorer addresses start with https://.');
    try {
      const { chainId } = await testNode(rpc);
      if (id && id !== chainId) return fail(`That node serves chain ${chainId}, not ${id}.`);
      id = chainId;
    } catch (err) {
      if (!id) return fail(`No node answered, so the chain ID is needed. ${err.message}`);
    }
    const taken = chains.find((c) => c.id === id);
    if (taken) return fail(`Chain ${id} is already in the list, as ${taken.name}.`);
    store.update(COLLECTION, (d) => {
      d.blockchains = { ...d.blockchains, custom: [...customChains(d), { id, name, rpc, explorer, symbol: symbol || 'ETH' }] };
    });
    delete chainsView.drafts.rpc;
    delete chainsView.drafts.explorer;
    e.target.reset();
    say(true, `${name} added, chain ${id}.`);
    store.refresh();
  };

  const removeChain = (c) => {
    store.update(COLLECTION, (d) => {
      d.blockchains = { ...d.blockchains, custom: customChains(d).filter((x) => x.id !== c.id) };
    });
    delete chainsView.tests[c.id];
    delete chainsView.drafts[`node-${c.id}`];
    delete chainsView.drafts[`explorer-${c.id}`];
    say(true, `${c.name} removed.`);
    store.refresh();
  };

  const row = (c) => {
    const test = chainsView.tests[c.id];
    return h('li', { class: 'chain-item' },
      h('span', { class: 'chain-who' },
        logo(c.logo, c.name, 'sm'),
        h('span', { class: 'chain-label' },
          h('strong', null, c.name),
          h('span', { class: 'muted small' }, `ID ${c.id} · ${c.symbol}`, c.builtin ? '' : ' · added'))),
      h('div', { class: 'chain-fields' },
        urlGroup({ name: `node-${c.id}`, values: nodeUrls(c.node), label: `${c.name} nodes`, what: 'node', placeholder: c.builtin ? 'Empty: the public nodes' : 'https://…' }),
        urlGroup({ name: `explorer-${c.id}`, values: c.explorers, label: `${c.name} explorers`, what: 'explorer', placeholder: c.builtin && c.defaultExplorer ? `Empty: ${c.defaultExplorer}` : 'https://… (optional)', link: true })),
      h('span', { class: 'chain-tools' },
        c.builtin
          ? h('label', { class: 'check small', title: 'Read by the Liquidity Pools tab' }, h('input', { type: 'checkbox', name: `on-${c.id}`, checked: c.lp }), 'LP')
          : null,
        h('button', { type: 'button', class: 'btn-small', disabled: test?.busy, onclick: (e) => {
          const typed = nodeList([...e.currentTarget.closest('li').querySelectorAll(`input[name="node-${c.id}"]`)].map((input) => input.value));
          runTest(store, c, typed || c.node);
        } }, 'Test'),
        c.builtin ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Remove chain', 'aria-label': `Remove ${c.name}`, onclick: () => removeChain(c) }, icon('trash'))),
      test ? h('span', { class: `chain-test small ${test.busy ? 'muted' : test.ok ? 'ok' : 'bad'}` }, test.text,
        ...(test.failed ?? []).map((line) => h('span', { class: 'chain-test-node' }, line))) : null);
  };

  // Saved under blockchains; the copy kept under uniswap from before is dropped.
  const saveEtherscan = (e) => {
    e.preventDefault();
    const key = String(new FormData(e.currentTarget).get('etherscan') ?? '').trim();
    store.update(COLLECTION, (d) => {
      d.blockchains = { ...d.blockchains, etherscan: key };
      if (d.uniswap) delete d.uniswap.etherscan;
    });
    say(true, key ? 'Etherscan key saved.' : 'Etherscan key removed.');
    store.refresh();
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Blockchains'),
    h('p', { class: 'muted small' }, 'The chains the board reads, for Liquidity Pools and smart contracts. A node is a JSON-RPC address a chain is read from. With several, reads go to the one answering fastest, spread across them, and move off a node that fails or stops answering. Built-in chains start with several public nodes and their usual explorer; empty the fields to go back to them. Links open in the first explorer. LP marks the chains the Liquidity Pools tab reads. Test asks each node for its chain ID and latest block.'),
    h('form', { class: 'stack', onsubmit: saveAll },
      h('ul', { class: 'chain-list' }, chains.map(row)),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn-small' }, 'Save chains'))),
    h('h3', null, 'Add a chain'),
    h('p', { class: 'muted small' }, 'Any EVM chain with a JSON-RPC node. Leave the chain ID empty to read it from the nodes.'),
    h('form', { class: 'stack', onsubmit: addChain },
      h('div', { class: 'row' },
        h('input', { name: 'name', placeholder: 'Name', 'aria-label': 'Chain name' }),
        h('input', { name: 'id', placeholder: 'Chain ID', inputmode: 'numeric', 'aria-label': 'Chain ID' }),
        h('input', { name: 'symbol', placeholder: 'Coin (ETH)', 'aria-label': 'Native coin symbol' })),
      urlGroup({ name: 'rpc', values: [], label: 'Nodes', what: 'node', placeholder: 'https://…' }),
      urlGroup({ name: 'explorer', values: [], label: 'Explorers (optional)', what: 'explorer', placeholder: 'https://…', link: true }),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn-small' }, 'Add chain'))),
    h('h3', null, 'Etherscan API key'),
    h('p', { class: 'muted small' }, 'Optional, free at etherscan.io. It covers most chains by their ID. Smart contracts uses it to fetch verified ABIs and to list transactions sent to a contract. Fees collected uses it to read each wallet\'s collect transactions, as Etherscan keeps every block where public nodes keep only recent ones. The addresses read and the key are sent to Etherscan.'),
    h('form', { class: 'row', onsubmit: saveEtherscan },
      h('input', { name: 'etherscan', type: 'password', value: etherscanKey(store.get(COLLECTION)), placeholder: 'Etherscan API key', autocomplete: 'off', spellcheck: false, 'aria-label': 'Etherscan API key' }),
      h('button', { type: 'submit', class: 'btn-small' }, 'Save key')),
    chainsView.message ? notice({ tone: chainsView.ok ? 'info' : 'error', text: chainsView.message }) : null);
}
