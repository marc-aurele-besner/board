// socials.json: the X, LinkedIn and GitHub accounts added in Settings, and their follower counts over time. The board adds
// and removes accounts; the runners (tools/jobs/socials.js) read each one's counts.

export interface SocialAccount {
  id: string;
  // 'x', 'linkedin' or 'github'.
  network: string;
  // X: the screen name, without @. LinkedIn: the profile's path, 'in/<name>' or 'company/<name>'. GitHub: the user or
  // organization login.
  handle: string;
  projectId?: string | null;
  // From the last read: the display name, the picture, the counts.
  name?: string;
  image?: string;
  followers?: number;
  following?: number;
  // GitHub: the stars of all the account's public repos, forks left out.
  stars?: number;
  // When the counts were last read (ms), and why the last read failed.
  at?: number;
  error?: string | null;
}

export interface SocialsData {
  accounts: SocialAccount[];
  // Account id -> local day (YYYY-MM-DD) -> followers that day, the day's last read.
  history: Record<string, Record<string, number>>;
  // GitHub accounts: account id -> local day -> stars that day.
  stars?: Record<string, Record<string, number>>;
  schemaVersion?: number;
}
