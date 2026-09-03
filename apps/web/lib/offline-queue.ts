'use client';

import { api } from '@/lib/api';
import type { CreateTxnPayload } from '@/hooks/usePos';

/**
 * Offline sale queue. When the network is down, completed sales are persisted
 * locally (each tagged with a stable clientUuid) and flushed when connectivity
 * returns. The server is idempotent on clientUuid, so replays are safe.
 *
 * Uses localStorage for durability + simplicity; the clientUuid idempotency key
 * is what actually guarantees no double-charges on sync.
 */
const KEY = 'mumbai-erp-pos-offline-queue';

export function getQueue(): CreateTxnPayload[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]') as CreateTxnPayload[];
  } catch {
    return [];
  }
}

function setQueue(q: CreateTxnPayload[]): void {
  localStorage.setItem(KEY, JSON.stringify(q));
}

export function enqueueSale(payload: CreateTxnPayload): void {
  setQueue([...getQueue(), payload]);
}

export function queueSize(): number {
  return getQueue().length;
}

/** Attempt to sync all queued sales. Returns how many were synced. */
export async function flushQueue(): Promise<number> {
  const queue = getQueue();
  if (queue.length === 0) return 0;
  const remaining: CreateTxnPayload[] = [];
  let synced = 0;
  for (const sale of queue) {
    try {
      await api.post('/pos/transactions', sale);
      synced += 1;
    } catch {
      remaining.push(sale); // keep for the next attempt
    }
  }
  setQueue(remaining);
  return synced;
}
