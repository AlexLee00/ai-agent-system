'use strict';
const { transformSync } = require('esbuild');

module.exports = {
  process(source, filename) {
    const result = transformSync(source, {
      loader: filename.endsWith('.tsx') ? 'tsx' : 'ts',
      target: 'node18',
      format: 'cjs',
      sourcemap: 'inline',
      sourcefile: filename,
    });
    return { code: result.code };
  },
};
