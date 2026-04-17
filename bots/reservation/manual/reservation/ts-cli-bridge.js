const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const compileCache = new Map();

function resolveTsCandidate(basePath) {
  const direct = basePath.replace(/\.js$/i, '.ts');
  if (fs.existsSync(direct)) return direct;
  throw new Error(`Unable to locate TS source for ${basePath}`);
}

function resolveRelativeTsImport(sourcePath, request) {
  if (!String(request || '').startsWith('.')) return null;

  const sourceDir = path.dirname(sourcePath);
  const candidates = [
    path.resolve(sourceDir, request.replace(/\.js$/i, '.ts')),
    path.resolve(sourceDir, `${request}.ts`),
    path.resolve(sourceDir, request, 'index.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function loadTsCliModule(sourcePath) {
  const cached = compileCache.get(sourcePath);
  if (cached) return cached.exports;

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
  compileCache.set(sourcePath, compiled);

  const nativeRequire = Module.createRequire(sourcePath);
  compiled.require = (request) => {
    try {
      return nativeRequire(request);
    } catch (error) {
      if (error?.code !== 'MODULE_NOT_FOUND') throw error;
      const nestedSourcePath = resolveRelativeTsImport(sourcePath, request);
      if (!nestedSourcePath) throw error;
      return loadTsCliModule(nestedSourcePath);
    }
  };

  compiled._compile(outputText, sourcePath);
  return compiled.exports;
}

function runTsCliBridge(currentFile) {
  const sourcePath = resolveTsCandidate(currentFile);
  return loadTsCliModule(sourcePath);
}

module.exports = {
  runTsCliBridge,
};
