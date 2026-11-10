// Registry of sections shown in the top nav. To add a section, create a module file
// with the same shape as todos.js and append it here.
import todos from './todos.js';
import projects from './projects.js';
import kitchen from './kitchen.js';
import money from './money.js';

export const modules = [todos, projects, kitchen, money];
