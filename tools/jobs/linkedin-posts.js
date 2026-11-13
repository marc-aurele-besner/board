// Posts the LinkedIn posts scheduled from the board once their time comes, every minute, through LinkedIn's API with
// the official sign-in. One more than 12 hours late (the Mac slept) is marked missed instead.
/** @import { Job } from '../../types/runner' */
import { LINKEDIN, postDuePosts } from '../../js/linkedin-core.js';

export default /** @satisfies {Job} */ ({
  id: 'linkedin-posts',
  delay: 6000,
  timeout: 5 * 60000,
  async run({ store }) {
    if (!store.get(LINKEDIN).posts.some((p) => p.status === 'scheduled')) return { waiting: 'No LinkedIn post is scheduled.' };
    return postDuePosts(store);
  },
});
