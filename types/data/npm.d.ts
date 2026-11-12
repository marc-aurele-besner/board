// npm.json: the registry reads of every project's npm org and packages (js/npm.js, tools/jobs/npm.js).
// An entry whose reads all failed has only `error` and `failedAt`; a failed read keeps the last good values.

export interface NpmOrg {
  at?: number;
  // Every package the org or user can publish to, sorted.
  packages?: string[];
  error: string | null;
  failedAt?: number;
}

export interface NpmPackage {
  at?: number;
  // The latest version.
  version?: string;
  // When the package last changed (ISO date).
  modified?: string;
  deprecated?: boolean;
  // Downloads last week; null when npm did not say.
  weekly?: number | null;
  error: string | null;
  failedAt?: number;
}

export interface NpmData {
  // By org name.
  orgs: Record<string, NpmOrg>;
  // By package name.
  packages: Record<string, NpmPackage>;
  schemaVersion?: number;
}
