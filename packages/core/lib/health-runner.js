'use strict';

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
    console.error(`${errorPrefix} 예외: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  parseHealthArgs,
  emitHealthReport,
  runHealthCli,
};
