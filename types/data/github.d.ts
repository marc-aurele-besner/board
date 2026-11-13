// github.json: open issues and PRs of every project's repos (js/github.js) and PR preview links (js/previews.js).

// An open issue or PR.
export interface GithubItem {
  number: number;
  title: string;
  pr: boolean;
  updated: string;
  author: string;
  labels: string[];
}

// A repo's last read. A repo whose reads all failed has only `error` and `failedAt`.
export interface RepoStats {
  at?: number;
  issues?: number;
  prs?: number;
  // The newest open issues and PRs.
  items?: GithubItem[];
  error: string | null;
  // Time (ms) of the last failed read; the counts of the last good one stay.
  failedAt?: number;
}

export interface PreviewItem {
  // 'vercel' or 'netlify'.
  provider: string;
  // The provider's project or site; may be empty.
  name: string;
  url: string;
  // 'ready', 'queued', 'building', 'failed', 'canceled' or ''.
  state: string;
  // The fields below come only from the provider's API (js/deployments.js), read with a Vercel or Netlify token.
  // The Vercel deployment ('dpl_…') or Netlify deploy; with it, the board can read the build log.
  id?: string;
  // The Vercel team of the project; missing for a personal project.
  team?: string;
  // The Netlify site.
  site?: string;
  // The deployment's page on Vercel or Netlify.
  inspect?: string;
  // Why the build failed or was canceled.
  error?: string;
  // The commit deployed.
  sha?: string;
  // Times (ms) the deployment was created and became ready.
  created?: number;
  ready?: number;
}

export interface PrPreviews {
  items?: PreviewItem[];
  error: string | null;
  at: number;
  // Time (ms) of the first read.
  first: number;
  // The PR's head branch, read once a Vercel or Netlify token is set.
  branch?: string;
}

// Whether an issue or PR linked to a task is open (js/link-states.js).
export interface LinkState {
  // 'open', 'merged' or 'closed' for a PR; 'open', 'completed' or 'not_planned' for an issue; '' before a good read.
  state: string;
  error: string | null;
  at: number;
}

export interface GithubData {
  // By "owner/repo".
  repos: Record<string, RepoStats>;
  // By "owner/repo#number", the repo in lower case.
  previews?: Record<string, PrPreviews>;
  // By "owner/repo#number", the repo in lower case.
  links?: Record<string, LinkState>;
  schemaVersion?: number;
}
