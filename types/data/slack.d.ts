// slack.json: the Slack workspaces signed in with a browser session, and how the Slack tab lays out their channels
// (js/slack.js, js/modules/slack.js). Messages are not stored: the tab reads them live through the runners.

// A workspace signed in as the user, with the session token and cookie of Slack's web client.
export interface SlackWorkspace {
  // Slack's team id (T…).
  id: string;
  name: string;
  // https://<domain>.slack.com/
  url: string;
  icon: string;
  // The web client's token (xoxc-…) and the value of its `d` cookie (xoxd-…).
  token: string;
  cookie: string;
  userId: string;
  userName: string;
  // The project the whole workspace belongs to, or null.
  projectId: string | null;
  // What the last call reported when the session no longer works, or ''.
  error?: string;
}

// A conversation the user is in, as last listed.
export interface SlackChannel {
  id: string;
  // A channel's name; '' for a direct message, which is named after its person.
  name: string;
  // 'channel', 'private', 'im' or 'mpim'.
  kind: string;
  // A direct message's other person.
  user?: string;
  topic?: string;
}

export interface SlackUser {
  // The display name, or the real name when there is none.
  name: string;
  avatar: string;
  bot?: boolean;
}

// A sidebar group: channels of any workspace, tied to a project or not.
export interface SlackGroup {
  id: string;
  name: string;
  projectId: string | null;
  // "<team>|<channel>" keys of its channels.
  items: string[];
}

export interface SlackData {
  workspaces: SlackWorkspace[];
  groups: SlackGroup[];
  // "<team>|<channel>" keys muted on the board: still listed in place, dimmed and never counted as unread.
  muted: string[];
  // "<team>|<channel>" keys in the order dragged; the others follow, channels before direct messages, by name.
  order: string[];
  // "<team>|<channel>" -> the project a channel is tied to, over its group's and its workspace's.
  projects: Record<string, string>;
  // Group ids, team ids and "project:<id>" sections folded in the sidebar.
  collapsed: string[];
  // By team id: the conversations as last listed, and the people seen so far.
  channels: Record<string, SlackChannel[]>;
  users: Record<string, Record<string, SlackUser>>;
}
