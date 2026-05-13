'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { compressFileGzip } = require('./backup-db.ts');

async function main() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ska-backup-stream-'));
  const sourcePath = path.join(tempDir, 'large.sql');
  const targetPath = `${sourcePath}.gz`;

  // Sparse file to reproduce >2 GiB handling without actually allocating 2 GiB in memory.
  const fd = fs.openSync(sourcePath, 'w');
  fs.writeSync(fd, Buffer.from('SELECT 1;\n'), 0, 9, 0);
  fs.writeSync(fd, Buffer.from('\n-- eof\n'), 0, 7, 2_161_077_492 - 7);
  fs.closeSync(fd);

  const stat = fs.statSync(sourcePath);
  if (stat.size <= 2 * 1024 * 1024 * 1024) {
    throw new Error(`expected sparse file > 2GiB, got ${stat.size}`);
  }

  await compressFileGzip(sourcePath, targetPath);

  if (!fs.existsSync(targetPath)) {
    throw new Error('gzip output missing');
  }

  const gzStat = fs.statSync(targetPath);
  if (gzStat.size <= 0) {
    throw new Error('gzip output empty');
  }

  fs.rmSync(tempDir, { recursive: true, force: true });
  console.log('backup_db_stream_smoke_ok');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
