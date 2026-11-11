// Solidity ABI encoding and decoding, enough for calls, transactions and event logs: every static and dynamic type,
// fixed and dynamic arrays, and tuples. Hex strings without 0x inside; 0x at the edges.
import { keccak256 } from './keccak.js';

const W = 64; // one 32-byte word, in hex characters
const strip = (hex) => String(hex ?? '').replace(/^0x/i, '');
const word = (big) => big.toString(16).padStart(W, '0');
const padRight = (hex) => hex.padEnd(Math.ceil(hex.length / W) * W, '0');
const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/../g)?.map((b) => parseInt(b, 16)) ?? []);
const utf8Hex = (text) => toHex(new TextEncoder().encode(text));

// "uint256[2][]" -> { base: "uint256", dims: [2, null] }, outermost dimension last.
function typeOf(param) {
  const m = String(param.type).match(/^([^[]+)((\[\d*\])*)$/);
  if (!m) throw new Error(`Unknown type ${param.type}.`);
  const dims = [...m[2].matchAll(/\[(\d*)\]/g)].map((x) => (x[1] === '' ? null : Number(x[1])));
  return { base: m[1], dims };
}

// The same parameter one array level in, or null when it is not an array.
function inner(param) {
  const { dims } = typeOf(param);
  if (!dims.length) return null;
  const size = dims.at(-1);
  return { param: { ...param, type: param.type.replace(/\[\d*\]$/, '') }, size };
}

export function canonical(param) {
  const { base, dims } = typeOf(param);
  const head = base === 'tuple' ? `(${(param.components ?? []).map(canonical).join(',')})` : base === 'uint' ? 'uint256' : base === 'int' ? 'int256' : base;
  return head + dims.map((d) => `[${d ?? ''}]`).join('');
}

export const signature = (item) => `${item.name}(${(item.inputs ?? []).map(canonical).join(',')})`;
export const selector = (item) => keccak256(utf8Hex(signature(item))).slice(0, 10);
export const topicOf = (event) => keccak256(utf8Hex(signature(event)));

function isDynamic(param) {
  const arr = inner(param);
  if (arr) return arr.size === null || isDynamic(arr.param);
  const { base } = typeOf(param);
  if (base === 'string' || base === 'bytes') return true;
  if (base === 'tuple') return (param.components ?? []).some(isDynamic);
  return false;
}

// Bytes a static parameter takes in the head.
function headSize(param) {
  if (isDynamic(param)) return 32;
  const arr = inner(param);
  if (arr) return arr.size * headSize(arr.param);
  if (typeOf(param).base === 'tuple') return (param.components ?? []).reduce((n, c) => n + headSize(c), 0);
  return 32;
}

// --- Encoding ---

function encodeTuple(params, values) {
  let heads = '';
  let tails = '';
  const headLen = params.reduce((n, p) => n + headSize(p), 0);
  params.forEach((p, i) => {
    const enc = encodeOne(p, values[i]);
    if (isDynamic(p)) {
      heads += word(BigInt(headLen + tails.length / 2));
      tails += enc;
    } else heads += enc;
  });
  return heads + tails;
}

function encodeOne(param, value) {
  const arr = inner(param);
  if (arr) {
    const list = Array.isArray(value) ? value : [];
    if (arr.size !== null && list.length !== arr.size) throw new Error(`${param.name || param.type} needs ${arr.size} items.`);
    const body = encodeTuple(list.map(() => arr.param), list);
    return arr.size === null ? word(BigInt(list.length)) + body : body;
  }
  const { base } = typeOf(param);
  if (base === 'tuple') {
    const comps = param.components ?? [];
    const vals = Array.isArray(value) ? value : comps.map((c, i) => value?.[c.name || i]);
    return encodeTuple(comps, vals);
  }
  if (base === 'string' || base === 'bytes') {
    const hex = base === 'string' ? utf8Hex(value) : strip(value);
    return word(BigInt(hex.length / 2)) + padRight(hex);
  }
  if (base === 'address') return strip(value).toLowerCase().padStart(W, '0');
  if (base === 'bool') return word(value ? 1n : 0n);
  if (/^bytes\d+$/.test(base)) return padRight(strip(value));
  if (/^u?int\d*$/.test(base)) {
    const n = BigInt(value);
    return word(n < 0n ? (1n << 256n) + n : n);
  }
  throw new Error(`Unsupported type ${param.type}.`);
}

export const encodeArgs = (params, values) => encodeTuple(params, values);
export const encodeCall = (fn, values) => `${selector(fn)}${encodeTuple(fn.inputs ?? [], values)}`;

// --- Decoding ---

const readWord = (hex, at) => {
  const w = hex.slice(at * 2, at * 2 + W);
  if (w.length < W) throw new Error('The answer is shorter than the ABI says.');
  return w;
};
const readUint = (hex, at) => BigInt(`0x${readWord(hex, at)}`);

// at: byte offset of the tuple's head in hex.
function decodeTuple(params, hex, at) {
  let pos = at;
  return params.map((p) => {
    let value;
    if (isDynamic(p)) value = decodeOne(p, hex, at + Number(readUint(hex, pos)));
    else value = decodeOne(p, hex, pos);
    pos += headSize(p);
    return value;
  });
}

function decodeOne(param, hex, at) {
  const arr = inner(param);
  if (arr) {
    if (arr.size === null) {
      const n = Number(readUint(hex, at));
      return decodeTuple(Array(n).fill(arr.param), hex, at + 32);
    }
    return decodeTuple(Array(arr.size).fill(arr.param), hex, at);
  }
  const { base } = typeOf(param);
  if (base === 'tuple') return decodeTuple(param.components ?? [], hex, at);
  if (base === 'string' || base === 'bytes') {
    const n = Number(readUint(hex, at));
    const body = hex.slice((at + 32) * 2, (at + 32 + n) * 2);
    return base === 'string' ? new TextDecoder().decode(fromHex(body)) : `0x${body}`;
  }
  const w = readWord(hex, at);
  if (base === 'address') return `0x${w.slice(24)}`;
  if (base === 'bool') return BigInt(`0x${w}`) !== 0n;
  if (/^bytes\d+$/.test(base)) return `0x${w.slice(0, Number(base.slice(5)) * 2)}`;
  if (/^uint\d*$/.test(base)) return BigInt(`0x${w}`);
  if (/^int\d*$/.test(base)) {
    const n = BigInt(`0x${w}`);
    return n >= 1n << 255n ? n - (1n << 256n) : n;
  }
  throw new Error(`Unsupported type ${param.type}.`);
}

export const decodeArgs = (params, data) => decodeTuple(params, strip(data), 0);

// An event log, decoded by the event its first topic names, or null when the ABI has no such event.
// Indexed strings, bytes, arrays and tuples are stored as their hash, so those come back as the hash.
export function decodeLog(events, log) {
  const event = events.find((e) => topicOf(e) === String(log.topics?.[0]).toLowerCase());
  if (!event) return null;
  const inputs = event.inputs ?? [];
  const plain = inputs.filter((p) => !p.indexed);
  const data = decodeArgs(plain, log.data ?? '0x');
  let t = 1;
  let d = 0;
  const args = inputs.map((p) => {
    if (!p.indexed) return data[d++];
    const topic = strip(log.topics[t++]);
    return isDynamic(p) || typeOf(p).base === 'tuple' ? `0x${topic}` : decodeOne(p, topic, 0);
  });
  return { event, args };
}

// --- ABI files and typed input ---

// An ABI pasted as JSON: an array, or an object with an "abi" field (Hardhat and Foundry artifacts).
export function parseAbi(text) {
  const json = typeof text === 'string' ? JSON.parse(text) : text;
  const list = Array.isArray(json) ? json : Array.isArray(json?.abi) ? json.abi : null;
  if (!list) throw new Error('An ABI is a JSON list of functions and events.');
  return list.filter((x) => x && typeof x === 'object');
}

const isView = (f) => f.stateMutability === 'view' || f.stateMutability === 'pure' || f.constant === true;
export const functionsOf = (abi) => abi.filter((x) => x.type === 'function' || (!x.type && x.name));
export const readsOf = (abi) => functionsOf(abi).filter(isView);
export const writesOf = (abi) => functionsOf(abi).filter((f) => !isView(f));
export const eventsOf = (abi) => abi.filter((x) => x.type === 'event');
export const isPayable = (f) => f.stateMutability === 'payable' || f.payable === true;

// A value typed in a field, for one parameter. Arrays and tuples are typed as JSON.
export function parseInput(param, text) {
  const raw = String(text ?? '').trim();
  const { base, dims } = typeOf(param);
  if (dims.length || base === 'tuple') {
    let json;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(`${param.name || param.type}: type a JSON ${dims.length ? 'list, like [1, 2]' : 'list of its fields'}.`);
    }
    return coerce(param, json);
  }
  return coerce(param, raw);
}

function coerce(param, value) {
  const label = param.name || param.type;
  const arr = inner(param);
  if (arr) {
    if (!Array.isArray(value)) throw new Error(`${label}: expected a list.`);
    return value.map((v) => coerce(arr.param, v));
  }
  const { base } = typeOf(param);
  if (base === 'tuple') {
    const comps = param.components ?? [];
    const list = Array.isArray(value) ? value : comps.map((c) => value?.[c.name]);
    return comps.map((c, i) => coerce(c, list[i]));
  }
  const s = typeof value === 'string' ? value.trim() : value;
  if (base === 'address') {
    if (!/^0x[0-9a-fA-F]{40}$/.test(String(s))) throw new Error(`${label}: not an address.`);
    return s;
  }
  if (base === 'bool') {
    if (s === true || s === false) return s;
    if (/^(true|1)$/i.test(String(s))) return true;
    if (/^(false|0)$/i.test(String(s))) return false;
    throw new Error(`${label}: true or false.`);
  }
  if (base === 'string') return String(s ?? '');
  if (base === 'bytes' || /^bytes\d+$/.test(base)) {
    if (!/^0x([0-9a-fA-F]{2})*$/.test(String(s))) throw new Error(`${label}: hex bytes starting with 0x.`);
    if (base !== 'bytes' && strip(s).length !== Number(base.slice(5)) * 2) throw new Error(`${label}: exactly ${base.slice(5)} bytes.`);
    return s;
  }
  const m = base.match(/^(u?)int(\d*)$/);
  if (m) {
    let n;
    try {
      n = BigInt(String(s));
    } catch {
      throw new Error(`${label}: a whole number.`);
    }
    const bits = BigInt(m[2] || 256);
    const ok = m[1] ? n >= 0n && n < 1n << bits : n >= -(1n << (bits - 1n)) && n < 1n << (bits - 1n);
    if (!ok) throw new Error(`${label}: out of range for ${base}.`);
    return n;
  }
  throw new Error(`Unsupported type ${param.type}.`);
}

// A decoded value as text: numbers in full, tuples and arrays as JSON.
export function show(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return JSON.stringify(value, (_, v) => (typeof v === 'bigint' ? v.toString() : v));
  return String(value);
}

// "1.5" in a coin with 18 decimals -> 1500000000000000000n.
export function parseUnits(text, decimals = 18) {
  const s = String(text ?? '').trim();
  if (!s) return 0n;
  const m = s.match(/^(\d*)(?:\.(\d*))?$/);
  if (!m || (!m[1] && !m[2])) throw new Error('Type an amount like 0.01.');
  if ((m[2] ?? '').length > decimals) throw new Error(`At most ${decimals} decimals.`);
  return BigInt(m[1] || '0') * 10n ** BigInt(decimals) + BigInt((m[2] ?? '').padEnd(decimals, '0') || '0');
}
