// Registry of sections. Sections with `hidden: true` are reachable by URL but not shown in the nav.
// To add a section, create a module file with the same shape as todos.js and append it here.
import home from './home.js';
import todos from './todos.js';
import projects from './projects.js';
import kitchen from './kitchen.js';
import money from './money.js';
import monitoring from './monitoring.js';
import settings from './settings.js';

export const modules = [home, todos, projects, kitchen, money, monitoring, settings];
