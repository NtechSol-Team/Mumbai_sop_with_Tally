'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiSuccess } from '@/types/api';

export type TallySyncStatus = 'PENDING' | 'SYNCED' | 'FAILED' | 'EXCLUDED';
export type TallyEntityType =
  | 'SALES_BILL' | 'POS_SALE' | 'PAYMENT_IN' | 'PURCHASE_BILL'
  | 'SUPPLIER_PAYMENT' | 'EXPENSE' | 'STOCK_TRANSFER' | 'RAW_INTAKE';

export interface TallyConfig {
  agentLabel: string | null;
  agentPaired: boolean;
  tallyCompanyName: string | null;
  tallyHost: string;
  tallyPort: number;
  syncEnabled: boolean;
  syncSales: boolean;
  syncReceipts: boolean;
  syncPurchases: boolean;
  syncExpenses: boolean;
  syncStockJournal: boolean;
  autoProvisionLedgers: boolean;
  inventoryMode: 'ACCOUNTING_ONLY' | 'WITH_STOCK_JOURNALS';
  posSupplyKind: 'GOODS' | 'RESTAURANT';
  posVoucherGranularity: 'PER_BILL' | 'DAILY_SUMMARY';
  razorpayReceiptMode: 'CLEARING' | 'DIRECT_BANK';
  discountMode: 'SEPARATE_LEDGER' | 'NET_OFF_SALES';
  billChargesTaxable: boolean;
  syncNonGstOutletSales: boolean;
  accruedExpenseMode: 'ON_PAYMENT' | 'JOURNAL_NOW';
  closingStockMode: 'MANUAL' | 'MONTHLY' | 'ON_DEMAND';
  closingStockBasis: 'GST_PURCHASE_STOCK' | 'TOTAL_ERP_STOCK';
  blockOnRateMismatch: boolean;
  blockOnMissingGstin: boolean;
  syncFromDate: string | null;
}

export interface LedgerMapRow {
  id: string;
  slot: 'SALES' | 'PURCHASE' | 'GST' | 'BANK_CASH' | 'EXPENSE' | 'PARTY_OUTLET' | 'PARTY_SUPPLIER' | 'SPECIAL';
  slotKey: string;
  slotLabel: string;
  tallyLedgerName: string;
  tallyParentGroup: string | null;
  validatedAt: string | null;
  notes: string | null;
}

export interface TallySettings {
  config: TallyConfig;
  agentOnline: boolean;
  ledgerMap: LedgerMapRow[];
}

export interface QueueRow {
  id: string;
  entityType: TallyEntityType;
  voucherType: string;
  status: TallySyncStatus;
  docNumber: string | null;
  partyName: string | null;
  amount: number;
  entityDate: string;
  revision: number;
  attempts: number;
  excludedReason: string | null;
  errorMessage: string | null;
  /** Tally's raw XML reply to the last attempt — the fallback when errorMessage is vague. */
  tallyResponse: string | null;
  tallyVoucherId: string | null;
  isReady: boolean;
  syncedAt: string | null;
  updatedAt: string;
}

export interface QueueResponse {
  rows: QueueRow[];
  counts: Record<TallySyncStatus, number>;
  meta: { page: number; limit: number; total: number; totalPages: number };
}

export function useTallySettings() {
  return useQuery({
    queryKey: ['tally', 'settings'],
    queryFn: async () => (await api.get<ApiSuccess<TallySettings>>('/tally/settings')).data.data,
    refetchInterval: 15_000,
  });
}

export function useUpdateTallyConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<TallyConfig>) => (await api.put<ApiSuccess<TallyConfig>>('/tally/settings', patch)).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tally'] }),
  });
}

export function useSaveLedgerMap() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (rows: Array<{ id: string; tallyLedgerName: string; tallyParentGroup?: string | null; notes?: string | null }>) =>
      (await api.put<ApiSuccess<LedgerMapRow[]>>('/tally/ledger-map', { rows })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tally'] }),
  });
}

export function useRotateAgentToken() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async () => (await api.post<ApiSuccess<{ token: string }>>('/tally/agent-token', {})).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tally', 'settings'] }),
  });
}

export function useTallyQueue(params: { status?: TallySyncStatus; entityType?: TallyEntityType; search?: string; page?: number } = {}) {
  return useQuery({
    queryKey: ['tally', 'queue', params],
    queryFn: async () => (await api.get<ApiSuccess<QueueResponse>>('/tally/queue', { params })).data.data,
    refetchInterval: 15_000,
  });
}

export function useRetryTallyItem() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.post<ApiSuccess<{ retried: boolean }>>(`/tally/queue/${id}/retry`, {})).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tally', 'queue'] }),
  });
}
