// socials.json: the X and LinkedIn accounts added in Settings, and their follower counts over time. The board adds
// and removes accounts; the runners (tools/jobs/socials.js) read each one's counts.

export interface SocialAccount {
  id: string;
  // 'x' or 'linkedin'.
  network: string;
  // X: the screen name, without @. LinkedIn: the profile's path, 'in/<name>' or 'company/<name>'.
  handle: string;
  projectId?: string | null;
  // From the last read: the display name, the picture, the counts.
  name?: string;
  image?: string;
  followers?: number;
  following?: number;
  // When the counts were last read (ms), and why the last read failed.
  at?: number;
  error?: string | null;
}

export interface SocialsData {
  accounts: SocialAccount[];
  // Account id -> local day (YYYY-MM-DD) -> followers that day, the day's last read.
  history: Record<string, Record<string, number>>;
  schemaVersion?: number;
}
