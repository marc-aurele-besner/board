// One place that talks to OpenRouter. Each feature names its task; the model comes from Settings.
import { modelForTask } from './modules/settings.js';
import { uid, now } from './ui.js';

// Every call is logged for the Monitoring tab: which task, which model, token counts, and cost if OpenRouter reports it.
function recordUsage(store, task, model, usage) {
  if (!usage) return;
  store.update('usage', (d) => {
    d.entries.push({
      id: uid(),
      at: now(),
      task,
      model,
      promptTokens: Number(usage.prompt_tokens) || 0,
      completionTokens: Number(usage.completion_tokens) || 0,
      cost: Number.isFinite(Number(usage.cost)) ? Number(usage.cost) : null,
    });
  });
}

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions';

// messages: [{ role, content }]. content can be text or an array with text and image_url parts.
export async function ask(store, taskId, messages) {
  const key = store.get('settings').openrouter?.key ?? '';
  if (!key) throw new Error('Add an OpenRouter key in Settings first.');
  const model = modelForTask(store, taskId);
  if (!model) throw new Error('No model is set for this task. Pick one in Settings → Models & tasks.');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'X-Title': 'Board' },
    // usage.include asks OpenRouter to return the cost of this call with the token counts.
    body: JSON.stringify({ model, messages, usage: { include: true } }),
  });
  if (!res.ok) throw new Error(`OpenRouter error ${res.status}. ${(await res.text()).slice(0, 160)}`);
  const data = await res.json();
  recordUsage(store, taskId, model, data.usage);
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('The model returned no text.');
  return text;
}

// Pulls the first JSON object or array out of a reply, even when it is wrapped in prose or a code fence.
export function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : text;
  const open = body.search(/[[{]/);
  const close = Math.max(body.lastIndexOf(']'), body.lastIndexOf('}'));
  if (open < 0 || close < open) throw new Error('The model did not return JSON.');
  return JSON.parse(body.slice(open, close + 1));
}
