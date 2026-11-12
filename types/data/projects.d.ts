// projects.json: projects and their labels. A project's shape is makeProject() in js/projects-core.js.

// A project label (Personal, Web, ...). Stored as `categories`.
export interface ProjectLabel {
  id: string;
  name: string;
  // Labels saved before colours existed get one in migrateProjectShape().
  color?: string;
}

// What the project is, built for the AI features (js/profile.js).
export interface ProjectProfile {
  text: string;
  // Extra page URLs read besides the website.
  sources: string[];
  updated: string;
  // Edited by hand since it was built.
  edited: boolean;
  usageId: string;
}

export interface ProjectGithub {
  org: string;
  repos: string[]; // owner/repo
}

export interface ProjectNpm {
  org: string;
  packages: string[];
}

export interface Project {
  id: string;
  name: string;
  color: string;
  description: string;
  website: string;
  // An image URL set by hand; wins over the site's icon.
  iconUrl?: string;
  // Folder on this machine where Dev opens terminals; may start with ~.
  localPath?: string;
  // What Dev runs for a task; '' uses the default.
  devCommand?: string;
  // A preset id from Settings → Dev environment; runs instead of devCommand.
  devPreset?: string;
  // Project label ids. Older files have `categoryId` instead; migrateProjectShape() fills it.
  labels?: string[];
  parentId?: string | null;
  // Old: a single label id.
  categoryId?: string;
  github: ProjectGithub;
  npm?: ProjectNpm;
  profile?: ProjectProfile;
  created: string;
}

export interface ProjectsData {
  projects: Project[];
  categories: ProjectLabel[];
  schemaVersion?: number;
}
