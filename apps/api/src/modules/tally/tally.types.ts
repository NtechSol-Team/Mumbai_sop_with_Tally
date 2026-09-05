/**
 * The canonical voucher — the contract between the ERP (which owns all accounting
 * logic) and the local sync agent (which only turns this JSON into Tally XML).
 * Versioned: bump `contractVersion` on any breaking change and teach the agent both.
 */

export type DrCr = 'DR' | 'CR';

export interface TallyBillAllocation {
  /** The bill reference this allocation is against (our doc number or the supplier's invoice no). */
  name: string;
  kind: 'NEW' | 'AGAINST' | 'ADVANCE';
  amount: number;
}

export interface TallyLedgerLine {
  /** Resolved Tally ledger name, exactly as it exists in the client's Tally. */
  ledger: string;
  drCr: DrCr;
  /** Always positive. The sign in Tally XML is derived from drCr by the agent. */
  amount: number;
  billAllocations?: TallyBillAllocation[];
}

export interface TallyInventoryLine {
  item: string;
  quantity: number;
  rate: number;
  amount: number;
  godownFrom?: string;
  godownTo?: string;
}

export interface TallyVoucherPayload {
  contractVersion: 1;
  action: 'CREATE' | 'CANCEL';
  voucherType: 'SALES' | 'RECEIPT' | 'PURCHASE' | 'PAYMENT' | 'STOCK_JOURNAL' | 'JOURNAL';
  /** The Tally voucher-type name to post as, if the accountant renamed it. */
  tallyVoucherType?: string;
  /** yyyymmdd. */
  date: string;
  voucherNumber: string;
  reference?: string;
  narration: string;
  /** Becomes REMOTEID in Tally — a retry with the same key updates, never duplicates. */
  dedupKey: string;
  /** PARTYLEDGERNAME for invoice-style vouchers (Sales / Purchase). */
  partyLedger?: string;
  placeOfSupplyStateCode?: string;
  lines: TallyLedgerLine[];
  inventory?: TallyInventoryLine[];
  meta: { entityType: string; entityId: string; revision: number };
}

/** Thrown by the builder/validator when a voucher cannot be safely posted. */
export class TallyBuildError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyBuildError';
  }
}

/**
 * Thrown when a voucher is fine but not its turn yet — typically a receipt
 * waiting for the invoice it is allocated against to reach Tally first. Distinct
 * from TallyBuildError because the row stays PENDING and retries, rather than
 * being marked FAILED; the reason is still shown so it never looks stuck for no
 * apparent cause.
 */
export class TallyDeferError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TallyDeferError';
  }
}
