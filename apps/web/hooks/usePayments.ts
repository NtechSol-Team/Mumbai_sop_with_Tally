'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiSuccess } from '@/types/api';

export interface PaymentSummary {
  totalReceivables: number;
  collectedThisMonth: number;
  overdueAmount: number;
  outletOutstanding: Array<{ outletId: string; outletName: string; outstanding: number }>;
  aging: Array<{ label: string; amount: number }>;
}

export interface PaymentRow {
  id: string;
  paymentNumber: string;
  amount: string;
  channel: string;
  method: string;
  paymentDate: string;
  referenceNumber: string | null;
  notes: string | null;
  bill: { billNumber: string } | null;
  outlet: { name: string };
}

export interface RazorpayOrder {
  orderId: string;
  amount: number;
  currency: string;
  keyId: string;
  /** Business name shown on the Razorpay checkout — from the company profile. */
  checkoutName?: string;
}

function invalidateAll(qc: ReturnType<typeof useQueryClient>) {
  ['bills', 'payments', 'dashboard', 'payment-summary'].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
}

export function usePaymentSummary() {
  return useQuery({
    queryKey: ['payment-summary'],
    queryFn: async () => (await api.get<ApiSuccess<PaymentSummary>>('/payments/summary')).data.data,
  });
}

export function usePayments(params: { outletId?: string } = {}) {
  return useQuery({
    queryKey: ['payments', params],
    queryFn: async () => (await api.get<ApiSuccess<PaymentRow[]>>('/payments', { params: { limit: 100, ...params } })).data.data,
  });
}

/** Records money taken in person — literal cash, or a UPI transfer the owner has seen land. */
export function useRecordCash() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { billId: string; amount: number; method?: 'CASH' | 'UPI' | 'BANK_TRANSFER'; referenceNumber?: string; notes?: string }) =>
      (await api.post('/payments/cash', input)).data,
    onSuccess: () => invalidateAll(qc),
  });
}

export function useRazorpayOrder() {
  return useMutation({
    mutationFn: async (billId: string) => (await api.post<ApiSuccess<RazorpayOrder>>('/payments/razorpay/order', { billId })).data.data,
  });
}

export function useVerifyRazorpay() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { billId: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
      (await api.post('/payments/razorpay/verify', input)).data,
    onSuccess: () => invalidateAll(qc),
  });
}

/** Reverses a payment entered by mistake. The bill's paid/due/status re-derive
 *  from what's actually left, so this correctly "un-pays" it either partway or
 *  all the way back to Unpaid, matching however much was wrongly recorded. */
export function useDeletePayment() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => (await api.delete(`/payments/${id}`)).data,
    onSuccess: () => invalidateAll(qc),
  });
}
