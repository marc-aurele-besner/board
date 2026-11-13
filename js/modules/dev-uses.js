// The panels under the skills and MCP buttons of Dev's bar, for the claude the shown terminal runs. Skills: each
// skill it ran with what it does, where it comes from, the turns it ran in and when it last did, then the project's
// skills it has not run. MCP: its calls by server and tool, with their failures, time per call, subagents' share
// and turns. A skill is typed into the terminal again, an MCP tool's name is copied.
import { h, icon } from '../ui.js';
import { toast } from '../toast.js';
import { onContextMenu, copyItem } from '../menu.js';
import { sessionSkills, sessionMcp, sessionTools, fmtSpan, pct } from '../dev-turns.js';
import { baseName, openFile } from './dev-files.js';
/** @import { DevContext } from '../../types/dev' */
/** @import { RunnerTurns, RunnerSkills, RunnerSkill } from '../../types/terminal' */
/** @import { MenuEntry } from '../menu.js' */
/** @import { SessionSkillRow, SessionMcpServer, SessionMcpTool } from '../dev-turns.js' */

// How many of the project's skills not run yet the skills panel lists.
const UNUSED_SHOWN = 6;

const clock = (/** @type {number} */ at) => (at ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '');
const plural = (/** @type {number} */ n, /** @type {string} */ one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Most calls answer in well under a second.
const perCall = (/** @type {number} */ t) => (t < 1000 ? `${Math.max(1, Math.round(t))} ms` : fmtSpan(t));
// "turn 4", "turns 2, 5, 9", "turns 2, 5, 9 +3".
/** @param {number[]} turns */
function turnsText(turns) {
  if (!turns.length) return '';
  const shown = turns.slice(-3).join(', ');
  return `${turns.length === 1 ? 'turn' : 'turns'} ${shown}${turns.length > 3 ? ` +${turns.length - 3}` : ''}`;
}
const lastText = (/** @type {number[]} */ turns, /** @type {number} */ last) => (turns.length ? `turn ${turns.at(-1)}${last ? ` at ${clock(last)}` : ''}` : '');

// The panel is drawn again every second while open: only when what it shows changed, so a press on a row is not
// lost to a new row and the list keeps its scroll.
/** @param {HTMLElement} el @param {unknown} shown @param {() => (Node | null)[]} build */
function redraw(el, shown, build) {
  const key = JSON.stringify(shown);
  if (el.dataset.key === key) return;
  el.dataset.key = key;
  const scroll = el.querySelector('.turns-list')?.scrollTop ?? 0;
  el.replaceChildren(...build().filter((n) => !!n));
  const list = el.querySelector('.turns-list');
  if (list) list.scrollTop = scroll;
}

/** @param {[string, string][]} facts */
const factList = (facts) => {
  const kept = facts.filter(([, text]) => text);
  return kept.length ? h('dl', { class: 'small tools-facts' }, kept.map(([name, text]) => [h('dt', { class: 'muted' }, name), h('dd', null, text)])) : null;
};

/** @param {RunnerTurns} data */
export const skillsOf = (data) => sessionSkills(data.turns, data.skills);
/** @param {RunnerTurns} data */
export const mcpOf = (data) => sessionMcp(data.turns, data.agentTools, data.mcp);

// The skills button's tooltip: its count, then the last skill run.
/** @param {RunnerTurns} data */
export function skillsTitle(data) {
  const { rows, uses } = skillsOf(data);
  const last = [...rows].filter((r) => r.last).sort((a, b) => b.last - a.last)[0];
  return [
    `${plural(uses, 'skill use')} in this claude session${rows.length ? ` (${plural(rows.length, 'skill')})` : ''}`,
    last ? `Last: /${last.name}, ${lastText(last.turns, last.last)}` : '',
    'Show the skills it ran and what each does',
  ].filter(Boolean).join('\n');
}
// The MCP button's tooltip: its count, its failures, then the server called most.
/** @param {RunnerTurns} data */
export function mcpTitle(data) {
  const { servers, calls, errors } = mcpOf(data);
  const more = [servers.length ? plural(servers.length, 'server') : '', errors ? `${errors} failed` : ''].filter(Boolean).join(', ');
  return [
    `${plural(calls, 'MCP call')} in this claude session${more ? ` (${more})` : ''}`,
    servers.length > 1 ? `Most called: ${servers[0].server}, ${servers[0].calls}×` : '',
    'Show the calls by server and tool, with failures and times',
  ].filter(Boolean).join('\n');
}

/**
 * @param {HTMLElement} el
 * @param {RunnerTurns} data
 * @param {{ ctx: DevContext, known: RunnerSkills | null, close: () => void, browse: () => void }} deps
 *   known: the skills read for the Skills side panel; browse opens that panel.
 */
export function drawSkills(el, data, { ctx, known, close, browse }) {
  const { rows, uses, ran } = skillsOf(data);
  const most = rows[0]?.uses ?? 0;
  /** @type {Map<string, RunnerSkill & { from: string }>} */
  const byName = new Map();
  // The project's skill wins over the user's of the same name, as in Claude Code.
  for (const s of known?.global ?? []) byName.set(s.name, { ...s, from: 'Your skill' });
  for (const s of known?.project ?? []) byName.set(s.name, { ...s, from: `${baseName(known?.root ?? '') || 'Project'} skill` });
  const used = new Set(rows.map((r) => r.name));
  const unused = (known?.project ?? []).filter((s) => !used.has(s.name));
  const last = [...rows].filter((r) => r.last).sort((a, b) => b.last - a.last)[0];
  const available = known ? [known.global.length ? `${known.global.length} yours` : '', known.project.length ? `${known.project.length} in ${baseName(known.root) || 'the project'}` : ''].filter(Boolean).join(' · ') : '';
  const type = (/** @type {string} */ name) => {
    close();
    ctx.typeInTerminal(`/${name} `);
  };

  redraw(el, { rows, known, turns: data.turns.length }, () => [
    h('div', { class: 'turns-head' },
      h('div', { class: 'turns-title' },
        icon('zap'),
        h('strong', null, 'Skills'),
        h('span', { class: 'muted' }, rows.length ? `${plural(uses, 'use')} · ${plural(rows.length, 'skill')}` : 'None run yet')),
      factList([
        ['Ran in', rows.length && data.turns.length ? `${ran} of ${plural(data.turns.length, 'turn')}` : ''],
        ['Last run', last ? `/${last.name}, ${lastText(last.turns, last.last)}` : ''],
        ['Available', available],
      ])),
    h('div', { class: 'turns-list', role: 'list' },
      rows.length ? rows.map(skillRow) : h('p', { class: 'muted small uses-empty' }, 'No skill run yet.'),
      unused.length ? [
        h('div', { class: 'muted small uses-section' }, `Not run yet · ${baseName(known?.root ?? '') || 'project'} skills`),
        unused.slice(0, UNUSED_SHOWN).map(unusedRow),
      ] : null,
      known ? h('button', { type: 'button', class: 'turns-row uses-more', onclick: () => { close(); browse(); } },
        h('div', { class: 'turns-line' },
          h('span', { class: 'turns-icon' }, icon('chevron-right')),
          h('span', { class: 'turns-text' }, unused.length > UNUSED_SHOWN ? `${unused.length - UNUSED_SHOWN} more, and yours: open the Skills panel` : 'Browse every skill in the Skills panel'))) : null),
  ]);

  /** @param {string} name @returns {MenuEntry[]} */
  function menuOf(name) {
    const file = byName.get(name)?.path;
    return [
      { label: 'Type in the terminal', icon: () => icon('terminal'), onSelect: () => type(name) },
      ...(file ? [{ label: 'Open its SKILL.md', icon: () => icon('file'), onSelect: () => { close(); openFile(ctx, file); } }] : []),
      '-',
      copyItem('Copy command', `/${name}`),
    ];
  }

  /** @param {SessionSkillRow} r */
  function skillRow(r) {
    const meta = byName.get(r.name);
    // A plugin's skill is named <plugin>:<skill>; one in neither folder came with Claude Code or a plugin.
    const from = meta?.from ?? (r.name.includes(':') ? `${r.name.split(':')[0]} plugin` : known ? 'Bundled or from a plugin' : '');
    return onContextMenu(h('button', {
      type: 'button',
      class: 'turns-row uses-row',
      role: 'listitem',
      title: `${meta?.description ? `${meta.description}\n\n` : ''}Click to type /${r.name} in the terminal`,
      onclick: () => type(r.name),
    },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-icon' }, icon('zap')),
      h('span', { class: 'turns-text uses-name' }, `/${r.name}`),
      h('span', { class: 'turns-took' }, `${r.uses}×`)),
    h('div', { class: 'turns-bar', 'aria-hidden': 'true' },
      h('span', { class: 'turns-seg work', style: { flexGrow: String(r.uses) } }),
      h('span', { class: 'turns-seg rest', style: { flexGrow: String(most - r.uses) } })),
    h('div', { class: 'muted small turns-meta' },
      meta?.description ? h('span', { class: 'uses-about' }, meta.description) : null,
      h('span', null, [from, turnsText(r.turns), r.last ? `last at ${clock(r.last)}` : ''].filter(Boolean).join(' · ')))), () => menuOf(r.name));
  }

  /** @param {RunnerSkill} s */
  function unusedRow(s) {
    return onContextMenu(h('button', {
      type: 'button',
      class: 'turns-row uses-row unused',
      role: 'listitem',
      title: `${s.description ? `${s.description}\n\n` : ''}Click to type /${s.name} in the terminal`,
      onclick: () => type(s.name),
    },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-icon' }, icon('zap')),
      h('span', { class: 'turns-text uses-name' }, `/${s.name}`)),
    s.description ? h('div', { class: 'muted small turns-meta' }, h('span', { class: 'uses-about' }, s.description)) : null), () => menuOf(s.name));
  }
}

/** @param {HTMLElement} el @param {RunnerTurns} data */
export function drawMcp(el, data) {
  const { servers, tools, calls, errors, ms, agents } = mcpOf(data);
  const all = sessionTools(data.turns, data.agentTools).calls;
  const most = servers[0]?.calls ?? 0;
  const flat = servers.flatMap((s) => s.tools);
  const slowest = [...flat].filter((t) => t.ms).sort((a, b) => b.ms / b.calls - a.ms / a.calls)[0];
  const failing = [...flat].sort((a, b) => b.errors - a.errors)[0];
  const last = [...flat].filter((t) => t.last).sort((a, b) => b.last - a.last)[0];
  const nameOf = (/** @type {SessionMcpTool} */ t) => (t.tool ? `${t.server} · ${t.tool}` : t.server);

  redraw(el, { servers, all }, () => [
    h('div', { class: 'turns-head' },
      h('div', { class: 'turns-title' },
        icon('plug'),
        h('strong', null, 'MCP'),
        h('span', { class: 'muted' }, calls ? `${plural(calls, 'call')} · ${plural(servers.length, 'server')} · ${plural(tools, 'tool')}` : 'None called yet')),
      calls ? h('div', { class: 'muted small turns-sum' },
        h('span', { class: 'turns-key work' }), `${Math.max(0, calls - errors)} succeeded`,
        errors ? [h('span', { class: 'turns-key fail' }), `${errors} failed (${pct(errors, calls)})`] : null,
        ms ? h('span', { class: 'tools-time' }, `${fmtSpan(ms)} in calls`) : null) : null,
      factList([
        ['Share', calls && all >= calls ? `${pct(calls, all)} of the session’s ${plural(all, 'tool call')}` : ''],
        ['By', agents ? `claude ${calls - agents} · its subagents ${agents}` : ''],
        ['Last call', last ? `${nameOf(last)}, ${lastText(last.turns, last.last)}` : ''],
        ['Slowest', flat.length > 1 && slowest ? `${nameOf(slowest)}, ${perCall(slowest.ms / slowest.calls)} a call` : ''],
        ['Most failures', flat.length > 1 && failing?.errors ? `${nameOf(failing)}, ${failing.errors} of its ${plural(failing.calls, 'call')}` : ''],
      ])),
    servers.length
      ? h('div', { class: 'turns-list', role: 'list' }, servers.map((s) => [serverRow(s), s.tools.map(toolRow)]))
      : h('p', { class: 'muted small agents-empty' }, 'No MCP tool called yet.'),
  ]);

  /** @param {{ calls: number, errors: number, ms: number, agents: number }} r */
  function numbers(r) {
    return [
      r.errors ? `${r.errors} failed (${pct(r.errors, r.calls)})` : '',
      r.agents ? `${r.agents} by subagents` : '',
      r.ms ? `${perCall(r.ms / r.calls)} a call` : '',
      r.ms >= 1000 && r.calls > 1 ? `${fmtSpan(r.ms)} in all` : '',
    ];
  }

  /** @param {SessionMcpServer} s */
  function serverRow(s) {
    return h('div', { class: 'turns-row tool-row uses-server', role: 'listitem' },
      h('div', { class: 'turns-line' },
        h('span', { class: 'turns-icon' }, icon('plug')),
        h('span', { class: 'turns-text' }, s.server),
        h('span', { class: 'turns-took' }, `${s.calls}×`)),
      h('div', { class: 'turns-bar', 'aria-hidden': 'true' },
        h('span', { class: 'turns-seg work', style: { flexGrow: String(Math.max(0, s.calls - s.errors)) } }),
        s.errors ? h('span', { class: 'turns-seg fail', style: { flexGrow: String(s.errors) } }) : null,
        h('span', { class: 'turns-seg rest', style: { flexGrow: String(most - s.calls) } })),
      h('div', { class: 'muted small turns-meta' },
        h('span', null, [`${pct(s.calls, calls)} of the MCP calls`, plural(s.tools.length, 'tool'), ...numbers(s)].filter(Boolean).join(' · '))));
  }

  /** @param {SessionMcpTool} t */
  function toolRow(t) {
    const meta = [...numbers(t), turnsText(t.turns), t.last ? `last at ${clock(t.last)}` : ''].filter(Boolean).join(' · ');
    return onContextMenu(h('button', {
      type: 'button',
      class: `turns-row uses-row uses-tool${t.errors ? ' failing' : ''}`,
      role: 'listitem',
      title: `${t.name}\n\nClick to copy the tool’s name`,
      onclick: () => { navigator.clipboard.writeText(t.name).then(() => toast('Tool name copied'), () => toast('Could not copy')); },
    },
    h('div', { class: 'turns-line' },
      h('span', { class: 'turns-text uses-name' }, t.tool || t.server),
      h('span', { class: 'turns-took' }, `${t.calls}×`)),
    meta ? h('div', { class: 'muted small turns-meta' }, h('span', null, meta)) : null), () => [copyItem('Copy tool name', t.name), copyItem('Copy server name', t.server)]);
  }
}
