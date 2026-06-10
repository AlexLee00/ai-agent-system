'use strict';

module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]sx?$': '<rootDir>/../hub/jest-esbuild-transform.cjs',
  },
  moduleFileExtensions: ['js', 'json', 'ts', 'tsx'],
};
