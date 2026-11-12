// What js/abi.js encodes and decodes with. The board's own ABIs (js/uniswap.js, js/aave.js, js/multicall.js) leave
// most names out, so these are looser than a saved contract's AbiParam and AbiItem (types/data/settings.d.ts).

// One parameter: its Solidity type, and the fields of a tuple.
export interface Param {
  type: string;
  name?: string;
  indexed?: boolean;
  components?: Param[];
}

// A function or event: its name and inputs are enough to encode a call or find a log's event.
export interface Fn {
  name?: string;
  inputs?: Param[];
}

// A value given to or decoded by js/abi.js: a bigint, string, boolean, or a list of them for arrays and tuples.
export type AbiValue = any; // any: its shape follows the ABI passed at runtime, and callers index it by that ABI

// A log as eth_getLogs returns it, as far as decodeLog() reads it.
export interface Log {
  topics?: string[];
  data?: string;
}
