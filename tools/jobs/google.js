// Renews every Google sign-in's access token before it expires, so the board's tabs and the other jobs always find a
// live one in google.json. Only this job renews: a tab that finds a token expired asks it (POST /run/google { key }).
// A sign-in Google refuses for good (invalid_grant) is marked removed, and Settings shows "Connect again".
import { bindGoogleStore, useRenewer, renewToken, googleData, tokenFresh, EARLY } from '../../js/google-core.js';

export default {
  id: 'google',
  delay: 500, // first: the jobs started next read with these tokens
  timeout: 60000,
  setup(store) {
    bindGoogleStore(store);
    useRenewer((key) => renewToken(key));
  },
  async run({ params }) {
    if (params.key) {
      await renewToken(params.key);
      return { renewed: 1 };
    }
    const live = Object.entries(googleData().tokens).filter(([, t]) => t?.refresh);
    if (!live.length) return { waiting: 'No Google account is connected.' };
    const due = live.filter(([key]) => !tokenFresh(key, 2 * EARLY));
    const failed = [];
    for (const [key] of due) {
      try {
        await renewToken(key);
      } catch (err) {
        failed.push(`${key}: ${err.message}`);
      }
    }
    if (failed.length && failed.length === due.length) throw new Error(failed.join('; '));
    return { renewed: due.length - failed.length, warning: failed.join('; ') || null };
  },
};
