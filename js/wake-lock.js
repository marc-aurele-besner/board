// Keeps the screen on while the board is open and visible, when the user turns it on in Settings → Appearance.
// The browser drops the lock whenever the tab is hidden, so it is asked for again on each return to the tab.

export const KEEP_AWAKE_KEY = 'board:keep-awake'; // unset: off; '1': on. Saved in this browser, like the theme.

/** @type {WakeLockSentinel | null} */
let sentinel = null;

/** @returns {boolean} */
export function keepAwakeOn() {
  try {
    return localStorage.getItem(KEEP_AWAKE_KEY) === '1';
  } catch {
    return false;
  }
}

/** @returns {boolean} */
export function keepAwakeSupported() {
  return 'wakeLock' in navigator;
}

async function acquire() {
  if (!keepAwakeSupported() || sentinel || document.visibilityState !== 'visible') return;
  try {
    sentinel = await navigator.wakeLock.request('screen');
    // The browser releases the lock itself when the tab hides or the system needs the screen; keep the handle clean.
    sentinel.addEventListener('release', () => {
      sentinel = null;
    });
  } catch {
    // Refused (battery saver, no user activation yet, or the page is not in the foreground): try again on the next visit.
    sentinel = null;
  }
}

async function release() {
  const held = sentinel;
  sentinel = null;
  try {
    await held?.release();
  } catch {
    /* already released */
  }
}

/** @param {boolean} on */
export function setKeepAwake(on) {
  try {
    if (on) localStorage.setItem(KEEP_AWAKE_KEY, '1');
    else localStorage.removeItem(KEEP_AWAKE_KEY);
  } catch {
    /* storage blocked: the choice lasts for this page only */
  }
  if (on) acquire();
  else release();
}

// Call once at startup. Re-takes the lock when the tab comes back to the front, if the option is on.
export function watchKeepAwake() {
  document.addEventListener('visibilitychange', () => {
    if (!keepAwakeOn()) return;
    if (document.visibilityState === 'visible') acquire();
  });
  if (keepAwakeOn()) acquire();
}
