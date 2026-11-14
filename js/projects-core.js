// Projects without the DOM: a project's shape, and finding or creating one by name. Tasks, the palette, Telegram (in
// the runners too) create a project from a #tag through createProject.
/** @import { Project, DataStore } from '../types/data' */
import { uid, now } from './ui.js';

const COLLECTION = 'projects';
export const PALETTE = ['#2f6f4e', '#3b6ea8', '#a3432b', '#8a5a9e', '#b08416', '#2e8a8a'];
/** @param {string} a @param {string} b */
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

// Shared by the todos module, so a #tag can create a project on the fly.
// Every project has the same shape; fields are optional and default to empty.
/** @param {number} existingCount @param {Partial<Project>} [fields] @returns {Project} */
export function makeProject(existingCount, fields = {}) {
  return {
    id: uid(),
    name: '',
    color: PALETTE[existingCount % PALETTE.length],
    description: '',
    website: '',
    // The project's folder on this machine, where the Dev section opens its terminals.
    localPath: '',
    // What Dev runs when a task is handed to it; empty uses DEFAULT_DEV_COMMAND.
    devCommand: '',
    // A command preset from Settings → Coding Agents; when set, it runs instead of devCommand.
    devPreset: '',
    labels: [],
    parentId: null,
    github: { org: '', repos: [] },
    // An npm org (or user) whose packages are the project's, and single packages; both optional.
    npm: { org: '', packages: [] },
    // What the project is, saved for the board's AI features (js/profile.js). A missing profile reads as empty.
    profile: { text: '', sources: [], updated: '', edited: false, usageId: '' },
    created: now(),
    ...fields,
  };
}

// Creates a project unless one with the same name exists. Returns { project, created }.
// The caller sets any view state it needs, then calls store.refresh().
/** @param {DataStore} store @param {string} name @param {Partial<Project>} [fields] */
export function createProject(store, name, fields = {}) {
  const { projects } = store.get(COLLECTION);
  const existing = projects.find((p) => sameName(p.name, name));
  if (existing) return { project: existing, created: false };
  const project = makeProject(projects.length, { name, ...fields });
  store.update(COLLECTION, (d) => d.projects.push(project));
  return { project, created: true };
}

