// webstats.json: each website's Bing Webmaster data, read by the runners (js/webstats.js, tools/jobs/webstats.js).
// The rows are Bing's own, as it sends them.

// A day of traffic.
export interface BingTrafficRow {
  __type?: string;
  // "/Date(<ms>)/".
  Date: string;
  Clicks: number;
  Impressions: number;
}

// A week of one query, or of one page (whose URL is in `Query` too).
export interface BingQueryRow extends BingTrafficRow {
  Query: string;
  AvgClickPosition: number;
  AvgImpressionPosition: number;
}

// A site's last read. A site whose reads all failed has only `error`.
export interface BingSiteStats {
  at?: number;
  traffic?: BingTrafficRow[];
  queries?: BingQueryRow[];
  pages?: BingQueryRow[];
  error: string | null;
}

export interface WebstatsData {
  // By website URL.
  bing: Record<string, BingSiteStats>;
  schemaVersion?: number;
}
