'use strict';

const { create } = require('xmlbuilder2');

/**
 * Ledger-master creation XML — used only when the owner has turned
 * "auto-provision ledgers" on (fresh/test companies). The ERP never sends the
 * 6 GST duty ledgers here; those are created by hand via Tally's own ledger
 * wizard, which handles the GST "type of duty/tax" fields more reliably than
 * hand-built XML across TallyPrime versions.
 */
function buildLedgerEnvelope(ledger, company) {
  const node = {
    '@NAME': ledger.name,
    '@ACTION': 'Create',
    PARENT: ledger.parentGroup,
    OPENINGBALANCE: '0',
  };
  if (ledger.isParty) {
    node.ISBILLWISEON = 'Yes';
    if (ledger.address) node['ADDRESS.LIST'] = { ADDRESS: ledger.address };
    if (ledger.phone) node.LEDGERPHONE = ledger.phone;
    if (ledger.gstin) {
      node.PARTYGSTIN = ledger.gstin;
      node.GSTREGISTRATIONTYPE = 'Regular';
      node.LEDSTATENAME = ledger.state || 'Maharashtra';
    }
  }

  const doc = {
    ENVELOPE: {
      HEADER: { TALLYREQUEST: 'Import Data' },
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

/** Tally returning "already exists" for a Create is a success, not a failure. */
function isAlreadyExists(message) {
  return /already exists|duplicate/i.test(message || '');
}

module.exports = { buildLedgerEnvelope, isAlreadyExists };
