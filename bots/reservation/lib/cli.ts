export interface CliResult {
  success?: boolean;
  message?: string;
  [key: string]: unknown;
}

export function outputResult(result: CliResult): void {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

export function fail(message: string, extra: Record<string, unknown> = {}): never {
  outputResult({ success: false, message, ...extra });
  process.exit(1);
}
