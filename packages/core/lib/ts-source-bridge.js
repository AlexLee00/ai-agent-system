const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

function findRepoRoot(startDir, sourceRelativePath) {
  let current = path.resolve(startDir);

  while (true) {
    const packageJsonPath = path.join(current, 'package.json');
    const sourcePath = path.join(current, sourceRelativePath);
    if (fs.existsSync(packageJsonPath) && fs.existsSync(sourcePath)) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveSourcePath(currentDir, moduleBaseName) {
  const sourceRelativePath = `packages/core/lib/${moduleBaseName}.ts`;
  const repoRoot =
    process.env.REPO_ROOT ||
    process.env.PROJECT_ROOT ||
    findRepoRoot(currentDir, sourceRelativePath) ||
    findRepoRoot(process.cwd(), sourceRelativePath);

  const candidates = [
    path.join(currentDir, `${moduleBaseName}.ts`),
    ...(repoRoot ? [path.join(repoRoot, sourceRelativePath)] : []),
    path.resolve(currentDir, `../../../../packages/core/lib/${moduleBaseName}.ts`),
    path.resolve(currentDir, `../../../../../packages/core/lib/${moduleBaseName}.ts`),
    path.resolve(currentDir, `../../../../../../packages/core/lib/${moduleBaseName}.ts`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Unable to locate ${moduleBaseName}.ts runtime source (checked: ${candidates.join(', ')})`);
}

function loadTsSourceBridge(currentDir, moduleBaseName) {
  const sourcePath = resolveSourcePath(currentDir, moduleBaseName);
  const source = fs.readFileSync(sourcePath, 'utf8');

  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
    },
    fileName: sourcePath,
  });

  const compiled = new Module(sourcePath, module);
  compiled.filename = sourcePath;
  compiled.paths = Module._nodeModulePaths(path.dirname(sourcePath));
  compiled.require = Module.createRequire(sourcePath);
  compiled._compile(outputText, sourcePath);
  return compiled.exports;
}

module.exports = {
  loadTsSourceBridge,
};
