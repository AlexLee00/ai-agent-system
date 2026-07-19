'use strict';

const fs = require('fs');
const path = require('path');

const CORE_LIB_RELATIVE_PATH = path.join('packages', 'core', 'lib');

function findProjectRoot(startDir, moduleBaseName) {
  let current = path.resolve(startDir);
  while (true) {
    const coreLibDir = path.join(current, CORE_LIB_RELATIVE_PATH);
    if (
      fs.existsSync(path.join(current, 'package.json'))
      && (
        fs.existsSync(path.join(coreLibDir, `${moduleBaseName}.js`))
        || fs.existsSync(path.join(coreLibDir, `${moduleBaseName}.legacy.js`))
      )
    ) {
      return current;
    }

    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function resolveCoreRuntimeModule(moduleBaseName) {
  const configuredRoot = String(process.env.PROJECT_ROOT || '').trim();
  const roots = [
    configuredRoot || null,
    findProjectRoot(process.cwd(), moduleBaseName),
    findProjectRoot(__dirname, moduleBaseName),
  ].filter(Boolean);
  const checked = [];

  for (const root of [...new Set(roots)]) {
    const coreLibDir = path.join(root, CORE_LIB_RELATIVE_PATH);
    for (const filename of [`${moduleBaseName}.js`, `${moduleBaseName}.legacy.js`]) {
      const candidate = path.join(coreLibDir, filename);
      checked.push(candidate);
      if (fs.existsSync(candidate)) return candidate;
    }
  }

  throw new Error(
    `[reservation] ${moduleBaseName} bridge target not found (checked: ${checked.join(', ') || 'no project root'})`,
  );
}

function loadCoreRuntimeModule(moduleBaseName) {
  return require(resolveCoreRuntimeModule(moduleBaseName));
}

module.exports = {
  findProjectRoot,
  loadCoreRuntimeModule,
  resolveCoreRuntimeModule,
};
