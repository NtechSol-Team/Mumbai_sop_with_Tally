'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** Reuse the existing file and its acknowledgement journal; never copy just tokens. */
function desktopConfigPath({ override, home, appData, userData }) {
  if (override) return override;
  const headless = path.join(home, '.mumbai-erp-tally-agent', 'config.json');
  return [headless, path.join(userData, 'config.json'),
    path.join(appData, 'Mumbai ERP Tally Sync Agent', 'config.json'),
    path.join(appData, 'mumbai-erp-tally-agent', 'config.json')]
    .find((file) => fs.existsSync(file)) || headless;
}

function loginItemSettings(executable, enabled) {
  return { name: 'Arthx Tally Sync Agent', path: executable, args: ['--autostart'], openAtLogin: enabled };
}

module.exports = { desktopConfigPath, loginItemSettings };
