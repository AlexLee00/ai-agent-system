'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const sourcePath = path.join(__dirname, 'agent-memory.ts');
const source = fs.readFileSync(sourcePath, 'utf8');

const { outputText } = ts.transpileModule(source, {
  compilerOptions: {
    module: ts.ModuleKind.CommonJS,
    target: ts.ScriptTarget.ES2020,
    esModuleInterop: true,
  },
  fileName: sourcePath,
});

const m = new Module(sourcePath, module);
m.filename = sourcePath;
m.paths = Module._nodeModulePaths(__dirname);
m._compile(outputText, sourcePath);

module.exports = m.exports;
