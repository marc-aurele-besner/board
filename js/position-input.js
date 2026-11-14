import { h } from './ui.js';
import { CHAINS, readLink, hasVersion, versionsOf, isAddress, readChoice, deploymentOf, dexName } from './uniswap.js';
/** @import { Chain } from '../types/uniswap' */
/** @import { PositionLink } from './uniswap.js' */

// The exchange and version picker's choices: "<version>" for Uniswap, "<dex>:<version>" for another exchange. A v2
// position is named by its pair's address, the others by a number, so each kind of text offers its own.
const CHOICES = [['v4', 'Uniswap v4'], ['v3', 'Uniswap v3'], ['pancakeswap:v3', 'PancakeSwap v3'], ['v2', 'Uniswap v2'], ['pancakeswap:v2', 'PancakeSwap v2']];
// What the picker's value is for a link's exchange and version.
const choiceOf = (/** @type {{ dex: string, version: string }} */ x) => (x.dex === 'uniswap' ? x.version : `${x.dex}:${x.version}`);
// Whether the exchange and version of a choice are read on a chain.
const offered = (/** @type {number} */ chainId, /** @type {string} */ choice) => {
  const { dex, version } = readChoice(choice);
  const at = deploymentOf(chainId, dex);
  return Boolean(at && hasVersion(at, version));
};

// The fields to add a position by hand: the link, number or v2 pair address, the chain and exchange pickers, and a
// line that says what was typed was read as. A link names its chain, exchange and version, so the pickers hide while
// one is typed; a number asks for the chain and one of the numbered versions, an address for the chain and a v2.
// Each form places the three parts in its own layout.
export function positionFields({ placeholder = 'Position link, number or v2 pair address', autofocus = false } = {}) {
  const chain = h('select', { name: 'chain', 'aria-label': 'Chain of the position' }, CHAINS.map((c) => h('option', { value: String(c.id) }, c.name)));
  const options = CHOICES.map(([value, label]) => h('option', { value }, label));
  const version = h('select', { name: 'version', 'aria-label': 'Exchange and version' }, options);
  // Only the choices read on the chain picked, of the kind the text is (a pair address, or a number).
  const syncVersion = (pair = isAddress(input?.value)) => {
    for (const o of options) {
      const ok = offered(Number(chain.value), o.value) && (readChoice(o.value).version === 'v2') === pair;
      o.hidden = o.disabled = !ok;
    }
    if (options.find((o) => o.value === version.value)?.disabled) version.value = options.find((o) => !o.disabled)?.value ?? '';
  };
  const pickers = h('span', { class: 'row lp-pickers' }, chain, version);
  const hint = h('p', { class: 'muted small lp-detected', 'aria-live': 'polite', hidden: true });
  const sync = () => {
    const link = readLink(input.value);
    const pair = !link && isAddress(input.value);
    syncVersion(pair);
    pickers.hidden = Boolean(link?.chainId);
    hint.hidden = !link && !pair;
    if (pair) {
      const picked = /** @type {Chain} */ (CHAINS.find((c) => String(c.id) === chain.value)); // the picker lists CHAINS
      hint.textContent = version.value
        ? `Read as a ${dexName(readChoice(version.value).dex)} v2 pair on ${picked.name}, for every wallet.`
        : `Neither Uniswap nor PancakeSwap has v2 on ${picked.name}: pick the chain the pair is on.`;
      return;
    }
    if (!link) return;
    if (link.chainId) {
      chain.value = String(link.chainId);
      syncVersion(false);
      version.value = choiceOf(link);
      const name = /** @type {Chain} */ (CHAINS.find((c) => c.id === link.chainId)).name;
      hint.textContent = link.version === 'v2'
        ? `Read from the link: ${name}, ${dexName(link.dex)} v2, pair ${short(/** @type {string} */ (link.tokenId))}, for every wallet.`
        : `Read from the link: ${name}, ${dexName(link.dex)} ${link.version}, position #${link.tokenId}.`;
    } else {
      hint.textContent = unreadLink(link);
    }
  };
  const input = h('input', { name: 'position', placeholder, spellcheck: false, autofocus, 'aria-label': 'Position link, number or v2 pair address', oninput: sync });
  chain.addEventListener('change', sync);
  version.addEventListener('change', sync);
  syncVersion(false);
  // A form reset clears the input without an input event, so the pickers come back after it.
  const reset = () => setTimeout(sync);
  return { input, pickers, hint, reset };
}

// Why typed text could not be added, for the form's message.
/** @param {unknown} text */
export function positionError(text) {
  const link = readLink(text);
  if (link && !link.chainId) return `${unreadLink(link)} The chains it reads are listed in Settings.`;
  if (isAddress(text)) return 'No v2 of the exchange picked is read on that chain. Pick the chain and exchange the pair is on.';
  return 'Paste a position link from app.uniswap.org or pancakeswap.finance, type the position number and pick its chain, exchange and version, or type a v2 pair\'s address and pick its chain.';
}

const short = (/** @type {string} */ address) => `${address.slice(0, 6)}…${address.slice(-4)}`;

// Why a link was not read: its chain is not one the board reads, or the exchange has no such version there.
/** @param {PositionLink} link */
function unreadLink(link) {
  const known = link.dex === 'uniswap' ? CHAINS.find((c) => c.app === link.slug) : null;
  const read = known ? versionsOf(known) : '';
  return known
    ? `The link names a Uniswap ${link.version} position on ${known.name}, where the board reads ${read.includes(' and ') ? read : `${read} only`}.`
    : `The link names the chain "${link.slug}", where the board does not read ${dexName(link.dex)}.`;
}
