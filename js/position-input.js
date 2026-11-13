import { h } from './ui.js';
import { CHAINS, readLink, hasVersion, versionsOf, isAddress } from './uniswap.js';
/** @import { Chain } from '../types/uniswap' */

// The fields to add a position by hand: the link, number or v2 pair address, the chain and version pickers, and a
// line that says what was typed was read as. A link names its chain and version, so the pickers hide while one is
// typed; a plain number asks for both, and an address, which can only be a v2 pair, for the chain alone. Each form
// places the three parts in its own layout.
export function positionFields({ placeholder = 'Position link, number or v2 pair address', autofocus = false } = {}) {
  const chain = h('select', { name: 'chain', 'aria-label': 'Chain of the position' }, CHAINS.map((c) => h('option', { value: String(c.id) }, c.name)));
  const v4 = h('option', { value: 'v4' }, 'v4');
  const version = h('select', { name: 'version', 'aria-label': 'Uniswap version' }, v4, h('option', { value: 'v3' }, 'v3'));
  // A chain without v4 offers v3 alone.
  const syncVersion = () => {
    v4.hidden = v4.disabled = !hasVersion(/** @type {Chain} */ (CHAINS.find((c) => String(c.id) === chain.value)), 'v4'); // the picker lists CHAINS
    if (v4.disabled) version.value = 'v3';
  };
  chain.addEventListener('change', () => {
    syncVersion();
    sync();
  });
  syncVersion();
  const pickers = h('span', { class: 'row lp-pickers' }, chain, version);
  const hint = h('p', { class: 'muted small lp-detected', 'aria-live': 'polite', hidden: true });
  const sync = () => {
    const link = readLink(input.value);
    const pair = !link && isAddress(input.value);
    pickers.hidden = Boolean(link?.chainId);
    version.hidden = pair;
    hint.hidden = !link && !pair;
    if (pair) {
      const picked = /** @type {Chain} */ (CHAINS.find((c) => String(c.id) === chain.value)); // the picker lists CHAINS
      hint.textContent = hasVersion(picked, 'v2')
        ? `Read as a Uniswap v2 pair on ${picked.name}, for every wallet.`
        : `Uniswap has no v2 on ${picked.name}: pick the chain the pair is on.`;
      return;
    }
    if (!link) return;
    if (link.chainId) {
      chain.value = String(link.chainId);
      syncVersion();
      version.value = link.version;
      const name = /** @type {Chain} */ (CHAINS.find((c) => c.id === link.chainId)).name;
      hint.textContent = link.version === 'v2'
        ? `Read from the link: ${name}, Uniswap v2, pair ${short(/** @type {string} */ (link.tokenId))}, for every wallet.`
        : `Read from the link: ${name}, Uniswap ${link.version}, position #${link.tokenId}.`;
    } else {
      hint.textContent = unreadLink(link);
    }
  };
  const input = h('input', { name: 'position', placeholder, spellcheck: false, autofocus, 'aria-label': 'Position link, number or v2 pair address', oninput: sync });
  // A form reset clears the input without an input event, so the pickers come back after it.
  const reset = () => setTimeout(() => { syncVersion(); sync(); });
  return { input, pickers, hint, reset };
}

// Why typed text could not be added, for the form's message.
/** @param {unknown} text */
export function positionError(text) {
  const link = readLink(text);
  if (link && !link.chainId) return `${unreadLink(link)} The chains it reads are listed in Settings.`;
  if (isAddress(text)) return 'Uniswap has no v2 on the chain picked, so no pair is read there. Pick the chain the pair is on.';
  return 'Paste a position link from app.uniswap.org, type the position number and pick its chain and version, or type a v2 pair\'s address and pick its chain.';
}

const short = (/** @type {string} */ address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// Why a link was not read: its chain is not one the board reads, or Uniswap has no such version there.
/** @param {{ slug: string, version: string }} link */
function unreadLink(link) {
  const known = CHAINS.find((c) => c.app === link.slug);
  const read = known ? versionsOf(known) : '';
  return known
    ? `The link names a Uniswap ${link.version} position on ${known.name}, where the board reads ${read.includes(' and ') ? read : `${read} only`}.`
    : `The link names the chain "${link.slug}", which the board does not read.`;
}
