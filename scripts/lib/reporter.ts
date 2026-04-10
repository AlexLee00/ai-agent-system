// @ts-nocheck
/**
 * reporter.js - 콘솔 출력 포맷터
 */

function step(label, msg) {
  console.log(`  ✅ [${label}] ${msg}`);
}

function warn(label, msg) {
  console.log(`  ⚠️  [${label}] ${msg}`);
}

function error(label, msg) {
  console.log(`  ❌ [${label}] ${msg}`);
}

/**
 * @param {Array<{label: string, status: 'ok'|'skip'|'error'|'dry', msg: string}>} results
 */
function summary(results) {
  console.log('\n' + '─'.repeat(50));
  console.log('  📋 실행 요약');
  console.log('─'.repeat(50));
  for (const r of results) {
    const icon = { ok: '✅', skip: '⏭️ ', skipped: '⏭️ ', error: '❌', dry: '🔍' }[r.status] || '  ';
    console.log(`  ${icon} ${r.label.padEnd(20)} ${r.msg}`);
  }
  console.log('─'.repeat(50));
}

module.exports = { step, warn, error, summary };
