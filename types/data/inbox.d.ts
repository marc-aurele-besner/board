// inbox.json: mail read from Resend (js/resend.js) and Gmail (js/gmail.js), shown in the Inbox (js/modules/inbox.js).

export interface InboxMessage {
  // The Resend email id, or 'gmail:<account>:<message id>' for Gmail rows.
  id: string;
  // 'gmail' for Gmail rows; Resend rows have none.
  source?: string;
  // The Gmail address the row was read from.
  account?: string;
  // The Gmail message id.
  msgId?: string;
  projectId: string | null;
  // 'received' | 'sent'
  dir: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  // ISO time, or '' when unknown.
  at: string;
  // Delivery state of a sent Resend email ('delivered', 'opened', 'bounced', 'scheduled', ...), else ''.
  status: string;
  unread?: boolean;
  archived?: boolean;
  starred?: boolean;
  // The task made from this email.
  taskId: string | null;
}

export interface InboxData {
  emails: InboxMessage[];
  // ISO time of the last sync, or ''.
  syncedAt: string;
  // Written by the store on save.
  schemaVersion?: number;
}
