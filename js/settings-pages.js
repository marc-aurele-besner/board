// The Settings pages, by category, in the order of Settings' rail and lists; search and the palette list them too.
// A page's key is its ?section= value, kept when a page moves or is renamed so old links still open it. (No DOM.)
/** @import { IconName } from '../types/data' */

/** @typedef {{ id: string, name: string, icon: IconName, pages: [string, string, IconName][] }} SettingsCategory */

/** @type {SettingsCategory[]} */
export const SETTINGS_CATEGORIES = [
  { id: 'ai', name: 'AI', icon: 'sparkle', pages: [
    ['openrouter', 'OpenRouter', 'ai-openrouter'],
    ['models', 'Models & tasks', 'cpu'],
    ['prompts', 'Prompts', 'align-left'],
  ] },
  { id: 'code', name: 'Code & deploys', icon: 'code', pages: [
    ['github', 'GitHub', 'github'],
    ['vercel', 'Vercel', 'triangle'],
    ['netlify', 'Netlify', 'rocket'],
    ['dev', 'Coding Agents', 'terminal'],
    ['runners', 'Runners', 'activity'],
  ] },
  { id: 'google', name: 'Google', icon: 'calendar', pages: [
    ['google', 'Google Calendar', 'gcal'],
    ['gmail', 'Gmail', 'gmail'],
  ] },
  { id: 'websites', name: 'Websites', icon: 'globe', pages: [
    ['websites', 'Websites', 'globe'],
    ['analytics', 'Google Analytics', 'activity'],
    ['search', 'Search consoles', 'search'],
  ] },
  { id: 'messaging', name: 'Messaging & docs', icon: 'message', pages: [
    ['slack', 'Slack', 'slack'],
    ['telegram', 'Telegram', 'send'],
    ['notion', 'Notion', 'notion'],
    ['resend', 'Resend', 'resend'],
  ] },
  { id: 'socials', name: 'Socials', icon: 'users', pages: [
    ['x', 'X / Twitter', 'x-mark'],
    ['linkedin', 'LinkedIn', 'linkedin'],
    ['github-accounts', 'GitHub accounts', 'github'],
    ['instagram', 'Instagram', 'instagram'],
  ] },
  { id: 'web3', name: 'Web3', icon: 'cube', pages: [
    ['wallets', 'Wallets', 'wallet'],
    ['blockchains', 'Blockchains', 'cube'],
    ['contracts', 'Smart contracts', 'code'],
    ['uniswap', 'Uniswap', 'droplet'],
  ] },
  { id: 'money', name: 'Money', icon: 'coins', pages: [
    ['exchange', 'Exchange rates', 'coins'],
  ] },
  { id: 'board', name: 'Board', icon: 'settings', pages: [
    ['appearance', 'Appearance', 'palette'],
    ['categories', 'Labels', 'tag'],
    ['notifications', 'Notifications', 'bell'],
    ['automations', 'Automations', 'zap'],
    ['data', 'Data folder', 'folder'],
  ] },
];

// Every page as [key, label], in order.
/** @type {[string, string][]} */
export const SETTINGS_PAGES = SETTINGS_CATEGORIES.flatMap((c) => c.pages.map(([key, label]) => /** @type {[string, string]} */ ([key, label])));

/** @param {string} key */
export const categoryOf = (key) => SETTINGS_CATEGORIES.find((c) => c.pages.some(([k]) => k === key)) ?? SETTINGS_CATEGORIES[0];
