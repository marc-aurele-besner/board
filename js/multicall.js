// Many read-only calls in one request, through Multicall3, which sits at the same address on every chain the board
// reads. Public nodes limit how often they are asked, so a wallet's hundreds of token balances go in a few requests.
import { encodeCall, decodeArgs } from './abi.js';
import { rpcCall } from './uniswap.js';

export const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const BATCH = 150; // calls per request: well under what public nodes accept for one eth_call

const AGGREGATE3 = {
  name: 'aggregate3',
  inputs: [{ type: 'tuple[]', components: [{ name: 'target', type: 'address' }, { name: 'allowFailure', type: 'bool' }, { name: 'callData', type: 'bytes' }] }],
};
const RESULTS = [{ type: 'tuple[]', components: [{ name: 'success', type: 'bool' }, { name: 'returnData', type: 'bytes' }] }];

// calls: [{ to, data }]. Answers in the same order: the returned hex, or null for a call that failed.
// One failing call does not fail the others.
export async function multicall(node, calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += BATCH) {
    const part = calls.slice(i, i + BATCH);
    const data = encodeCall(AGGREGATE3, [part.map((c) => [c.to, true, c.data])]);
    const [results] = decodeArgs(RESULTS, await rpcCall(node, MULTICALL, data));
    for (const [ok, ret] of results) out.push(ok && ret !== '0x' ? ret : null);
  }
  return out;
}

// Multicall3's own getEthBalance(address): the native coin balance, so it rides in the same request.
export const nativeBalanceCall = (address) => ({ to: MULTICALL, data: `0x4d2301cc${address.replace(/^0x/, '').toLowerCase().padStart(64, '0')}` });
