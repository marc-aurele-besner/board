// Settings → Blockchains: the chains the board reads, the node each is read from, and chains added by hand.
import { h, icon, notice } from '../ui.js';
import { allChains, customChains, isNodeUrl, isExplorerUrl, testNode, testNodes } from '../chains.js';
import { nodeUrls } from '../uniswap.js';
import { logo } from './positions.js';

const COLLECTION = 'settings';
// The last message, and each chain's last node test: chainId -> { ok, text } (busy while it runs).
const chainsView = { message: '', ok: null, tests: {} };

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

// Saved as one line of addresses separated by spaces; shown separated by commas.
const nodeList = (s) => nodeUrls(s).join(' ');
const shownList = (s) => nodeUrls(s).join(', ');

export function chainsCard(store) {
  const settings = store.get(COLLECTION);
  const chains = allChains(settings);

  // Built-in nodes and LP switches go where the LP tab reads them; a custom chain keeps its node on its own entry.
  const saveAll = (e) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const bad = chains.filter((c) => {
      const node = String(form.get(`node-${c.id}`) ?? '').trim();
      return node ? !isNodeUrl(node) : !c.builtin;
    });
    if (bad.length) {
      say(false, `Node addresses start with https:// and are separated by commas. Check: ${bad.map((c) => c.name).join(', ')}.`);
      store.refresh();
      return;
    }
    store.update(COLLECTION, (d) => {
      const lp = {};
      for (const c of chains.filter((x) => x.builtin)) lp[c.id] = { enabled: form.get(`on-${c.id}`) === 'on', node: nodeList(form.get(`node-${c.id}`)) };
      // node: '' drops the Ethereum-only field kept from before the chains list.
      d.uniswap = { wallets: [], ...d.uniswap, chains: lp, node: '' };
      d.blockchains = { ...d.blockchains, custom: customChains(d).map((c) => ({ ...c, rpc: nodeList(form.get(`node-${c.id}`) ?? c.rpc) })) };
    });
    say(true, 'Chains saved.');
    store.refresh();
  };

  // A chain added by hand. Its ID is read from the node when left empty, and checked against it otherwise.
  const addChain = async (e) => {
    e.preventDefault();
    const formEl = e.currentTarget;
    const form = new FormData(formEl);
    const name = String(form.get('name') ?? '').trim();
    const rpc = nodeList(form.get('rpc'));
    const explorer = String(form.get('explorer') ?? '').trim();
    const symbol = String(form.get('symbol') ?? '').trim().toUpperCase();
    let id = Number(String(form.get('id') ?? '').trim() || 0);
    const fail = (text) => {
      say(false, text);
      store.refresh();
    };
    if (!name) return fail('Give the chain a name.');
    if (!isNodeUrl(rpc)) return fail('Node addresses start with https:// and are separated by commas.');
    if (explorer && !isExplorerUrl(explorer)) return fail('The explorer address starts with https://.');
    try {
      const { chainId } = await testNode(rpc);
      if (id && id !== chainId) return fail(`That node serves chain ${chainId}, not ${id}.`);
      id = chainId;
    } catch (err) {
      if (!id) return fail(`The node did not answer, so the chain ID is needed. ${err.message}`);
    }
    const taken = chains.find((c) => c.id === id);
    if (taken) return fail(`Chain ${id} is already in the list, as ${taken.name}.`);
    store.update(COLLECTION, (d) => {
      d.blockchains = { ...d.blockchains, custom: [...customChains(d), { id, name, rpc, explorer, symbol: symbol || 'ETH' }] };
    });
    formEl.reset();
    say(true, `${name} added, chain ${id}.`);
    store.refresh();
  };

  const removeChain = (c) => {
    store.update(COLLECTION, (d) => {
      d.blockchains = { ...d.blockchains, custom: customChains(d).filter((x) => x.id !== c.id) };
    });
    delete chainsView.tests[c.id];
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
      h('input', { name: `node-${c.id}`, value: shownList(c.saved), placeholder: c.builtin ? shownList(c.rpc) : 'https://…', title: c.builtin && !c.saved ? `Public nodes: ${shownList(c.rpc)}` : null, spellcheck: false, 'aria-label': `${c.name} node URLs` }),
      h('span', { class: 'chain-tools' },
        c.builtin
          ? h('label', { class: 'check small', title: 'Read by the Liquidity Pools tab' }, h('input', { type: 'checkbox', name: `on-${c.id}`, checked: c.lp }), 'LP')
          : null,
        h('button', { type: 'button', class: 'btn-small', disabled: test?.busy, onclick: (e) => {
          const typed = String(e.currentTarget.closest('li').querySelector('input:not([type])')?.value ?? '').trim();
          runTest(store, c, typed || c.node);
        } }, 'Test'),
        c.explorer ? h('a', { class: 'icon-btn', href: c.explorer, target: '_blank', rel: 'noopener', title: 'Open the block explorer', 'aria-label': `Open the ${c.name} block explorer` }, icon('globe')) : null,
        c.builtin ? null : h('button', { type: 'button', class: 'icon-btn', title: 'Remove chain', 'aria-label': `Remove ${c.name}`, onclick: () => removeChain(c) }, icon('trash'))),
      test ? h('span', { class: `chain-test small ${test.busy ? 'muted' : test.ok ? 'ok' : 'bad'}` }, test.text,
        ...(test.failed ?? []).map((line) => h('span', { class: 'chain-test-node' }, line))) : null);
  };

  return h('section', { class: 'card panel' },
    h('h2', null, 'Blockchains'),
    h('p', { class: 'muted small' }, 'The chains the board reads, for Liquidity Pools and smart contracts. A node is the JSON-RPC address a chain is read from. List several, separated by commas: reads go to the one answering fastest, spread across them, and move off a node that fails or stops answering. Leave it empty to use the public nodes shown as the placeholder. LP marks the chains the Liquidity Pools tab reads. Test asks each node for its chain ID and latest block.'),
    h('form', { class: 'stack', onsubmit: saveAll },
      h('ul', { class: 'chain-list' }, chains.map(row)),
      h('div', { class: 'row' }, h('button', { type: 'submit', class: 'btn-small' }, 'Save chains'))),
    h('h3', null, 'Add a chain'),
    h('p', { class: 'muted small' }, 'Any EVM chain with a JSON-RPC node. Leave the chain ID empty to read it from the node.'),
    h('form', { class: 'stack', onsubmit: addChain },
      h('div', { class: 'row' },
        h('input', { name: 'name', placeholder: 'Name', 'aria-label': 'Chain name' }),
        h('input', { name: 'id', placeholder: 'Chain ID', inputmode: 'numeric', 'aria-label': 'Chain ID' }),
        h('input', { name: 'symbol', placeholder: 'Coin (ETH)', 'aria-label': 'Native coin symbol' })),
      h('div', { class: 'row' },
        h('input', { name: 'rpc', placeholder: 'Nodes https://…, https://…', spellcheck: false, 'aria-label': 'Node URLs' }),
        h('input', { name: 'explorer', placeholder: 'Explorer https://… (optional)', spellcheck: false, 'aria-label': 'Block explorer URL' }),
        h('button', { type: 'submit', class: 'btn-small' }, 'Add chain'))),
    chainsView.message ? notice({ tone: chainsView.ok ? 'info' : 'error', text: chainsView.message }) : null);
}
