'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiSuccess } from '@/types/api';
import { useCompanyProfile } from '@/hooks/useSettings';

export type ExpenseLocation = 'GODOWN' | 'MAIN_BRANCH' | 'GENERAL';
export type ExpensePaymentMethod = 'CASH' | 'CARD' | 'UPI' | 'NET_BANKING' | 'RAZORPAY' | 'BANK_TRANSFER' | 'NOT_PAID';
export type PaidBy = 'COMPANY' | 'PARTNER_1' | 'PARTNER_2';

/**
 * Fallback labels. The partner slots are deliberately generic here: a partner's
 * real name is business configuration (Settings → Business Profile), not
 * something baked into the code, so it can change without a release. Use
 * `usePaidByLabels()` for anything a user reads.
 */
export const PAID_BY_LABEL: Record<PaidBy, string> = {
  COMPANY: 'Company',
  PARTNER_1: 'Partner 1',
  PARTNER_2: 'Partner 2',
};
export const PAID_BY_OPTIONS = Object.keys(PAID_BY_LABEL) as PaidBy[];

/** The configured partner names, falling back to the generic labels above. */
export function usePaidByLabels(): Record<PaidBy, string> {
  const { data } = useCompanyProfile();
  return {
    COMPANY: PAID_BY_LABEL.COMPANY,
    PARTNER_1: data?.partner1Name?.trim() || PAID_BY_LABEL.PARTNER_1,
    PARTNER_2: data?.partner2Name?.trim() || PAID_BY_LABEL.PARTNER_2,
  };
}

export interface ExpenseCategory { id: string; name: string; isSystem: boolean }

export interface Expense {
  id: string;
  amount: string;
  expenseDate: string;
  paymentMethod: ExpensePaymentMethod;
  paidTo: string | null;
  paidBy: PaidBy;
  location: ExpenseLocation;
  note: string | null;
  category: { id: string; name: string };
}

export interface ExpenseSummary {
  total: number;
  count: number;
  byCategory: Array<{ categoryId: string; category: string; total: number }>;
  byLocation: Array<{ location: string; total: number }>;
  byPaidBy: Array<{ paidBy: PaidBy; total: number }>;
  monthly: Array<{ month: string; total: number }>;
}

/** Everything the Expenses screen filters by, in one object. */
export interface ExpenseFilters {
  location?: ExpenseLocation;
  paidBy?: PaidBy;
  categoryId?: string;
  /** Inclusive ISO dates (yyyy-MM-dd). */
  from?: string;
  to?: string;
}

export function useExpenseCategories() {
  return useQuery({ queryKey: ['expense-categories'], queryFn: async () => (await api.get<ApiSuccess<ExpenseCategory[]>>('/expenses/categories')).data.data });
}

export function useCreateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (name: string) => (await api.post<ApiSuccess<ExpenseCategory>>('/expenses/categories', { name })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['expense-categories'] }),
  });
}

export function useUpdateExpenseCategory() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, name }: { id: string; name: string }) =>
      (await api.patch<ApiSuccess<ExpenseCategory>>(`/expenses/categories/${id}`, { name })).data.data,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['expense-categories'] });
      // The category name shows on expense rows + the by-category summary chart.
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['expense-summary'] });
    },
  });
}

export function useExpenses(params: ExpenseFilters = {}) {
  return useQuery({
    queryKey: ['expenses', params],
    // 100 is the server's MAX_LIMIT; the headline figures come from /summary, which
    // aggregates over the whole window, so a truncated table never skews them.
    queryFn: async () => (await api.get<ApiSuccess<Expense[]>>('/expenses', { params: { limit: 100, ...params } })).data.data,
  });
}

export function useExpenseSummary(params: ExpenseFilters = {}, enabled = true) {
  return useQuery({
    queryKey: ['expense-summary', params],
    enabled,
    queryFn: async () => (await api.get<ApiSuccess<ExpenseSummary>>('/expenses/summary', { params })).data.data,
  });
}

export function useSaveExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...input }: { id?: string; categoryId: string; amount: number; paymentMethod: string; location: string; paidBy: PaidBy; paidTo?: string; note?: string; expenseDate?: string }) =>
      id ? (await api.patch(`/expenses/${id}`, input)).data : (await api.post('/expenses', input)).data,
    onSuccess: () => {
      ['expenses', 'expense-summary', 'dashboard'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
  });
}

export function useDeleteExpense() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/expenses/${id}`)).data,
    onSuccess: () => { ['expenses', 'expense-summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
  });
}
