// linkedin.json: LinkedIn beyond follower counts (those stay in socials.json). The official sign-in that posts as the
// member, the posts written in the board (drafts, scheduled, posted) and what the runners read of them through the
// saved session (results, comments), and that session's call queue: its saved answers and calls per day.

// The official sign-in ("Sign In with LinkedIn" and "Share on LinkedIn"), done with the app in Settings → LinkedIn.
// Its token lasts 60 days and cannot be renewed without signing in again.
export interface LinkedinAuth {
  token: string;
  // When the token stops working (ms).
  expires: number;
  // The member's id from the OpenID userinfo (`sub`); posts are authored by `urn:li:person:<sub>`.
  sub: string;
  name?: string;
  picture?: string;
  // When the sign-in happened (ms).
  at: number;
}

// One read of a post's results.
export interface LinkedinPostMetrics {
  at: number;
  reactions?: number;
  comments?: number;
  reposts?: number;
  // Only when LinkedIn's answer has it.
  impressions?: number;
}

export interface LinkedinPost {
  id: string;
  // The task it was written from, and its project.
  taskId?: string | null;
  projectId?: string | null;
  text: string;
  // A link shared with the post.
  link?: string;
  // 'draft', 'scheduled', 'posting', 'posted', 'failed' or 'missed' (scheduled, but more than 12 h late).
  status: string;
  // When it should be posted (ms).
  scheduledAt?: number | null;
  postedAt?: number | null;
  // The post's URN once posted ('urn:li:share:…' or 'urn:li:ugcPost:…'), and its page.
  urn?: string;
  url?: string;
  error?: string | null;
  createdAt: number;
  updatedAt?: number;
  // Results read after 1 hour, 24 hours and 7 days, oldest first.
  metrics?: LinkedinPostMetrics[];
}

// A comment on one of the member's posts, read through the session.
export interface LinkedinComment {
  // LinkedIn's comment URN.
  id: string;
  postId: string;
  postUrn: string;
  author: string;
  authorHeadline?: string;
  authorUrl?: string;
  text: string;
  at: number;
  read: boolean;
  // A task made from it.
  taskId?: string | null;
}

// A session answer kept so the same question is not asked again for a while.
export interface LinkedinCacheEntry {
  at: number;
  value: unknown;
}

export interface LinkedinSessionState {
  // Local day (YYYY-MM-DD) -> calls made through the session that day.
  calls: Record<string, number>;
  // Set when LinkedIn signed the session out (302, 401, 999): every session read stops until it is saved again.
  expiredAt?: number | null;
  error?: string | null;
  lastCallAt?: number;
}

export interface LinkedinData {
  auth?: LinkedinAuth | null;
  posts: LinkedinPost[];
  comments: LinkedinComment[];
  // Cache key (what was asked) -> the answer.
  cache: Record<string, LinkedinCacheEntry>;
  session: LinkedinSessionState;
  schemaVersion?: number;
}
