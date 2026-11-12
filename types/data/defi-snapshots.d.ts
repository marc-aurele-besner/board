// defi-snapshots.json: one entry an hour of what the DeFi reads saved, written only by the runners
// (tools/jobs/defi.js). Hourly entries are kept 90 days, then one a day.

export interface SnapshotPosition {
  usd: number | null;
  inRange: boolean;
  feesUsd: number | null; // unclaimed fees
}

export interface DefiSnapshot {
  at: string; // ISO time
  // Lowercase wallet address -> total USD balance.
  wallets: Record<string, { usd: number }>;
  // Position ref -> its values.
  positions: Record<string, SnapshotPosition>;
  // Lowercase wallet address -> Aave health factor (null with no debt).
  lending: Record<string, { health: number | null }>;
}

export interface DefiSnapshotsData {
  entries: DefiSnapshot[];
  schemaVersion?: number;
}
