// The board-tasks skill (skills/board-tasks): installed for Claude Code as a link from ~/.claude/skills/board-tasks to
// this checkout's folder, so a pull updates it. Used by `bun run install-skill` and by Settings → Coding Agents
// through the command runner (GET /board-skill, POST /board-skill/install).
import { lstat, mkdir, readlink, symlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SKILL_NAME = 'board-tasks';
const SOURCE = fileURLToPath(new URL(`../skills/${SKILL_NAME}`, import.meta.url)).replace(/[\\/]$/, '');
const TARGET = join(homedir(), '.claude', 'skills', SKILL_NAME);

/** @param {string} path */
const tilde = (path) => (path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

// 'installed' (the link points here), 'other' (something else has the name: another checkout, or a folder),
// or 'missing'.
/** @returns {Promise<{ state: 'installed' | 'other' | 'missing', path: string, source: string, points?: string }>} */
export async function skillStatus() {
  const base = { path: tilde(TARGET), source: tilde(SOURCE) };
  const info = await lstat(TARGET).catch(() => null);
  if (!info) return { state: 'missing', ...base };
  if (!info.isSymbolicLink()) return { state: 'other', ...base };
  const points = resolve(dirname(TARGET), await readlink(TARGET));
  return points === SOURCE ? { state: 'installed', ...base } : { state: 'other', ...base, points: tilde(points) };
}

// Links the skill in. Anything else already there is left alone: the answer says what holds the name.
export async function installSkill() {
  const status = await skillStatus();
  if (status.state !== 'missing') return status;
  await mkdir(dirname(TARGET), { recursive: true });
  await symlink(SOURCE, TARGET, 'dir');
  return skillStatus();
}
