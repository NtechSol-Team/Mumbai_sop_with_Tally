const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const filename = path.resolve(__dirname, '../lib/utils.ts');
const compiled = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const loaded = new Module(filename, module);
loaded.paths = Module._nodeModulePaths(path.dirname(filename));
loaded._compile(compiled, filename);
const { cn } = loaded.exports;
for (const size of ['caption', 'body', 'label', 'card-title', 'page-heading', 'kpi']) {
  test(`${size} typography preserves semantic text colors`, () => {
    assert.equal(cn('text-primary-foreground', `text-${size}`), `text-primary-foreground text-${size}`);
    assert.equal(cn(`text-${size}`, 'text-danger'), `text-${size} text-danger`);
    assert.equal(cn(`text-${size}`, 'text-sm'), 'text-sm');
  });
}
test('responsive typography and explicit color overrides still merge correctly', () => {
  assert.equal(cn('text-white sm:text-label', 'text-primary sm:text-body'), 'text-primary sm:text-body');
});
