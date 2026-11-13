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

// One entry of a brand list: a name and what it points to. Images and links hold a URL or a path in the local
// folder; colours a CSS colour; fonts a font family.
export interface BrandItem {
  label: string;
  value: string;
}

// The project's brand: images (logo, favicon, share image), colours, fonts, links (stylesheets, guidelines) and notes.
// Filled by hand or by Find with AI (js/brand.js), which only adds what is not there yet.
export interface ProjectBrand {
  images: BrandItem[];
  colors: BrandItem[];
  fonts: BrandItem[];
  links: BrandItem[];
  notes: string;
  updated: string;
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
  brand?: ProjectBrand;
  created: string;
}

export interface ProjectsData {
  projects: Project[];
  categories: ProjectLabel[];
  schemaVersion?: number;
}
