// Registry of sections, in the order of the top bar. Sections with `hidden: true` are reachable by URL but not shown there.
// To add a section, create a module file with the same shape as todos.js and append it here.
import home from './home.js';
import todos from './todos.js';
import calendar from './calendar.js';
import projects from './projects.js';
import kitchen from './kitchen.js';
import money from './money.js';
import positions from './positions.js';
import inbox from './inbox.js';
import monitoring from './monitoring.js';
import tools from './tools.js';
import cron from './cron.js';
import settings from './settings.js';
import search from './search.js';

export const modules = [home, todos, calendar, projects, kitchen, money, positions, inbox, monitoring, tools, cron, settings, search];
