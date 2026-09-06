'use strict';

const $ = (id) => document.getElementById(id);
const FIELDS = ['erpUrl', 'agentToken', 'tallyHost', 'tallyPort', 'tallyCompany', 'pollSeconds'];

function render(state) {
  const bits = [];
  bits.push(`ERP: ${state.erpOk ? 'connected' : 'not reachable'}`);
  bits.push(`Tally: ${state.tallyOk ? 'responding' : 'not responding'}`);
  if (state.lastRun) bits.push(`Last check: ${new Date(state.lastRun).toLocaleTimeString()}`);
  if (state.pushed) bits.push(`Pushed: ${state.pushed}`);
  if (state.failed) bits.push(`Failed: ${state.failed}`);
  if (state.lastError) bits.push(`Note: ${state.lastError}`);
  $('status').textContent = bits.join('\n');
}

(async () => {
  const c = await window.agent.getConfig();
  for (const f of FIELDS) $(f).value = c[f] ?? '';
  render(await window.agent.getState());
})();

window.agent.onState(render);

$('save').addEventListener('click', async () => {
  const patch = {};
  for (const f of FIELDS) patch[f] = f === 'tallyPort' || f === 'pollSeconds' ? Number($(f).value) : $(f).value.trim();
  await window.agent.saveConfig(patch);
  $('status').textContent = 'Saved. Syncing on the new settings…';
});

$('test').addEventListener('click', async () => {
  $('status').textContent = 'Pinging Tally…';
  const p = await window.agent.pingTally();
  if (p.ok) {
    $('status').textContent = 'Tally responded and "' + (p.openCompanies && p.openCompanies[0] || 'the company') + '" is open. Good.';
  } else {
    $('status').textContent = p.error || 'Tally did not respond.';
  }
});

$('now').addEventListener('click', async () => {
  $('status').textContent = 'Running a sync pass…';
  render(await window.agent.syncNow());
});
