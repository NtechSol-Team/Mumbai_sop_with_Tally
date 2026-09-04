'use strict';

const { create } = require('xmlbuilder2');

/**
 * Ledger-master creation XML — used only when the owner has turned
 * "auto-provision ledgers" on (fresh/test companies). The ERP never sends the
 * 6 GST duty ledgers here; those are created by hand via Tally's own ledger
 * wizard, which handles the GST "type of duty/tax" fields more reliably than
 * hand-built XML across TallyPrime versions.
 *
 * NAME.LIST is required, not optional: the NAME= attribute only identifies
 * WHICH master to act on, while <NAME.LIST> is what actually establishes the
 * master's name on a Create. Omitting it makes Tally reject every ledger
 * identically, which is a confusing failure to debug.
 */

function ledgerNode(ledger, { withGst }) {
  const node = {
    '@NAME': ledger.name,
    '@ACTION': 'Create',
    'NAME.LIST': { NAME: ledger.name },
    PARENT: ledger.parentGroup,
    ISDEEMEDPOSITIVE: 'No',
    AFFECTSSTOCK: 'No',
    ISCOSTCENTRESON: 'No',
    OPENINGBALANCE: '0',
  };

  if (ledger.isParty) {
    node.ISBILLWISEON = 'Yes';
    node.COUNTRYNAME = 'India';
    if (ledger.address) node['ADDRESS.LIST'] = { ADDRESS: ledger.address };
    if (ledger.phone) node.LEDGERPHONE = ledger.phone;
    if (ledger.state) node.LEDSTATENAME = ledger.state;
    // GST identity is the part most likely to differ between TallyPrime builds,
    // so it is separable — see buildLedgerMessages() for the retry-without-GST
    // fallback that keeps a GST quirk from blocking the ledger entirely.
    if (withGst && ledger.gstin) {
      node.PARTYGSTIN = ledger.gstin;
      node.GSTREGISTRATIONTYPE = 'Regular';
      node['LEDGSTREGDETAILS.LIST'] = {
        GSTREGISTRATIONTYPE: 'Regular',
        GSTIN: ledger.gstin,
      };
    }
  }
  return node;
}

function envelope(node, company) {
  const doc = {
    ENVELOPE: {
      HEADER: { VERSION: '1', TALLYREQUEST: 'Import Data' },
      BODY: {
        IMPORTDATA: {
          REQUESTDESC: {
            REPORTNAME: 'All Masters',
            STATICVARIABLES: { SVCURRENTCOMPANY: company || '' },
          },
          REQUESTDATA: {
            TALLYMESSAGE: { '@xmlns:UDF': 'TallyUDF', LEDGER: node },
          },
        },
      },
    },
  };
  return create(doc).end({ prettyPrint: false });
}

function buildLedgerEnvelope(ledger, company) {
  return envelope(ledgerNode(ledger, { withGst: true }), company);
}

/**
 * The attempts to make for one ledger, in order. A party ledger with a GSTIN is
 * tried with its GST details first; if Tally rejects that (the GST master fields
 * vary across releases), it is retried without them — a ledger that exists with
 * its GST details left to fill in by hand beats no ledger at all.
 */
function buildLedgerMessages(ledger, company) {
  const attempts = [{ label: 'with GST details', xml: envelope(ledgerNode(ledger, { withGst: true }), company) }];
  if (ledger.isParty && ledger.gstin) {
    attempts.push({ label: 'without GST details', xml: envelope(ledgerNode(ledger, { withGst: false }), company) });
  }
  return attempts;
}

/** Tally returning "already exists" for a Create is a success, not a failure. */
function isAlreadyExists(message) {
  return /already exist|duplicate|same name/i.test(message || '');
}

module.exports = { buildLedgerEnvelope, buildLedgerMessages, isAlreadyExists };
