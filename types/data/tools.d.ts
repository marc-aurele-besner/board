// tools.json: the Tools section's site checks and provider status (js/automations.js, js/sitecheck.js, js/modules/tools.js).
// A lookup that fails is saved as { error, at }, or keeps the last good answer with `error` added, so the
// fields of each check are optional.

// A format check of a crawl file: [level ('ok' | 'warn' | 'error'), text]. An array, not a tuple, as JSON imports widen it.
export type CrawlCheck = string[];

export interface SiteHealth {
  // 'up' | 'slow' | 'down'
  status: string;
  ms: number;
  at: string;
}

export interface HealthSample {
  at: string;
  ok: boolean;
  ms: number;
}

export interface SiteSsl {
  // YYYY-MM-DD
  until?: string;
  issuer?: string;
  error?: string;
  at: string;
}

export interface SiteDomain {
  // The registrable domain.
  name?: string;
  // YYYY-MM-DD
  until?: string;
  registrar?: string;
  error?: string;
  at: string;
}

// The share tags of the home page.
export interface SiteMeta {
  title?: string;
  description?: string;
  ogTitle?: string;
  ogDescription?: string;
  ogImage?: string;
  ogUrl?: string;
  twitterCard?: string;
  twitterImage?: string;
  error?: string;
  at: string;
}

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export interface SiteDns {
  domain?: string;
  a?: string[];
  aaaa?: string[];
  caa?: string[];
  records?: DnsRecord[];
  ns?: string[];
  // Mail hosts, lowest preference first.
  mx?: string[];
  spf?: { record: string; all: string };
  dmarc?: { record: string; policy: string };
  // DKIM selectors that have a key.
  dkim?: string[];
  error?: string;
  at: string;
}

// One file of the crawl check (robots.txt, sitemap, llms.txt, ...).
export interface CrawlFile {
  url: string;
  found: boolean;
  // HTTP status; missing when the reader could not fetch the file.
  status?: number;
  // Why the reader could not fetch the file.
  unread?: string;
  // Why an answer did not count as the file.
  note?: string;
  // The start of the file.
  raw?: string;
  checks?: CrawlCheck[];
  size?: number;
}

export interface RobotsFile extends CrawlFile {
  sitemaps: string[];
  blocksSearch: boolean;
  blocksAll: boolean;
  // AI crawlers the file blocks.
  aiBlocked: string[];
}

export interface SitemapFile extends CrawlFile {
  urls?: number;
  indexes?: number;
  // YYYY-MM-DD, or ''.
  lastmod?: string;
}

export interface LlmsFile extends CrawlFile {
  title?: string;
}

export interface SecurityFile extends CrawlFile {
  contact?: string[];
  expires?: string;
}

// Files read before a kind was added have no entry for it.
export interface SiteCrawl {
  robots?: RobotsFile;
  sitemap?: SitemapFile;
  llms?: LlmsFile;
  llmsFull?: CrawlFile;
  security?: SecurityFile;
  humans?: CrawlFile;
  ads?: CrawlFile;
  manifest?: CrawlFile;
  aasa?: CrawlFile;
  assetlinks?: CrawlFile;
  error?: string;
  at: string;
}

export interface SiteLogEntry {
  at: string;
  // 'info' | 'warn' | 'error'
  level: string;
  // The check: 'health', 'ssl', 'domain', 'meta', 'dns' or 'crawl'.
  source: string;
  text: string;
}

// What the checks found for one project's website. Each part appears once that check has run.
export interface Site {
  health?: SiteHealth;
  // The last health checks, oldest first.
  history?: HealthSample[];
  ssl?: SiteSsl;
  domain?: SiteDomain;
  meta?: SiteMeta;
  dns?: SiteDns;
  crawl?: SiteCrawl;
  log?: SiteLogEntry[];
}

// A followed status page.
export interface Provider {
  id: string;
  name: string;
  url: string;
  // 'statuspage' | 'datadog'; learned on the first read when missing.
  kind?: string;
}

export interface StatusComponent {
  name: string;
  status: string;
}

export interface StatusIncident {
  name: string;
  impact: string;
  status: string;
  url: string;
  started: string;
  updated: string;
  // The latest update's text, clipped.
  update: string;
}

export interface StatusMaintenance {
  name: string;
  status: string;
  start: string;
  end: string;
  url: string;
}

// A resolved incident.
export interface StatusRecent {
  name: string;
  impact: string;
  at: string;
  url: string;
}

// The last read of a provider's status page.
export interface ProviderStatus {
  // 'none' | 'minor' | 'major' | 'critical' | 'maintenance'
  indicator?: string;
  description?: string;
  parts?: { total: number; ok: number };
  // The parts that are not operational.
  components?: StatusComponent[];
  // Open incidents.
  incidents?: StatusIncident[];
  maintenances?: StatusMaintenance[];
  // Incidents resolved in the last 30 days, newest first (a few kept).
  recent?: StatusRecent[];
  // null when the incident history could not be read.
  recentCount?: number | null;
  kind?: string;
  error?: string;
  at: string;
}

// A key and value of a request's params, headers or form body. `on: false` keeps the row without sending it.
export interface RequestPair {
  key: string;
  value: string;
  on?: boolean;
}

export interface RequestAuth {
  // 'none' | 'bearer' | 'basic'
  type: string;
  token?: string;
  user?: string;
  pass?: string;
}

// A saved request of Tools → Requests (js/http-request.js).
export interface ApiRequest {
  id: string;
  name: string;
  projectId: string | null;
  method: string;
  url: string;
  params: RequestPair[];
  headers: RequestPair[];
  // 'none' | 'json' | 'text' | 'form' | 'graphql'. For 'graphql', `body` is the query.
  bodyType: string;
  body: string;
  // A GraphQL request's variables, as JSON text. Missing in requests saved before GraphQL.
  variables?: string;
  form: RequestPair[];
  auth: RequestAuth;
}

export interface ToolsData {
  // Project id -> what the checks found for its website.
  sites: Record<string, Site>;
  // Minutes between automatic checks.
  every: number;
  providers: Provider[];
  // Provider id -> its last status.
  status: Record<string, ProviderStatus>;
  // Tools → Requests: the saved requests. Missing in files saved before it.
  requests?: ApiRequest[];
  // Written by the store on save.
  schemaVersion?: number;
}
