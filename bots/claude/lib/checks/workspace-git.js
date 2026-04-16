'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function findRepoRoot(startDir) {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const sourcePath = path.join(current, 'bots/claude/lib/checks/workspace-git.ts');
    if (fs.existsSync(packageJsonPath) && fs.existsSync(sourcePath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveSourcePath() {
  const repoRoot =
    process.env.REPO_ROOT ||
    process.env.PROJECT_ROOT ||
    findRepoRoot(__dirname) ||
    findRepoRoot(process.cwd());

  const candidates = [
    path.join(__dirname, 'workspace-git.ts'),
    ...(repoRoot ? [path.join(repoRoot, 'bots/claude/lib/checks/workspace-git.ts')] : []),
    path.resolve(__dirname, './workspace-git.ts'),
    path.resolve(__dirname, '../../../../bots/claude/lib/checks/workspace-git.ts'),
    path.resolve(__dirname, '../../../../dist/ts-runtime/bots/claude/lib/checks/workspace-git.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(
    `Unable to locate workspace-git.ts runtime source (checked: ${candidates.join(', ')})`,
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
module.exports.default = m.exports;
