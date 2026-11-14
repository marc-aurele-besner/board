// `bun run login-agent [install|uninstall|status|print]`: a launchd agent (macOS) that runs `bun start` from this checkout
// at login and starts it again if it exits, so the installed app never opens on a dead server. It logs to
// ~/Library/Logs/board.log. Run it from the checkout the board runs from, with the PATH the board's terminals need:
// launchd starts the agent with that PATH and SHELL, written into the plist now, since it reads no shell profile.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.board.start';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library', 'Logs', 'board.log');
const DOMAIN = `gui/${process.getuid?.() ?? ''}`;

if (process.platform !== 'darwin') {
  console.error('The login agent uses launchd, which is macOS only.');
  process.exit(1);
}

/** @param {string} text */
const xml = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** @param {string[]} args */
const launchctl = (args) => {
  try {
    return { ok: true, out: execFileSync('launchctl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (error) {
    return { ok: false, out: String(/** @type {any} */ (error).stderr || error) }; // any: execFileSync's error carries stderr
  }
};

/** The bun binary: this process when run with bun, else the first on PATH. */
const bunPath = () => {
  if (process.versions.bun) return process.execPath;
  try {
    return execFileSync('/usr/bin/which', ['bun'], { encoding: 'utf8' }).trim();
  } catch {
    console.error('bun was not found on PATH.');
    process.exit(1);
  }
};

const plist = () => {
  /** @type {Record<string, string>} */
  const env = { PATH: process.env.PATH || '/usr/bin:/bin:/usr/sbin:/sbin', SHELL: process.env.SHELL || '/bin/zsh', HOME: homedir() };
  for (const key of ['LANG', 'PORT', 'TERMINAL_PORT', 'WORKER_PORT', 'BOARD_DATA']) if (process.env[key]) env[key] = /** @type {string} */ (process.env[key]);
  const vars = Object.entries(env).map(([key, value]) => `    <key>${key}</key><string>${xml(value)}</string>`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(bunPath())}</string>
    <string>tools/start.js</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
${vars}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key><string>${xml(LOG)}</string>
  <key>StandardErrorPath</key><string>${xml(LOG)}</string>
</dict>
</plist>
`;
};

const unload = () => launchctl(['bootout', `${DOMAIN}/${LABEL}`]);

const command = process.argv[2] || 'install';
if (command === 'install') {
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  unload(); // a reinstall replaces the running one
  writeFileSync(PLIST, plist());
  const result = launchctl(['bootstrap', DOMAIN, PLIST]);
  if (!result.ok) {
    console.error(`launchctl bootstrap failed: ${result.out.trim()}`);
    process.exit(1);
  }
  console.log(`Installed ${PLIST}\nIt runs bun start from ${ROOT} now and at every login, and restarts it if it exits.\nLogs: ${LOG}`);
  if (ROOT.includes('/.claude/worktrees/')) console.log('Warning: this is a worktree, which may be removed. Run it again from the main checkout.');
  console.log('Stop a bun start or bun dev already running in a terminal first: the ports are taken while it runs.');
} else if (command === 'uninstall') {
  unload();
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`Removed ${LABEL}; the board's servers stop now and no longer start at login.`);
} else if (command === 'print') {
  process.stdout.write(plist());
} else if (command === 'status') {
  const result = launchctl(['print', `${DOMAIN}/${LABEL}`]);
  if (!result.ok) console.log(existsSync(PLIST) ? `${PLIST} exists but is not loaded.` : 'Not installed.');
  else {
    const line = (/** @type {string} */ key) => result.out.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1] ?? '-';
    console.log(`state: ${line('state')}\npid: ${line('pid')}\nlast exit: ${line('last exit code')}\nruns: ${line('runs')}\nlog: ${LOG}`);
  }
} else {
  console.error('Usage: bun run login-agent [install|uninstall|status|print]');
  process.exit(1);
}
