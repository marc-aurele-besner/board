// settings.json: keys and connections set in Settings (js/modules/settings.js and the js/modules/settings-*.js cards).

// GitHub: the personal token, and a token per organization.
export interface GithubOrgToken {
  org: string;
  token: string;
}

export interface GithubSettings {
  token: string;
  orgs: GithubOrgToken[];
}

export interface OpenRouterSettings {
  key: string;
}

// The Google OAuth client every Google sign-in uses.
export interface GoogleSettings {
  clientId: string;
  clientSecret: string;
}

// A public wallet address followed by the DeFi tabs.
export interface Wallet {
  address: string;
  label: string;
}

// A built-in chain's saved choices, by chain id. Empty strings mean the chain's own nodes and explorer.
export interface ChainChoice {
  // Read by the Liquidity Pools tab; missing means on.
  enabled?: boolean;
  // One or more node addresses separated by spaces.
  node?: string;
  // One or more explorer addresses separated by spaces.
  explorer?: string;
}

// A Uniswap position added by hand.
export interface AddedPosition {
  chainId: number;
  tokenId: string;
}

// Kept under "uniswap" because the wallets and nodes were first saved there.
export interface UniswapSettings {
  wallets: Wallet[];
  // Chain id -> its saved choices.
  chains: Record<string, ChainChoice>;
  v3ids?: AddedPosition[];
  v4ids?: AddedPosition[];
  // Old: Ethereum's node, from before the chains list. Saved as '' once the chains are saved.
  node?: string;
  // Old: the Etherscan key, now under blockchains.etherscan.
  etherscan?: string;
}

// A chain added by hand in Settings → Blockchains.
export interface CustomChain {
  id: number;
  name: string;
  // One or more node addresses separated by spaces.
  rpc: string;
  // One or more explorer addresses separated by spaces, or ''.
  explorer: string;
  symbol: string;
}

export interface BlockchainsSettings {
  custom: CustomChain[];
  // The Etherscan API key.
  etherscan?: string;
}

// One parameter of an ABI entry.
export interface AbiParam {
  name: string;
  type: string;
  internalType?: string;
  indexed?: boolean;
  // The fields of a tuple.
  components?: AbiParam[];
}

// One entry of a contract's ABI, as Solidity emits it.
export interface AbiItem {
  type: string;
  name?: string;
  inputs?: AbiParam[];
  outputs?: AbiParam[];
  stateMutability?: string;
  anonymous?: boolean;
  // Old ABIs' flags, before stateMutability.
  constant?: boolean;
  payable?: boolean;
}

// A smart contract saved in Settings → Smart contracts.
export interface Contract {
  id: string;
  label: string;
  chainId: number;
  address: string;
  // '' when it belongs to no project.
  projectId: string;
  abi: AbiItem[];
}

// A Vercel or Netlify token (js/deployments.js): the runners read the PRs' deployments with it.
export interface DeploySettings {
  token: string;
}

export interface TelegramSettings {
  token: string;
  chatId: string;
  // Reply in the chat when a message becomes a task; missing means on.
  confirm?: boolean;
  // The next update id to read, so a message is never read twice.
  offset?: number;
}

// A Notion database whose pages become tasks in one project (js/notion.js).
export interface NotionLink {
  id: string;
  // The database's id, 32 hex digits without dashes.
  databaseId: string;
  // The database's title, read when the link is added.
  name: string;
  // null means Personal, and its tasks wait in To Organize; missing means its account's project.
  projectId?: string | null;
  // The NotionAccount that reads it.
  account?: string;
  // Missing means on.
  on?: boolean;
  // The newest last_edited_time read, so the next sync asks only for later edits.
  syncedAt?: string;
  // The last sync's error, '' after one that worked.
  error?: string;
  // Before accounts: 'oauth' with the OAuth sign-in, 'session' with the browser session; missing with the secret.
  via?: string;
}

// A public integration, for workspaces where no internal integration can be made. Each sign-in with it is an account.
export interface NotionOAuth {
  clientId: string;
  clientSecret: string;
  // Before accounts, the one sign-in.
  accessToken?: string;
  refreshToken?: string;
  // The workspace the sign-in was given for.
  workspace?: string;
}

// notion.so's own session (the token_v2 cookie): reads what the signed-in account sees, through the web app's API.
export interface NotionSession {
  tokenV2: string;
  // The notion_user_id cookie, when several accounts are signed in.
  userId?: string;
}

// One way into Notion: an internal integration's secret, an OAuth sign-in or a browser session. There may be several
// of each, one per workspace or person.
export interface NotionAccount {
  id: string;
  // 'token', 'oauth' or 'session'.
  way: string;
  // What Notion called it when it was added: the workspace, or the person signed in.
  name?: string;
  // 'token': the secret (ntn_… or secret_…).
  token?: string;
  // 'oauth': the sign-in's tokens and workspace.
  accessToken?: string;
  refreshToken?: string;
  workspace?: string;
  workspaceId?: string;
  // 'session': the token_v2 and notion_user_id cookies.
  tokenV2?: string;
  userId?: string;
  // The project its databases feed unless they pick their own; null or missing is Personal (To Organize).
  projectId?: string | null;
}

export interface NotionSettings {
  accounts?: NotionAccount[];
  // The public integration's client, shared by every OAuth account.
  oauth?: NotionOAuth;
  links: NotionLink[];
  // Before accounts: the one integration secret and the one browser session.
  token?: string;
  session?: NotionSession;
}

export interface AnalyticsSettings {
  // Project id -> its Google Analytics property id.
  properties: Record<string, string>;
}

// The signed-in LinkedIn session that reads company pages (Settings → LinkedIn): the li_at and JSESSIONID cookies.
export interface LinkedinSettings {
  liAt?: string;
  jsessionid?: string;
  // The LinkedIn developer app for the official sign-in that posts (Sign In with LinkedIn, Share on LinkedIn).
  clientId?: string;
  clientSecret?: string;
  // Session reads allowed per day (the runners' queue); 60 when unset.
  dailyLimit?: number;
}

export interface BingSettings {
  key: string;
  // Old: no longer read; Settings drops it when the key is saved.
  relay?: string;
}

export interface ResendSettings {
  // Project id -> that project's Resend API key.
  keys: Record<string, string>;
  // Old: no longer read; Settings drops it when a key is saved.
  relay?: string;
}

export interface GmailAccount {
  email: string;
  projectId: string | null;
  // A project label (projects.json categories) for the Inbox filter.
  labelId?: string | null;
}

export interface GmailSettings {
  accounts: GmailAccount[];
}

// One calendar of a Google Calendar account. Its project and label fall back to the account's when null.
export interface CalendarChoice {
  id: string;
  name: string;
  color: string;
  // Shown on the board.
  on: boolean;
  projectId: string | null;
  labelId: string | null;
}

export interface CalendarAccount {
  email: string;
  calendars: CalendarChoice[];
  projectId?: string | null;
  labelId?: string | null;
}

export interface GcalSettings {
  accounts: CalendarAccount[];
}

// An automation rule's saved choices over its defaults (RULE_DEFAULTS in js/automations.js).
export interface AutomationRule {
  on?: boolean;
  // Days before the deadline a task is made.
  days?: number;
  // The Aave health factor a task is made below.
  factor?: number;
}

// An AI task and the model pinned to it.
export interface ModelTask {
  id: string;
  name: string;
  description: string;
  // '' follows the default model.
  model: string;
}

export interface ModelsSettings {
  // The default OpenRouter model id.
  default: string;
  tasks: ModelTask[];
}

// Exchange rates (js/fx.js). A null field follows the default.
export interface FxSettings {
  provider?: string | null;
  // false turns the fallback provider off.
  fallback?: boolean | null;
  // A rate typed by hand.
  manual?: number | null;
}

// A runner job's switch and interval (js/runner-jobs.js jobConfig).
export interface RunnerJobSettings {
  // Missing means on.
  on?: boolean;
  // Minutes between runs; null or missing means the job's default.
  every?: number | null;
}

export interface Settings {
  github: GithubSettings;
  openrouter: OpenRouterSettings;
  google: GoogleSettings;
  uniswap: UniswapSettings;
  blockchains: BlockchainsSettings;
  contracts: Contract[];
  telegram: TelegramSettings;
  notion?: NotionSettings;
  vercel?: DeploySettings;
  netlify?: DeploySettings;
  analytics: AnalyticsSettings;
  bing: BingSettings;
  linkedin?: LinkedinSettings;
  resend: ResendSettings;
  gmail: GmailSettings;
  gcal: GcalSettings;
  // Rule key ('domain', 'ssl', ...) -> its saved choices.
  automations: Record<string, AutomationRule>;
  models: ModelsSettings;
  // Prompt id -> the text that replaces its default (js/prompts.js); 'global' is the shared text (GLOBAL_PROMPT).
  prompts: Record<string, string>;
  fx?: FxSettings;
  // Job id -> its switch and interval.
  runners?: Record<string, RunnerJobSettings>;
  // Ties the data folder to the runners serving it.
  folderId?: string;
  schemaVersion?: number;
}
