// The numbers behind Monitoring → Development, without the DOM: a turn's working and review time, its tools, skills
// and MCP calls grouped and added up, and the findings the Insights card states in plain words.
import { fmtDuration, mcpTool } from './dev-usage.js';
/** @import { DevToolUse, DevTurn, DevUsage } from '../types/data' */

// A turn with its record and the project of the record's tasks ('' without one).
/** @typedef {{ t: DevTurn, r: DevUsage, project: string }} TurnRow */
// What a skill, a tool or a server added up to over some turns. works: claude's working time of each turn it ran in.
/** @typedef {{ key: string, calls: number, errors: number, ms: number, turns: number, tasks: Set<string>, projects: Set<string>, names: Set<string>, last: number, works: number[] }} UseRow */
/** @typedef {{ tone: 'good' | 'warn' | 'info', text: string, view?: string }} Insight */

// A pause between turns longer than this is time away, not review.
export const AWAY_MS = 60 * 60000;
const MIN = 60000;

export const workOf = (/** @type {DevTurn} */ t) => Math.max(0, t.end - t.at - t.wait);
export const reviewOf = (/** @type {DevTurn} */ t) => (t.review <= AWAY_MS ? t.review : 0);
export const sum = (/** @type {number[]} */ list) => list.reduce((s, v) => s + v, 0);
export const median = (/** @type {number[]} */ list) => {
  if (!list.length) return 0;
  const s = [...list].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
// Durations down to seconds: most turns take less than a minute or two.
/** @param {number} ms */
export function fmtSpan(ms) {
  if (!ms) return '—';
  if (ms < 1000) return '< 1 s';
  if (ms < MIN) return `${Math.round(ms / 1000)} s`;
  if (ms < 10 * MIN) {
    const s = Math.round((ms % MIN) / 1000);
    return s && s < 60 ? `${Math.floor(ms / MIN)} min ${s} s` : `${Math.round(ms / MIN)} min`;
  }
  return fmtDuration(ms);
}
export const pct = (/** @type {number} */ n, /** @type {number} */ d) => (d ? `${Math.round((n / d) * 100)}%` : '—');

// How the Tools view names a tool: an MCP tool by its server (the Skills & MCP view lists each one), a subagent's
// call (Agent, or Task in an older claude) as Subagents.
/** @param {string} name */
export function toolGroup(name) {
  if (name.startsWith('mcp__')) {
    const { server } = mcpTool(name);
    return { key: `mcp:${server}`, label: `MCP · ${server}` };
  }
  if (name === 'Agent' || name === 'Task') return { key: 'Agent', label: 'Subagents' };
  return { key: name, label: name };
}
/** @param {DevTurn} t @returns {[string, DevToolUse][]} */
const mcpOf = (t) => Object.entries(t.tools ?? {}).filter(([name]) => name.startsWith('mcp__'));

// A turn's uses as each grouping counts them: [key, use, the name behind the key].
/** @type {Record<string, (t: DevTurn) => [string, DevToolUse, string?][]>} */
export const USES = {
  skills: (t) => Object.entries(t.skills ?? {}).map(([name, calls]) => [name, { calls }]),
  mcp: mcpOf,
  servers: (t) => mcpOf(t).map(([name, u]) => [mcpTool(name).server, u, name]),
  tools: (t) => Object.entries(t.tools ?? {}).map(([name, u]) => [toolGroup(name).key, u, name]),
};

/** @param {TurnRow[]} rows @param {(t: DevTurn) => [string, DevToolUse, string?][]} uses @returns {Map<string, UseRow>} */
export function groupUses(rows, uses) {
  /** @type {Map<string, UseRow>} */
  const out = new Map();
  for (const { t, r, project } of rows) {
    const seen = new Set();
    for (const [key, u, name] of uses(t)) {
      let row = out.get(key);
      if (!row) out.set(key, (row = { key, calls: 0, errors: 0, ms: 0, turns: 0, tasks: new Set(), projects: new Set(), names: new Set(), last: 0, works: [] }));
      row.calls += u.calls;
      row.errors += u.errors ?? 0;
      row.ms += u.ms ?? 0;
      row.last = Math.max(row.last, t.end);
      row.tasks.add(r.name);
      row.names.add(name ?? key);
      if (project) row.projects.add(project);
      if (seen.has(key)) continue;
      seen.add(key);
      row.turns++;
      row.works.push(workOf(t));
    }
  }
  return out;
}

// A turn's calls, failures and call time, all tools together or only those `keep` names.
/** @param {DevTurn} t @param {(name: string) => boolean} [keep] */
export function callsOf(t, keep = () => true) {
  const out = { calls: 0, errors: 0, ms: 0 };
  for (const [name, u] of Object.entries(t.tools ?? {})) {
    if (!keep(name)) continue;
    out.calls += u.calls;
    out.errors += u.errors ?? 0;
    out.ms += u.ms ?? 0;
  }
  return out;
}
// Every tool some turns called, added up by tool (as toolGroup names it), the most called first: what the tools
// button on Dev's bar lists for the shown claude.
/** @typedef {{ key: string, label: string, calls: number, errors: number, ms: number, names: string[] }} ToolRow */
/** @typedef {ToolRow & { agents: number }} SessionToolRow */
/** @param {{ tools?: Record<string, DevToolUse> | null }[]} turns @returns {ToolRow[]} */
export function toolRows(turns) {
  /** @type {Map<string, ToolRow>} */
  const out = new Map();
  for (const t of turns) {
    for (const [name, u] of Object.entries(t.tools ?? {})) {
      const { key, label } = toolGroup(name);
      let row = out.get(key);
      if (!row) out.set(key, (row = { key, label, calls: 0, errors: 0, ms: 0, names: [] }));
      row.calls += u.calls;
      row.errors += u.errors ?? 0;
      row.ms += u.ms ?? 0;
      if (!row.names.includes(name)) row.names.push(name);
    }
  }
  return [...out.values()].sort((a, b) => b.calls - a.calls || a.label.localeCompare(b.label));
}
// A claude session's tools: its turns' calls and its subagents' own, added up by tool, the most called first.
// `agents` is how many of a row's calls the subagents made.
/** @param {{ tools?: Record<string, DevToolUse> | null }[]} turns @param {Record<string, DevToolUse>} [agentTools] */
export function sessionTools(turns, agentTools) {
  const byAgents = new Map(toolRows([{ tools: agentTools }]).map((r) => [r.key, r.calls]));
  /** @type {SessionToolRow[]} */
  const rows = toolRows([...turns, { tools: agentTools }]).map((r) => ({ ...r, agents: byAgents.get(r.key) ?? 0 }));
  return {
    rows,
    calls: sum(rows.map((r) => r.calls)),
    errors: sum(rows.map((r) => r.errors)),
    ms: sum(rows.map((r) => r.ms)),
    agents: sum(rows.map((r) => r.agents)),
  };
}
export const isMcp = (/** @type {string} */ name) => name.startsWith('mcp__');
export const skillUses = (/** @type {DevTurn} */ t) => sum(Object.values(t.skills ?? {}));

// The period's findings, the most telling first: what changed, where the time went, and what failed. Each needs
// enough turns to mean something, so a quiet period says little.
/**
 * @param {{ turns: TurnRow[], prev: TurnRow[], tasks: { turns: number }[], projectName: (id: string) => string }} data
 * @returns {Insight[]}
 */
export function insights({ turns, prev, tasks, projectName }) {
  /** @type {Insight[]} */
  const out = [];
  if (!turns.length) return out;
  const works = turns.map((x) => workOf(x.t));
  const work = sum(works);
  const prevWork = sum(prev.map((x) => workOf(x.t)));
  if (prev.length >= 3 && prevWork) {
    const p = (work - prevWork) / prevWork;
    if (Math.abs(p) >= 0.15) out.push({ tone: 'info', text: `Claude worked ${fmtSpan(work)} over ${turns.length} turns, ${Math.round(Math.abs(p) * 100)}% ${p > 0 ? 'more' : 'less'} than in the period before (${fmtSpan(prevWork)}).` });
  }

  const read = turns.filter((x) => x.t.tools);
  const label = (/** @type {string} */ key) => (key.startsWith('mcp:') ? `The ${key.slice(4)} MCP server` : key === 'Agent' ? 'Subagents' : key);
  const tools = [...groupUses(read, USES.tools).values()];
  const calls = sum(tools.map((r) => r.calls));
  const errors = sum(tools.map((r) => r.errors));
  const failing = tools.filter((r) => r.calls >= 10 && r.errors / r.calls >= 0.1).sort((a, b) => b.errors - a.errors)[0];
  if (failing) {
    out.push({ tone: 'warn', view: failing.key.startsWith('mcp:') ? 'skills' : 'tools', text: `${label(failing.key)} failed ${pct(failing.errors, failing.calls)} of its calls (${failing.errors} of ${failing.calls}).` });
  } else if (calls >= 20) {
    const most = [...tools].sort((a, b) => b.errors - a.errors)[0];
    const where = errors ? `, ${most.errors === errors ? 'all' : `${most.errors} of them`} in ${label(most.key).replace(/^The /, 'the ')}` : '';
    out.push({ tone: errors / calls < 0.05 ? 'good' : 'info', view: 'tools', text: `${errors} of the ${calls} tool calls failed (${pct(errors, calls)})${where}.` });
  }

  const interrupted = turns.filter((x) => x.t.interrupted);
  if (turns.length >= 5 && interrupted.length / turns.length >= 0.1) {
    /** @type {Map<string, number>} */
    const by = new Map();
    for (const x of interrupted) by.set(x.project, (by.get(x.project) ?? 0) + 1);
    const [top, n] = [...by].sort((a, b) => b[1] - a[1])[0];
    const where = by.size > 1 && n >= 2 && top ? `, ${n} of them on ${projectName(top)}` : '';
    out.push({ tone: 'warn', view: 'turns', text: `You interrupted ${interrupted.length} of ${turns.length} turns (${pct(interrupted.length, turns.length)})${where}.` });
  }

  if (tasks.length >= 3) {
    const one = tasks.filter((t) => t.turns === 1).length;
    const share = one / tasks.length;
    const more = tasks.filter((t) => t.turns > 1);
    const followUps = more.length ? ` The others took ${(sum(more.map((t) => t.turns - 1)) / more.length).toFixed(1)} follow-ups on average.` : '';
    out.push({ tone: share >= 0.7 ? 'good' : share < 0.4 ? 'warn' : 'info', view: 'turns', text: `${one ? `${pct(one, tasks.length)} of tasks were` : 'No task was'} done from a single prompt.${followUps}` });
  }

  const waits = turns.map((x) => x.t.wait).filter(Boolean);
  const wait = sum(waits);
  const review = sum(turns.map((x) => reviewOf(x.t)));
  if (wait >= 5 * MIN) {
    out.push({ tone: wait / (work || 1) > 0.25 ? 'warn' : 'info', text: `Claude waited ${fmtSpan(wait)} on your answer to questions and plans in ${waits.length} turn${waits.length === 1 ? '' : 's'} (median ${fmtSpan(median(waits))}).` });
  }
  if (turns.length >= 3 && work >= 10 * MIN && wait + review) {
    out.push({ tone: 'info', text: `For each hour claude worked, you spent ${fmtSpan(((wait + review) / work) * 60 * MIN)} reviewing and answering.` });
  }

  // Skills and MCP: how often, and whether the turns that used them ran longer.
  const against = (/** @type {TurnRow[]} */ a, /** @type {TurnRow[]} */ b) =>
    (a.length >= 3 && b.length >= 3 ? ` Those turns took a median ${fmtSpan(median(a.map((x) => workOf(x.t))))}, against ${fmtSpan(median(b.map((x) => workOf(x.t))))} without.` : '');
  if (read.length >= 3) {
    const withSkill = read.filter((x) => skillUses(x.t));
    const skills = [...groupUses(read, USES.skills).values()].sort((a, b) => b.calls - a.calls);
    if (!skills.length) out.push({ tone: 'info', view: 'skills', text: `No skill ran in these ${read.length} turns.` });
    else {
      out.push({ tone: 'info', view: 'skills', text: `Skills ran in ${withSkill.length} of ${read.length} turns, /${skills[0].key} the most (${skills[0].calls} use${skills[0].calls === 1 ? '' : 's'}).${against(withSkill, read.filter((x) => !skillUses(x.t)))}` });
    }
    const withMcp = read.filter((x) => callsOf(x.t, isMcp).calls);
    const servers = [...groupUses(read, USES.servers).values()].sort((a, b) => b.calls - a.calls);
    if (servers.length) {
      const all = sum(servers.map((r) => r.calls));
      const ms = sum(servers.map((r) => r.ms));
      out.push({ tone: 'info', view: 'skills', text: `MCP tools were called ${all} times in ${pct(withMcp.length, read.length)} of turns, mostly ${servers[0].key}, at ${fmtSpan(ms / all)} a call.${against(withMcp, read.filter((x) => !callsOf(x.t, isMcp).calls))}` });
    }
    // Calls made together overlap, so the share is only said when it stays under the whole.
    const ms = sum(tools.map((r) => r.ms));
    const slow = [...tools].sort((a, b) => b.ms - a.ms)[0];
    if (slow && work && ms / work >= 0.3 && ms <= work) out.push({ tone: 'info', view: 'tools', text: `${pct(ms, work)} of claude's working time went to waiting on tool calls, mostly ${label(slow.key).replace(/^The /, 'the ')} (${fmtSpan(slow.ms)}).` });
  }

  // Review time per turn, by project: where the answers take the longest to check.
  /** @type {Map<string, number[]>} */
  const reviews = new Map();
  for (const x of turns) {
    const v = reviewOf(x.t);
    if (v && x.project) reviews.set(x.project, [...(reviews.get(x.project) ?? []), v]);
  }
  const overall = median([...reviews.values()].flat());
  const slowest = [...reviews].filter(([, list]) => list.length >= 3).map(([id, list]) => ({ id, value: median(list) })).sort((a, b) => b.value - a.value)[0];
  if (reviews.size > 1 && slowest && slowest.value >= 1.5 * overall) {
    out.push({ tone: 'info', text: `You take the longest to answer on ${projectName(slowest.id)}: a median ${fmtSpan(slowest.value)} between turns, against ${fmtSpan(overall)} overall.` });
  }

  if (turns.length >= 10) {
    const hours = Array.from({ length: 24 }, () => 0);
    for (const x of turns) hours[new Date(x.t.at).getHours()]++;
    const top = hours.indexOf(Math.max(...hours));
    const two = (/** @type {number} */ n) => String(n % 24).padStart(2, '0');
    if (hours[top] / turns.length >= 0.15) out.push({ tone: 'info', text: `Your busiest hour is ${two(top)}:00 to ${two(top + 1)}:00, with ${hours[top]} of ${turns.length} prompts.` });
  }

  const longest = turns.reduce((a, b) => (workOf(b.t) > workOf(a.t) ? b : a));
  if (workOf(longest.t) >= 30 * MIN) out.push({ tone: 'info', view: 'turns', text: `The longest turn ran ${fmtSpan(workOf(longest.t))}: “${longest.t.text.slice(0, 80)}${longest.t.text.length > 80 ? '…' : ''}”` });
  return out.slice(0, 8);
}
