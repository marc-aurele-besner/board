// The shared data model: one type per JSON file in the data folder, and the store and section contracts.
// Each collection's shape lives in types/data/<name>.d.ts and describes the file as it is on disk, old fields included.
// Fields that older files may lack are optional: store.load() only fills the top-level defaults.

import type { TodosData } from './data/todos';
import type { ProjectsData } from './data/projects';
import type { FinanceData } from './data/finance';
import type { PoolsData } from './data/pools';
import type { Settings } from './data/settings';
import type { RecipesData } from './data/recipes';
import type { InboxData } from './data/inbox';
import type { UsageData } from './data/usage';
import type { ToolsData } from './data/tools';
import type { DevData } from './data/dev';
import type { CronData } from './data/cron';
import type { NotificationsData } from './data/notifications';
import type { GoogleData } from './data/google';
import type { CalendarData } from './data/calendar';
import type { SlackData } from './data/slack';
import type { GithubData } from './data/github';
import type { NpmData } from './data/npm';
import type { WebstatsData } from './data/webstats';
import type { SocialsData } from './data/socials';
import type { FxData } from './data/fx';
import type { RunnersData } from './data/runners';
import type { DefiSnapshotsData } from './data/defi-snapshots';

export type * from './data/todos';
export type * from './data/projects';
export type * from './data/finance';
export type * from './data/pools';
export type * from './data/settings';
export type * from './data/recipes';
export type * from './data/inbox';
export type * from './data/usage';
export type * from './data/tools';
export type * from './data/dev';
export type * from './data/cron';
export type * from './data/notifications';
export type * from './data/google';
export type * from './data/calendar';
export type * from './data/slack';
export type * from './data/github';
export type * from './data/npm';
export type * from './data/webstats';
export type * from './data/socials';
export type * from './data/fx';
export type * from './data/runners';
export type * from './data/defi-snapshots';

// Every collection the board loads, by file name (collectionDefaults() in js/app.js).
export interface Collections {
  todos: TodosData;
  projects: ProjectsData;
  finance: FinanceData;
  pools: PoolsData;
  settings: Settings;
  recipes: RecipesData;
  inbox: InboxData;
  usage: UsageData;
  tools: ToolsData;
  dev: DevData;
  cron: CronData;
  notifications: NotificationsData;
  google: GoogleData;
  calendar: CalendarData;
  slack: SlackData;
  github: GithubData;
  npm: NpmData;
  webstats: WebstatsData;
  socials: SocialsData;
  fx: FxData;
}

// The runners also write files the board's tabs never load (tools/worker/store.js).
export interface WorkerCollections extends Collections {
  runners: RunnersData;
  'defi-snapshots': DefiSnapshotsData;
}

export type CollectionName = keyof Collections;

// What code shared by the board and the runners needs of a store: the tab's store (js/store.js) and the runners'
// store (tools/worker/store.js) both have it.
export interface DataStore {
  get<K extends CollectionName>(name: K): Collections[K];
  update<K extends CollectionName>(name: K, mutate: (data: Collections[K]) => void): void;
  save<K extends CollectionName>(name: K, mutate: (data: Collections[K]) => void): void;
}

// An icon name from ICON_PATHS in js/ui.js.
export type IconName = import('../js/ui.js').IconName;

// The store of a tab: js/store.js createStore().
export type Store = ReturnType<typeof import('../js/store.js').createStore>;

// A section of the board (js/modules/index.js).
export interface Module {
  id: string;
  title: string;
  icon: IconName;
  // A shorter title for the top bar.
  short?: string;
  // Reachable by URL but not shown in the top bar.
  hidden?: boolean;
  // The collection the section owns; none or null for one that only reads others.
  collection?: CollectionName | null;
  defaults?: object;
  render(root: HTMLElement, store: Store): void;
  // The view's state for the URL, and back.
  serialize?(): Record<string, unknown>;
  restore?(params?: Record<string, string>): void;
  // Redraw when a runner job's outcome changes; 'all' also when only run times did.
  readonly readsRunners?: boolean | 'all';
  // Redraws within the section are patched into the page on screen (ui.js patch()) instead of swapping it, so
  // nothing may keep an element of a render to change later unless it is marked data-own.
  patch?: boolean;
}
