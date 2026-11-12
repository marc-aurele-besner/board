// Reads the USD to CAD rates Money needs into fx.json: every day from the oldest entry to today, once (a past day's
// rate never changes). The board asks it for days it lacks (POST /run/fx { from, to }).
/** @import { Job } from '../../types/runner' */
import { useFxStore, fillRates } from '../../js/fx.js';

const today = () => new Date().toISOString().slice(0, 10);

export default /** @satisfies {Job} */ ({
  id: 'fx',
  delay: 7000,
  timeout: 5 * 60000,
  setup(store) {
    useFxStore(store, { direct: true });
  },
  async run({ store, params }) {
    if (params.from && params.to) return { reads: await fillRates(params.from, params.to) };
    const dates = store.get('finance').entries.map((e) => e.date).filter(Boolean).sort();
    if (!dates.length) return { waiting: 'Money has no entries yet.' };
    return { reads: await fillRates(dates[0], today()) };
  },
});
