'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/lib/api';
import type { ApiSuccess } from '@/types/api';
import type { ItemUnit } from './useProducts';

export type OrderStatus = 'CONFIRMED' | 'DELIVERED' | 'CANCELLED';

export type FulfillmentSource = 'MAIN_BRANCH' | 'GODOWN';
export type OrderPaymentMode = 'ONLINE' | 'CREDIT';

/**
 * CONFIRMED reads as "Confirm Orders" because that is the queue it represents:
 * placed orders waiting for the main owner or godown to fulfil them.
 */
export const ORDER_STATUS_LABEL: Record<OrderStatus, string> = {
  CONFIRMED: 'Confirm Orders',
  DELIVERED: 'Delivered',
  CANCELLED: 'Cancelled',
};

export const ORDER_STATUS_BADGE: Record<OrderStatus, 'warning' | 'info' | 'success' | 'danger' | 'neutral'> = {
  CONFIRMED: 'warning',
  DELIVERED: 'success',
  CANCELLED: 'danger',
};

export interface OrderItem {
  id: string;
  requestedQuantity: string;
  confirmedQuantity: string | null;
  unitPriceSnapshot: string | null;
  product: { id: string; name: string; unit: ItemUnit; mrp: string; taxPercent: string };
}

export interface Order {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  orderDate: string;
  notes: string | null;
  paymentMode: OrderPaymentMode | null;
  fulfillmentSource: FulfillmentSource | null;
  isGstBill: boolean;
  confirmedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  cancellationReason: string | null;
  items: OrderItem[];
  outlet: { id: string; name: string; pricingMode: 'GENERIC' | 'SPECIAL'; gstBilling: boolean; creditPeriodDays: number };
  bill: { id: string; billNumber: string; grandTotal: string; status: string; isGstBill: boolean; balanceDue: string; payments: Array<{ method: string }> } | null;
  /** What the outlet owes — computed server-side with the same maths as the bill. */
  totals: { subTotal: number; taxTotal: number; grandTotal: number };
}

/**
 * What this order still owes on its bill. Bills are raised at placement now, so an
 * order can owe money well before it's delivered — this deliberately doesn't gate on
 * status, or every newly-placed order would read as owing nothing.
 */
export function amountDue(order: Order): number {
  if (!order.bill || order.bill.status === 'CANCELLED') return 0;
  return Number(order.bill.balanceDue);
}

export function isPendingPayment(order: Order): boolean {
  return order.status !== 'CANCELLED' && amountDue(order) > 0;
}

export function isCompleted(order: Order): boolean {
  return order.status === 'DELIVERED' && amountDue(order) <= 0;
}

/** How this order's payment state should read on a printed slip. */
export function paymentInfoFor(order: Order): { status: 'PENDING' | 'PARTIAL' | 'PAID'; amountDue: number; method?: string } {
  const method = order.bill?.payments?.[0]?.method;
  const pretty = method ? method.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) : undefined;
  if (!order.bill) {
    // Not fulfilled yet, so nothing is billed — the whole order total is still to collect.
    return { status: 'PENDING', amountDue: order.totals.grandTotal, method: pretty };
  }
  const due = Number(order.bill.balanceDue);
  if (due <= 0) return { status: 'PAID', amountDue: 0, method: pretty };
  return { status: pretty ? 'PARTIAL' : 'PENDING', amountDue: due, method: pretty };
}

export interface RazorpayOrderIntent { orderId: string; amount: number; currency: string; keyId: string; checkoutName?: string }

/** Inclusive ISO dates (yyyy-MM-dd), read as IST calendar days on the server. */
export interface OrderFilters {
  status?: OrderStatus;
  outletId?: string;
  from?: string;
  to?: string;
}

export function useOrders(params: OrderFilters = {}) {
  return useQuery({
    queryKey: ['orders', params],
    queryFn: async () => (await api.get<ApiSuccess<Order[]>>('/orders', { params: { limit: 100, ...params } })).data.data,
  });
}

/** One product's total for the day, across every franchise. */
export interface OrderSummaryProduct {
  productId: string;
  productName: string;
  sku: string;
  unitName: string;
  decimalPlaces: number;
  quantity: number;
  orderCount: number;
}

/** What a single franchise asked for that day. */
export interface OrderSummaryOutlet {
  outletId: string;
  outletName: string;
  totalQuantity: number;
  orderCount: number;
  products: Array<{
    productId: string;
    productName: string;
    sku: string;
    unitName: string;
    decimalPlaces: number;
    quantity: number;
  }>;
}

export interface OrderSummaryDay {
  day: string;
  totalQuantity: number;
  /** What has to be made in total. */
  products: OrderSummaryProduct[];
  /** Who it's for, biggest first. */
  outlets: OrderSummaryOutlet[];
}

/** Product-wise ordered quantities per IST day — the packing view, not the money view. */
export function useOrderSummary(params: { outletId?: string; from?: string; to?: string } = {}) {
  return useQuery({
    queryKey: ['orders', 'summary', params],
    queryFn: async () =>
      (await api.get<ApiSuccess<{ days: OrderSummaryDay[] }>>('/orders/summary', { params })).data.data,
  });
}

/** Every order mutation ripples into the same downstream views — invalidate them together. */
function useOrderMutation<TVars, TData>(fn: (vars: TVars) => Promise<TData>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['orders'] });
      qc.invalidateQueries({ queryKey: ['bills'] });
      qc.invalidateQueries({ queryKey: ['payments'] });
      qc.invalidateQueries({ queryKey: ['inventory'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
  });
}

export function useCreateOrder() {
  return useOrderMutation(async (input: { items: Array<{ productId: string; requestedQuantity: number }>; notes?: string; orderDate?: string }) =>
    (await api.post<ApiSuccess<Order>>('/orders', input)).data.data,
  );
}

/** Outlet: open (or retry) an online checkout — allowed before or after fulfilment. */
export function useOrderPaymentIntent() {
  return useMutation({
    mutationFn: async (id: string) => (await api.post<ApiSuccess<RazorpayOrderIntent>>(`/orders/${id}/razorpay/order`, {})).data.data,
  });
}

export function useVerifyOrderPayment() {
  return useOrderMutation(async ({ id, ...body }: { id: string; razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string }) =>
    (await api.post<ApiSuccess<Order>>(`/orders/${id}/razorpay/verify`, body)).data.data,
  );
}

/**
 * Main owner / godown: send the order out. One action — stock leaves the godown,
 * lands at the outlet, and the bill is raised.
 */
export function useFulfilOrder() {
  return useOrderMutation(async (id: string) => (await api.post<ApiSuccess<Order>>(`/orders/${id}/fulfil`, {})).data.data);
}

export function useCancelOrder() {
  return useOrderMutation(async ({ id, reason }: { id: string; reason?: string }) =>
    (await api.post<ApiSuccess<Order>>(`/orders/${id}/cancel`, { reason })).data.data,
  );
}
