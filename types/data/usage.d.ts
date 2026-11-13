// usage.json: every AI call (js/ai.js) and what the claude sessions Dev ran used (js/dev-usage.js, tools/usage.js).

// One part of a message's content: text, or an image or file sent as a data URL (the log keeps a short placeholder).
export interface AiContentPart {
  type: string;
  text?: string;
  image_url?: { url: string };
  file?: { filename?: string; file_data?: string };
  [key: string]: unknown;
}

export interface AiMessage {
  role: string;
  content: string | AiContentPart[];
}

// The usage object OpenRouter returns, as reported. Only the fields the board reads are typed.
export interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost?: number | null;
  prompt_tokens_details?: { cached_tokens?: number; [key: string]: unknown };
  completion_tokens_details?: { reasoning_tokens?: number; [key: string]: unknown };
  [key: string]: unknown;
}

// How the call went. A failed call has only `overridden`, `ms` and maybe `status`.
export interface AiCallMeta {
  // The caller picked the model (a Cron step), not the task's setting.
  overridden: boolean;
  ms?: number;
  // HTTP status of OpenRouter's answer.
  status?: number;
  generationId?: string;
  provider?: string;
  servedModel?: string;
  finishReason?: string;
  usage?: OpenRouterUsage | null;
}

export interface UsageEntry {
  id: string;
  at: string;
  // The task id from Settings → Models & tasks.
  task: string;
  // The project the call was made for, when the feature knows it (a profile, a brand, a triage, a Cron flow's).
  projectId?: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
  // Null when OpenRouter reported none: Monitoring estimates it from the model's price.
  cost: number | null;
  // Kept for the latest calls only (LOG_LIMIT); older entries and entries from before call logging lack them.
  input?: AiMessage[];
  output?: string;
  meta?: AiCallMeta;
  // Set on a failed call.
  error?: string;
}

// One model's use in a Dev record.
export interface DevModelUsage {
  // 'Anthropic', 'Amazon Bedrock', 'Google Vertex AI' or 'Other'.
  provider: string;
  input: number;
  output: number;
  thinking: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number | null;
  // The part of the cost billed beyond the Claude plan. Lacking in records saved before the split.
  extraCost?: number | null;
}

// A worktree's claude sessions. Records only remembered (no transcript read yet) have just name, cwd, added and taskIds.
export interface DevUsage {
  name: string;
  cwd: string;
  added: string;
  taskIds: string[];
  // The claude session id the worktree last ran.
  session?: string;
  sessions?: number;
  // 'plan' or 'api'; null once the transcripts were gone before the cost could be split; lacking before the split.
  billing?: string | null;
  models?: Record<string, DevModelUsage>;
  cost?: number | null;
  extraCost?: number | null;
  // Milliseconds of work and of API time.
  duration?: number;
  apiDuration?: number;
  linesAdded?: number;
  linesRemoved?: number;
  // Replies per effort level ('low', 'medium', 'high' ...).
  efforts?: Record<string, number>;
  replies?: number;
  // Uses per skill name ('fix-issue', 'plugin:skill'), and calls per MCP tool ('mcp__<server>__<tool>').
  skills?: Record<string, number>;
  mcp?: Record<string, number>;
  // Times (ms) of the first and last reply.
  start?: number | null;
  end?: number | null;
}

export interface UsageData {
  entries: UsageEntry[];
  // By worktree name.
  dev?: Record<string, DevUsage>;
  schemaVersion?: number;
}
