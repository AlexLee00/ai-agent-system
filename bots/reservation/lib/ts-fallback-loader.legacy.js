'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { transformSync } = require('esbuild');

function loadTsModule(tsPath) {
  const resolvedPath = path.resolve(tsPath);
  const source = fs.readFileSync(resolvedPath, 'utf8');
  const { code } = transformSync(source, {
    loader: 'ts',
    format: 'cjs',
    target: 'node22',
    sourcemap: false,
  });

  const runtimeModule = new Module(resolvedPath, module.parent);
  runtimeModule.filename = resolvedPath;
  runtimeModule.paths = Module._nodeModulePaths(path.dirname(resolvedPath));
  runtimeModule._compile(code, resolvedPath);
  return runtimeModule.exports;
}

function loadTsModuleWithFallback(baseDir, tsRelativePath, distRelativePath) {
  const distPath = distRelativePath ? path.resolve(baseDir, distRelativePath) : null;
  if (distPath && fs.existsSync(distPath)) {
    return require(distPath);
  }

  const tsPath = path.resolve(baseDir, tsRelativePath);
  return loadTsModule(tsPath);
}

module.exports = {
  loadTsModule,
  loadTsModuleWithFallback,
};
