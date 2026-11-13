// The Slack tab's calls: every workspace signed in with a browser session (token and `d` cookie), through the runners
// (tools/slack.js), since a page cannot send Slack's cookie. Only the workspaces, the channel lists, the people and the
// layout are saved, in slack.json; messages are read live. No DOM, so it loads under Node too.
/** @import { DataStore, SlackWorkspace, SlackChannel, SlackUser } from '../types/data' */
import { workerCall } from './runners.js';

export const SLACK = 'slack';
/** @type {import('../types/data').SlackData} */
export const SLACK_DEFAULTS = { workspaces: [], groups: [], muted: [], order: [], projects: {}, collapsed: [], channels: {}, users: {} };

/**
 * @typedef {{ name: string, users: string[], count: number }} Reaction
 * @typedef {{ id: string, name: string, mimetype: string, link: string, thumb: string, image: boolean }} MessageFile
 * @typedef {{ title: string, text: string, link: string, image: string, color: string }} Attachment
 * @typedef {{ ts: string, user: string, username: string, avatar: string, text: string, subtype: string, threadTs: string,
 *   replyCount: number, latestReply: string, replyUsers: string[], reactions: Reaction[], files: MessageFile[],
 *   attachments: Attachment[], edited: boolean }} Message
 * @typedef {{ unread: boolean, mentions: number, latest: string, lastRead: string }} Count
 */

/** @param {string} team @param {string} channel */
export const keyOf = (team, channel) => `${team}|${channel}`;
/** @param {string} key */
export const splitKey = (key) => /** @type {[string, string]} */ (key.split('|'));

// A Slack error code in words, for the few people meet.
/** @type {Record<string, string>} */
const ERRORS = {
  invalid_auth: 'Slack no longer accepts this session. Sign in again: copy a fresh token and d cookie.',
  not_authed: 'Slack no longer accepts this session. Sign in again: copy a fresh token and d cookie.',
  token_revoked: 'This session was signed out. Copy a fresh token and d cookie.',
  account_inactive: 'This account is deactivated in the workspace.',
  channel_not_found: 'Slack does not know this conversation, or you are no longer in it.',
  not_in_channel: 'You are not in this channel.',
  is_archived: 'This channel is archived.',
  msg_too_long: 'The message is too long.',
  cant_update_message: 'Slack does not let you edit this message.',
  cant_delete_message: 'Slack does not let you delete this message.',
  already_reacted: 'You already reacted with this emoji.',
  invalid_name: 'Slack does not know this emoji.',
};

// One Web API call as the workspace's user. Throws Slack's error in words; a session Slack refuses is marked on the
// workspace, so the tab can ask for a new one.
/**
 * @param {SlackWorkspace | { token: string, cookie: string, url?: string }} ws
 * @param {string} method
 * @param {Record<string, unknown>} [params]
 * @param {DataStore} [store]
 * @returns {Promise<any>} any: each Slack method answers its own shape
 */
export async function slackApi(ws, method, params = {}, store) {
  const answer = await workerCall('POST', '/slack', { token: ws.token, cookie: ws.cookie, url: ws.url, method, params }, 45000);
  if (answer.ok) return answer;
  const code = String(answer.error ?? 'unknown_error');
  if (code === 'ratelimited') throw new Error(`Slack is rate limiting ${method}; it can be called again in ${answer.retryAfter ?? 30} s.`);
  const message = ERRORS[code] ?? `Slack: ${code}${answer.needed ? ` (needs ${answer.needed})` : ''}`;
  if (store && 'id' in ws && /^(invalid_auth|not_authed|token_revoked|account_inactive)$/.test(code)) {
    store.update(SLACK, (d) => {
      const w = d.workspaces.find((x) => x.id === ws.id);
      if (w) w.error = message;
    });
  }
  throw new Error(message);
}

// The tokens in what was pasted: xoxc- tokens, or the teams of Slack's web client, which
// `copy(JSON.parse(localStorage.localConfig_v2).teams)` puts on the clipboard (team id -> { token, name, url, … }).
/** @param {string} text @returns {{ token: string, name?: string, url?: string, icon?: string }[]} */
export function parseTokens(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed);
      const teams = parsed.teams && typeof parsed.teams === 'object' ? parsed.teams : parsed;
      return Object.values(teams)
        .filter((t) => t && typeof t.token === 'string' && t.token.startsWith('xox'))
        .map((t) => ({ token: t.token, name: t.name, url: t.url, icon: t.icon?.image_132 ?? t.icon?.image_68 ?? '' }));
    } catch {
      // not JSON after all: look for tokens in the text
    }
  }
  return [...new Set(trimmed.match(/xox[a-z]-[A-Za-z0-9-]+/g) ?? [])].map((token) => ({ token }));
}

// Signs in each pasted token with the cookie, and adds (or renews) its workspace. Answers what was added and what failed.
/**
 * @param {DataStore} store
 * @param {string} text
 * @param {string} cookie
 */
export async function addWorkspaces(store, text, cookie) {
  const found = parseTokens(text);
  if (!found.length) throw new Error('No Slack token found. A token starts with xoxc-.');
  /** @type {string[]} */
  const added = [];
  /** @type {string[]} */
  const errors = [];
  for (const t of found) {
    try {
      const auth = await slackApi({ token: t.token, cookie, url: t.url }, 'auth.test');
      const info = await slackApi({ token: t.token, cookie, url: auth.url }, 'team.info').catch(() => null);
      const icon = info?.team?.icon?.image_132 ?? info?.team?.icon?.image_68 ?? t.icon ?? '';
      /** @type {SlackWorkspace} */
      const ws = { id: auth.team_id, name: info?.team?.name ?? auth.team ?? t.name ?? auth.team_id, url: auth.url ?? t.url ?? '', icon, token: t.token, cookie, userId: auth.user_id, userName: auth.user ?? '', projectId: null, error: '' };
      store.update(SLACK, (d) => {
        const old = d.workspaces.find((w) => w.id === ws.id);
        if (old) Object.assign(old, { ...ws, projectId: old.projectId });
        else d.workspaces.push(ws);
      });
      added.push(ws.name);
    } catch (err) {
      errors.push(`${t.name ?? `${t.token.slice(0, 12)}…`}: ${/** @type {Error} */ (err).message}`);
    }
  }
  return { added, errors };
}

/** @param {any} c any: a conversation as Slack sends it @returns {SlackChannel} */
function channelOf(c) {
  const kind = c.is_im ? 'im' : c.is_mpim ? 'mpim' : c.is_private || c.is_group ? 'private' : 'channel';
  /** @type {SlackChannel} */
  const out = { id: c.id, name: kind === 'im' ? '' : String(c.name_normalized ?? c.name ?? c.id), kind };
  if (c.user) out.user = c.user;
  if (c.topic?.value) out.topic = c.topic.value;
  return out;
}

// Lists the conversations the user is in, and reads the people of its direct messages it does not know yet.
/** @param {DataStore} store @param {SlackWorkspace} ws */
export async function listChannels(store, ws) {
  /** @type {SlackChannel[]} */
  const all = [];
  let cursor = '';
  do {
    const page = await slackApi(ws, 'users.conversations', { types: 'public_channel,private_channel,mpim,im', exclude_archived: true, limit: 200, cursor: cursor || undefined }, store);
    all.push(...(page.channels ?? []).filter((/** @type {any} */ c) => !c.is_archived && !(c.is_im && c.is_user_deleted)).map(channelOf));
    cursor = page.response_metadata?.next_cursor ?? '';
  } while (cursor);
  store.update(SLACK, (d) => {
    d.channels[ws.id] = all;
    const w = d.workspaces.find((x) => x.id === ws.id);
    if (w?.error) w.error = '';
  });
  await ensureUsers(store, ws, all.map((c) => c.user ?? '').filter(Boolean));
  return all;
}

/** @param {any} u any: a user as Slack sends it @returns {SlackUser} */
const userOf = (u) => ({
  name: String(u.profile?.display_name || u.profile?.real_name || u.real_name || u.name || u.id),
  avatar: String(u.profile?.image_72 ?? u.profile?.image_48 ?? ''),
  ...(u.is_bot ? { bot: true } : {}),
});

// People asked for at once share one read; a person Slack cannot find is remembered as their id.
/** @type {Map<string, Promise<void>>} */
const userReads = new Map();

// Reads the people (users.info) a workspace's list does not have yet, four at a time, and saves them together.
/** @param {DataStore} store @param {SlackWorkspace} ws @param {string[]} ids */
export async function ensureUsers(store, ws, ids) {
  const known = store.get(SLACK).users[ws.id] ?? {};
  const missing = [...new Set(ids)].filter((id) => id && /^[UWB]/.test(id) && !known[id] && !userReads.has(keyOf(ws.id, id)));
  if (!missing.length) return Promise.all(ids.map((id) => userReads.get(keyOf(ws.id, id)))).then(() => {});
  /** @type {Record<string, SlackUser>} */
  const found = {};
  const work = (async () => {
    for (let i = 0; i < missing.length; i += 4) {
      await Promise.all(missing.slice(i, i + 4).map(async (id) => {
        try {
          const answer = id.startsWith('B')
            ? await slackApi(ws, 'bots.info', { bot: id })
            : await slackApi(ws, 'users.info', { user: id });
          found[id] = answer.bot
            ? { name: String(answer.bot.name ?? id), avatar: String(answer.bot.icons?.image_72 ?? answer.bot.icons?.image_48 ?? ''), bot: true }
            : userOf(answer.user);
        } catch {
          found[id] = { name: id, avatar: '' };
        }
      }));
    }
    if (Object.keys(found).length) store.update(SLACK, (d) => { d.users[ws.id] = { ...(d.users[ws.id] ?? {}), ...found }; });
  })();
  for (const id of missing) userReads.set(keyOf(ws.id, id), work);
  return work.finally(() => { for (const id of missing) userReads.delete(keyOf(ws.id, id)); });
}

// What is unread, per conversation. client.counts is what Slack's own client asks; it answers for channels, direct
// messages and group messages at once.
/** @param {SlackWorkspace} ws @param {DataStore} [store] @returns {Promise<Map<string, Count>>} */
export async function readCounts(ws, store) {
  const answer = await slackApi(ws, 'client.counts', { thread_counts_by_channel: false }, store);
  /** @type {Map<string, Count>} */
  const out = new Map();
  for (const c of [...(answer.channels ?? []), ...(answer.mpims ?? []), ...(answer.ims ?? [])]) {
    out.set(c.id, {
      unread: Boolean(c.has_unreads),
      mentions: Number(c.mention_count ?? 0),
      latest: String(c.latest ?? ''),
      lastRead: String(c.last_read ?? ''),
    });
  }
  return out;
}

/** @param {any} f any: a file as Slack sends it @returns {MessageFile} */
const fileOf = (f) => ({
  id: String(f.id ?? ''),
  name: String(f.title || f.name || 'File'),
  mimetype: String(f.mimetype ?? ''),
  link: String(f.permalink ?? f.url_private ?? ''),
  thumb: String(f.thumb_480 ?? f.thumb_360 ?? f.thumb_160 ?? ''),
  image: String(f.mimetype ?? '').startsWith('image/') && Boolean(f.thumb_360 ?? f.thumb_480 ?? f.thumb_160),
});

/** @param {any} a any: an attachment as Slack sends it @returns {Attachment} */
const attachmentOf = (a) => ({
  title: String(a.title ?? a.author_name ?? ''),
  text: String(a.text ?? a.fallback ?? ''),
  link: String(a.title_link ?? a.from_url ?? a.original_url ?? ''),
  image: String(a.thumb_url ?? a.image_url ?? ''),
  color: /^[0-9a-f]{6}$/i.test(a.color ?? '') ? `#${a.color}` : '',
});

// Block Kit sections that carry text, for messages from apps whose `text` is only a summary.
/** @param {any[]} blocks any: blocks as Slack sends them */
function blocksText(blocks) {
  const parts = [];
  for (const b of blocks ?? []) {
    if (b.type === 'section' || b.type === 'header') {
      if (b.text?.text) parts.push(String(b.text.text));
      for (const f of b.fields ?? []) if (f.text) parts.push(String(f.text));
    } else if (b.type === 'context') {
      parts.push((b.elements ?? []).map((/** @type {any} */ e) => e.text ?? '').filter(Boolean).join(' '));
    }
  }
  return parts.filter(Boolean).join('\n');
}

/** @param {any} m any: a message as Slack sends it @returns {Message} */
export function messageOf(m) {
  const fromBlocks = m.blocks?.some((/** @type {any} */ b) => b.type !== 'rich_text') ? blocksText(m.blocks) : '';
  return {
    ts: String(m.ts),
    user: String(m.user ?? m.bot_id ?? ''),
    username: String(m.user_profile?.display_name || m.user_profile?.real_name || m.bot_profile?.name || m.username || ''),
    avatar: String(m.user_profile?.image_72 ?? m.bot_profile?.icons?.image_72 ?? m.icons?.image_72 ?? m.icons?.image_48 ?? ''),
    text: fromBlocks && fromBlocks.length > String(m.text ?? '').length ? fromBlocks : String(m.text ?? ''),
    subtype: String(m.subtype ?? ''),
    threadTs: String(m.thread_ts ?? ''),
    replyCount: Number(m.reply_count ?? 0),
    latestReply: String(m.latest_reply ?? ''),
    replyUsers: (m.reply_users ?? []).map(String),
    reactions: (m.reactions ?? []).map((/** @type {any} */ r) => ({ name: String(r.name), users: (r.users ?? []).map(String), count: Number(r.count ?? 0) })),
    files: (m.files ?? []).filter((/** @type {any} */ f) => f.mode !== 'tombstone').map(fileOf),
    attachments: (m.attachments ?? []).map(attachmentOf).filter((/** @type {Attachment} */ a) => a.title || a.text || a.image),
    edited: Boolean(m.edited),
  };
}

// The newest messages of a conversation, oldest first, and the cursor to older ones ('' when there are none).
/** @param {SlackWorkspace} ws @param {string} channel @param {{ cursor?: string, limit?: number }} [options] @param {DataStore} [store] */
export async function readHistory(ws, channel, { cursor = '', limit = 50 } = {}, store) {
  const answer = await slackApi(ws, 'conversations.history', { channel, limit, cursor: cursor || undefined, include_all_metadata: false }, store);
  return {
    messages: (answer.messages ?? []).map(messageOf).reverse(),
    next: answer.has_more ? String(answer.response_metadata?.next_cursor ?? '') : '',
  };
}

// A thread: its parent first, then every reply.
/** @param {SlackWorkspace} ws @param {string} channel @param {string} ts @param {DataStore} [store] */
export async function readThread(ws, channel, ts, store) {
  /** @type {Message[]} */
  const out = [];
  let cursor = '';
  do {
    const page = await slackApi(ws, 'conversations.replies', { channel, ts, limit: 200, cursor: cursor || undefined }, store);
    out.push(...(page.messages ?? []).map(messageOf));
    cursor = page.has_more ? String(page.response_metadata?.next_cursor ?? '') : '';
  } while (cursor && out.length < 1000);
  return out;
}

/**
 * @param {SlackWorkspace} ws
 * @param {string} channel
 * @param {string} text
 * @param {{ threadTs?: string, broadcast?: boolean }} [options]
 */
export const postMessage = (ws, channel, text, { threadTs = '', broadcast = false } = {}) =>
  slackApi(ws, 'chat.postMessage', { channel, text, thread_ts: threadTs || undefined, reply_broadcast: threadTs && broadcast ? true : undefined, link_names: true });

/** @param {SlackWorkspace} ws @param {string} channel @param {string} ts @param {string} text */
export const editMessage = (ws, channel, ts, text) => slackApi(ws, 'chat.update', { channel, ts, text, link_names: true });
/** @param {SlackWorkspace} ws @param {string} channel @param {string} ts */
export const deleteMessage = (ws, channel, ts) => slackApi(ws, 'chat.delete', { channel, ts });

/** @param {SlackWorkspace} ws @param {string} channel @param {string} ts @param {string} name @param {boolean} on */
export const react = (ws, channel, ts, name, on) =>
  slackApi(ws, on ? 'reactions.add' : 'reactions.remove', { channel, timestamp: ts, name });

// Marks a conversation read up to `ts`, in Slack too.
/** @param {SlackWorkspace} ws @param {string} channel @param {string} ts */
export const markRead = (ws, channel, ts) => slackApi(ws, 'conversations.mark', { channel, ts });

// A workspace's custom emoji (name -> image address or "alias:<name>"), read once per page load.
/** @type {Map<string, Promise<Record<string, string>>>} */
const emojiReads = new Map();
/** @param {SlackWorkspace} ws */
export function customEmoji(ws) {
  let read = emojiReads.get(ws.id);
  if (!read) {
    read = slackApi(ws, 'emoji.list').then((a) => /** @type {Record<string, string>} */ (a.emoji ?? {})).catch(() => ({}));
    emojiReads.set(ws.id, read);
  }
  return read;
}

// Images Slack keeps behind the session, as data: URLs, by address.
/** @type {Map<string, Promise<string>>} */
const files = new Map();
/** @param {SlackWorkspace} ws @param {string} url @returns {Promise<string>} */
export function fileData(ws, url) {
  let read = files.get(url);
  if (!read) {
    read = workerCall('POST', '/slack/file', { token: ws.token, cookie: ws.cookie, file: url }, 45000)
      .then((a) => (a.ok ? String(a.dataUrl) : ''))
      .catch(() => '');
    files.set(url, read);
  }
  return read;
}

// A message's page in Slack's web client.
/** @param {SlackWorkspace} ws @param {string} channel @param {string} [ts] */
export const slackLink = (ws, channel, ts) =>
  `${ws.url || 'https://app.slack.com/'}archives/${channel}${ts ? `/p${ts.replace('.', '')}` : ''}`;
