import { Prisma, StockTransferStatus } from '@prisma/client';
import { prisma } from '../../config/prisma';
import { cache, CacheTag } from '../../config/cache';
import { AppError } from '../../shared/utils/AppError';
import { nextDocNumber } from '../../shared/utils/docNumber';
import { buildPaginationMeta, toSkipTake } from '../../shared/utils/pagination';
import { emitRealtime } from '../../sockets/realtime';
import { RealtimeEvent } from '../../sockets/events';
import { assertProductQuantities } from '../../shared/utils/quantity';
import { enqueueTallySync, markTallyDeleted } from '../tally/tally.outbox';
import type { CreateTransferInput, ListTransfersQuery, UpdateTransferStatusInput } from './transfers.schema';

const transferInclude = {
  items: { include: { product: { select: { id: true, name: true, unit: { select: { id: true, name: true, decimalPlaces: true } } } } } },
  destinationOutlet: { select: { id: true, name: true } },
} satisfies Prisma.StockTransferInclude;

export async function createTransfer(input: CreateTransferInput, userId: string) {
  // Validate products exist.
  const productIds = input.items.map((i) => i.productId);
  const found = await prisma.product.count({ where: { id: { in: productIds }, isDeleted: false } });
  if (found !== new Set(productIds).size) throw AppError.badRequest('One or more products are invalid');
  await assertProductQuantities(input.items);

  if (input.destinationType === 'OUTLET' && input.destinationOutletId) {
    const outlet = await prisma.outlet.count({ where: { id: input.destinationOutletId, isDeleted: false } });
    if (!outlet) throw AppError.badRequest('Invalid destination outlet', undefined, 'destinationOutletId');
  }

  const transfer = await prisma.$transaction(async (tx) => {
    const transferNumber = await nextDocNumber(tx, 'TRANSFER');
    return tx.stockTransfer.create({
      data: {
        transferNumber,
        status: StockTransferStatus.DRAFT,
        destinationType: input.destinationType,
        destinationOutletId: input.destinationType === 'OUTLET' ? input.destinationOutletId : null,
        transferDate: input.transferDate,
        vehicleNumber: input.vehicleNumber,
        notes: input.notes,
        createdById: userId,
        items: { create: input.items.map((i) => ({ productId: i.productId, quantity: i.quantity })) },
      },
      include: transferInclude,
    });
  });

  cache.invalidateTags(CacheTag.INVENTORY);
  return transfer;
}

const FORWARD: Record<StockTransferStatus, StockTransferStatus[]> = {
  DRAFT: [StockTransferStatus.DISPATCHED, StockTransferStatus.CANCELLED],
  DISPATCHED: [StockTransferStatus.RECEIVED],
  RECEIVED: [],
  CANCELLED: [],
};

export async function updateStatus(id: string, input: UpdateTransferStatusInput, _userId: string) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id, isDeleted: false }, include: transferInclude });
  if (!transfer) throw AppError.notFound('Transfer not found');

  if (!FORWARD[transfer.status].includes(input.status)) {
    throw AppError.invalidState(`Cannot move transfer from ${transfer.status} to ${input.status}`);
  }

  const updated = await prisma.$transaction(async (tx) => {
    let transferValue = new Prisma.Decimal(0);
    if (input.status === StockTransferStatus.RECEIVED) {
      // Move stock out of the godown into the destination (main branch OR a direct outlet).
      const toOutlet = transfer.destinationType === 'OUTLET' && transfer.destinationOutletId;
      for (const item of transfer.items) {
        const godown = await tx.godownStock.findUnique({ where: { productId: item.productId } });
        if (!godown || new Prisma.Decimal(godown.quantity).lessThan(item.quantity)) {
          throw AppError.insufficientStock(
            `Not enough godown stock for ${item.product.name}: need ${item.quantity}, have ${godown?.quantity ?? 0}`,
          );
        }
      }
      // Snapshot the transferred value (weighted-average cost) for the Stock Journal.
      const costs = await tx.product.findMany({
        where: { id: { in: transfer.items.map((i) => i.productId) } },
        select: { id: true, avgCost: true },
      });
      const costOf = new Map(costs.map((c) => [c.id, new Prisma.Decimal(c.avgCost)]));
      for (const item of transfer.items) {
        const unitCost = costOf.get(item.productId) ?? new Prisma.Decimal(0);
        await tx.stockTransferItem.update({ where: { id: item.id }, data: { unitCost } });
        transferValue = transferValue.add(new Prisma.Decimal(item.quantity).mul(unitCost));
      }
      for (const item of transfer.items) {
        await tx.godownStock.update({ where: { productId: item.productId }, data: { quantity: { decrement: item.quantity } } });
        if (toOutlet) {
          await tx.outletStock.upsert({
            where: { outletId_productId: { outletId: transfer.destinationOutletId!, productId: item.productId } },
            create: { outletId: transfer.destinationOutletId!, productId: item.productId, quantity: item.quantity },
            update: { quantity: { increment: item.quantity } },
          });
        } else {
          await tx.mainBranchStock.upsert({
            where: { productId: item.productId },
            create: { productId: item.productId, quantity: item.quantity },
            update: { quantity: { increment: item.quantity } },
          });
        }
      }
    }

    const saved = await tx.stockTransfer.update({
      where: { id },
      data: {
        status: input.status,
        ...(input.status === StockTransferStatus.DISPATCHED ? { dispatchedAt: new Date() } : {}),
        ...(input.status === StockTransferStatus.RECEIVED ? { receivedAt: new Date() } : {}),
      },
      include: transferInclude,
    });

    // Stock Journal — an internal godown → branch move (no GST, no party). Only
    // built when the accountant turns on the optional stock-journal module.
    if (input.status === StockTransferStatus.RECEIVED) {
      await enqueueTallySync(tx, {
        entityType: 'STOCK_TRANSFER', entityId: id, voucherType: 'STOCK_JOURNAL',
        entityDate: saved.receivedAt ?? new Date(), amount: transferValue, docNumber: saved.transferNumber,
        partyName: saved.destinationType === 'OUTLET' ? saved.destinationOutlet?.name ?? 'Outlet' : 'Main Branch',
      });
    } else if (input.status === StockTransferStatus.CANCELLED) {
      await markTallyDeleted(tx, 'STOCK_TRANSFER', id);
    }
    return saved;
  });

  cache.invalidateTags(CacheTag.INVENTORY, CacheTag.DASHBOARD);
  await emitRealtime(RealtimeEvent.TRANSFER_STATUS_CHANGED, { transferNumber: updated.transferNumber, status: updated.status });
  return updated;
}

export async function listTransfers(query: ListTransfersQuery) {
  const where: Prisma.StockTransferWhereInput = {
    isDeleted: false,
    ...(query.status ? { status: query.status } : {}),
    ...(query.productId ? { items: { some: { productId: query.productId } } } : {}),
    ...(query.from || query.to
      ? { transferDate: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
      : {}),
  };
  const { skip, take } = toSkipTake(query);
  const [rows, total] = await Promise.all([
    prisma.stockTransfer.findMany({ where, orderBy: { transferDate: 'desc' }, skip, take, include: transferInclude }),
    prisma.stockTransfer.count({ where }),
  ]);
  return { rows, meta: buildPaginationMeta(query, total) };
}

export async function getTransfer(id: string) {
  const transfer = await prisma.stockTransfer.findFirst({ where: { id, isDeleted: false }, include: transferInclude });
  if (!transfer) throw AppError.notFound('Transfer not found');
  return transfer;
}

export const transfersService = { createTransfer, updateStatus, listTransfers, getTransfer };
