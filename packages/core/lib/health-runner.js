'use strict';

function formatHealthError(error) {
  if (!error) return 'unknown_error';

  const code = error.code ? `[${error.code}] ` : '';
  const message = String(error.message || '').trim();
  if (message) return `${code}${message}`;

  const stackLine = String(error.stack || '')
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line && !line.toLowerCase().startsWith(String(error.name || '').toLowerCase()));
  if (stackLine) return `${code}${stackLine}`;

  if (error.name) return `${code}${error.name}`;
  return `${code}${String(error) || 'unknown_error'}`;
}

function parseHealthArgs(argv = process.argv) {
  return {
    outputJson: Array.isArray(argv) && argv.includes('--json'),
  };
}

function emitHealthReport(report, {
  outputJson = false,
  formatText = null,
} = {}) {
  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  const text = typeof formatText === 'function' ? formatText(report) : String(report || '');
  console.log(text);
}

async function runHealthCli({
  argv = process.argv,
  buildReport,
  formatText,
  errorPrefix = '[health-report]',
} = {}) {
  const { outputJson } = parseHealthArgs(argv);
  try {
    const report = await buildReport();
    emitHealthReport(report, { outputJson, formatText });
  } catch (error) {
    console.error(`${errorPrefix} 예외: ${formatHealthError(error)}`);
    process.exit(1);
  }
}

module.exports = {
  parseHealthArgs,
  emitHealthReport,
  formatHealthError,
  runHealthCli,
};
