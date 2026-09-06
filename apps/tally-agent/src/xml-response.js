'use strict';

const { SaxesParser } = require('saxes');

// xmlbuilder2 is retained for writing XML. Its permissive parser accepts missing
// closing tags, so replies use a strict parser before any success decision.
function parseXml(body) {
  if (typeof body !== 'string' || !body.trim()) throw new Error('Tally returned an empty response.');
  const parser = new SaxesParser();
  const stack = [];
  let root;
  parser.on('doctype', () => { throw new Error('DOCTYPE is not supported in Tally responses.'); });
  parser.on('opentag', (tag) => {
    if (stack.length > 64) throw new Error('Tally response nesting is too deep.');
    const node = { name: tag.name.toUpperCase(), attributes: {}, children: [], text: '' };
    for (const [key, value] of Object.entries(tag.attributes)) node.attributes[key.toUpperCase()] = value;
    if (stack.length) stack[stack.length - 1].children.push(node);
    else root = node;
    stack.push(node);
  });
  const append = (value) => { if (stack.length) stack[stack.length - 1].text += value; };
  parser.on('text', append);
  parser.on('cdata', append);
  parser.on('closetag', () => { stack.pop(); });
  try { parser.write(body).close(); }
  catch (err) { throw new Error(`Invalid XML from Tally: ${err.message}`); }
  if (!root || !['ENVELOPE', 'RESPONSE'].includes(root.name)) throw new Error('Tally returned an unrecognised response (expected ENVELOPE or RESPONSE).');
  return root;
}

function elements(node, name) {
  const out = [];
  if (node.name === name) out.push(node);
  for (const child of node.children) out.push(...elements(child, name));
  return out;
}

function textOf(node) {
  return node.text + node.children.map(textOf).join(' ');
}

function responseError(root) {
  const messages = ['LINEERROR', 'ERRMSG'].flatMap((tag) => elements(root, tag).map(textOf)).filter((s) => s.trim());
  const failedStatus = elements(root, 'HEADER').some((header) =>
    header.children.some((node) => node.name === 'STATUS' && node.text.trim() !== '1'));
  const errorCount = ['ERRORS', 'EXCEPTIONS'].some((tag) => elements(root, tag).some((n) => n.text.trim() !== '0'));
  if (!messages.length && (failedStatus || errorCount)) {
    messages.push(...elements(root, 'DESC').map(textOf).filter((s) => s.trim()));
    if (!messages.length) {
      const exceptions = elements(root, 'EXCEPTIONS').find((n) => /^[1-9]\d*$/.test(n.text.trim()));
      messages.push(exceptions
        ? `Tally reported ${exceptions.text.trim()} import exception(s). In the selected Tally company, open Alt+O (Import) > Exceptions > Voucher-Related Exceptions for the reason. Review any retained exception before retrying; no successful import has been confirmed.`
        : 'Tally rejected the request without an error description. Inspect the raw response.');
    }
  }
  return messages.length ? [...new Set(messages)].join(' | ').trim() : null;
}

function parseCollection(body) {
  const root = parseXml(body);
  const error = responseError(root);
  if (error) throw new Error(error);
  const collections = elements(root, 'COLLECTION');
  if (!collections.length) throw new Error('Tally returned no collection. Company or master discovery could not be verified.');
  return collections;
}

function namesFromCollections(collections, type) {
  const names = new Set();
  const companies = [];
  for (const collection of collections) {
    for (const object of collection.children.filter((node) => node.name === type)) {
      // The object's name attribute is authoritative. Do not collect aliases or
      // unrelated nested NAME elements. XML entities/CDATA are already decoded.
      const name = object.attributes.NAME ?? object.children.find((node) => node.name === 'NAME')?.text
        ?? object.children.find((node) => node.name === `${type}NAME`)?.text
        ?? object.children.find((node) => node.name === 'NAME.LIST')?.children.find((node) => node.name === 'NAME')?.text;
      if (typeof name !== 'string' || !name.trim()) throw new Error(`Tally returned a ${type.toLowerCase()} without a name.`);
      names.add(name);
      if (type === 'COMPANY') companies.push(name);
    }
  }
  // Preserve duplicate company objects so selection can reject ambiguous names.
  return type === 'COMPANY' ? companies : [...names];
}

module.exports = { parseXml, elements, responseError, parseCollection, namesFromCollections };
