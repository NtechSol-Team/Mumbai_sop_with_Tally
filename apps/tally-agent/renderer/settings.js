'use strict';

const $ = (id) => document.getElementById(id);
const FIELDS = ['erpUrl', 'agentToken', 'tallyHost', 'tallyPort', 'tallyCompany', 'pollSeconds'];
let busy = false;
let openCompanies = [];
const connection = () => ({ tallyHost: $('tallyHost').value.trim(), tallyPort: Number($('tallyPort').value), tallyCompany: $('tallyCompany').value });

function render(state) {
  if (busy) return;
  const bits = [
    `ERP: ${state.erpOk ? 'connected' : 'not reachable'}`,
    `Tally: ${state.tallyOk ? 'company verified' : state.tallyReachable ? 'reachable, company not verified' : 'not responding'}`,
  ];
  if (state.company) bits.push(`Selected company: ${JSON.stringify(state.company)}`);
  if (state.lastRun) bits.push(`Last check: ${new Date(state.lastRun).toLocaleTimeString()}`);
  if (state.pushed) bits.push(`Pushed: ${state.pushed}`);
  if (state.failed) bits.push(`Failed: ${state.failed}`);
  if (state.ledgerCandidates) bits.push(`Ledgers: ${state.ledgerCreated} created, ${state.ledgerExists} found, ${state.ledgerFailed} failed`);
  if (state.ledgerFailures?.length) bits.push(...state.ledgerFailures);
  if (state.lastError) bits.push(`Note: ${state.lastError}`);
  $('status').textContent = bits.join('\n');
}

function showCompanies(names) {
  openCompanies = names || [];
  $('companies').replaceChildren(new Option(openCompanies.length ? 'Select the intended company…' : 'No companies available', ''));
  openCompanies.forEach((name, index) => $('companies').add(new Option(JSON.stringify(name), String(index))));
  $('companies').disabled = !openCompanies.length;
}

async function action(message, work) {
  busy = true;
  $('status').textContent = message;
  document.querySelectorAll('button').forEach((button) => { button.disabled = true; });
  try { await work(); }
  catch (err) { $('status').textContent = err.message || String(err); }
  finally {
    busy = false;
    document.querySelectorAll('button').forEach((button) => { button.disabled = false; });
  }
}

(async () => {
  try {
    const c = await window.agent.getConfig();
    $('version').textContent = c.agentVersion ? `Version ${c.agentVersion}` : '';
    for (const field of FIELDS) $(field).value = c[field] ?? '';
    $('companySource').textContent = `Company setting comes from: ${c.companySource}`;
    render(await window.agent.getState());
  } catch (err) { $('status').textContent = err.message || String(err); }
})();

window.agent.onState(render);
$('companies').addEventListener('change', () => {
  const index = $('companies').value;
  if (index !== '') $('tallyCompany').value = openCompanies[Number(index)];
});
for (const field of ['tallyHost', 'tallyPort']) $(field).addEventListener('input', () => showCompanies([]));

$('discover').addEventListener('click', () => action('Asking Tally for its open companies…', async () => {
  const result = await window.agent.listCompanies(connection());
  showCompanies(result.openCompanies);
  $('status').textContent = result.error || (openCompanies.length ? 'Choose the intended company above, then Save.' : 'Tally responded, but no company is open. Open the intended company in Tally and try again.');
}));

$('save').addEventListener('click', () => action('Saving settings…', async () => {
  const patch = {};
  for (const field of FIELDS) patch[field] = ['tallyPort', 'pollSeconds'].includes(field) ? Number($(field).value)
    : field === 'tallyCompany' ? $(field).value : $(field).value.trim();
  const saved = await window.agent.saveConfig(patch);
  for (const field of FIELDS) $(field).value = saved[field] ?? '';
  $('status').textContent = 'Saved. The agent will validate the exact company before sending anything.';
}));

$('test').addEventListener('click', () => action('Checking these Tally settings…', async () => {
  const result = await window.agent.pingTally(connection());
  showCompanies(result.openCompanies);
  $('status').textContent = result.ok ? `Tally verified ${JSON.stringify(result.company)}. Save to use these settings.` : result.error || 'Tally did not respond.';
}));

$('now').addEventListener('click', () => action('Running a sync pass using saved settings…', async () => {
  const state = await window.agent.syncNow();
  busy = false;
  render(state);
}));
