'use strict';

const fs = require('fs');
const path = require('path');

const LOG_DIR = '/tmp';
const ERR_SUFFIX = '.err.log';

async function errorsRecentRoute(req, res) {
  const minutes = parseInt(req.query.minutes || '60', 10);
  const serviceFilter = req.query.service || null;

  const files = fs.readdirSync(LOG_DIR)
    .filter((file) => file.endsWith(ERR_SUFFIX))
    .filter((file) => !serviceFilter || file.includes(serviceFilter));

  const results = [];
  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (stat.size === 0) continue;

      const content = fs.readFileSync(filePath, 'utf8');
      const lines = content.split('\n').filter((line) => line.trim());
      if (lines.length === 0) continue;

      results.push({
        service: file.replace(ERR_SUFFIX, ''),
        file: filePath,
        size_bytes: stat.size,
        modified_at: stat.mtime.toISOString(),
        error_count: lines.length,
        recent_errors: lines.slice(-5),
      });
    } catch {
      // 읽기 실패는 해당 파일만 건너뜀
    }
  }

  return res.json({
    ok: true,
    minutes,
    service_filter: serviceFilter,
    total_services: results.length,
    total_errors: results.reduce((sum, item) => sum + item.error_count, 0),
    services: results.sort((a, b) => b.error_count - a.error_count),
  });
}

async function errorsSummaryRoute(req, res) {
  const files = fs.readdirSync(LOG_DIR).filter((file) => file.endsWith(ERR_SUFFIX));
  const summary = [];

  for (const file of files) {
    const filePath = path.join(LOG_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      summary.push({
        service: file.replace(ERR_SUFFIX, ''),
        size_bytes: stat.size,
        has_errors: stat.size > 0,
        modified_at: stat.mtime.toISOString(),
      });
    } catch {
      // 읽기 실패는 건너뜀
    }
  }

  return res.json({
    ok: true,
    total: summary.length,
    with_errors: summary.filter((item) => item.has_errors).length,
    clean: summary.filter((item) => !item.has_errors).length,
    services: summary.sort((a, b) => b.size_bytes - a.size_bytes),
  });
}

module.exports = {
  errorsRecentRoute,
  errorsSummaryRoute,
};
