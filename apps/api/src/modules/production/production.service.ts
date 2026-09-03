import { Prisma, ContactType } from '@prisma/client';
import { addDays } from 'date-fns';
import { prisma } from '../../config/prisma';
import { logger } from '../../config/logger';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { booksScopeFor } from '../../shared/utils/books';
import type { AuthUser } from '../../shared/types/api';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { env } from '../../config/env';
import { gstinStateCode, splitGst } from '../../shared/utils/gst';
import { assertQuantityPrecision } from '../../shared/utils/quantity';
import { enqueueTallySync, markTallyDeleted } from '../tally/tally.outbox';
import type { ListBatchesQuery, ListIntakeQuery, LogBatchInput, LogIntakeInput } from './production.schema';

type SupplierBillRow = { id: string; billNumber: string; billDate: Date; totalAmount: Prisma.Decimal; isGstBill: boolean };
type SupplierPaymentRow = { id: string; paymentNumber: string; paymentDate: Date; amount: Prisma.Decimal };

/**
 * Enqueue a Purchase voucher for the Tally sync — HARD-EXCLUDING the two cases
 * that must never reach the client's statutory books:
 *   • a non-GST purchase (unregistered / informal vendor);
 *   • a branch's own purchase (outletId set) — already off the company books.
 * The exclusion is enforced here in code, not left to config or to anyone
 * remembering, and is recorded with a reason so the owner can see it was skipped
 * on purpose (dashboard → Excluded view).
 */
async function enqueuePurchaseBillSync(
  tx: Prisma.TransactionClient,
  bill: SupplierBillRow,
  supplierName: string | null,
  outletId: string | null,
): Promise<void> {
  const excludedReason = !bill.isGstBill
    ? 'Non-GST purchase — unregistered/informal vendor; recorded in the ERP for cost tracking only, never pushed to Tally.'
    : outletId
      ? 'Branch purchase — the outlet bears this cost; excluded from the company books.'
      : null;
  await enqueueTallySync(tx, {
    entityType: 'PURCHASE_BILL', entityId: bill.id, voucherType: 'PURCHASE',
    entityDate: bill.billDate, amount: bill.totalAmount, docNumber: bill.billNumber,
    partyName: supplierName, excludedReason,
  });
}

async function enqueuePurchasePaymentSync(
  tx: Prisma.TransactionClient,
  payment: SupplierPaymentRow,
  bill: SupplierBillRow,
  supplierName: string | null,
  outletId: string | null,
): Promise<void> {
  const excludedReason = !bill.isGstBill
    ? 'Payment against a non-GST purchase — excluded from Tally along with its bill.'
    : outletId
      ? 'Payment for a branch purchase — excluded from the company books.'
      : null;
  await enqueueTallySync(tx, {
    entityType: 'SUPPLIER_PAYMENT', entityId: payment.id, voucherType: 'PAYMENT',
    entityDate: payment.paymentDate, amount: payment.amount, docNumber: payment.paymentNumber,
    partyName: supplierName, excludedReason,
  });
}

/**
 * Log a production batch: consume the product's BOM (raw materials AND any
 * finished-product components, e.g. Khawsa used to make frozen Khawsa),
 * increment finished-goods stock at the godown, and compute the true per-unit
 * cost (material + component + overhead), rolling it into the product's
 * weighted-average cost so multi-level costs cascade. Fully atomic.
 */
export async function logBatch(input: LogBatchInput, userId: string) {
  const product = await prisma.product.findFirst({
    where: { id: input.productId, isDeleted: false },
    include: {
      godownStock: true,
      unit: { select: { name: true, decimalPlaces: true } },
      bom: {
        where: { isDeleted: false },
        include: {
          rawMaterial: { include: { unit: { select: { name: true, decimalPlaces: true } } } },
          componentProduct: { include: { godownStock: true, unit: { select: { name: true, decimalPlaces: true } } } },
        },
      },
    },
  });
  if (!product) throw AppError.notFound('Product not found');

  // The produced quantity has to respect the output product's own unit precision.
  assertQuantityPrecision(input.quantityProduced, product.unit, 'quantityProduced');

  const producedQty = new Prisma.Decimal(input.quantityProduced);
  const overrideMap = new Map((input.ingredients ?? []).map((i) => [i.bomItemId, i]));

  // Build the consumption plan for both component kinds, verifying stock up front.
  // Quantity/price default to the recipe × live cost, but the caller can override
  // either per line (actual usage can differ from theory; prices fluctuate daily).
  const consumption = product.bom.map((b) => {
    const override = overrideMap.get(b.id);
    const required = override ? new Prisma.Decimal(override.quantity) : new Prisma.Decimal(b.quantity).mul(producedQty);
    if (b.componentType === 'PRODUCT') {
      const cp = b.componentProduct;
      if (!cp) throw AppError.badRequest('A component product in the recipe is missing');
      const unitCost = override ? new Prisma.Decimal(override.unitCost) : new Prisma.Decimal(cp.avgCost);
      const available = new Prisma.Decimal(cp.godownStock?.quantity ?? 0);
      if (available.lessThan(required)) {
        throw AppError.insufficientStock(`Not enough ${cp.name} in godown: need ${required.toString()} ${cp.unit.name}, have ${available.toString()}`);
      }
      return { kind: 'PRODUCT' as const, id: cp.id, name: cp.name, required, unitCost, belowReorder: false };
    }
    const rm = b.rawMaterial;
    if (!rm) throw AppError.badRequest('A raw material in the recipe is missing');
    const unitCost = override ? new Prisma.Decimal(override.unitCost) : new Prisma.Decimal(rm.costPerUnit);
    if (new Prisma.Decimal(rm.currentStock).lessThan(required)) {
      throw AppError.insufficientStock(`Not enough ${rm.name}: need ${required.toString()} ${rm.unit.name}, have ${rm.currentStock}`);
    }
    return { kind: 'RAW_MATERIAL' as const, id: rm.id, name: rm.name, required, unitCost, belowReorder: false };
  });

  const materialCost = consumption.reduce((s, c) => s.add(c.unitCost.mul(c.required)), new Prisma.Decimal(0));
  const overheadCost = (input.overheads ?? []).reduce((s, o) => s.add(new Prisma.Decimal(o.amount)), new Prisma.Decimal(0));
  const totalCost = materialCost.add(overheadCost);
  const costPerUnit = producedQty.greaterThan(0) ? totalCost.div(producedQty) : new Prisma.Decimal(0);

  // Roll the batch cost into the product's weighted-average unit cost.
  const oldQty = new Prisma.Decimal(product.godownStock?.quantity ?? 0);
  const oldAvg = new Prisma.Decimal(product.avgCost);
  const newQty = oldQty.add(producedQty);
  const newAvg = newQty.greaterThan(0) ? oldQty.mul(oldAvg).add(totalCost).div(newQty) : costPerUnit;

  const batch = await prisma.$transaction(async (tx) => {
    const batchNumber = input.batchNumber ?? (await nextDocNumber(tx, 'BATCH'));
    const items = consumption.map((c) => ({
      componentType: c.kind,
      rawMaterialId: c.kind === 'RAW_MATERIAL' ? c.id : null,
      componentProductId: c.kind === 'PRODUCT' ? c.id : null,
      nameSnapshot: c.name,
      quantityConsumed: c.required,
      unitCostSnapshot: c.unitCost.toDecimalPlaces(2),
      lineCost: c.unitCost.mul(c.required).toDecimalPlaces(2),
    }));

    const created = await tx.productionBatch.create({
      data: {
        batchNumber,
        productId: product.id,
        quantityProduced: input.quantityProduced,
        totalMaterialCost: materialCost.toDecimalPlaces(2),
        overheadCost: overheadCost.toDecimalPlaces(2),
        costPerUnit: costPerUnit.toDecimalPlaces(2),
        productionDate: input.productionDate,
        notes: input.notes,
        createdById: userId,
        items: { create: items },
        overheads: input.overheads?.length
          ? { create: input.overheads.map((o) => ({ label: o.label, amount: o.amount })) }
          : undefined,
      },
      include: { items: true, overheads: true, product: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } },
    });

    // Deduct consumed components from their respective stock ledgers.
    for (const c of consumption) {
      if (c.kind === 'RAW_MATERIAL') {
        await tx.rawMaterial.update({ where: { id: c.id }, data: { currentStock: { decrement: c.required } } });
      } else {
        await tx.godownStock.update({ where: { productId: c.id }, data: { quantity: { decrement: c.required } } });
      }
    }
    // Add finished goods to the godown + update the product's rolling avg cost.
    await tx.godownStock.upsert({
      where: { productId: product.id },
      create: { productId: product.id, quantity: input.quantityProduced },
      update: { quantity: { increment: input.quantityProduced } },
    });
    await tx.product.update({ where: { id: product.id }, data: { avgCost: newAvg.toDecimalPlaces(2) } });

    return created;
  });

  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.PRODUCTION, CacheTag.DASHBOARD);

  // Low-stock alerts for any consumed raw material below its reorder level.
  for (const c of consumption) {
    if (c.kind !== 'RAW_MATERIAL') continue;
    const fresh = await prisma.rawMaterial.findUnique({ where: { id: c.id }, select: { name: true, currentStock: true, reorderLevel: true } });
    if (fresh && new Prisma.Decimal(fresh.currentStock).lessThan(fresh.reorderLevel)) {
      await emitRealtime(RealtimeEvent.STOCK_LOW, { productName: fresh.name, currentStock: Number(fresh.currentStock), type: 'raw_material' });
    }
  }

  return batch;
}

export async function listBatches(query: ListBatchesQuery) {
  const where: Prisma.ProductionBatchWhereInput = {
    isDeleted: false,
    ...(query.productId ? { productId: query.productId } : {}),
    ...(query.from || query.to
      ? { productionDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
      : {}),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.productionBatch.findMany({
      where,
      orderBy: { productionDate: 'desc' },
      skip,
      take,
      select: {
        id: true, batchNumber: true, quantityProduced: true, totalMaterialCost: true, overheadCost: true, costPerUnit: true, productionDate: true, notes: true,
        product: { select: { id: true, name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } },
      },
    }),
    prisma.productionBatch.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

export async function getBatch(id: string) {
  const batch = await prisma.productionBatch.findFirst({
    where: { id, isDeleted: false },
    include: {
      items: { include: { rawMaterial: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } }, componentProduct: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } } },
      overheads: true,
      product: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } },
    },
  });
  if (!batch) throw AppError.notFound('Batch not found');
  return batch;
}

/** Log raw-material purchase: increase stock, recompute weighted-average cost. */
export async function logIntake(input: LogIntakeInput, userId: string) {
  const material = await prisma.rawMaterial.findFirst({
    where: { id: input.rawMaterialId, isDeleted: false },
    include: { unit: { select: { name: true, decimalPlaces: true } } },
  });
  if (!material) throw AppError.notFound('Raw material not found');
  assertQuantityPrecision(input.quantity, material.unit);

  const oldStock = new Prisma.Decimal(material.currentStock);
  const oldCost = new Prisma.Decimal(material.costPerUnit);
  const addQty = new Prisma.Decimal(input.quantity);
  const addCost = new Prisma.Decimal(input.costPerUnit);
  const newStock = oldStock.add(addQty);
  // Weighted-average cost (guard divide-by-zero).
  const weightedCost = newStock.greaterThan(0)
    ? oldStock.mul(oldCost).add(addQty.mul(addCost)).div(newStock)
    : addCost;

  const intake = await prisma.$transaction(async (tx) => {
    const created = await tx.rawMaterialIntake.create({
      data: {
        rawMaterialId: input.rawMaterialId,
        quantity: addQty,
        costPerUnit: addCost,
        totalCost: addQty.mul(addCost),
        supplierName: input.supplierName ?? material.supplierName,
        invoiceNumber: input.invoiceNumber,
        intakeDate: input.intakeDate,
        notes: input.notes,
        createdById: userId,
      },
      include: { rawMaterial: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } },
    });
    await tx.rawMaterial.update({
      where: { id: input.rawMaterialId },
      data: { currentStock: newStock, costPerUnit: weightedCost.toDecimalPlaces(2) },
    });
    // A quick stock intake carries no bill and no GST detail, so it is never a
    // Tally purchase voucher — record it EXCLUDED for the owner's audit view.
    await enqueueTallySync(tx, {
      entityType: 'RAW_INTAKE', entityId: created.id, voucherType: 'PURCHASE',
      entityDate: created.intakeDate, amount: created.totalCost,
      docNumber: created.invoiceNumber, partyName: created.supplierName,
      excludedReason: 'Quick stock intake without a purchase bill — no GST detail; use a purchase bill for a GST purchase.',
    });
    return created;
  });

  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.DASHBOARD);
  return intake;
}

/**
 * Record a purchase bill: one supplier invoice with mixed lines.
 *  • RAW_MATERIAL lines → goods receipt (stock += qty, weighted-avg cost)
 *  • OTHER lines        → booked to an expense category (non-inventory item)
 * All lines commit atomically; "other" lines carry the supplier + invoice so the
 * full bill is reconstructable and shows in the Day Book / Expenses.
 */
type PurchaseInput = import('./production.schema').RecordPurchaseInput;
type PurchaseItem = PurchaseInput['items'][number];

/**
 * Auto-save the bill's supplier into the shared Contacts directory so it's
 * remembered — the cashier types a supplier once, and next time it shows up as
 * a search suggestion in the purchase form. Best-effort: a directory hiccup
 * must never block recording the purchase itself, so this runs after the bill's
 * own transaction has committed and swallows its own errors.
 *
 * Matching (to avoid piling up duplicates): prefer the GSTIN (a business's real
 * identity); fall back to a case-insensitive name match. An existing contact is
 * only enriched with details it was missing — a user-curated name/GSTIN is
 * never overwritten.
 */
async function upsertSupplierContact(input: PurchaseInput, userId: string): Promise<string | null> {
  const name = input.supplierName?.trim();
  if (!name) return null; // Contact needs a name; nothing to remember without one.
  const gstin = input.supplierGstin?.trim() || null;
  const stateCode = gstin ? gstinStateCode(gstin) : null;
  const stateName = input.supplierStateName?.trim() || null;

  try {
    const existing = await prisma.contact.findFirst({
      where: {
        type: ContactType.SUPPLIER,
        isDeleted: false,
        ...(gstin
          ? { gstin: { equals: gstin, mode: 'insensitive' } }
          : { name: { equals: name, mode: 'insensitive' } }),
      },
    });

    if (existing) {
      const data: Prisma.ContactUpdateInput = {};
      if (gstin && !existing.gstin) data.gstin = gstin;
      if (stateCode && !existing.stateCode) data.stateCode = stateCode;
      if (stateName && !existing.stateName) data.stateName = stateName;
      if (Object.keys(data).length) await prisma.contact.update({ where: { id: existing.id }, data });
      return existing.id;
    }

    const created = await prisma.contact.create({
      data: { type: ContactType.SUPPLIER, name, gstin, stateCode, stateName, createdById: userId },
    });
    return created.id;
  } catch (err) {
    logger.warn({ err }, 'Failed to auto-save supplier contact from purchase');
    return null;
  }
}

/** Post-commit: tie the purchase bill to its supplier's party-master row, so the
 *  Tally sync maps it to one Sundry Creditor ledger regardless of name spelling. */
async function linkSupplierContact(billId: string, contactId: string | null): Promise<void> {
  if (!contactId) return;
  try {
    await prisma.supplierBill.update({ where: { id: billId }, data: { supplierContactId: contactId } });
  } catch (err) {
    logger.warn({ err, billId }, 'Failed to link supplier contact to purchase bill');
  }
}

/** Shared by create + update: normalise GST, validate refs exist, and compute per-line + total money. */
async function preparePurchase(input: PurchaseInput) {
  // Without-GST bills carry no tax at all, regardless of what the client sent per line.
  const items: PurchaseItem[] = input.isGstBill ? input.items : input.items.map((it) => ({ ...it, taxRate: 0 }));

  const rmIds = items.flatMap((i) => (i.kind === 'RAW_MATERIAL' ? [i.rawMaterialId] : []));
  const fgIds = items.flatMap((i) => (i.kind === 'FINISHED_GOOD' ? [i.productId] : []));
  const catIds = items.flatMap((i) => (i.kind === 'OTHER' ? [i.categoryId] : []));

  const rawMaterials = rmIds.length
    ? await prisma.rawMaterial.findMany({ where: { id: { in: rmIds }, isDeleted: false }, select: { id: true, name: true } })
    : [];
  if (rawMaterials.length !== new Set(rmIds).size) throw AppError.badRequest('One or more raw materials are invalid');
  // Needed for the asset-line label, since an asset row snapshots a name rather than
  // pointing at the material.
  const rawMaterialName = new Map(rawMaterials.map((m) => [m.id, m.name]));
  if (catIds.length && (await prisma.expenseCategory.count({ where: { id: { in: catIds }, isDeleted: false } })) !== new Set(catIds).size)
    throw AppError.badRequest('One or more expense categories are invalid');

  const products = fgIds.length ? await prisma.product.findMany({ where: { id: { in: fgIds }, isDeleted: false }, select: { id: true, name: true } }) : [];
  if (products.length !== new Set(fgIds).size) throw AppError.badRequest('One or more finished goods are invalid');
  const productName = new Map(products.map((p) => [p.id, p.name]));
  const categories = catIds.length ? await prisma.expenseCategory.findMany({ where: { id: { in: catIds } }, select: { id: true, name: true } }) : [];
  const categoryName = new Map(categories.map((c) => [c.id, c.name]));

  // Per-line taxable base + GST; raw-material/FG cost stays EX-GST (GST = recoverable ITC).
  const lineCalc = items.map((it) => {
    const base = it.kind === 'OTHER' ? new Prisma.Decimal(it.amount) : new Prisma.Decimal(it.quantity).mul(it.costPerUnit);
    const tax = base.mul(it.taxRate).div(100).toDecimalPlaces(2);
    return { base, tax };
  });
  const taxableTotal = lineCalc.reduce((s, l) => s.add(l.base), new Prisma.Decimal(0));
  const taxTotal = lineCalc.reduce((s, l) => s.add(l.tax), new Prisma.Decimal(0));
  const roundOff = new Prisma.Decimal(input.roundOff ?? 0);
  // Never let a negative round-off (or a stale amountPaidNow) push the bill total
  // below zero — that would make paidNow/balance math nonsensical.
  const billTotal = Prisma.Decimal.max(taxableTotal.add(taxTotal).add(roundOff), new Prisma.Decimal(0));
  const paidNow = Prisma.Decimal.min(new Prisma.Decimal(input.amountPaidNow), billTotal);
  const supplierStateCode = input.supplierGstin ? gstinStateCode(input.supplierGstin) : null;
  const { cgst, sgst, igst } = splitGst(Number(taxTotal), supplierStateCode, env.HOME_STATE_CODE);

  return { items, productName, categoryName, rawMaterialName, lineCalc, taxableTotal, taxTotal, roundOff, billTotal, paidNow, cgst, sgst, igst };
}

/** Shared by create + update: write each line's itemized row and apply its stock/expense side effect. */
async function applyPurchaseLines(
  tx: Prisma.TransactionClient,
  billId: string,
  prepared: Awaited<ReturnType<typeof preparePurchase>>,
  input: PurchaseInput,
  userId: string,
  outletId: string | null,
) {
  const { items, lineCalc, productName, categoryName, rawMaterialName } = prepared;
  let rawLineCount = 0;
  let fgLineCount = 0;
  let otherLineCount = 0;
  let assetLineCount = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const { base, tax } = lineCalc[i];
    const lineTotal = base.add(tax);

    // "Is Asset?" wins over the line's own kind: a capital purchase goes to the asset
    // register and must NOT move stock, touch weighted-average cost, or book an expense.
    // Cost is the ex-GST base, matching how inventory cost is recorded elsewhere.
    if (item.isAsset) {
      const label =
        item.kind === 'RAW_MATERIAL'
          ? rawMaterialName.get(item.rawMaterialId) ?? 'Asset'
          : item.kind === 'FINISHED_GOOD'
            ? productName.get(item.productId) ?? 'Asset'
            : item.description?.trim() || categoryName.get(item.categoryId) || 'Asset';
      const qty = item.kind === 'OTHER' ? new Prisma.Decimal(1) : new Prisma.Decimal(item.quantity);
      const assetCode = await nextDocNumber(tx, 'ASSET');
      await tx.asset.create({
        data: {
          assetCode,
          name: label,
          quantity: qty,
          purchaseCost: base,
          purchaseDate: input.intakeDate,
          supplierName: input.supplierName,
          invoiceNumber: input.invoiceNumber,
          notes: input.notes,
          supplierBillId: billId,
          createdById: userId,
        },
      });
      await tx.supplierBillItem.create({
        data: {
          supplierBillId: billId,
          kind: item.kind,
          refId: item.kind === 'RAW_MATERIAL' ? item.rawMaterialId : item.kind === 'FINISHED_GOOD' ? item.productId : item.categoryId,
          name: label,
          hsnCode: item.hsnCode,
          quantity: qty,
          unitCost: item.kind === 'OTHER' ? base : new Prisma.Decimal(item.costPerUnit),
          taxRate: item.taxRate,
          taxableAmount: base,
          taxAmount: tax,
          lineTotal,
          isAsset: true,
        },
      });
      assetLineCount += 1;
      continue;
    }

    if (item.kind === 'RAW_MATERIAL') {
      const m = await tx.rawMaterial.findUniqueOrThrow({ where: { id: item.rawMaterialId } });
      const oldStock = new Prisma.Decimal(m.currentStock);
      const oldCost = new Prisma.Decimal(m.costPerUnit);
      const addQty = new Prisma.Decimal(item.quantity);
      const addCost = new Prisma.Decimal(item.costPerUnit);
      const newStock = oldStock.add(addQty);
      const weighted = newStock.greaterThan(0) ? oldStock.mul(oldCost).add(addQty.mul(addCost)).div(newStock) : addCost;
      await tx.rawMaterialIntake.create({
        data: {
          rawMaterialId: item.rawMaterialId, quantity: addQty, costPerUnit: addCost, totalCost: base,
          taxRate: item.taxRate, taxAmount: tax, hsnCode: item.hsnCode,
          supplierName: input.supplierName ?? m.supplierName, invoiceNumber: input.invoiceNumber, intakeDate: input.intakeDate,
          notes: input.notes, supplierBillId: billId, createdById: userId,
        },
      });
      await tx.rawMaterial.update({ where: { id: item.rawMaterialId }, data: { currentStock: newStock, costPerUnit: weighted.toDecimalPlaces(2) } });
      await tx.supplierBillItem.create({ data: { supplierBillId: billId, kind: 'RAW_MATERIAL', refId: item.rawMaterialId, name: m.name, hsnCode: item.hsnCode, quantity: addQty, unitCost: addCost, taxRate: item.taxRate, taxableAmount: base, taxAmount: tax, lineTotal } });
      rawLineCount += 1;
    } else if (item.kind === 'FINISHED_GOOD') {
      // Bought finished goods land in godown finished-goods stock.
      await tx.godownStock.upsert({
        where: { productId: item.productId },
        create: { productId: item.productId, quantity: item.quantity },
        update: { quantity: { increment: item.quantity } },
      });
      await tx.supplierBillItem.create({ data: { supplierBillId: billId, kind: 'FINISHED_GOOD', refId: item.productId, name: productName.get(item.productId) ?? 'Product', hsnCode: item.hsnCode, quantity: new Prisma.Decimal(item.quantity), unitCost: new Prisma.Decimal(item.costPerUnit), taxRate: item.taxRate, taxableAmount: base, taxAmount: tax, lineTotal } });
      fgLineCount += 1;
    } else {
      await tx.expense.create({
        data: {
          categoryId: item.categoryId, amount: base, expenseDate: input.intakeDate, paymentMethod: input.paymentMethod,
          taxRate: item.taxRate, taxAmount: tax, hsnCode: item.hsnCode,
          paidTo: input.supplierName, supplierName: input.supplierName, invoiceNumber: input.invoiceNumber,
          // The expense follows the bill's books — a branch purchase is the branch's cost.
          outletId,
          note: item.description ?? input.notes, supplierBillId: billId, createdById: userId,
        },
      });
      await tx.supplierBillItem.create({ data: { supplierBillId: billId, kind: 'OTHER', refId: item.categoryId, name: categoryName.get(item.categoryId) ?? 'Expense', hsnCode: item.hsnCode, taxRate: item.taxRate, taxableAmount: base, taxAmount: tax, lineTotal } });
      otherLineCount += 1;
    }
  }

  return { rawLineCount, fgLineCount, otherLineCount, assetLineCount };
}

/**
 * A branch buys its own supplies; it does not receive goods into the company's
 * godown. Raw-material and finished-good lines move central stock and central
 * weighted-average cost, so they are refused outright rather than silently
 * dropped — as is the asset register, which is a head-office ledger.
 */
function assertBranchLinesAllowed(outletId: string | null, input: PurchaseInput) {
  if (!outletId) return;
  const stockLine = input.items.find((i) => i.kind !== 'OTHER');
  if (stockLine) {
    throw AppError.badRequest(
      'A branch purchase can only record expense lines — goods received into the godown must be entered by the main owner.',
      undefined,
      'items',
    );
  }
  if (input.items.some((i) => i.isAsset)) {
    throw AppError.badRequest('The asset register is kept by the main owner, so a branch purchase cannot mark a line as an asset.', undefined, 'items');
  }
}

export async function logPurchase(input: PurchaseInput, user: AuthUser) {
  const userId = user.id;
  const { outletId } = booksScopeFor(user);
  assertBranchLinesAllowed(outletId, input);
  const prepared = await preparePurchase(input);
  const { billTotal, paidNow, taxableTotal, taxTotal, roundOff, cgst, sgst, igst } = prepared;

  const result = await prisma.$transaction(async (tx) => {
    // 1) The payable bill (header) with GST breakup.
    const balance = billTotal.sub(paidNow);
    const status = balance.lessThanOrEqualTo(0) ? 'PAID' : paidNow.greaterThan(0) ? 'PARTIALLY_PAID' : 'UNPAID';
    // Credit terms only mean anything while a balance remains.
    const creditDays = balance.greaterThan(0) ? input.creditDays : undefined;
    const dueDate = creditDays ? addDays(input.intakeDate, creditDays) : null;
    const bill = await tx.supplierBill.create({
      data: {
        billNumber: await nextDocNumber(tx, 'SUPPLIER_BILL'),
        supplierName: input.supplierName,
        supplierGstin: input.supplierGstin,
        invoiceNumber: input.invoiceNumber,
        billDate: input.intakeDate,
        taxableAmount: taxableTotal,
        cgst, sgst, igst,
        taxAmount: taxTotal,
        roundOff,
        totalAmount: billTotal,
        amountPaid: paidNow,
        balanceDue: balance,
        status,
        paymentMethod: input.paymentMethod,
        creditDays,
        dueDate,
        isGstBill: input.isGstBill,
        outletId,
        notes: input.notes,
        createdById: userId,
      },
    });

    // 2) Each line: store an itemized bill line + apply its side effect.
    const counts = await applyPurchaseLines(tx, bill.id, prepared, input, userId, outletId);

    // 3) Initial supplier payment (if anything paid at entry).
    if (paidNow.greaterThan(0)) {
      const sp = await tx.supplierPayment.create({
        data: {
          paymentNumber: await nextDocNumber(tx, 'SUPPLIER_PAYMENT'),
          supplierBillId: bill.id, amount: paidNow, method: input.paymentMethod,
          paymentDate: input.intakeDate, paidById: userId, createdById: userId,
        },
      });
      await enqueuePurchasePaymentSync(tx, sp, bill, input.supplierName ?? null, outletId);
    }

    // 4) Tally: Purchase voucher — GST bills only, head-office books only.
    await enqueuePurchaseBillSync(tx, bill, input.supplierName ?? null, outletId);

    return { bill, ...counts };
  });

  await linkSupplierContact(result.bill.id, await upsertSupplierContact(input, userId));
  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.EXPENSES, CacheTag.PAYMENTS, CacheTag.ANALYTICS, CacheTag.ASSETS, CacheTag.DASHBOARD);
  return {
    billNumber: result.bill.billNumber,
    invoiceNumber: input.invoiceNumber,
    supplierName: input.supplierName,
    intakeDate: input.intakeDate,
    totalCost: billTotal,
    amountPaid: paidNow,
    balanceDue: result.bill.balanceDue,
    status: result.bill.status,
    lineCount: result.rawLineCount + result.fgLineCount + result.otherLineCount,
  };
}

/**
 * Reverses every side effect of an existing purchase bill's line items (stock, weighted-avg
 * cost, expenses) and removes its itemized rows — leaving only the bill header behind, ready
 * for either a fresh set of lines (edit) or a final soft-delete. Any payments recorded on the
 * bill are removed by the callers (updatePurchase re-creates the at-entry one; deletePurchase
 * drops them) — the owner is warned in the UI first, since deleting a paid bill also erases
 * that supplier-payment record.
 *
 * Still refuses (throws, touching nothing) if reversing a raw-material/finished-good line would
 * drive stock negative — meaning some of it has already been consumed/moved elsewhere and can
 * no longer be cleanly un-received. That stock guard is a hard data-integrity limit, not a
 * policy choice.
 *
 * The weighted-average-cost reversal is mathematically exact as long as that stock guard
 * holds: consumption only ever decrements currentStock (never costPerUnit), so subtracting
 * this purchase's own quantity/cost back out of the running total/average is a plain reversal
 * of the addition `logPurchase` made, regardless of how many other purchases happened between.
 */
async function reversePurchaseEffects(tx: Prisma.TransactionClient, billId: string) {
  const bill = await tx.supplierBill.findFirst({
    where: { id: billId, isDeleted: false },
    include: {
      items: { where: { isDeleted: false } },
    },
  });
  if (!bill) throw AppError.notFound('Purchase bill not found');

  // Validate every reversal is safe BEFORE mutating anything.
  for (const item of bill.items) {
    // An asset line never moved stock on the way in, so there is nothing to check
    // (and decrementing here would eat stock this bill never added).
    if (item.isAsset) continue;
    if (item.kind === 'RAW_MATERIAL' && item.refId) {
      const m = await tx.rawMaterial.findUniqueOrThrow({ where: { id: item.refId } });
      if (new Prisma.Decimal(m.currentStock).lessThan(item.quantity ?? 0)) {
        throw AppError.conflict(`Cannot modify — some of the "${item.name}" from this bill has already been used elsewhere.`);
      }
    } else if (item.kind === 'FINISHED_GOOD' && item.refId) {
      const g = await tx.godownStock.findUnique({ where: { productId: item.refId } });
      if (!g || new Prisma.Decimal(g.quantity).lessThan(item.quantity ?? 0)) {
        throw AppError.conflict(`Cannot modify — some of the "${item.name}" from this bill has already moved elsewhere.`);
      }
    }
  }

  // Now actually reverse.
  for (const item of bill.items) {
    if (item.isAsset) continue;
    if (item.kind === 'RAW_MATERIAL' && item.refId) {
      const m = await tx.rawMaterial.findUniqueOrThrow({ where: { id: item.refId } });
      const currentStock = new Prisma.Decimal(m.currentStock);
      const currentCost = new Prisma.Decimal(m.costPerUnit);
      const removeQty = new Prisma.Decimal(item.quantity ?? 0);
      const removeCost = new Prisma.Decimal(item.unitCost ?? 0);
      const oldStock = currentStock.sub(removeQty);
      const oldCost = oldStock.greaterThan(0) ? currentStock.mul(currentCost).sub(removeQty.mul(removeCost)).div(oldStock) : new Prisma.Decimal(0);
      await tx.rawMaterial.update({ where: { id: item.refId }, data: { currentStock: oldStock, costPerUnit: oldCost.toDecimalPlaces(2) } });
    } else if (item.kind === 'FINISHED_GOOD' && item.refId) {
      await tx.godownStock.update({ where: { productId: item.refId }, data: { quantity: { decrement: item.quantity ?? 0 } } });
    }
  }

  await tx.expense.deleteMany({ where: { supplierBillId: billId } });
  await tx.rawMaterialIntake.deleteMany({ where: { supplierBillId: billId } });
  // Assets raised by this bill go with it — re-applying the lines mints them again,
  // so leaving them would duplicate the register on every edit.
  await tx.asset.deleteMany({ where: { supplierBillId: billId } });
  await tx.supplierBillItem.deleteMany({ where: { supplierBillId: billId } });

  return bill;
}

/** Edit a purchase bill: reverse its old effects, then re-apply fresh ones under the same bill number. */
export async function updatePurchase(id: string, input: PurchaseInput, user: AuthUser) {
  const userId = user.id;
  const { outletId } = booksScopeFor(user);
  assertBranchLinesAllowed(outletId, input);
  const existing = await prisma.supplierBill.findFirst({ where: { id, isDeleted: false, outletId }, select: { id: true } });
  if (!existing) throw AppError.notFound('Purchase bill not found');
  const prepared = await preparePurchase(input);
  const { billTotal, paidNow, taxableTotal, taxTotal, roundOff, cgst, sgst, igst } = prepared;

  const result = await prisma.$transaction(async (tx) => {
    await reversePurchaseEffects(tx, id);
    // The old at-entry payment is about to be replaced with a new id — cancel its
    // Tally voucher before it's deleted.
    const oldPayments = await tx.supplierPayment.findMany({ where: { supplierBillId: id }, select: { id: true } });
    for (const p of oldPayments) await markTallyDeleted(tx, 'SUPPLIER_PAYMENT', p.id);
    await tx.supplierPayment.deleteMany({ where: { supplierBillId: id } });

    const balance = billTotal.sub(paidNow);
    const status = balance.lessThanOrEqualTo(0) ? 'PAID' : paidNow.greaterThan(0) ? 'PARTIALLY_PAID' : 'UNPAID';
    const creditDays = balance.greaterThan(0) ? input.creditDays : undefined;
    const dueDate = creditDays ? addDays(input.intakeDate, creditDays) : null;
    const bill = await tx.supplierBill.update({
      where: { id },
      data: {
        supplierName: input.supplierName,
        supplierGstin: input.supplierGstin,
        invoiceNumber: input.invoiceNumber,
        billDate: input.intakeDate,
        taxableAmount: taxableTotal,
        cgst, sgst, igst,
        taxAmount: taxTotal,
        roundOff,
        totalAmount: billTotal,
        amountPaid: paidNow,
        balanceDue: balance,
        status,
        paymentMethod: input.paymentMethod,
        creditDays: creditDays ?? null,
        dueDate,
        isGstBill: input.isGstBill,
        notes: input.notes,
      },
    });

    const counts = await applyPurchaseLines(tx, bill.id, prepared, input, userId, outletId);

    if (paidNow.greaterThan(0)) {
      const sp = await tx.supplierPayment.create({
        data: {
          paymentNumber: await nextDocNumber(tx, 'SUPPLIER_PAYMENT'),
          supplierBillId: bill.id, amount: paidNow, method: input.paymentMethod,
          paymentDate: input.intakeDate, paidById: userId, createdById: userId,
        },
      });
      await enqueuePurchasePaymentSync(tx, sp, bill, input.supplierName ?? null, outletId);
    }

    await enqueuePurchaseBillSync(tx, bill, input.supplierName ?? null, outletId);

    return { bill, ...counts };
  });

  await linkSupplierContact(id, await upsertSupplierContact(input, userId));
  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.EXPENSES, CacheTag.PAYMENTS, CacheTag.ANALYTICS, CacheTag.ASSETS, CacheTag.DASHBOARD);
  return {
    billNumber: result.bill.billNumber,
    totalCost: billTotal,
    amountPaid: paidNow,
    balanceDue: result.bill.balanceDue,
    status: result.bill.status,
    lineCount: result.rawLineCount + result.fgLineCount + result.otherLineCount,
  };
}

/**
 * Delete a purchase bill: reverse its stock/cost/expense effects and remove its
 * payments, then remove the header.
 *
 * Numbering ("reuse only if it's the last one"): if this bill holds the most
 * recently issued number, it is HARD-deleted and the shared counter rolls back
 * one, so the next purchase takes that number again with no gap. (Soft-deleting
 * it wouldn't free the number — `billNumber` is unique across every row,
 * including deleted ones — so the reuse would collide.) Deleting any older bill
 * instead SOFT-deletes it: its number is retired (a gap remains) and no other
 * bill's number is ever rewritten, keeping the audit trail intact.
 */
export async function deletePurchase(id: string, user: AuthUser) {
  const { outletId } = booksScopeFor(user);
  await prisma.$transaction(async (tx) => {
    const bill = await tx.supplierBill.findFirst({ where: { id, isDeleted: false, outletId }, select: { billNumber: true } });
    if (!bill) throw AppError.notFound('Purchase bill not found');
    await reversePurchaseEffects(tx, id);
    // Cancel the bill's + payments' Tally vouchers (no-op if they were EXCLUDED).
    await markTallyDeleted(tx, 'PURCHASE_BILL', id);
    const pmts = await tx.supplierPayment.findMany({ where: { supplierBillId: id }, select: { id: true } });
    for (const p of pmts) await markTallyDeleted(tx, 'SUPPLIER_PAYMENT', p.id);
    await tx.supplierPayment.deleteMany({ where: { supplierBillId: id } });

    const seq = Number.parseInt(bill.billNumber.split('-').pop() ?? '', 10);
    const counter = Number.isFinite(seq)
      ? await tx.documentCounter.findUnique({ where: { key: 'SUPPLIER_BILL' }, select: { value: true } })
      : null;
    const isLatest = !!counter && Number(counter.value) === seq;

    if (isLatest) {
      // Free the number and hand it back: hard-delete (its child rows are all
      // gone now) and roll the counter back one.
      await tx.supplierBill.delete({ where: { id } });
      await tx.documentCounter.update({ where: { key: 'SUPPLIER_BILL' }, data: { value: { decrement: 1 } } });
    } else {
      await tx.supplierBill.update({ where: { id }, data: { isDeleted: true } });
    }
  });
  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.EXPENSES, CacheTag.PAYMENTS, CacheTag.ANALYTICS, CacheTag.ASSETS, CacheTag.DASHBOARD);
  return { deleted: true };
}

export interface ListPurchasesQuery { status?: string; search?: string }

/** Purchase bills (supplier bills) for the Purchases register. */
export async function listPurchases(query: ListPurchasesQuery = {}, user: AuthUser) {
  const where: Prisma.SupplierBillWhereInput = {
    isDeleted: false,
    ...booksScopeFor(user),
    ...(query.status ? { status: query.status as Prisma.EnumSupplierBillStatusFilter['equals'] } : {}),
    ...(query.search
      ? { OR: [{ supplierName: { contains: query.search, mode: 'insensitive' } }, { invoiceNumber: { contains: query.search, mode: 'insensitive' } }, { billNumber: { contains: query.search, mode: 'insensitive' } }] }
      : {}),
  };
  return prisma.supplierBill.findMany({
    where, orderBy: { billDate: 'desc' }, take: 200,
    select: {
      id: true, billNumber: true, supplierName: true, supplierGstin: true, invoiceNumber: true, billDate: true,
      taxableAmount: true, taxAmount: true, roundOff: true, totalAmount: true, amountPaid: true, balanceDue: true, status: true,
      creditDays: true, dueDate: true, isGstBill: true,
      _count: { select: { items: true } },
    },
  });
}

/** Full itemized purchase bill with GST breakup + payments. */
export async function getPurchaseDetail(id: string, user: AuthUser) {
  const bill = await prisma.supplierBill.findFirst({
    where: { id, isDeleted: false, ...booksScopeFor(user) },
    include: { items: { where: { isDeleted: false } }, payments: { where: { isDeleted: false }, orderBy: { paymentDate: 'desc' } } },
  });
  if (!bill) throw AppError.notFound('Purchase bill not found');
  return bill;
}

export async function listIntake(query: ListIntakeQuery) {
  const where: Prisma.RawMaterialIntakeWhereInput = {
    isDeleted: false,
    ...(query.rawMaterialId ? { rawMaterialId: query.rawMaterialId } : {}),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.rawMaterialIntake.findMany({
      where,
      orderBy: { intakeDate: 'desc' },
      skip,
      take,
      include: { rawMaterial: { select: { name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } },
    }),
    prisma.rawMaterialIntake.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

/** Finished-goods stock at the godown (per product). */
export async function getGodownStock() {
  return prisma.godownStock.findMany({
    where: { isDeleted: false, product: { isDeleted: false } },
    orderBy: { product: { name: 'asc' } },
    select: {
      quantity: true,
      product: { select: { id: true, name: true, sku: true, unit: { select: { id: true, name: true, decimalPlaces: true } }, reorderLevel: true } },
    },
  });
}

export const productionService = { logBatch, listBatches, getBatch, logIntake, listIntake, logPurchase, updatePurchase, deletePurchase, listPurchases, getPurchaseDetail, getGodownStock };
