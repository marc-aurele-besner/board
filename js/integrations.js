// Banners for sections that need a connection set up in Settings. Each one links to the right Settings section.
import { h, notice } from './ui.js';

const SECTIONS = {
  openrouter: ['openrouter', 'OpenRouter'],
  google: ['google', 'Google Calendar'],
  github: ['github', 'GitHub'],
  exchange: ['exchange', 'Exchange rates'],
  uniswap: ['uniswap', 'Uniswap'],
  wallets: ['wallets', 'Wallets'],
  telegram: ['telegram', 'Telegram'],
  analytics: ['analytics', 'Google Analytics'],
  search: ['search', 'Search consoles'],
  resend: ['resend', 'Resend'],
  gmail: ['gmail', 'Gmail'],
};

export const settingsHref = (key) => `#/settings?section=${SECTIONS[key][0]}`;

// A banner explaining what is missing, with a button to the Settings section that sets it up.
// tone: 'info' for a missing setup, 'error' for a failure. Extra actions are shown after the link.
export function setupBanner(key, text, { tone = 'info', actions = [] } = {}) {
  const [, name] = SECTIONS[key];
  return notice({
    tone,
    text,
    actions: [
      h('a', { href: settingsHref(key), class: 'btn-small primary-link' }, `Set up ${name} in Settings`),
      ...actions,
    ],
  });
}

// True when the OpenRouter key has been saved.
export const hasOpenRouter = (store) => Boolean(store.get('settings').openrouter?.key);
