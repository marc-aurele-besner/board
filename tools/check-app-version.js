// The rules of js/app-version-core.js: when a tab is current, asked to reload, or made to.
// `node tools/check-app-version.js`: exits 1 when a rule is broken.
import { updateState, snoozed, silentReloadOk, mayAutoReload, isVersionInfo, STALE_FORCE_MS, SILENT_AFTER_MS, LOOP_GUARD_MS } from '../js/app-version-core.js';

let failed = 0;
/** @param {boolean} ok @param {string} text */
const expect = (ok, text) => {
  if (!ok) failed += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${text}`);
};

const now = 1_000_000_000_000;
const client = { version: 'a', epoch: 1 };
const server = { version: 'b', epoch: 1, builtAt: now };

expect(updateState(client, { ...server, version: 'a' }, { now, staleSince: null }).kind === 'current', 'same version is current');
expect(updateState(client, server, { now, staleSince: now }).kind === 'available', 'another version is available');
const epoch = updateState(client, { ...server, epoch: 2 }, { now, staleSince: null });
expect(epoch.kind === 'required' && epoch.reason === 'epoch', 'a higher epoch is required');
expect(updateState(client, { ...server, epoch: 0 }, { now, staleSince: now }).kind === 'available', 'a lower epoch is only available');
expect(updateState(client, server, { now, staleSince: now - STALE_FORCE_MS }).kind === 'available', 'stale for exactly a day is still available');
const age = updateState(client, server, { now, staleSince: now - STALE_FORCE_MS - 1 });
expect(age.kind === 'required' && age.reason === 'age', 'stale for over a day is required');

expect(isVersionInfo(server) && !isVersionInfo({ version: 'b' }) && !isVersionInfo(null), 'only a full answer is a version');

expect(!snoozed(null, now) && snoozed(now + 1, now) && !snoozed(now, now), 'snooze lasts until its time');

expect(silentReloadOk({ hiddenFor: SILENT_AFTER_MS, busy: false }), 'a long hidden idle tab reloads quietly');
expect(!silentReloadOk({ hiddenFor: SILENT_AFTER_MS - 1, busy: false }), 'a quick switch never reloads');
expect(!silentReloadOk({ hiddenFor: SILENT_AFTER_MS * 10, busy: true }), 'a busy tab never reloads quietly');

expect(mayAutoReload(null, now) && mayAutoReload(now - LOOP_GUARD_MS - 1, now), 'a first or late reload goes ahead');
expect(!mayAutoReload(now - 1000, now), 'a reload right after one waits for a click');

if (failed) {
  console.log(`${failed} failed`);
  process.exit(1);
}
