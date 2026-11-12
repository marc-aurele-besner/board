// @ts-check
// Keccak-256, the hash Ethereum uses. Uniswap v4 names each pool by the hash of its key, and nothing on chain
// returns that id from a position, so the board computes it. BigInt lanes: slow, but it hashes a few keys per read.

const MASK = (1n << 64n) - 1n;
// Rotation offset of each lane, indexed x + 5y.
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
// Round constants, from the standard's linear feedback shift register.
/** @type {bigint[]} */
const RC = [];
for (let round = 0, R = 1; round < 24; round++) {
  let rc = 0n;
  for (let j = 0; j < 7; j++) {
    R = ((R << 1) ^ ((R >> 7) * 0x71)) % 256;
    if (R & 2) rc ^= 1n << ((1n << BigInt(j)) - 1n);
  }
  RC.push(rc);
}

const rotl = (/** @type {bigint} */ v, /** @type {number} */ n) => (n === 0 ? v : ((v << BigInt(n)) | (v >> BigInt(64 - n))) & MASK);

/** @param {bigint[]} s */
function permute(s) {
  /** @type {bigint[]} */
  const C = new Array(5);
  /** @type {bigint[]} */
  const B = new Array(25);
  for (let round = 0; round < 24; round++) {
    for (let x = 0; x < 5; x++) C[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
    for (let x = 0; x < 5; x++) {
      const d = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      for (let y = 0; y < 25; y += 5) s[x + y] ^= d;
    }
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) B[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    }
    for (let y = 0; y < 25; y += 5) {
      for (let x = 0; x < 5; x++) s[x + y] = B[x + y] ^ (~B[((x + 1) % 5) + y] & MASK & B[((x + 2) % 5) + y]);
    }
    s[0] ^= RC[round];
  }
}

// The Keccak-256 hash of hex-encoded bytes, as 0x-prefixed hex.
/** @param {string} hex @returns {string} */
export function keccak256(hex) {
  const clean = String(hex).replace(/^0x/, '');
  const RATE = 136;
  const bytes = new Uint8Array(Math.floor(clean.length / 2 / RATE) * RATE + RATE);
  for (let i = 0; i < clean.length / 2; i++) bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  bytes[clean.length / 2] ^= 0x01;
  bytes[bytes.length - 1] ^= 0x80;

  const s = new Array(25).fill(0n);
  for (let off = 0; off < bytes.length; off += RATE) {
    for (let i = 0; i < RATE / 8; i++) {
      let lane = 0n;
      for (let b = 7; b >= 0; b--) lane = (lane << 8n) | BigInt(bytes[off + i * 8 + b]);
      s[i] ^= lane;
    }
    permute(s);
  }
  let out = '0x';
  for (let i = 0; i < 4; i++) {
    for (let b = 0; b < 8; b++) out += Number((s[i] >> BigInt(8 * b)) & 0xffn).toString(16).padStart(2, '0');
  }
  return out;
}
