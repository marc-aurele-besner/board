// todos.json: tasks, task categories and the status overrides from Settings → Labels.
// A task's shape is makeTask() in js/capture.js, plus the fields other code adds.

import type { Project } from './projects';

// A GitHub issue or pull request linked to a task (js/task-links.js).
export interface TaskLink {
  repo: string; // owner/repo
  number: number;
  url: string;
  // Read from GitHub after the link is added; '' until then.
  title: string;
}

// A claude.ai Artifact a Dev session on the task published (js/task-links.js); title '' when it had none.
export interface TaskArtifact {
  url: string;
  title: string;
}

// A page a task led to, by its title.
export interface TaskWebLink {
  url: string;
  title: string;
}

// An image pasted or dropped on a task, kept in the data folder (js/task-images.js).
export interface TaskImage {
  path: string; // relative to the data folder, e.g. tasks/<task id>-<id>.png
  name: string;
  type: string; // MIME type
}

// A git worktree a Dev session made for the task (js/task-worktrees.js).
export interface TaskWorktree {
  name: string;
  cwd: string;
  session: string;
  // git refused to remove it; its answer.
  kept?: string;
}

// The Inbox email a task was made from (js/modules/inbox.js).
export interface TaskEmail {
  id: string;
  dir: string;
}

// The Notion page a task was imported from (js/notion.js), with the values last read from it: a field changes on the
// board only when it changed in Notion since, so edits made on the board are kept.
export interface TaskNotion {
  url: string;
  link: string; // the NotionLink's id
  edited: string; // the page's last_edited_time
  text: string;
  status: string;
  due: string;
  priority: string;
}

export interface Task {
  id: string;
  text: string;
  // Older tasks may lack it.
  description?: string;
  // One of the fixed keys in STATUSES (js/task-labels.js). Older tasks have `done` instead.
  status?: string;
  priority: string;
  // A task category's name ('' for none).
  category: string;
  // null means Personal.
  projectId: string | null;
  // YYYY-MM-DD or ''. Older tasks may lack it.
  due?: string;
  created: string;
  // Old: before statuses.
  done?: boolean;
  // Which rule or source made the task ('telegram', 'cron', 'domain', ...), and what it is about. 'dev': a Dev
  // session made it through tools/board.js, and autoRef is its terminal session's id.
  auto?: string;
  autoRef?: string;
  // Waits in "To Organize".
  inbox?: boolean;
  // The task it sits under (Tasks nests it there); missing or '' for a top-level task.
  parentId?: string;
  // The Cron run that made it.
  cronRun?: string;
  // The Dev session that last worked on it.
  devSession?: string;
  // The model and effort its Dev sessions run with (--model, --effort for claude); missing or '' for the default.
  devModel?: string;
  devEffort?: string;
  // The agent it picked in its right-click menu (Settings → Dev environment); missing for its project's. A devModel
  // without it was picked from Claude's models, before agents named theirs.
  devProvider?: string;
  images?: TaskImage[];
  worktrees?: TaskWorktree[];
  prs?: TaskLink[];
  issues?: TaskLink[];
  artifacts?: TaskArtifact[];
  // Other pages the task led to, such as the LinkedIn post written from it (js/linkedin-core.js).
  links?: TaskWebLink[];
  // Old: a single issue, before several were allowed.
  issue?: TaskLink;
  email?: TaskEmail;
  notion?: TaskNotion;
}

// A task category. scope: 'all', 'project' (projectId) or 'projectCategory' (projectCategoryIds, project label ids).
export interface TaskCategory {
  id: string;
  name: string;
  scope: string;
  projectId: string | null;
  projectCategoryIds?: string[];
  // Old: a single project label id.
  projectCategoryId?: string | null;
  color?: string;
}
export type Category = TaskCategory;

// A status's overrides from Settings → Labels, by status key.
export interface StatusOverride {
  name?: string;
  color?: string;
  hidden?: boolean;
}

export interface TodosData {
  items: Task[];
  categories: TaskCategory[];
  statuses?: Record<string, StatusOverride>;
  // Status keys in picker order.
  statusOrder?: string[];
  // Old: projects lived here before projects.json; moved by migrateLegacyProjects().
  projects?: Array<Partial<Project> & { id: string }>;
  schemaVersion?: number;
}
