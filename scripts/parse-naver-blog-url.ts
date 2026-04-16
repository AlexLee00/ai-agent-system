// @ts-nocheck
'use strict';

const path = require('path');
const { parseNaverBlogUrl } = require(path.join(__dirname, '../packages/core/lib/naver-blog-url'));

function parseArgs(argv = process.argv.slice(2)) {
  const url = argv.find((arg) => !arg.startsWith('--')) || '';
  return {
    url,
    json: argv.includes('--json'),
  };
}

function printHuman(result) {
  if (!result.ok) {
    process.stdout.write([
      '네이버 블로그 URL 파싱 실패',
      `- input: ${result.input || '-'}`,
      `- reason: ${result.reason}`,
    ].join('\n') + '\n');
    return;
  }

  process.stdout.write([
    '네이버 블로그 URL 파싱',
    `- input: ${result.input}`,
    `- blogId: ${result.blogId}`,
    `- logNo: ${result.logNo}`,
    `- canonical: ${result.canonicalUrl}`,
    `- mobile: ${result.mobileUrl}`,
    `- source: ${result.source}`,
  ].join('\n') + '\n');
}

function main() {
  const { url, json } = parseArgs();
  const result = parseNaverBlogUrl(url);
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  printHuman(result);
}

if (require.main === module) {
  main();
}
