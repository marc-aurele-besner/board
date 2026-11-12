// google.json: every Google sign-in and the accounts' pictures (js/google.js, js/google-core.js).

// A live sign-in.
export interface GoogleSignIn {
  refresh: string;
  access: string;
  // Time (ms) the access token lapses.
  expiresAt: number;
  // The granted scopes, space separated.
  scope: string;
  // Time (ms) it was saved or last renewed.
  at: number;
  removed?: undefined;
}

// A removed sign-in, kept so a tab that still holds it takes the removal in instead of writing it back.
export interface GoogleRemovedSignIn {
  removed: boolean;
  at: number;
  refresh?: undefined;
  access?: undefined;
  expiresAt?: undefined;
  scope?: undefined;
}

export type GoogleToken = GoogleSignIn | GoogleRemovedSignIn;

export interface GoogleData {
  // By "gmail:<address>", "gcal:<address>" or "web" (Analytics and Search Console).
  tokens: Record<string, GoogleToken>;
  // Picture URL by account address.
  pictures: Record<string, string>;
  // The old event cache, now in calendar.json; the calendar job deletes it.
  events?: unknown;
  schemaVersion?: number;
}
