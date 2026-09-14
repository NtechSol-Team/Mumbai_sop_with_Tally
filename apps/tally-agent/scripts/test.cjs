'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Windows cmd.exe does not expand *.test.js; enumerate files identically on all hosts.
const directory = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(directory).filter((file) => file.endsWith('.test.js')).sort().map((file) => path.join(directory, file));
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio:'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
