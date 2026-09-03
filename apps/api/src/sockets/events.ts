/** Real-time event names. Kept as a const enum-like object for type safety. */
export const RealtimeEvent = {
  NEW_ORDER: 'new_order',
  ORDER_STATUS_CHANGED: 'order_status_changed',
  /** An outlet asked to settle an order on credit — the main owner must approve it. */
  ORDER_CREDIT_REQUESTED: 'order_credit_requested',
  /** An outlet confirmed a dispatched order physically arrived. */
  ORDER_RECEIVED: 'order_received',
  PAYMENT_RECEIVED: 'payment_received',
  STOCK_LOW: 'stock_low',
  BILL_GENERATED: 'bill_generated',
  TRANSFER_STATUS_CHANGED: 'transfer_status_changed',
  POS_SALE: 'pos_sale',
  POS_KOT: 'pos_kot',
  /** Midnight auto-close/reopen of a till session — terminal must swap to the new session id. */
  POS_SESSION_ROLLOVER: 'pos_session_rollover',
  PAYMENT_DUE_REMINDER: 'payment_due_reminder',
  REPORT_READY: 'report_ready',
  /** A user's first connection opened / last one closed — developer console only. */
  PRESENCE_ONLINE: 'presence_online',
  PRESENCE_OFFLINE: 'presence_offline',
} as const;

export type RealtimeEventName = (typeof RealtimeEvent)[keyof typeof RealtimeEvent];

/**
 * Routing scope for an event:
 *  • global  → delivered to the admin room (super admins see everything)
 *  • outletId → also delivered to that outlet's room
 */
export interface EventScope {
  global?: boolean;
  outletId?: string | null;
}

export interface RealtimeMessage<T = unknown> {
  event: RealtimeEventName;
  scope: EventScope;
  data: T;
  emittedAt: string;
}

/** The single Postgres NOTIFY channel all app events flow through. */
export const PG_NOTIFY_CHANNEL = 'mumbai_erp_events';

/** Socket.IO room names. */
export const Room = {
  ADMIN: 'role:admin',
  outlet: (outletId: string) => `outlet:${outletId}`,
} as const;
