// Proves the typedefs in types/data/ match real data: each fixture is a sanitized copy of a data folder's file, and
// assigning it to its type fails the type check when the two drift apart. Never imported by the board.
/** @import { Collections, WorkerCollections } from './data' */
import todos from './fixtures/todos.json' with { type: 'json' };
import projects from './fixtures/projects.json' with { type: 'json' };
import finance from './fixtures/finance.json' with { type: 'json' };
import pools from './fixtures/pools.json' with { type: 'json' };
import settings from './fixtures/settings.json' with { type: 'json' };
import recipes from './fixtures/recipes.json' with { type: 'json' };
import inbox from './fixtures/inbox.json' with { type: 'json' };
import usage from './fixtures/usage.json' with { type: 'json' };
import tools from './fixtures/tools.json' with { type: 'json' };
import dev from './fixtures/dev.json' with { type: 'json' };
import cron from './fixtures/cron.json' with { type: 'json' };
import notifications from './fixtures/notifications.json' with { type: 'json' };
import google from './fixtures/google.json' with { type: 'json' };
import calendar from './fixtures/calendar.json' with { type: 'json' };
import slack from './fixtures/slack.json' with { type: 'json' };
import github from './fixtures/github.json' with { type: 'json' };
import npm from './fixtures/npm.json' with { type: 'json' };
import webstats from './fixtures/webstats.json' with { type: 'json' };
import socials from './fixtures/socials.json' with { type: 'json' };
import linkedin from './fixtures/linkedin.json' with { type: 'json' };
import contacts from './fixtures/contacts.json' with { type: 'json' };
import fx from './fixtures/fx.json' with { type: 'json' };
import runners from './fixtures/runners.json' with { type: 'json' };
import defiSnapshots from './fixtures/defi-snapshots.json' with { type: 'json' };

// Every collection must have a fixture: a missing key here is an error.
/** @type {WorkerCollections} */
export const fixtures = {
  todos,
  projects,
  finance,
  pools,
  settings,
  recipes,
  inbox,
  usage,
  tools,
  dev,
  cron,
  notifications,
  google,
  calendar,
  slack,
  github,
  npm,
  webstats,
  socials,
  linkedin,
  contacts,
  fx,
  runners,
  'defi-snapshots': defiSnapshots,
};

/** @type {Collections} */
export const boardFixtures = fixtures;
