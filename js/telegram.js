// Telegram: messages sent to your own bot become tasks, and notifications can be sent back to the same chat.
// The runners (tools/jobs/telegram.js) listen for new messages all the time; the board only reads them during setup.
// The token goes only to api.telegram.org.
// Only one reader may ask Telegram for a bot's messages at a time. findChat() runs only while no chat is saved, and
// the runners read only once one is (hasTelegram), so the two never overlap. Keep it that way.
import { parseTask, makeTask } from './capture.js';
import { notify } from './notify-core.js';
import { createProject } from './projects-core.js';
/** @import { DataStore, TelegramSettings } from '../types/data' */
/**
 * An update from getUpdates, as far as it is read.
 * @typedef {{ update_id: number, message?: { text?: string, chat?: { id?: number } } }} TelegramUpdate
 */

const API = 'https://api.telegram.org';

/**
 * @param {DataStore} store
 * @returns {Partial<TelegramSettings>}
 */
const config = (store) => store.get('settings').telegram ?? {};
/** @param {DataStore} store */
export const hasTelegram = (store) => Boolean(config(store).token && config(store).chatId);

/**
 * @param {string} token
 * @param {string} method
 * @param {object} [body]
 * @param {AbortSignal} [signal]
 * @returns {Promise<unknown>}
 */
async function call(token, method, body, signal) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal,
    });
  } catch (err) {
    if (signal?.aborted) throw err;
    throw new Error('Telegram could not be reached. Check your connection.');
  }
  /** @type {{ ok?: boolean, description?: string, result?: unknown }} */
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 404) throw new Error('Telegram rejected this token. Copy it again from BotFather.');
  // 409: a webhook is set on the bot, or another program is reading its messages at the same time.
  if (res.status === 409) {
    throw new Error(/webhook/i.test(data.description ?? '')
      ? 'This bot has a webhook set, so its messages cannot be read here. Remove the webhook, or create a separate bot for the board.'
      : 'Another program is reading this bot’s messages. Stop it, or create a separate bot for the board.');
  }
  if (!data.ok) throw new Error(data.description || `Telegram error ${res.status}`);
  return data.result;
}

// The bot's name, to confirm the token works.
/** @param {string} token */
export const checkBot = async (token) => `Connected as @${/** @type {{ username?: string }} */ (await call(token, 'getMe')).username}`;

let polling = false;

// Only updates with a chat are kept, so the last one has its message and chat.
/** @param {unknown} updates */
const lastChat = (updates) => /** @type {{ message: { chat: { id: number } } }[]} */ (/** @type {TelegramUpdate[]} */ (updates).filter((u) => u.message?.chat?.id)).pop()?.message.chat.id;

// The chat of the most recent message sent to the bot. Messages the board already read are gone
// from Telegram, so when none is waiting it keeps listening for a short while for a new one.
/**
 * @param {string} token
 * @param {() => void} [onWait]
 */
export async function findChat(token, onWait) {
  while (polling) await new Promise((r) => setTimeout(r, 200));
  polling = true;
  try {
    let id = lastChat(await call(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] }));
    if (!id) {
      onWait?.();
      id = lastChat(await call(token, 'getUpdates', { timeout: 30, allowed_updates: ['message'] }));
    }
    if (!id) throw new Error('No message arrived. Send your bot a message, then press Find my chat again.');
    return String(id);
  } finally {
    polling = false;
  }
}

/**
 * @param {DataStore} store
 * @param {string} text
 */
export async function sendTelegram(store, text) {
  const { token, chatId } = config(store);
  if (!token || !chatId) return;
  await call(token, 'sendMessage', { chat_id: chatId, text });
}

// Turns one message into a task. Without a project or a deadline it waits in "To Organize".
// `ref` (the update's id) is kept as the task's autoRef, so a message read twice never makes two tasks.
/**
 * @param {DataStore} store
 * @param {string} text
 */
export function taskFromMessage(store, text, ref = '') {
  if (ref && store.get('todos').items.some((t) => t.auto === 'telegram' && t.autoRef === ref)) return null;
  const projects = store.get('projects').projects;
  const parsed = parseTask(text, projects);
  if (!parsed.text) return null;
  const projectId = parsed.projectId ?? (parsed.tag ? createProject(store, parsed.tag).project.id : null);
  const inbox = !projectId || !parsed.due;
  const task = makeTask({ text: parsed.text, priority: parsed.priority, due: parsed.due, projectId, auto: 'telegram', inbox, ...(ref ? { autoRef: ref } : {}) });
  store.update('todos', (d) => d.items.push(task));
  const where = projectId ? store.get('projects').projects.find((p) => p.id === projectId)?.name : null;
  notify(store, {
    kind: 'telegram',
    text: inbox ? `New task from Telegram: “${task.text}”. It waits in To Organize.` : `New task from Telegram in ${where}: “${task.text}”.`,
    href: inbox ? '#/todos?filter=organize' : `#/todos?filter=${projectId}`,
  });
  return { task, inbox, where };
}

// Reads the messages that arrived since the last read. Only the saved chat can create tasks. `wait` is how long
// Telegram may hold the request open for a new message (long polling), in seconds. Runs in the runners.
/**
 * @param {DataStore} store
 * @param {{ wait?: number, signal?: AbortSignal }} [options]
 */
export async function pollTelegram(store, { wait = 0, signal } = {}) {
  const cfg = config(store);
  if (polling || !cfg.token || !cfg.chatId) return 0;
  polling = true;
  try {
    const updates = /** @type {TelegramUpdate[]} */ (await call(cfg.token, 'getUpdates', { offset: cfg.offset || 0, timeout: wait, allowed_updates: ['message'] }, signal));
    if (!updates.length) return 0;
    let made = 0;
    for (const u of updates) {
      const m = u.message;
      if (!m?.text || String(m.chat?.id) !== String(cfg.chatId) || m.text.startsWith('/')) continue;
      const result = taskFromMessage(store, m.text, `update:${u.update_id}`);
      if (!result) continue;
      made += 1;
      if (cfg.confirm !== false) {
        sendTelegram(store, result.inbox ? `Added to To Organize: ${result.task.text}` : `Added to ${result.where}: ${result.task.text}`).catch(() => {});
      }
    }
    // Remember where we stopped, so a message is never read twice.
    store.update('settings', (d) => {
      d.telegram = { ...d.telegram, offset: updates[updates.length - 1].update_id + 1 };
    });
    return made;
  } finally {
    polling = false;
  }
}
