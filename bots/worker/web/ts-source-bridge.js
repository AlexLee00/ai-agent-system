'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');
const ts = require('typescript');

const bridgeCache = new Map();

function resolveSiblingSourcePath(baseDir, moduleName) {
  const candidates = ['.ts', '.tsx'].map((extension) => path.join(baseDir, `${moduleName}${extension}`));
  const sourcePath = candidates.find((candidate) => fs.existsSync(candidate));
  if (!sourcePath) {
    throw new Error(`worker-web ts source not found for ${moduleName}`);
  }
  return sourcePath;
}

function resolveTsImportCandidate(basePath, request) {
  const normalized = path.extname(request)
    ? request.replace(/\.js$/i, '.ts')
    : `${request}.ts`;
  const candidates = [
    path.resolve(basePath, normalized),
    path.resolve(basePath, normalized.replace(/\.ts$/i, '.tsx')),
    path.resolve(basePath, request, 'index.ts'),
    path.resolve(basePath, request, 'index.tsx'),
  ];

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

function resolveFallbackSourceImport(sourcePath, request) {
  if (path.isAbsolute(request)) {
    return resolveTsImportCandidate(path.parse(request).root, request);
  }

  const sourceDir = path.dirname(sourcePath);
  return resolveTsImportCandidate(sourceDir, request);
}

function loadTsSourceFile(sourcePath) {
  const cached = bridgeCache.get(sourcePath);
  if (cached) return cached.exports;

  const source = fs.readFileSync(sourcePath, 'utf8').replace(/^#!.*\n/m, '');
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      jsx: ts.JsxEmit.ReactJSX,
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
      const isRecoverablePath = String(request || '').startsWith('.') || path.isAbsolute(String(request || ''));
      if (!isRecoverablePath || error?.code !== 'MODULE_NOT_FOUND') throw error;

      const nestedSourcePath = resolveFallbackSourceImport(sourcePath, request);
      if (!nestedSourcePath) throw error;
      return loadTsSourceFile(nestedSourcePath);
    }
  };

  compiled._compile(outputText, sourcePath);
  return compiled.exports;
}

function loadSiblingTsSource(baseDir, moduleName) {
  return loadTsSourceFile(resolveSiblingSourcePath(baseDir, moduleName));
}

module.exports = {
  loadSiblingTsSource,
};
