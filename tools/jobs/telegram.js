// Listens for messages to the bot and turns them into tasks. Nothing else reads the bot once setup is done, so it
// long-polls: Telegram holds each request open up to WAIT seconds and answers as soon as a message arrives, and the
// next request starts at once. Setup (Settings → Telegram → Find my chat) reads the bot only while no chat is saved,
// and this job only once one is, so the two never read at the same time.
/** @import { Job } from '../../types/runner' */
import { pollTelegram, hasTelegram } from '../../js/telegram.js';

const WAIT = 25;

export default /** @satisfies {Job} */ ({
  id: 'telegram',
  delay: 1500,
  timeout: (WAIT + 20) * 1000,
  loop: true,
  quiet: true, // a log line per empty poll would drown the rest
  async run({ store, signal }) {
    if (!hasTelegram(store)) {
      // Nothing to read: check again in a while rather than spin.
      await new Promise((resolve) => setTimeout(resolve, 30000));
      return { waiting: 'No bot and chat are set up.' };
    }
    // pollTelegram() is not typed yet: its options read as only { wait }.
    const made = await pollTelegram(store, /** @type {Parameters<typeof pollTelegram>[1]} */ ({ wait: WAIT, signal }));
    return made ? { added: made } : {};
  },
});
