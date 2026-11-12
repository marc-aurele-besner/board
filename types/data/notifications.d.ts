// notifications.json: the bell's notifications and each kind's preferences (js/notify-core.js).

export interface Notification {
  id: string;
  // A key from KINDS in js/notify-core.js ('deadline', 'health', 'cron', ...).
  kind: string;
  text: string;
  // Where clicking it goes, e.g. #/todos?filter=today; '' for nowhere.
  href: string;
  // Names the event, so it is announced once; '' for none.
  key: string;
  at: string;
  read: boolean;
}

// Where a kind is shown. A kind never changed shows in the board only.
export interface NotificationPref {
  app: boolean;
  telegram: boolean;
}

export interface NotificationsData {
  items: Notification[];
  // By kind.
  prefs: Record<string, NotificationPref>;
  schemaVersion?: number;
}
