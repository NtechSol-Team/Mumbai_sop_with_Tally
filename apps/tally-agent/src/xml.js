'use strict';

const { create } = require('xmlbuilder2');

/**
 * Canonical voucher JSON (built by the ERP) → TallyPrime import XML.
 *
 * Sign convention for ALLLEDGERENTRIES.LIST (verify against the client's exact
 * TallyPrime 7.1 build with a test company before go-live — Tally publishes no
 * API compatibility spec):
 *   • Debit  → ISDEEMEDPOSITIVE Yes, AMOUNT negative
 *   • Credit → ISDEEMEDPOSITIVE No,  AMOUNT positive
 *
 * REMOTEID carries the ERP's dedup key, so a retry updates rather than duplicates.
 * A revision > 0 (an edited source row) is sent as Delete-then-Create.
 */

const BILLTYPE = { NEW: 'New Ref', AGAINST: 'Agst Ref', ADVANCE: 'Advance' };
const money = (n) => Number(n).toFixed(2);

function ledgerEntry(line) {
  const debit = line.drCr === 'DR';
  const node = {
    LEDGERNAME: line.ledger,
    ISDEEMEDPOSITIVE: debit ? 'Yes' : 'No',
    AMOUNT: money(debit ? -line.amount : line.amount),
  };
  if (line.billAllocations && line.billAllocations.length) {
    node['BILLALLOCATIONS.LIST'] = line.billAllocations.map((b) => ({
      NAME: b.name,
      BILLTYPE: BILLTYPE[b.kind] || 'New Ref',
      AMOUNT: money(debit ? -b.amount : b.amount),
    }));
  }
  return node;
}

function inventoryEntry(inv) {
  // A stock-journal consumption (source) / production (destination) pair.
  return {
    STOCKITEMNAME: inv.item,
    ISDEEMEDPOSITIVE: inv.godownTo ? 'No' : 'Yes',
    AMOUNT: money(inv.amount),
    ACTUALQTY: `${inv.quantity}`,
    BILLEDQTY: `${inv.quantity}`,
    RATE: money(inv.rate),
    'BATCHALLOCATIONS.LIST': {
      GODOWNNAME: inv.godownTo || inv.godownFrom || 'Main Location',
      ACTUALQTY: `${inv.quantity}`,
      BILLEDQTY: `${inv.quantity}`,
    },
  };
}

function voucherNode(payload, action) {
  const v = {
    '@REMOTEID': payload.dedupKey,
    '@VCHTYPE': payload.tallyVoucherType || defaultVchType(payload.voucherType),
    '@ACTION': action,
    '@OBJVIEW': payload.voucherType === 'SALES' || payload.voucherType === 'PURCHASE' ? 'Invoice Voucher View' : 'Accounting Voucher View',
    DATE: payload.date,
    EFFECTIVEDATE: payload.date,
    VOUCHERTYPENAME: payload.tallyVoucherType || defaultVchType(payload.voucherType),
    VOUCHERNUMBER: payload.voucherNumber,
    REFERENCE: payload.reference || payload.voucherNumber,
    NARRATION: payload.narration,
    REMOTEID: payload.dedupKey,
  };
  if (action === 'Delete') return v;

  if (payload.partyLedger) v.PARTYLEDGERNAME = payload.partyLedger;
  if (payload.placeOfSupplyStateCode) v.PLACEOFSUPPLY = payload.placeOfSupplyStateCode;

  if (payload.lines && payload.lines.length) {
    v['ALLLEDGERENTRIES.LIST'] = payload.lines.map(ledgerEntry);
  }
  if (payload.inventory && payload.inventory.length) {
    v['ALLINVENTORYENTRIES.LIST'] = payload.inventory.map(inventoryEntry);
  }
  return v;
}

function defaultVchType(t) {
  return {
    SALES: 'Sales', RECEIPT: 'Receipt', PURCHASE: 'Purchase',
    PAYMENT: 'Payment', STOCK_JOURNAL: 'Stock Journal', JOURNAL: 'Journal',
  }[t] || 'Journal';
}

/** Build the full import envelope for one voucher. `action` is Create | Alter | Delete. */
function buildEnvelope(payload, company, action) {
  const doc = {
    ENVELOPE: {
      HEADER: { TALLYREQUEST: 'Import Data' },
      BODY: {
        IMPORTDATA: {
          REQUESTDESC: {
            REPORTNAME: 'Vouchers',
            STATICVARIABLES: { SVCURRENTCOMPANY: company || '' },
          },
          REQUESTDATA: {
            TALLYMESSAGE: {
              '@xmlns:UDF': 'TallyUDF',
              VOUCHER: voucherNode(payload, action),
            },
          },
        },
      },
    },
  };
  return create(doc).end({ prettyPrint: false });
}

/**
 * The messages to send for one queue item, in order. A fresh voucher is one
 * Create; an edited one is a Delete then a Create; a cancelled one is a Delete.
 */
function messagesFor(item, company) {
  const p = item.payload;
  if (p.action === 'CANCEL') return [{ action: 'Delete', xml: buildEnvelope(p, company, 'Delete') }];
  const msgs = [];
  if ((item.revision || p.meta?.revision || 0) > 0) {
    msgs.push({ action: 'Delete', xml: buildEnvelope(p, company, 'Delete'), tolerateNotFound: true });
  }
  msgs.push({ action: 'Create', xml: buildEnvelope(p, company, 'Create') });
  return msgs;
}

module.exports = { buildEnvelope, messagesFor };
