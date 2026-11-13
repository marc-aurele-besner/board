// Slack's emoji short names, so reactions and :codes: show as characters, and the categories the reaction picker
// shows. A name missing here is a workspace's custom emoji (an image) or shows as :name:.

import { EMOJI_GROUPS } from './emoji-data.js';

/** @typedef {{ char: string, names: string[], skin: boolean }} EmojiEntry */

/** @type {{ id: string, label: string, emoji: EmojiEntry[] }[]} the picker's categories, in Slack's order */
export const EMOJI_CATEGORIES = EMOJI_GROUPS.map(([id, label, entries]) => ({
  id,
  label,
  emoji: entries.split('|').map((e) => {
    const skin = e.endsWith('~');
    const [char, names] = (skin ? e.slice(0, -1) : e).split('=');
    return { char, names: names.split(','), skin };
  }),
}));

// Names Slack accepts that the data lacks.
/** @type {Record<string, string>} */
const EXTRA = {
  simple_smile: '🙂', thinking: '🤔', star_struck: '🤩', hugs: '🤗', shipit: '🐿️', ship_it: '🐿️',
  man_shrugging: '🤷‍♂️', woman_shrugging: '🤷‍♀️', facepalm: '🤦', man_facepalming: '🤦‍♂️', woman_facepalming: '🤦‍♀️',
};

/** @type {Record<string, string>} name -> emoji; several names may share one */
export const EMOJI = { ...EXTRA };
/** @type {Set<string>} the names that take a skin tone */
const SKIN = new Set();
for (const c of EMOJI_CATEGORIES) {
  for (const e of c.emoji) {
    for (const n of e.names) {
      EMOJI[n] = e.char;
      if (e.skin) SKIN.add(n);
    }
  }
}

// Slack's suggested reactions, in its order.
export const QUICK_REACTIONS = ['+1', 'white_check_mark', 'eyes', 'heart', 'joy', 'tada', 'pray', 'raised_hands', 'fire', 'thinking_face', '100', 'rocket'];

// Slack's skin tones 2 to 6 are these modifiers.
const TONES = ['\u{1F3FB}', '\u{1F3FC}', '\u{1F3FD}', '\u{1F3FE}', '\u{1F3FF}'];

// The emoji for a short name, or '' when it is not a standard one. A skin tone (::skin-tone-2) goes right after the
// first character, where Unicode puts it, on the emoji that take one.
/** @param {string} name */
export function emojiChar(name) {
  const [, base = name, tone] = /^(.*?)(?:::skin-tone-(\d))?$/.exec(name) ?? [];
  const char = EMOJI[base] ?? '';
  const mod = tone && SKIN.has(base) ? TONES[Number(tone) - 2] ?? '' : '';
  if (!char || !mod) return char;
  const [first, ...rest] = [...char];
  // A variation selector (U+FE0F) gives way to the modifier.
  return first + mod + rest.join('').replace(/^️/, '');
}
