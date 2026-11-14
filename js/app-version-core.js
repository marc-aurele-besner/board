// When an open tab runs older code than the folder on disk, and what it should do about it. No DOM: tools/serve.js
// reads APP_EPOCH from this file, and tools/check-app-version.js checks the rules under Node.

// Bump it in the same commit as a change that older tabs must not keep running, such as a new shape of a data file
// that an old tab would save back in its old shape. Every tab loaded before the bump is then made to reload.
export const APP_EPOCH = 1;

// A tab that has known of a newer version for this long is reloaded, so a tab left open for days catches up.
export const STALE_FORCE_MS = 24 * 60 * 60 * 1000;
// "Later" on the banner hides it for this long.
export const SNOOZE_MS = 30 * 60 * 1000;
// A tab hidden at least this long is reloaded quietly when it shows again, so a quick switch never reloads it.
export const SILENT_AFTER_MS = 10 * 60 * 1000;
// A second reload this soon after one the board made by itself waits for a click, so a broken version cannot loop.
export const LOOP_GUARD_MS = 30 * 1000;

/** @typedef {{ version: string, epoch: number, builtAt: number }} VersionInfo what GET /version answers */
/**
 * @typedef {{ kind: 'current' }
 *   | { kind: 'available' }
 *   | { kind: 'required', reason: 'epoch' | 'age' }} UpdateState
 */

/**
 * @param {{ version: string, epoch: number }} client what this tab loaded
 * @param {VersionInfo} server what is on disk now
 * @param {{ now: number, staleSince: number | null }} ctx staleSince: when this tab first saw a newer version
 * @returns {UpdateState}
 */
export function updateState(client, server, { now, staleSince }) {
  // The epoch is the code's own, so it counts even when the tab's first check already saw the newer files.
  if (server.epoch > client.epoch) return { kind: 'required', reason: 'epoch' };
  if (server.version === client.version) return { kind: 'current' };
  if (staleSince !== null && now - staleSince > STALE_FORCE_MS) return { kind: 'required', reason: 'age' };
  return { kind: 'available' };
}

/** @param {unknown} value @returns {value is VersionInfo} */
export const isVersionInfo = (value) => {
  const v = /** @type {Record<string, unknown> | null} */ (value);
  return Boolean(v) && typeof v?.version === 'string' && typeof v.epoch === 'number' && typeof v.builtAt === 'number';
};

/** @param {number | null} until @param {number} now */
export const snoozed = (until, now) => until !== null && now < until;

/**
 * Whether a tab that shows again may be reloaded without asking.
 * @param {{ hiddenFor: number, busy: boolean }} tab
 */
export const silentReloadOk = ({ hiddenFor, busy }) => !busy && hiddenFor >= SILENT_AFTER_MS;

/** @param {number | null} lastAutoReload @param {number} now */
export const mayAutoReload = (lastAutoReload, now) => lastAutoReload === null || now - lastAutoReload > LOOP_GUARD_MS;
