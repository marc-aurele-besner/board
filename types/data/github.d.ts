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
  // 'ready', 'building', 'failed', 'canceled' or ''.
  state: string;
}

export interface PrPreviews {
  items?: PreviewItem[];
  error: string | null;
  at: number;
  // Time (ms) of the first read.
  first: number;
}

export interface GithubData {
  // By "owner/repo".
  repos: Record<string, RepoStats>;
  // By "owner/repo#number", the repo in lower case.
  previews?: Record<string, PrPreviews>;
  schemaVersion?: number;
}
