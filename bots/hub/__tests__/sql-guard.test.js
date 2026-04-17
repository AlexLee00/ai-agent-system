'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function loadSqlGuard() {
  const sourcePath = path.join(__dirname, '..', 'lib', 'sql-guard.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: sourcePath,
  });

  const mod = new Module(sourcePath, module);
  mod.filename = sourcePath;
  mod.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  mod._compile(outputText, sourcePath);
  return mod.exports;
}

const { validateSql } = loadSqlGuard();

test('blocks pg_read_file', () => {
  const result = validateSql("SELECT pg_read_file('/etc/passwd')");
  assert.equal(result.ok, false);
});

test('blocks dblink', () => {
  const result = validateSql("SELECT * FROM dblink('host=localhost', 'SELECT 1')");
  assert.equal(result.ok, false);
});

test('removes inline comment safely', () => {
  const result = validateSql('SELECT 1 --; DROP TABLE users');
  assert.equal(result.ok, true);
  assert.equal(result.sql, 'SELECT 1');
});

test('removes block comment safely', () => {
  const result = validateSql('SELECT /* DROP */ 1');
  assert.equal(result.ok, true);
  assert.equal(result.sql, 'SELECT 1');
});

test('blocks drop hidden behind comment split statements', () => {
  const result = validateSql('SELECT 1/**/; /**/DROP/**/ TABLE x');
  assert.equal(result.ok, false);
});

test('allows normal select', () => {
  const result = validateSql('SELECT id, name FROM agents WHERE active = true');
  assert.equal(result.ok, true);
});

test('blocks multiple statements', () => {
  const result = validateSql('SELECT 1; SELECT 2');
  assert.equal(result.ok, false);
});
