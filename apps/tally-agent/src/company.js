'use strict';

// Normalisation is ONLY for suggestions. Never use its result in a Tally request.
const comparable = (name) => name.normalize('NFC').trim().replace(/\s+/gu, ' ').toLowerCase();
const quoted = (names) => names.map((name) => JSON.stringify(name)).join(', ');

function requireCompany(company) {
  if (typeof company !== 'string' || !company.trim()) {
    throw new Error('Select a Tally company before sending a company-scoped request.');
  }
  return company;
}

function selectCompany(requested, openCompanies) {
  const open = [...new Set(openCompanies)];
  const list = open.length ? `Open companies: ${quoted(open)}.` : 'No company is open in Tally.';
  if (!requested || !requested.trim()) {
    return { company: null, code: 'COMPANY_REQUIRED', error: `No Tally company selected. ${list} Choose the intended company in agent Settings or set TALLY_COMPANY to its exact name.` };
  }
  if (!open.length) {
    return { company: null, code: 'NO_COMPANY_OPEN', error: `${list} Open ${JSON.stringify(requested)} in Tally, then retry.` };
  }
  if (openCompanies.filter((name) => name === requested).length > 1) {
    return { company: null, code: 'COMPANY_AMBIGUOUS', error: `Tally reported multiple loaded companies named ${JSON.stringify(requested)}. Close the unintended copy or give the companies distinct names before syncing.` };
  }
  if (open.includes(requested)) return { company: open.find((name) => name === requested), code: null, error: null };
  const similar = open.filter((name) => comparable(name) === comparable(requested));
  return {
    company: null,
    code: similar.length ? 'COMPANY_NAME_MISMATCH' : 'COMPANY_NOT_OPEN',
    error: `Configured company ${JSON.stringify(requested)} does not exactly match an open company. ${list} ` +
      (similar.length ? `Case or whitespace differs; select ${quoted(similar)} explicitly. ` : '') +
      'Open the intended company or select its exact name in agent Settings / TALLY_COMPANY. Sync is paused; no other company was selected.',
  };
}

module.exports = { requireCompany, selectCompany };
