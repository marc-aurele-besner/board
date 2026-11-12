// @ts-check
// One place that talks to OpenRouter. Each feature names its task; the model comes from Settings.
import { modelForTask } from './models.js';
import { globalPrompt } from './prompts.js';
import { uid, now } from './ui.js';

/** @import { DataStore, AiMessage, AiCallMeta, OpenRouterUsage } from '../types/data' */
/**
 * The fields of OpenRouter's reply read here.
 * @typedef {{ id?: string, provider?: string, model?: string, usage?: OpenRouterUsage,
 *   choices?: { finish_reason?: string, native_finish_reason?: string, message?: { content?: string } }[] }} OpenRouterReply
 */

// Full input and output are kept for this many recent calls; older entries keep only their numbers, so usage.json stays small.
export const LOG_LIMIT = 300;

// Images and PDFs travel as data URLs. The log keeps their type and size, not the bytes.
/**
 * @template T
 * @param {T} value
 * @returns {T}
 */
function stripData(value) {
  if (typeof value === 'string') {
    if (value.startsWith('data:') && value.length > 200) {
      return /** @type {T} */ (`[${value.slice(5, value.indexOf(';')) || 'data'}, ${Math.round((value.length * 3) / 4 / 1024)} KB, not kept]`);
    }
    return value;
  }
  if (Array.isArray(value)) return /** @type {T} */ (value.map(stripData));
  if (value && typeof value === 'object') return /** @type {T} */ (Object.fromEntries(Object.entries(value).map(([k, v]) => [k, stripData(v)])));
  return value;
}

// Every call is logged for the Monitoring tab: task, model, tokens, cost if OpenRouter reports it,
// and the full exchange (messages sent, reply, response details), failed calls included.
/**
 * @param {DataStore} store
 * @param {{ id: string, task: string, model: string, usage?: OpenRouterUsage, input: AiMessage[], output?: string, meta: AiCallMeta, error?: string }} call
 */
function recordCall(store, { id, task, model, usage, input, output, meta, error }) {
  store.update('usage', (d) => {
    d.entries.push({
      id: id || uid(),
      at: now(),
      task,
      model,
      promptTokens: Number(usage?.prompt_tokens) || 0,
      completionTokens: Number(usage?.completion_tokens) || 0,
      // A failed call without a reported cost cost nothing; a reply with no text may still have been billed.
      cost: Number.isFinite(Number(usage?.cost)) && usage?.cost !== null ? Number(/** @type {OpenRouterUsage} */ (usage).cost) : error ? 0 : null,
      input: stripData(input),
      output: output ?? '',
      meta,
      ...(error ? { error } : {}),
    });
    let kept = 0;
    for (let i = d.entries.length - 1; i >= 0; i--) {
      const e = d.entries[i];
      if (!('input' in e)) continue;
      kept += 1;
      if (kept > LOG_LIMIT) {
        delete e.input;
        delete e.output;
      }
    }
  });
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// Adds the Settings → Prompts text meant for every call ahead of the feature's own instructions.
/** @param {DataStore} store @param {AiMessage[]} messages @returns {AiMessage[]} */
function withGlobal(store, messages) {
  const text = globalPrompt(store);
  if (!text) return messages;
  return [{ role: 'system', content: text }, ...messages];
}

// messages: [{ role, content }]. content can be text or an array with text and image_url parts.
// `model` overrides the task's model for one call (a Cron step can pick its own). `usageId` names the usage.json
// entry, so a feature can point back to the call that made its result.
/**
 * @param {DataStore} store
 * @param {string} taskId
 * @param {AiMessage[]} messages
 * @param {{ model?: string, usageId?: string }} [options]
 * @returns {Promise<string>}
 */
export async function ask(store, taskId, messages, { model: override = '', usageId = '' } = {}) {
  const key = store.get('settings').openrouter?.key ?? '';
  if (!key) throw new Error('Add an OpenRouter key in Settings first.');
  const model = override || modelForTask(store, taskId);
  if (!model) throw new Error('No model is set for this task. Pick one in Settings → Models & tasks.');

  const input = withGlobal(store, messages);
  const started = performance.now();
  /** @type {AiCallMeta} */
  const meta = { overridden: Boolean(override) };
  /** @type {(error: string, usage?: OpenRouterUsage) => never} */
  const fail = (error, usage) => {
    meta.ms = Math.round(performance.now() - started);
    recordCall(store, { id: usageId, task: taskId, model, usage, input, output: '', meta, error });
    throw new Error(error);
  };

  /** @type {Response} */
  let res;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Board' },
      // usage.include asks OpenRouter to return the cost of this call with the token counts.
      body: JSON.stringify({ model, messages: input, usage: { include: true } }),
    });
  } catch (err) {
    fail(`Could not reach OpenRouter. ${/** @type {Error} */ (err).message}`);
  }
  meta.status = res.status;
  if (!res.ok) fail(`OpenRouter error ${res.status}. ${(await res.text()).slice(0, 160)}`);
  const data = /** @type {OpenRouterReply} */ (await res.json());
  const choice = data.choices?.[0];
  Object.assign(meta, {
    ms: Math.round(performance.now() - started),
    generationId: data.id ?? '',
    provider: data.provider ?? '',
    servedModel: data.model ?? '',
    finishReason: choice?.finish_reason ?? choice?.native_finish_reason ?? '',
    usage: data.usage ?? null,
  });
  const text = choice?.message?.content;
  if (!text) fail('The model returned no text.', data.usage);
  recordCall(store, { id: usageId, task: taskId, model, usage: data.usage, input, output: text, meta });
  return text;
}

// Pulls the first JSON object or array out of a reply, even when it is wrapped in prose or a code fence.
/** @param {string} text */
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const open = body.search(/[[{]/);
  const close = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (open < 0 || close < open) throw new Error('The model did not return JSON.');
  return JSON.parse(body.slice(open, close + 1));
}
