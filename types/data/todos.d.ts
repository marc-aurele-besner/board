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
  // Which rule or source made the task ('telegram', 'cron', 'domain', ...), and what it is about.
  auto?: string;
  autoRef?: string;
  // Waits in "To Organize".
  inbox?: boolean;
  // The Cron run that made it.
  cronRun?: string;
  // The Dev session that last worked on it.
  devSession?: string;
  images?: TaskImage[];
  worktrees?: TaskWorktree[];
  prs?: TaskLink[];
  issues?: TaskLink[];
  // Old: a single issue, before several were allowed.
  issue?: TaskLink;
  email?: TaskEmail;
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
