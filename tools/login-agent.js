// `bun run login-agent <command>`: a launchd agent (macOS) that runs the board from this checkout at login and starts
// it again if it exits, so the installed app never opens on a dead server. It runs `bun dev` (tools/dev.js) by default,
// so a `git pull` reloads the static server and the worker on its own; `install start` runs `bun start` instead.
// It logs to ~/Library/Logs/board.log. Run it from the checkout the board runs from, with the PATH the board's
// terminals need: launchd starts the agent with that PATH and SHELL, written into the plist now, since it reads no
// shell profile.
//   install [dev|start]  write the plist and start it now (dev by default)
//   restart              stop and start it again, e.g. after a pull that changed tools/terminal.js (`bun run restart`)
//   stop / start         stop it until the next login or `start`, e.g. to run `bun dev` in a terminal for a while
//   logs                 follow the log (`bun run logs`)
//   status, print, uninstall
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'local.board.start';
const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const PLIST = join(homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library', 'Logs', 'board.log');
const DOMAIN = `gui/${process.getuid?.() ?? ''}`;
const SCRIPTS = { dev: 'tools/dev.js', start: 'tools/start.js' };
const USAGE = 'Usage: bun run login-agent install [dev|start] | restart | stop | start | logs | status | print | uninstall';

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

/** @param {keyof typeof SCRIPTS} mode */
const plist = (mode) => {
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
    <string>${SCRIPTS[mode]}</string>
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

const loaded = () => launchctl(['print', `${DOMAIN}/${LABEL}`]);
const unload = () => launchctl(['bootout', `${DOMAIN}/${LABEL}`]);
/** @param {string} what */
const fail = (what) => {
  console.error(what);
  process.exit(1);
};
const load = () => {
  if (!existsSync(PLIST)) fail('Not installed. Run `bun run login-agent install` first.');
  const result = launchctl(['bootstrap', DOMAIN, PLIST]);
  if (!result.ok) fail(`launchctl bootstrap failed: ${result.out.trim()}`);
};
const ENDS_TERMINALS = "It ends every command running in Dev's terminals, claude sessions included.";

const [command = 'install', arg] = process.argv.slice(2);
if (command === 'install') {
  const mode = arg === 'start' ? 'start' : 'dev';
  if (arg && arg !== mode) fail(USAGE);
  mkdirSync(dirname(PLIST), { recursive: true });
  mkdirSync(dirname(LOG), { recursive: true });
  unload(); // a reinstall replaces the running one
  writeFileSync(PLIST, plist(mode));
  load();
  console.log(`Installed ${PLIST}\nIt runs bun ${mode} from ${ROOT} now and at every login, and restarts it if it exits.\nLogs: ${LOG} (bun run logs)`);
  if (ROOT.includes('/.claude/worktrees/')) console.log('Warning: this is a worktree, which may be removed. Run it again from the main checkout.');
  console.log(`Stop a bun start or bun dev already running in a terminal first: the ports are taken while it runs.`);
} else if (command === 'restart') {
  if (!loaded().ok) load();
  else {
    const result = launchctl(['kickstart', '-k', `${DOMAIN}/${LABEL}`]);
    if (!result.ok) fail(`launchctl kickstart failed: ${result.out.trim()}`);
  }
  console.log(`Restarted. ${ENDS_TERMINALS}`);
} else if (command === 'stop') {
  if (!unload().ok) fail('Not running.');
  console.log('Stopped until the next login or `bun run login-agent start`.');
} else if (command === 'start') {
  if (loaded().ok) console.log('Already running.');
  else {
    load();
    console.log('Started.');
  }
} else if (command === 'logs') {
  mkdirSync(dirname(LOG), { recursive: true });
  if (!existsSync(LOG)) writeFileSync(LOG, '');
  spawn('tail', ['-n', '100', '-F', LOG], { stdio: 'inherit' }).on('exit', (code) => process.exit(code ?? 0));
} else if (command === 'uninstall') {
  unload();
  if (existsSync(PLIST)) unlinkSync(PLIST);
  console.log(`Removed ${LABEL}; the board's servers stop now and no longer start at login.`);
} else if (command === 'print') {
  process.stdout.write(plist(arg === 'start' ? 'start' : 'dev'));
} else if (command === 'status') {
  const result = loaded();
  if (!result.ok) console.log(existsSync(PLIST) ? `${PLIST} exists but is not loaded (bun run login-agent start).` : 'Not installed.');
  else {
    const line = (/** @type {string} */ key) => result.out.match(new RegExp(`^\\s*${key} = (.*)$`, 'm'))?.[1] ?? '-';
    const text = readFileSync(PLIST, 'utf8');
    const mode = text.includes(SCRIPTS.start) ? 'start' : 'dev';
    const dir = text.match(/<key>WorkingDirectory<\/key><string>([^<]*)</)?.[1] ?? '-';
    console.log(`runs: bun ${mode} from ${dir}\nstate: ${line('state')}\npid: ${line('pid')}\nlast exit: ${line('last exit code')}\nlog: ${LOG}`);
  }
} else fail(USAGE);
