'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiSuccess } from '@/types/api';

/** The number a franchise owner's Call button dials — set by the main owner. */
export function useCallNumber() {
  return useQuery({
    queryKey: ['settings', 'call-number'],
    queryFn: async () => (await api.get<ApiSuccess<{ phone: string | null }>>('/settings/call-number')).data.data,
  });
}

export function useUpdateCallNumber() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (phone: string) => (await api.put<ApiSuccess<{ phone: string | null }>>('/settings/call-number', { phone })).data.data,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings', 'call-number'] }),
  });
}

/**
 * Head-office business identity — the entity that raises franchise invoices and
 * collects payment. Maintained by the main owner in Settings → Business Profile;
 * read by the invoice PDF, the payslip PDF, the payment checkout name, and the
 * franchise-payment UPI QR.
 */
export interface CompanyProfile {
  legalName: string;
  displayName: string;
  tagline: string;
  address: string;
  phone: string;
  email: string;
  gstin: string;
  fssai: string;
  upiVpa: string;
  upiPayeeName: string;
  invoiceTerms: string;
}

/** Readable by every authenticated role — the UPI QR and invoice header need it. */
export function useCompanyProfile() {
  return useQuery({
    queryKey: ['settings', 'company'],
    queryFn: async () => (await api.get<ApiSuccess<CompanyProfile>>('/settings/company')).data.data,
    staleTime: 5 * 60_000,
  });
}

export function useUpdateCompanyProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (patch: Partial<CompanyProfile>) =>
      (await api.put<ApiSuccess<CompanyProfile>>('/settings/company', patch)).data.data,
    onSuccess: (data) => {
      qc.setQueryData(['settings', 'company'], data);
      qc.invalidateQueries({ queryKey: ['settings', 'company'] });
    },
  });
}
