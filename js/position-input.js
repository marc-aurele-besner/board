import { h } from './ui.js';
import { CHAINS, readLink, hasVersion } from './uniswap.js';

// The fields to add a position by hand: the link or number, the chain and version pickers, and a line that says
// what a pasted link was read as. A link names its chain and version, so the pickers hide while one is typed and
// only a plain number asks for them. Each form places the three parts in its own layout.
export function positionFields({ placeholder = 'Position link or number', autofocus = false } = {}) {
  const chain = h('select', { name: 'chain', 'aria-label': 'Chain of the position' }, CHAINS.map((c) => h('option', { value: String(c.id) }, c.name)));
  const v4 = h('option', { value: 'v4' }, 'v4');
  const version = h('select', { name: 'version', 'aria-label': 'Uniswap version' }, v4, h('option', { value: 'v3' }, 'v3'));
  // A chain without v4 offers v3 alone.
  const syncVersion = () => {
    v4.hidden = v4.disabled = !hasVersion(CHAINS.find((c) => String(c.id) === chain.value), 'v4');
    if (v4.disabled) version.value = 'v3';
  };
  chain.addEventListener('change', syncVersion);
  syncVersion();
  const pickers = h('span', { class: 'row lp-pickers' }, chain, version);
  const hint = h('p', { class: 'muted small lp-detected', 'aria-live': 'polite', hidden: true });
  const sync = () => {
    const link = readLink(input.value);
    pickers.hidden = Boolean(link?.chainId);
    hint.hidden = !link;
    if (!link) return;
    if (link.chainId) {
      chain.value = String(link.chainId);
      syncVersion();
      version.value = link.version;
      hint.textContent = `Read from the link: ${CHAINS.find((c) => c.id === link.chainId).name}, Uniswap ${link.version}, position #${link.tokenId}.`;
    } else {
      hint.textContent = unreadLink(link);
    }
  };
  const input = h('input', { name: 'position', placeholder, spellcheck: false, autofocus, 'aria-label': 'Position link or number', oninput: sync });
  // A form reset clears the input without an input event, so the pickers come back after it.
  const reset = () => setTimeout(() => { syncVersion(); sync(); });
  return { input, pickers, hint, reset };
}

// Why typed text could not be added, for the form's message.
export function positionError(text) {
  const link = readLink(text);
  if (link && !link.chainId) return `${unreadLink(link)} The chains it reads are listed in Settings.`;
  return 'Paste a position link from app.uniswap.org, or type the position number and pick its chain and version.';
}

// Why a link was not read: its chain is not one the board reads, or Uniswap has no such version there.
function unreadLink(link) {
  const known = CHAINS.find((c) => c.app === link.slug);
  return known
    ? `The link names a Uniswap ${link.version} position on ${known.name}, where the board reads ${hasVersion(known, 'v4') ? 'v3 and v4' : 'v3 only'}.`
    : `The link names the chain "${link.slug}", which the board does not read.`;
}
