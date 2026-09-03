import {
  Prisma, BillStatus, FulfillmentSource, OrderPaymentMode, OutletOrderStatus,
  PaymentChannel, PaymentMethod, PaymentStatus, StockMovementReason, UserRole,
} from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { IST_AT, istRange } from '../../shared/utils/date';
import { assertProductQuantities } from '../../shared/utils/quantity';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { razorpay, razorpayErrorMessage, verifyCheckoutSignature } from '../../config/razorpay';
import { env } from '../../config/env';
import { enqueue, JobName } from '../../jobs/queue';
import { billingService } from '../billing/billing.service';
import { getCompanyProfile } from '../settings/settings.service';
import { enqueueTallySync } from '../tally/tally.outbox';
import type { AuthUser } from '../../shared/types/api';
import type {
  CreateOrderInput, ListOrdersQuery, OrderSummaryQuery, RejectOrderInput, VerifyOrderPaymentInput,
} from './orders.schema';

const orderInclude = {
  // Franchise ordering prices against MRP, not the internal basePrice cost basis —
  // an outlet order calculates and bills the same way an outlet customer would see.
  items: {
    include: {
      product: {
        select: { id: true, name: true, mrp: true, taxPercent: true, unit: { select: { id: true, name: true, decimalPlaces: true } } },
      },
    },
  },
  outlet: { select: { id: true, name: true, pricingMode: true, gstBilling: true, creditPeriodDays: true } },
  bill: {
    select: {
      id: true, billNumber: true, grandTotal: true, status: true, isGstBill: true, balanceDue: true,
      // Just the most recent payment — enough to print "paid by Cash/UPI" on a
      // reprinted order slip without pulling the whole payment history.
      payments: {
        where: { isDeleted: false },
        select: { method: true },
        orderBy: { paymentDate: 'desc' },
        take: 1,
      },
    },
  },
} satisfies Prisma.OutletOrderInclude;

type OrderWithItems = Prisma.OutletOrderGetPayload<{ include: typeof orderInclude }>;

/** Where confirmed stock is decremented from at dispatch — chosen by the admin when dispatching. */
function sourceStockModel(source: FulfillmentSource) {
  return source === FulfillmentSource.GODOWN
    ? {
        label: 'godown',
        find: (tx: Prisma.TransactionClient, productId: string) => tx.godownStock.findUnique({ where: { productId } }),
        dec: (tx: Prisma.TransactionClient, productId: string, qty: Prisma.Decimal) => tx.godownStock.update({ where: { productId }, data: { quantity: { decrement: qty } } }),
      }
    : {
        label: 'main-branch',
        find: (tx: Prisma.TransactionClient, productId: string) => tx.mainBranchStock.findUnique({ where: { productId } }),
        dec: (tx: Prisma.TransactionClient, productId: string, qty: Prisma.Decimal) => tx.mainBranchStock.update({ where: { productId }, data: { quantity: { decrement: qty } } }),
      };
}

/**
 * Apply a signed change to a product's godown stock and record why.
 *
 * `quantityDelta` is negative to take stock out, positive to put it back. Uses
 * upsert rather than update because plenty of products have never had a
 * GodownStock row (they were created without opening stock), and an order for one
 * of those must still be recorded rather than blowing up on a missing row.
 *
 * Deliberately does NOT refuse to go negative: outlets order freely, most products
 * are not stock-counted rigorously, and a negative godown figure is a truthful
 * "we owe this much" signal rather than a reason to block a franchise's order.
 */
async function moveGodownStockTx(
  tx: Prisma.TransactionClient,
  input: {
    productId: string;
    quantityDelta: Prisma.Decimal;
    reason: StockMovementReason;
    orderId: string;
    outletId: string;
    userId: string | null;
    notes?: string;
    // Back-dated orders need their audit trail dated to match, not to the moment
    // someone got around to typing it in. Omitted callers keep the DB default (now).
    createdAt?: Date;
  },
) {
  const stock = await tx.godownStock.upsert({
    where: { productId: input.productId },
    create: { productId: input.productId, quantity: input.quantityDelta },
    update: { quantity: { increment: input.quantityDelta } },
    select: { quantity: true },
  });
  await tx.stockMovement.create({
    data: {
      productId: input.productId,
      outletId: input.outletId,
      orderId: input.orderId,
      reason: input.reason,
      quantityDelta: input.quantityDelta,
      balanceAfter: stock.quantity,
      notes: input.notes,
      createdById: input.userId,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    },
  });
}

function resolveOutletId(user: AuthUser, requested?: string): string {
  if (user.role === UserRole.SUPER_ADMIN) {
    if (!requested) throw AppError.badRequest('outletId is required when ordering as admin', undefined, 'outletId');
    return requested;
  }
  if (!user.outletId) throw AppError.forbidden('Your account is not linked to an outlet');
  return user.outletId;
}

function assertOwnOutlet(user: AuthUser, outletId: string) {
  if (user.role === UserRole.SUPER_ADMIN) return;
  if (user.outletId !== outletId) throw AppError.forbidden();
}

/**
 * What the outlet owes for this order, from the price/quantity snapshot taken at
 * placement (and possibly adjusted by the main owner while approving a credit
 * order). Mirrors the bill's own arithmetic exactly, so the amount charged at
 * checkout always equals the bill that gets generated on confirmation.
 */
export function orderTotals(order: OrderWithItems) {
  let subTotal = new Prisma.Decimal(0);
  let taxTotal = new Prisma.Decimal(0);
  for (const item of order.items) {
    const qty = new Prisma.Decimal(item.confirmedQuantity ?? item.requestedQuantity);
    const rate = new Prisma.Decimal(item.unitPriceSnapshot ?? item.product.mrp);
    const lineBase = rate.mul(qty);
    const taxPercent = order.isGstBill ? new Prisma.Decimal(item.product.taxPercent) : new Prisma.Decimal(0);
    subTotal = subTotal.add(lineBase);
    taxTotal = taxTotal.add(lineBase.mul(taxPercent).div(100));
  }
  return { subTotal, taxTotal, grandTotal: subTotal.add(taxTotal) };
}

/**
 * Place an order. It goes straight into the fulfilment queue (CONFIRMED) — there
 * is no payment or credit-approval gate in front of it.
 *
 * Two things happen here that used to wait for Fulfil: the ordered quantities come
 * out of the godown, and the bill is raised. So an order is a real, payable
 * document from the moment it's placed — it shows under Sales immediately and the
 * outlet can settle it whenever. Fulfil is now purely the physical hand-over
 * (godown → outlet stock), and cancelling before that voids the bill it raised.
 */
export async function createOrder(user: AuthUser, input: CreateOrderInput) {
  const outletId = resolveOutletId(user, input.outletId);

  // Outlets can place as many orders as they like, whether or not earlier ones
  // have been fulfilled yet — there is no one-at-a-time gate here anymore.

  const productIds = input.items.map((i) => i.productId);
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, isDeleted: false, isActive: true, isPosEnabled: false },
    select: { id: true, mrp: true, trackInventory: true },
  });
  if (products.length !== new Set(productIds).size) throw AppError.badRequest('One or more products are invalid');
  const priceOf = new Map(products.map((p) => [p.id, p.mrp]));
  // Products that keep no stock ledger are ordered and billed, but nothing is
  // decremented for them — the same rule POS sales already follow.
  const tracksStock = new Map(products.map((p) => [p.id, p.trackInventory]));
  await assertProductQuantities(input.items.map((i) => ({ productId: i.productId, quantity: i.requestedQuantity })));

  const outlet = await prisma.outlet.findFirst({ where: { id: outletId, isDeleted: false }, select: { id: true, pricingMode: true, gstBilling: true } });
  if (!outlet) throw AppError.notFound('Outlet not found');

  // Negotiated prices only apply to outlets on SPECIAL pricing; otherwise catalog price.
  const specials = outlet.pricingMode === 'SPECIAL'
    ? await prisma.outletProductPrice.findMany({ where: { outletId, productId: { in: productIds } }, select: { productId: true, price: true } })
    : [];
  const specialOf = new Map(specials.map((s) => [s.productId, s.price]));

  // The order's own date — today unless the franchise owner back-dated it. Every
  // timestamp below uses this rather than "now", so a Monday order entered on
  // Tuesday still reports, numbers and reconciles as Monday's, the same way a
  // back-dated manual bill does.
  const placedAt = input.orderDate;

  const created = await prisma.$transaction(async (tx) => {
    const orderNumber = await nextDocNumber(tx, 'ORDER', placedAt);
    const placed = await tx.outletOrder.create({
      data: {
        orderNumber,
        outletId,
        status: OutletOrderStatus.CONFIRMED,
        orderDate: placedAt,
        confirmedAt: placedAt,
        // Stock leaves the godown as part of this same transaction, so the order
        // is born already marked as deducted — Fulfil must not take it a second time.
        stockDeductedAt: placedAt,
        isGstBill: outlet.gstBilling,
        notes: input.notes,
        createdById: user.id,
        items: {
          create: input.items.map((i) => ({
            productId: i.productId,
            requestedQuantity: i.requestedQuantity,
            // Priced up-front so the outlet can pay immediately. Quantities are
            // taken as ordered; the main owner may still trim them on credit orders.
            confirmedQuantity: i.requestedQuantity,
            unitPriceSnapshot: specialOf.get(i.productId) ?? priceOf.get(i.productId)!,
          })),
        },
      },
      include: orderInclude,
    });

    // Commit the goods to this outlet the moment the order is placed, so the
    // godown figure the owner sees already accounts for what's been ordered.
    for (const item of input.items) {
      if (!tracksStock.get(item.productId)) continue;
      await moveGodownStockTx(tx, {
        productId: item.productId,
        quantityDelta: new Prisma.Decimal(item.requestedQuantity).negated(),
        reason: StockMovementReason.ORDER_PLACED,
        orderId: placed.id,
        outletId,
        userId: user.id,
        notes: `Order ${orderNumber} placed`,
        createdAt: placedAt,
      });
    }

    // Raise the bill now rather than at Fulfil. createBillForOrderTx needs the
    // product rows and the outlet's credit period, which orderInclude doesn't carry.
    const forBill = await tx.outletOrder.findUniqueOrThrow({
      where: { id: placed.id },
      include: { items: { include: { product: true } }, outlet: true },
    });
    const bill = await billingService.createBillForOrderTx(tx, forBill, user.id, placedAt);
    return { placed, bill };
  });

  cache.invalidateTags(
    CacheTag.ORDERS, CacheTag.INVENTORY, CacheTag.BILLS, CacheTag.DASHBOARD, CacheTag.outlet(outletId),
  );
  // Queues the PDF and announces the bill — same post-commit work Fulfil used to do.
  await billingService.afterBillGenerated({ ...created.bill, outletId });

  // Re-read so the response carries the bill that was just raised; the row created
  // above was fetched before it existed.
  const order = await loadForTransition(created.placed.id);

  // Auto-print trigger: fire the instant the order lands, regardless of what
  // happens next (online payment vs. credit approval) — godown/admin start
  // processing it right away instead of waiting on that approval workflow.
  // Full print-ready data rides in the event itself so the listener never
  // needs a follow-up fetch to print.
  await emitRealtime(
    RealtimeEvent.NEW_ORDER,
    {
      orderId: order.id,
      orderNumber: order.orderNumber,
      outletName: order.outlet.name,
      isGstBill: order.isGstBill,
      orderDate: order.orderDate.toISOString(),
      items: order.items.map((i) => ({
        name: i.product.name,
        // The print payload wants a printable label, not the Unit record.
        unit: i.product.unit.name,
        qty: Number(i.confirmedQuantity ?? i.requestedQuantity),
        price: Number(i.unitPriceSnapshot ?? i.product.mrp),
      })),
      // A just-placed order is billed but never yet paid, so the slip always prints
      // "collect this much" — which is exactly what the packer needs.
      payment: { status: 'PENDING' as const, amountDue: Number(orderTotals(order).grandTotal) },
    },
    { global: true, outletId },
  );

  return { ...order, totals: numericTotals(order) };
}

export async function listOrders(user: AuthUser, query: ListOrdersQuery) {
  const scoped = user.role === UserRole.FRANCHISE_OWNER || user.role === UserRole.CASHIER;
  const scopeKey = scoped ? (user.outletId ?? '__none__') : (query.outletId ?? '__all__');
  return cache.getOrSet(`orders:list:${scopeKey}:${JSON.stringify(query)}`, [CacheTag.ORDERS], async () => {
    const dateRange = istRange(query.from, query.to);
    const where: Prisma.OutletOrderWhereInput = {
      isDeleted: false,
      ...(scoped ? { outletId: user.outletId ?? '__none__' } : query.outletId ? { outletId: query.outletId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(dateRange ? { orderDate: dateRange } : {}),
    };
    const { skip, take } = toSkipTake(query);
    const [rows, total] = await Promise.all([
      prisma.outletOrder.findMany({ where, orderBy: { orderDate: 'desc' }, skip, take, include: orderInclude }),
      prisma.outletOrder.count({ where }),
    ]);
    return { rows: rows.map((o) => ({ ...o, totals: numericTotals(o) })), meta: buildPaginationMeta(query, total) };
  });
}

/**
 * Product-wise ordered quantities, bucketed by IST calendar day, each product
 * broken down by the outlets that ordered it.
 *
 * Answers "how much of each product did the outlets order today, and who wants
 * it" — the packing list view, rather than the money view the order list gives.
 * Raw SQL because Prisma's groupBy can't bucket a timestamp into a day, let
 * alone an IST one.
 */
export async function getOrderSummary(user: AuthUser, query: OrderSummaryQuery) {
  const scoped = user.role === UserRole.FRANCHISE_OWNER || user.role === UserRole.CASHIER;
  // A franchise owner only ever sees their own outlet, whatever they ask for.
  const outletId = scoped ? (user.outletId ?? '__none__') : query.outletId;
  const range = istRange(query.from, query.to);
  const scopeKey = `${outletId ?? '__all__'}:${JSON.stringify(query)}`;

  return cache.getOrSet(`orders:summary:${scopeKey}`, [CacheTag.ORDERS], async () => {
    // Grouped per outlet as well as per product; the product- and day-level totals
    // are folded up from these rows below, so every level agrees by construction.
    const rows = await prisma.$queryRaw<Array<{
      day: string; productId: string; productName: string; sku: string;
      unitName: string; decimalPlaces: number; outletId: string; outletName: string;
      quantity: number; orderCount: number;
    }>>`
      SELECT to_char(date_trunc('day', o.order_date ${Prisma.raw(IST_AT)}), 'YYYY-MM-DD') AS day,
             p.id   AS "productId",
             p.name AS "productName",
             p.sku  AS sku,
             u.name AS "unitName",
             u.decimal_places AS "decimalPlaces",
             ot.id   AS "outletId",
             ot.name AS "outletName",
             COALESCE(SUM(COALESCE(i.confirmed_quantity, i.requested_quantity)), 0)::float AS quantity,
             COUNT(DISTINCT o.id)::int AS "orderCount"
      FROM outlet_orders o
      JOIN outlet_order_items i ON i.order_id = o.id AND i.is_deleted = false
      JOIN products p ON p.id = i.product_id
      JOIN units u ON u.id = p.unit_id
      JOIN outlets ot ON ot.id = o.outlet_id
      WHERE o.is_deleted = false
        ${query.includeCancelled ? Prisma.empty : Prisma.sql`AND o.status <> 'CANCELLED'::"OutletOrderStatus"`}
        ${outletId ? Prisma.sql`AND o.outlet_id = ${outletId}::uuid` : Prisma.empty}
        -- Bounds are pre-converted in JS (istRange), so order_date stays bare and
        -- its index can still range-seek. Same reasoning as the expense trend.
        ${range?.gte ? Prisma.sql`AND o.order_date >= ${range.gte}` : Prisma.empty}
        ${range?.lt ? Prisma.sql`AND o.order_date < ${range.lt}` : Prisma.empty}
      GROUP BY 1, 2, 3, 4, 5, 6, 7, 8
      ORDER BY 1 DESC`;

    type ProductLine = {
      productId: string; productName: string; sku: string; unitName: string;
      decimalPlaces: number; quantity: number; orderCount: number;
    };
    type OutletProductLine = {
      productId: string; productName: string; sku: string; unitName: string;
      decimalPlaces: number; quantity: number;
    };
    type OutletLine = {
      outletId: string; outletName: string; totalQuantity: number; orderCount: number;
      products: OutletProductLine[];
    };

    // Two views of the same rows, because they answer different questions: what has
    // to be made in total, and what each franchise is waiting for. Both are folded
    // here so the client renders them without regrouping.
    const byDay = new Map<string, {
      day: string; totalQuantity: number;
      products: Map<string, ProductLine>;
      outlets: Map<string, OutletLine & { orderIds: Set<string> }>;
    }>();

    for (const row of rows) {
      const day = byDay.get(row.day) ?? { day: row.day, totalQuantity: 0, products: new Map(), outlets: new Map() };

      const product = day.products.get(row.productId) ?? {
        productId: row.productId, productName: row.productName, sku: row.sku,
        unitName: row.unitName, decimalPlaces: row.decimalPlaces,
        quantity: 0, orderCount: 0,
      };
      product.quantity += row.quantity;
      // An order belongs to exactly one outlet, so per-outlet distinct counts never
      // overlap and summing them gives the product's true order count.
      product.orderCount += row.orderCount;
      day.products.set(row.productId, product);

      const outlet = day.outlets.get(row.outletId) ?? {
        outletId: row.outletId, outletName: row.outletName,
        totalQuantity: 0, orderCount: 0, products: [], orderIds: new Set<string>(),
      };
      outlet.totalQuantity += row.quantity;
      // Per-product counts double-count an order that contains several products, so
      // the outlet's own order count is taken as the max across its lines rather
      // than the sum — one order with three products is still one order.
      outlet.orderCount = Math.max(outlet.orderCount, row.orderCount);
      outlet.products.push({
        productId: row.productId, productName: row.productName, sku: row.sku,
        unitName: row.unitName, decimalPlaces: row.decimalPlaces, quantity: row.quantity,
      });
      day.outlets.set(row.outletId, outlet);

      day.totalQuantity += row.quantity;
      byDay.set(row.day, day);
    }

    const days = [...byDay.values()].map((d) => ({
      day: d.day,
      totalQuantity: d.totalQuantity,
      products: [...d.products.values()].sort((a, b) => b.quantity - a.quantity),
      outlets: [...d.outlets.values()]
        .map(({ orderIds: _orderIds, ...o }) => ({
          ...o,
          products: o.products.sort((a, b) => b.quantity - a.quantity),
        }))
        .sort((a, b) => b.totalQuantity - a.totalQuantity),
    }));
    return { days };
  });
}

export async function getOrder(user: AuthUser, id: string) {
  const scoped = user.role === UserRole.FRANCHISE_OWNER || user.role === UserRole.CASHIER;
  const order = await prisma.outletOrder.findFirst({
    where: { id, isDeleted: false, ...(scoped ? { outletId: user.outletId ?? '__none__' } : {}) },
    include: orderInclude,
  });
  if (!order) throw AppError.notFound('Order not found');
  return { ...order, totals: numericTotals(order) };
}

/** Totals as plain numbers for the API surface (Decimals don't survive JSON meaningfully). */
function numericTotals(order: OrderWithItems) {
  const t = orderTotals(order);
  return { subTotal: Number(t.subTotal), taxTotal: Number(t.taxTotal), grandTotal: Number(t.grandTotal) };
}

async function loadForTransition(id: string): Promise<OrderWithItems> {
  const order = await prisma.outletOrder.findFirst({ where: { id, isDeleted: false }, include: orderInclude });
  if (!order) throw AppError.notFound('Order not found');
  return order;
}


/**
 * Attach any advance payments taken against this order to its freshly-raised bill,
 * and roll the bill's paid/outstanding figures forward.
 *
 * An outlet may pay before its order is fulfilled, at which point no bill exists —
 * the money is recorded against the order instead (Payment.orderId, billId null).
 * Fulfil raises the bill, so this is where that money finally lands on it, and why
 * a prepaid order never shows up under Pending Payment.
 */
async function applyAdvancesToBillTx(
  tx: Prisma.TransactionClient,
  orderId: string,
  bill: { id: string; grandTotal: Prisma.Decimal },
) {
  const advances = await tx.payment.findMany({
    where: { orderId, billId: null, isDeleted: false, status: PaymentStatus.SUCCESS },
    select: { id: true, amount: true },
  });
  if (advances.length === 0) return;

  await tx.payment.updateMany({ where: { id: { in: advances.map((a) => a.id) } }, data: { billId: bill.id } });

  const paid = advances.reduce((sum, a) => sum.add(new Prisma.Decimal(a.amount)), new Prisma.Decimal(0));
  const balance = new Prisma.Decimal(bill.grandTotal).sub(paid);
  await tx.bill.update({
    where: { id: bill.id },
    data: {
      amountPaid: paid,
      // Never go negative: an overpayment leaves the bill settled, and the surplus
      // stays visible as payments exceeding the bill total rather than a bogus credit.
      balanceDue: balance.lessThan(0) ? new Prisma.Decimal(0) : balance,
      status: balance.lessThanOrEqualTo(0) ? BillStatus.PAID : BillStatus.PARTIALLY_PAID,
    },
  });
}

/** The outlet's outstanding bill for this order, if it has been fulfilled and still owes. */
async function outstandingBillFor(orderId: string) {
  return prisma.bill.findFirst({
    where: { orderId, isDeleted: false, status: { in: [BillStatus.UNPAID, BillStatus.PARTIALLY_PAID] } },
    select: { id: true, billNumber: true, grandTotal: true, amountPaid: true, balanceDue: true },
  });
}

/**
 * What this order still needs paying, and where that money should attach.
 *
 * The bill is the source of truth whenever one exists — which, since bills are
 * raised at placement, is every order from here on. The advance-against-the-order
 * branch below only still applies to orders raised under the older flow, where the
 * bill didn't appear until Fulfil; Fulfil moves that money onto the bill.
 */
async function payableFor(order: OrderWithItems): Promise<{ amount: Prisma.Decimal; billId: string | null }> {
  const bill = await outstandingBillFor(order.id);
  if (bill) return { amount: new Prisma.Decimal(bill.balanceDue), billId: bill.id };

  // No outstanding bill: either it's fully settled/cancelled, or this is a legacy
  // order still awaiting Fulfil. Only the latter is payable, as an advance.
  if (order.status === OutletOrderStatus.CONFIRMED && !order.bill) {
    const alreadyAdvanced = await prisma.payment.aggregate({
      where: { orderId: order.id, billId: null, isDeleted: false, status: PaymentStatus.SUCCESS },
      _sum: { amount: true },
    });
    const paid = new Prisma.Decimal(alreadyAdvanced._sum.amount ?? 0);
    return { amount: orderTotals(order).grandTotal.sub(paid), billId: null };
  }
  return { amount: new Prisma.Decimal(0), billId: null };
}

/**
 * Start (or retry) an online checkout for an order.
 *
 * Allowed both before fulfilment (paying up front) and after it while the bill is
 * still outstanding — the outlet chooses when to settle.
 */
export async function createOrderPaymentIntent(user: AuthUser, id: string) {
  const order = await loadForTransition(id);
  assertOwnOutlet(user, order.outletId);
  if (order.status === OutletOrderStatus.CANCELLED) throw AppError.invalidState('This order was cancelled');

  const { amount } = await payableFor(order);
  const amountPaise = Math.round(Number(amount) * 100);
  if (amountPaise <= 0) throw AppError.invalidState('This order is already fully paid');

  try {
    const rzpOrder = await razorpay.orders.create({
      amount: amountPaise,
      currency: 'INR',
      receipt: order.orderNumber,
      // orderId lets the webhook record the payment even if the browser dies mid-checkout.
      notes: { orderId: order.id, outletId: order.outletId },
    });
    await prisma.outletOrder.update({
      where: { id },
      data: { razorpayOrderId: rzpOrder.id, paymentMode: OrderPaymentMode.ONLINE },
    });
    const company = await getCompanyProfile();
    const checkoutName = company.displayName || company.legalName || 'Payment';
    return { orderId: rzpOrder.id, amount: amountPaise, currency: 'INR', keyId: env.RAZORPAY_KEY_ID, checkoutName };
  } catch (err) {
    throw AppError.payment(`Could not initiate payment: ${razorpayErrorMessage(err)}`);
  }
}

/**
 * Record a verified online payment for an order.
 *
 * Where the money lands depends on how far the order has got: against the bill if
 * it has been fulfilled, otherwise held against the order as an advance that Fulfil
 * will apply. Either way the order's own status is untouched — paying no longer
 * gates anything.
 */
async function recordOrderPaymentTx(
  tx: Prisma.TransactionClient,
  order: OrderWithItems,
  userId: string | null,
  amount: Prisma.Decimal,
  billId: string | null,
  paidWith: { razorpayOrderId: string; razorpayPaymentId: string; razorpaySignature: string },
) {
  const paymentNumber = await nextDocNumber(tx, 'PAYMENT');
  const payment = await tx.payment.create({
    data: {
      paymentNumber,
      billId,
      orderId: order.id,
      outletId: order.outletId,
      channel: PaymentChannel.DIGITAL,
      method: PaymentMethod.RAZORPAY,
      amount,
      status: PaymentStatus.SUCCESS,
      createdById: userId,
      razorpayOrderId: paidWith.razorpayOrderId,
      razorpayPaymentId: paidWith.razorpayPaymentId,
      razorpaySignature: paidWith.razorpaySignature,
      notes: billId
        ? `Online payment for order ${order.orderNumber}`
        : `Advance online payment for order ${order.orderNumber} (before fulfilment)`,
    },
  });

  await enqueueTallySync(tx, {
    entityType: 'PAYMENT_IN',
    entityId: payment.id,
    voucherType: 'RECEIPT',
    entityDate: payment.paymentDate,
    amount: payment.amount,
    docNumber: payment.paymentNumber,
    partyName: order.outlet.name,
  });

  if (billId) {
    const bill = await tx.bill.findUniqueOrThrow({ where: { id: billId }, select: { grandTotal: true, amountPaid: true } });
    const paid = new Prisma.Decimal(bill.amountPaid).add(amount);
    const balance = new Prisma.Decimal(bill.grandTotal).sub(paid);
    await tx.bill.update({
      where: { id: billId },
      data: {
        amountPaid: paid,
        balanceDue: balance.lessThan(0) ? new Prisma.Decimal(0) : balance,
        status: balance.lessThanOrEqualTo(0) ? BillStatus.PAID : BillStatus.PARTIALLY_PAID,
      },
    });
  }
}

/** Verify the Razorpay checkout signature and bank the payment. */
export async function verifyOrderPayment(user: AuthUser, id: string, input: VerifyOrderPaymentInput) {
  const order = await loadForTransition(id);
  assertOwnOutlet(user, order.outletId);

  const valid = verifyCheckoutSignature({
    orderId: input.razorpayOrderId,
    paymentId: input.razorpayPaymentId,
    signature: input.razorpaySignature,
  });
  if (!valid) throw AppError.payment('Payment signature verification failed');

  // The signature proves the payment is authentic; this proves it belongs to THIS order.
  if (order.razorpayOrderId !== input.razorpayOrderId) {
    throw AppError.payment('This payment does not belong to this order');
  }

  // Idempotency: the webhook may have banked it first, or the user double-submitted.
  const already = await prisma.payment.findFirst({ where: { razorpayPaymentId: input.razorpayPaymentId } });
  if (already) return { ...order, totals: numericTotals(order) };

  const { amount, billId } = await payableFor(order);
  if (Number(amount) <= 0) return { ...order, totals: numericTotals(order) };

  await prisma.$transaction((tx) =>
    recordOrderPaymentTx(tx, order, user.id, amount, billId, {
      razorpayOrderId: input.razorpayOrderId,
      razorpayPaymentId: input.razorpayPaymentId,
      razorpaySignature: input.razorpaySignature,
    }),
  );

  const updated = await loadForTransition(id);
  cache.invalidateTags(CacheTag.ORDERS, CacheTag.BILLS, CacheTag.PAYMENTS, CacheTag.DASHBOARD, CacheTag.outlet(order.outletId));
  await emitRealtime(
    RealtimeEvent.ORDER_STATUS_CHANGED,
    { orderId: id, orderNumber: order.orderNumber, status: updated.status, outletName: order.outlet.name, paid: true },
    { global: true, outletId: order.outletId },
  );
  return { ...updated, totals: numericTotals(updated) };
}

/**
 * Bank an online order payment straight from the Razorpay webhook — the safety net
 * for when the payment succeeds but the browser never comes back to verify it.
 * Called by the payments webhook handler; there is no authenticated user here.
 */
export async function confirmPaidOrderFromWebhook(
  orderId: string,
  paidWith: { razorpayOrderId: string; razorpayPaymentId: string },
) {
  const order = await prisma.outletOrder.findFirst({ where: { id: orderId, isDeleted: false }, include: orderInclude });
  if (!order || order.status === OutletOrderStatus.CANCELLED) return { ignored: true };
  if (order.razorpayOrderId !== paidWith.razorpayOrderId) return { ignored: true };

  const already = await prisma.payment.findFirst({ where: { razorpayPaymentId: paidWith.razorpayPaymentId } });
  if (already) return { ignored: true };

  const { amount, billId } = await payableFor(order);
  if (Number(amount) <= 0) return { ignored: true };

  await prisma.$transaction((tx) =>
    recordOrderPaymentTx(tx, order, order.createdById ?? null, amount, billId, {
      razorpayOrderId: paidWith.razorpayOrderId,
      razorpayPaymentId: paidWith.razorpayPaymentId,
      razorpaySignature: 'webhook',
    }),
  );

  cache.invalidateTags(CacheTag.ORDERS, CacheTag.BILLS, CacheTag.PAYMENTS, CacheTag.DASHBOARD, CacheTag.outlet(order.outletId));
  await emitRealtime(
    RealtimeEvent.ORDER_STATUS_CHANGED,
    { orderId, orderNumber: order.orderNumber, status: order.status, outletName: order.outlet.name, paid: true },
    { global: true, outletId: order.outletId },
  );
  return { confirmed: true };
}

/**
 * Fulfil an order: the single action that sends it out and completes delivery.
 *
 * Replaces the old dispatch-then-outlet-confirms-receipt pair. Stock leaves the
 * godown and lands at the outlet in one transaction, the bill is raised (this is
 * the point the outlet genuinely owes money), and any advance already paid is
 * applied to it. What remains outstanding is what Pending Payment tracks.
 */
export async function fulfilOrder(user: AuthUser, id: string) {
  const order = await loadForTransition(id);
  if (order.status !== OutletOrderStatus.CONFIRMED) {
    throw AppError.invalidState('Only an order awaiting fulfilment can be fulfilled');
  }

  const model = sourceStockModel(FulfillmentSource.GODOWN);
  // Orders placed since deduct-on-placement landed already had their stock taken
  // out of the godown; fulfilling one only has to hand the goods to the outlet.
  // Anything older (stockDeductedAt null) still gets deducted here, the old way.
  const alreadyDeducted = order.stockDeductedAt !== null;

  const { updated, bill, isNewBill } = await prisma.$transaction(async (tx) => {
    // Check every line before moving anything, so a shortfall can't leave the
    // order half-fulfilled. Only meaningful for orders that haven't been
    // deducted yet — for the rest the stock left the godown at placement.
    if (!alreadyDeducted) {
      for (const item of order.items) {
        const qty = new Prisma.Decimal(item.confirmedQuantity ?? item.requestedQuantity);
        const stock = await model.find(tx, item.productId);
        if (!stock || new Prisma.Decimal(stock.quantity).lessThan(qty)) {
          throw AppError.insufficientStock(
            `Not enough ${model.label} stock for ${item.product.name}: need ${qty}, have ${stock?.quantity ?? 0}`,
          );
        }
      }
    }

    for (const item of order.items) {
      const qty = new Prisma.Decimal(item.confirmedQuantity ?? item.requestedQuantity);
      if (!alreadyDeducted) {
        await moveGodownStockTx(tx, {
          productId: item.productId,
          quantityDelta: qty.negated(),
          reason: StockMovementReason.ORDER_FULFILLED,
          orderId: id,
          outletId: order.outletId,
          userId: user.id,
          notes: `Order ${order.orderNumber} fulfilled (stock taken at fulfilment)`,
        });
      }
      await tx.outletStock.upsert({
        where: { outletId_productId: { outletId: order.outletId, productId: item.productId } },
        create: { outletId: order.outletId, productId: item.productId, quantity: qty },
        update: { quantity: { increment: qty } },
      });
    }

    // Orders are billed at placement, so normally the bill is already there and gets
    // reused — raising a second one here would double-charge the outlet. The create
    // branch is only for orders placed before that change, which reach Fulfil unbilled.
    const isNewBill = !order.bill;
    const raised: { id: string; billNumber: string; grandTotal: Prisma.Decimal } = order.bill
      ?? await (async () => {
        const fullOrder = await tx.outletOrder.findUniqueOrThrow({
          where: { id },
          include: { items: { include: { product: true } }, outlet: true },
        });
        return billingService.createBillForOrderTx(tx, fullOrder, user.id);
      })();
    await applyAdvancesToBillTx(tx, id, raised);

    const now = new Date();
    const row = await tx.outletOrder.update({
      where: { id },
      data: {
        status: OutletOrderStatus.DELIVERED,
        // Goods leaving and arriving are the same event now; both stamps are kept
        // so historical orders and new ones read consistently.
        dispatchedAt: now,
        deliveredAt: now,
        // A legacy order's stock came out just now, so stamp it — every delivered
        // order then carries the moment its stock actually left the godown.
        ...(alreadyDeducted ? {} : { stockDeductedAt: now }),
        fulfillmentSource: FulfillmentSource.GODOWN,
      },
      include: orderInclude,
    });
    return { updated: row, bill: raised, isNewBill };
  });

  cache.invalidateTags(
    CacheTag.ORDERS, CacheTag.INVENTORY, CacheTag.BILLS, CacheTag.PAYMENTS,
    CacheTag.DASHBOARD, CacheTag.outlet(order.outletId),
  );
  // Only a genuinely new bill needs its PDF generated / a "bill generated" notice —
  // a reused legacy bill already went through this when it was first raised.
  if (isNewBill) await billingService.afterBillGenerated({ ...bill, outletId: order.outletId });
  await emitRealtime(
    RealtimeEvent.ORDER_RECEIVED,
    {
      orderId: id,
      orderNumber: order.orderNumber,
      status: updated.status,
      outletName: order.outlet.name,
      receivedAt: updated.deliveredAt,
    },
    { global: true, outletId: order.outletId },
  );
  return { ...updated, totals: numericTotals(updated) };
}

/**
 * Call off an order before it ships. Whoever works the fulfilment queue (main owner
 * or godown) can do this; the outlet that placed it cannot withdraw it themselves.
 *
 * Deliberately limited to unfulfilled orders: once Fulfil has run, stock has moved
 * and a bill exists, so undoing it is a credit note rather than a status flip.
 */
export async function cancelOrder(user: AuthUser, id: string, input: RejectOrderInput) {
  const order = await loadForTransition(id);
  if (order.status !== OutletOrderStatus.CONFIRMED) {
    throw AppError.invalidState('Only an order awaiting fulfilment can be cancelled');
  }
  // Every order is billed at placement now, so a bill existing is normal and can't
  // be a reason to refuse — it gets voided below. Money already banked against it is
  // a different matter: that's a refund, which this flow can't do, so refuse instead
  // of leaving a paid bill attached to a cancelled order.
  if (order.bill && new Prisma.Decimal(order.bill.grandTotal).sub(order.bill.balanceDue).greaterThan(0)) {
    throw AppError.invalidState(
      `${order.orderNumber} already has payments recorded against bill ${order.bill.billNumber}. Refund those before cancelling the order.`,
    );
  }
  // An outlet may pay online at order time, before any bill exists. That money is
  // held as an advance keyed to the order, and Fulfil is what moves it onto the
  // bill — so cancelling here would strand a real payment against a dead order,
  // attached to no bill and reconcilable by nothing. Refuse until it's refunded.
  const advanced = await prisma.payment.aggregate({
    where: { orderId: id, billId: null, isDeleted: false, status: PaymentStatus.SUCCESS },
    _sum: { amount: true },
  });
  const advanceTotal = new Prisma.Decimal(advanced._sum.amount ?? 0);
  if (advanceTotal.greaterThan(0)) {
    throw AppError.invalidState(
      `${order.orderNumber} has ₹${advanceTotal.toString()} already paid in advance. Refund that payment before cancelling the order.`,
    );
  }

  const updated = await prisma.$transaction(async (tx) => {
    // Stock was committed to this outlet when the order was placed, so calling the
    // order off has to hand it back — otherwise the goods would simply vanish from
    // the godown. Reverse the movements that were actually written rather than
    // recomputing from the order lines: a product whose trackInventory was switched
    // off after placement never had stock taken, and re-deriving would invent it.
    const taken = await tx.stockMovement.findMany({
      where: { orderId: id, reason: StockMovementReason.ORDER_PLACED },
      select: { productId: true, quantityDelta: true },
    });
    for (const movement of taken) {
      await moveGodownStockTx(tx, {
        productId: movement.productId,
        quantityDelta: new Prisma.Decimal(movement.quantityDelta).negated(),
        reason: StockMovementReason.ORDER_CANCELLED,
        orderId: id,
        outletId: order.outletId,
        userId: user.id,
        notes: `Order ${order.orderNumber} cancelled — stock returned`,
      });
    }

    // Take the bill out of the books entirely. Soft-deleted rather than row-deleted:
    // isDeleted is what every sales list, the Day Book, the P&L and the analytics
    // views already filter on, so this removes it from revenue, receivables and
    // reporting exactly as a delete would, while keeping the numbered document and
    // its line items intact for audit. Nothing was paid against it (guarded above),
    // so there is no money to unwind.
    if (order.bill) {
      await tx.billItem.updateMany({ where: { billId: order.bill.id }, data: { isDeleted: true } });
      await tx.bill.update({
        where: { id: order.bill.id },
        data: { status: BillStatus.CANCELLED, balanceDue: 0, isDeleted: true },
      });
    }

    return tx.outletOrder.update({
      where: { id },
      data: {
        status: OutletOrderStatus.CANCELLED,
        cancelledAt: new Date(),
        cancelledById: user.id,
        cancellationReason: input.reason,
      },
      include: orderInclude,
    });
  });

  cache.invalidateTags(
    CacheTag.ORDERS, CacheTag.INVENTORY, CacheTag.BILLS, CacheTag.PAYMENTS,
    CacheTag.ANALYTICS, CacheTag.DASHBOARD, CacheTag.outlet(order.outletId),
  );
  // The P&L and outlet-sales figures come from materialized views, which don't
  // notice the voided bill until they're rebuilt — without this the cancelled
  // sale keeps showing in analytics until the next scheduled refresh.
  await enqueue(JobName.REFRESH_ANALYTICS, {});
  await emitRealtime(
    RealtimeEvent.ORDER_STATUS_CHANGED,
    { orderId: id, orderNumber: order.orderNumber, status: updated.status, outletName: order.outlet.name, reason: input.reason ?? null },
    { global: true, outletId: order.outletId },
  );
  return { ...updated, totals: numericTotals(updated) };
}

export const ordersService = {
  createOrder, listOrders, getOrder, getOrderSummary,
  createOrderPaymentIntent, verifyOrderPayment, confirmPaidOrderFromWebhook,
  fulfilOrder, cancelOrder,
};
