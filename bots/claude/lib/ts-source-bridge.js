'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');

const bridgeCache = new Map();

function resolveSourcePath(currentDir, moduleBaseName) {
  const candidates = [
    path.join(currentDir, `${moduleBaseName}.ts`),
    path.resolve(currentDir, `./${moduleBaseName}.ts`),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  throw new Error(`Unable to locate ${moduleBaseName}.ts runtime source (checked: ${candidates.join(', ')})`);
}

function resolveRelativeTsImport(sourcePath, request) {
  const sourceDir = path.dirname(sourcePath);
  const hasExtension = Boolean(path.extname(request));
  const normalized = hasExtension ? request.replace(/\.js$/i, '.ts') : `${request}.ts`;
  const candidates = [
    path.resolve(sourceDir, normalized),
    path.resolve(sourceDir, request, 'index.ts'),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  return null;
}

function loadTsSourceFile(sourcePath) {
  const cached = bridgeCache.get(sourcePath);
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
  bridgeCache.set(sourcePath, compiled);

  const compiledRequire = Module.createRequire(sourcePath);
  compiled.require = (request) => {
    try {
      return compiledRequire(request);
    } catch (error) {
      const isRelative = String(request || '').startsWith('.');
      if (!isRelative || error?.code !== 'MODULE_NOT_FOUND') throw error;

      const nestedSourcePath = resolveRelativeTsImport(sourcePath, request);
      if (!nestedSourcePath) throw error;
      return loadTsSourceFile(nestedSourcePath);
    }
  };

  compiled._compile(outputText, sourcePath);
  return compiled.exports;
}

function loadTsSourceBridge(currentDir, moduleBaseName) {
  const sourcePath = resolveSourcePath(currentDir, moduleBaseName);
  return loadTsSourceFile(sourcePath);
}

module.exports = {
  loadTsSourceBridge,
};
