type HealthErrorLike = {
  code?: string;
  message?: string;
  stack?: string;
  name?: string;
};

type HealthCliArgs = {
  outputJson: boolean;
};

type EmitHealthReportOptions = {
  outputJson?: boolean;
  formatText?: ((report: unknown) => string) | null;
};

type RunHealthCliOptions = {
  argv?: string[];
  buildReport: () => Promise<unknown>;
  formatText?: ((report: unknown) => string) | null;
  errorPrefix?: string;
};

function formatHealthError(error: unknown): string {
  if (!error) return 'unknown_error';

  const errorLike = error as HealthErrorLike;
  const code = errorLike.code ? `[${errorLike.code}] ` : '';
  const message = String(errorLike.message || '').trim();
  if (message) return `${code}${message}`;

  const stackLine = String(errorLike.stack || '')
    .split('\n')
    .map((line: string) => line.trim())
    .find((line: string) => line && !line.toLowerCase().startsWith(String(errorLike.name || '').toLowerCase()));
  if (stackLine) return `${code}${stackLine}`;

  if (errorLike.name) return `${code}${errorLike.name}`;
  return `${code}${String(error) || 'unknown_error'}`;
}

function parseHealthArgs(argv: string[] = process.argv): HealthCliArgs {
  return {
    outputJson: Array.isArray(argv) && argv.includes('--json'),
  };
}

function emitHealthReport(
  report: unknown,
  {
    outputJson = false,
    formatText = null,
  }: EmitHealthReportOptions = {},
): void {
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
}: RunHealthCliOptions): Promise<void> {
  const { outputJson } = parseHealthArgs(argv);
  try {
    const report = await buildReport();
    emitHealthReport(report, { outputJson, formatText });
  } catch (error) {
    console.error(`${errorPrefix} 예외: ${formatHealthError(error)}`);
    process.exit(1);
  }
}

export = {
  parseHealthArgs,
  emitHealthReport,
  formatHealthError,
  runHealthCli,
};
