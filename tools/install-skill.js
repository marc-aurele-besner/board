// `bun run install-skill`: links the board-tasks skill into ~/.claude/skills, so Claude Code sessions the board
// starts in Dev know how to list, add and edit their tasks (tools/board.js). Run it from the checkout the board runs
// from: the link points at this checkout's skills/ folder.
import { installSkill } from './board-skill.js';

const status = await installSkill();
if (status.state === 'installed') console.log(`The board-tasks skill is installed: ${status.path} → ${status.source}`);
else {
  console.error(`${status.path} already exists${status.points ? ` and points at ${status.points}` : ''}. Remove it, then run this again.`);
  process.exit(1);
}
