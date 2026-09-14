'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { desktopConfigPath, loginItemSettings } = require('../src/desktop');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arthx-desktop-'));
  t.after(() => fs.rmSync(root, { recursive:true, force:true }));
  return { home:root, appData:path.join(root,'appdata'), userData:path.join(root,'appdata','current') };
}
function save(file) { fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'{}'); }

test('desktop reuses headless settings in place, keeping the result journal alongside them', (t) => {
  const dirs=fixture(t), file=path.join(dirs.home,'.mumbai-erp-tally-agent','config.json');
  save(file); save(path.join(path.dirname(file),'pending-results.json'));
  assert.equal(desktopConfigPath(dirs),file);
  assert.ok(fs.existsSync(path.join(path.dirname(desktopConfigPath(dirs)),'pending-results.json')));
});
test('explicit configuration path wins even when it has not been created yet', (t) => {
  const dirs=fixture(t), override=path.join(dirs.home,'custom','config.json');
  assert.equal(desktopConfigPath({...dirs,override}),override);
});
test('legacy Electron settings remain usable when there is no headless configuration', (t) => {
  const dirs=fixture(t), legacy=path.join(dirs.appData,'Mumbai ERP Tally Sync Agent','config.json');
  save(legacy); assert.equal(desktopConfigPath(dirs),legacy);
});
test('fresh installations use the same settings location as the CLI', (t) => {
  const dirs=fixture(t); assert.equal(desktopConfigPath(dirs),path.join(dirs.home,'.mumbai-erp-tally-agent','config.json'));
});
test('Windows startup points to the installed executable with background launch arguments', () => {
  const exe='C:\\Users\\Test User\\AppData\\Local\\Programs\\Arthx\\agent.exe';
  assert.deepEqual(loginItemSettings(exe,true),{name:'Arthx Tally Sync Agent',path:exe,args:['--autostart'],openAtLogin:true});
  assert.equal(loginItemSettings(exe,false).openAtLogin,false);
});
test('desktop startup preference is validated and survives saving configuration', (t) => {
  const config=require('../src/config');
  const old=config.storePath, dirs=fixture(t);
  config.setStorePath(path.join(dirs.home,'config.json'));t.after(()=>config.setStorePath(old));
  assert.equal(config.get().startWithWindows,true);
  config.set({startWithWindows:false});assert.equal(config.get().startWithWindows,false);
  assert.throws(()=>config.set({startWithWindows:'false'}),/Start with Windows/);
});
test('installer packages the tray image and provides desktop and Start menu shortcuts', () => {
  const pkg=require('../package.json');
  assert.ok(pkg.build.files.includes('build/*.png'));
  const icon=fs.readFileSync(path.join(__dirname,'..','build','icon.png'));
  assert.equal(icon.subarray(1,4).toString(),'PNG');
  assert.equal(icon.readUInt32BE(16),256);assert.equal(icon.readUInt32BE(20),256);
  assert.equal(pkg.build.nsis.createDesktopShortcut,true);
  assert.equal(pkg.build.nsis.createStartMenuShortcut,true);
  assert.equal(pkg.build.nsis.perMachine,false);
});
