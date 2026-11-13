// linkedin.json without the DOM: LinkedIn's posts, comments, official sign-in and the saved session's call queue state.
// Follower counts stay in socials.json (js/socials.js). The runners import this file.
/** @import { LinkedinData } from '../types/data' */

export const LINKEDIN = 'linkedin';
/** @type {LinkedinData} */
export const LINKEDIN_DEFAULTS = { auth: null, posts: [], comments: [], cache: {}, session: { calls: {} } };
