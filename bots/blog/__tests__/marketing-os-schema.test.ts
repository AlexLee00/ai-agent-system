'use strict';

jest.mock('fs', () => ({
  readFileSync: jest.fn().mockReturnValue('CREATE TABLE IF NOT EXISTS blog.t1(id int);'),
}));

jest.mock('../../../packages/core/lib/env', () => ({
  PROJECT_ROOT: '/Users/alexlee/projects/ai-agent-system',
}));

jest.mock('../../../packages/core/lib/pg-pool', () => ({
  run: jest.fn().mockResolvedValue(undefined),
  query: jest.fn().mockResolvedValue([]),
}));

const fs = require('fs');
const pgPool = require('../../../packages/core/lib/pg-pool');

describe('omnichannel marketing-os-schema', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    fs.readFileSync.mockReturnValue('CREATE TABLE IF NOT EXISTS blog.t1(id int);');
    pgPool.run.mockResolvedValue(undefined);
    pgPool.query.mockResolvedValue([]);
  });

  test('ensureMarketingOsSchema — migration sql 적용', async () => {
    const schema = require('../lib/omnichannel/marketing-os-schema.ts');
    await schema.ensureMarketingOsSchema();

    expect(fs.readFileSync).toHaveBeenCalled();
    expect(pgPool.run).toHaveBeenCalledWith('blog', 'CREATE SCHEMA IF NOT EXISTS blog');
    expect(pgPool.query).toHaveBeenCalledWith('blog', expect.stringContaining('CREATE TABLE'));
  });
});
