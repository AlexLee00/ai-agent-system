'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function resolveSourcePath() {
  const repoRoot = process.env.REPO_ROOT || process.env.PROJECT_ROOT || process.cwd();
  const candidates = [
    path.join(__dirname, 'runtime-config-loader.ts'),
    path.join(repoRoot, 'packages/core/lib/runtime-config-loader.ts'),
    path.join(__dirname, '../../../../packages/core/lib/runtime-config-loader.ts'),
    path.join(__dirname, '../../../../../packages/core/lib/runtime-config-loader.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Unable to locate runtime-config-loader.ts runtime source (checked: ${candidates.join(', ')})`
  );
}

const sourcePath = resolveSourcePath();
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
m.paths = Module._nodeModulePaths(path.dirname(sourcePath));
m._compile(outputText, sourcePath);

module.exports = m.exports;
