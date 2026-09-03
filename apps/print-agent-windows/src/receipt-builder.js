'use strict';

// Builds the small line-DSL that printer-manager.buildEscPosBuffer() renders.
// Layout matches apps/web/lib/print/receipt-escpos.ts's pickListBytes() line
// for line (the same "New Order Receipt" the browser/Android print path
// already produces) -- store name, subtitle, Order/Outlet/Received/Bill type,
// items, total, footer message, same ordering, same wording. Only the
// subtitle and footer message change between new/revised/cancelled; nothing
// about the receipt's shape does. Do not restyle this without checking that
// file first -- it's the one format every print path in this system agrees on.
const STORE_NAME = 'Mumbai ERP';

const inr = (n) => `Rs ${Number(n).toFixed(2)}`;

function formatDate(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true,
  });
}

/** items: [{ name, unit, qty, price }] -- the shape both the new_order socket payload and GET /orders/:id share. */
function itemLines(items) {
  const out = [];
  let total = 0;
  for (const it of items) {
    const lineTotal = Number(it.qty) * Number(it.price);
    total += lineTotal;
    // Double-height (not double-width) -- matches pickListBytes()'s smartLine(name, { bold: true, tall: true }):
    // readable across the counter without halving how many characters fit on the line.
    out.push({ type: 'text', text: it.name, bold: true, size: 'tall' });
    out.push({ type: 'row', left: `  ${it.qty} ${it.unit} x ${inr(it.price)}`, right: inr(lineTotal), bold: true });
  }
  return { lines: out, total };
}

/** `subtitle` sits exactly where pickListBytes() puts 'New Order Receipt' / 'Order Pick List'. */
function header(order, subtitle) {
  return [
    { type: 'text', text: STORE_NAME, align: 'center', bold: true, size: 'huge' },
    { type: 'text', text: subtitle, align: 'center' },
    { type: 'divider' },
    { type: 'row', left: 'Order', right: order.orderNumber },
    { type: 'row', left: 'Outlet', right: order.outletName },
    { type: 'row', left: 'Received', right: formatDate(order.orderDate) },
    { type: 'row', left: 'Bill type', right: order.isGstBill ? 'With GST' : 'No GST' },
    { type: 'divider' },
  ];
}

/** `message` sits exactly where pickListBytes() prints its own closing line, same feed(1)/feed(4) spacing. */
function footer(total, message) {
  return [
    { type: 'divider' },
    { type: 'row', left: 'ESTIMATED TOTAL', right: inr(total), bold: true },
    { type: 'feed' },
    { type: 'text', text: message, align: 'center' },
    { type: 'feed' }, { type: 'feed' }, { type: 'feed' }, { type: 'feed' },
  ];
}

/** new_order -> the standard new-order slip, unchanged from what every other print path already produces. */
function buildNewOrderReceipt(order) {
  const lines = header(order, 'New Order Receipt');
  const { lines: items, total } = itemLines(order.items);
  lines.push(...items, ...footer(total, 'New order - start processing.'));
  return lines;
}

/**
 * A revised order -- reprints the current item list under a "Revised Order"
 * subtitle, same skeleton as the new-order slip above. There's no order-revision
 * event or version field in the backend today (checked orders.service.ts /
 * sockets/events.ts): the only live signal this can fire from is a caller
 * explicitly passing a version, or the agent's own in-memory "how many times
 * have I seen this order change" counter as a fallback (see socket-client.js).
 * If the server never emits a real order_modified event, this is simply never
 * called.
 */
function buildModifiedOrderReceipt(order, version) {
  const lines = header(order, `Revised Order${version ? ` (v${version})` : ''}`);
  const { lines: items, total } = itemLines(order.items);
  lines.push(...items, ...footer(total, 'Order was revised - re-check quantities before packing.'));
  return lines;
}

/** order_cancelled (in practice: order_status_changed with status CANCELLED) -> same skeleton, stop-work footer. */
function buildCancelledOrderReceipt(order) {
  const lines = header(order, 'Order Cancelled');
  if (order.items && order.items.length) {
    const { lines: items, total } = itemLines(order.items);
    lines.push(...items);
    lines.push({ type: 'divider' }, { type: 'row', left: 'ESTIMATED TOTAL', right: inr(total), bold: true });
  }
  if (order.reason) lines.push({ type: 'row', left: 'Reason', right: order.reason });
  lines.push(
    { type: 'feed' },
    { type: 'text', text: 'DO NOT PACK OR DISPATCH', align: 'center', bold: true },
    { type: 'feed' }, { type: 'feed' }, { type: 'feed' }, { type: 'feed' },
  );
  return lines;
}

module.exports = { buildNewOrderReceipt, buildModifiedOrderReceipt, buildCancelledOrderReceipt };
