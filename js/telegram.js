// Telegram: messages sent to your own bot become tasks, and notifications can be sent back to the same chat.
// There is no server, so new messages are read while the board is open. The token goes only to api.telegram.org.
import { parseTask, makeTask } from './capture.js';
import { notify } from './notifications.js';
import { createProject } from './modules/projects.js';

const API = 'https://api.telegram.org';

const config = (store) => store.get('settings').telegram ?? {};
export const hasTelegram = (store) => Boolean(config(store).token && config(store).chatId);

async function call(token, method, body) {
  let res;
  try {
    res = await fetch(`${API}/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body ?? {}),
    });
  } catch {
    throw new Error('Telegram could not be reached. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 || res.status === 404) throw new Error('Telegram rejected this token. Copy it again from BotFather.');
  if (!data.ok) throw new Error(data.description || `Telegram error ${res.status}`);
  return data.result;
}

// The bot's name, to confirm the token works.
export const checkBot = async (token) => `Connected as @${(await call(token, 'getMe')).username}`;

// The chat of the most recent message sent to the bot. The user sends any message first.
export async function findChat(token) {
  const updates = await call(token, 'getUpdates', { timeout: 0, allowed_updates: ['message'] });
  const last = updates.filter((u) => u.message?.chat?.id).pop();
  if (!last) throw new Error('No message found. Send your bot a message first, then try again.');
  return String(last.message.chat.id);
}

export async function sendTelegram(store, text) {
  const { token, chatId } = config(store);
  if (!token || !chatId) return;
  await call(token, 'sendMessage', { chat_id: chatId, text });
}

// Turns one message into a task. Without a project or a deadline it waits in "To Organize".
export function taskFromMessage(store, text) {
  const projects = store.get('projects').projects;
  const parsed = parseTask(text, projects);
  if (!parsed.text) return null;
  const projectId = parsed.projectId ?? (parsed.tag ? createProject(store, parsed.tag).project.id : null);
  const inbox = !projectId || !parsed.due;
  const task = makeTask({ text: parsed.text, priority: parsed.priority, due: parsed.due, projectId, auto: 'telegram', inbox });
  store.update('todos', (d) => d.items.push(task));
  const where = projectId ? store.get('projects').projects.find((p) => p.id === projectId)?.name : null;
  notify(store, {
    kind: 'telegram',
    text: inbox ? `New task from Telegram: “${task.text}”. It waits in To Organize.` : `New task from Telegram in ${where}: “${task.text}”.`,
    href: inbox ? '#/todos?filter=organize' : `#/todos?filter=${projectId}`,
  });
  return { task, inbox, where };
}

let polling = false;

// Reads the messages that arrived since the last read. Only the saved chat can create tasks.
export async function pollTelegram(store) {
  const cfg = config(store);
  if (polling || !cfg.token || !cfg.chatId) return 0;
  polling = true;
  try {
    const updates = await call(cfg.token, 'getUpdates', { offset: cfg.offset || 0, timeout: 0, allowed_updates: ['message'] });
    if (!updates.length) return 0;
    let made = 0;
    for (const u of updates) {
      const m = u.message;
      if (!m?.text || String(m.chat?.id) !== String(cfg.chatId) || m.text.startsWith('/')) continue;
      const result = taskFromMessage(store, m.text);
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
