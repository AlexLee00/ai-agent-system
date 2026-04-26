import fs from 'node:fs';
import path from 'node:path';
import { publishToWebhook } from './reporting-hub';

const PROTECTED_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs',
  '.ts', '.tsx', '.jsx',
  '.py',
  '.sh', '.bash', '.zsh',
]);

const BLOCKED_FILENAMES = new Set([
  'package.json',
  'package-lock.json',
  'CLAUDE.md',
  '.env',
  'config.yaml',
  'config.yml',
  'secrets.json',
]);

const DEXTER_ALLOWED_PATTERNS = [
  /\.checksums\.json$/,
  /dexter-state\.json$/,
  /dexter-mode\.json$/,
  /\.lock$/,
];

const RETIRED_WORKSPACE_DIR_PATTERN = new RegExp(`[/\\\\]\\.open${'claw'}[/\\\\]`);

const ALLOWED_WRITE_PATTERNS = [
  /\.log$/i,
  /\.html$/i,
  /\.txt$/i,
  /\.csv$/i,
  /\.png$/i, /\.jpg$/i, /\.jpeg$/i, /\.webp$/i, /\.gif$/i,
  /\.pdf$/i,
  RETIRED_WORKSPACE_DIR_PATTERN,
  /[/\\]workspace[/\\]/,
  /[/\\]tmp[/\\]/,
  /[/\\]output[/\\]/,
  /[/\\]cache[/\\]/,
  /[/\\]logs?[/\\]/,
  /dexter-fixes\.json$/,
  /dexter-issues\.json$/,
  /screening-monitor-state\.json$/,
  /prescreened\.json$/,
  /insta-meta\.json$/,
  /naver-bookings.*\.json$/,
  /health-check-state\.json$/,
];

function canWrite(filePath: string, callerBot = 'unknown'): boolean {
  const normalized = filePath.replace(/\\/g, '/');
  const ext = path.extname(filePath).toLowerCase();
  const basename = path.basename(filePath);

  if (callerBot === 'dexter') {
    for (const pattern of DEXTER_ALLOWED_PATTERNS) {
      if (pattern.test(normalized)) return true;
    }
  }

  if (BLOCKED_FILENAMES.has(basename)) {
    warn(callerBot, filePath, `명시적 금지 파일 (${basename})`);
    return false;
  }

  for (const pattern of ALLOWED_WRITE_PATTERNS) {
    if (pattern.test(normalized)) return true;
  }

  if (PROTECTED_EXTENSIONS.has(ext)) {
    warn(callerBot, filePath, `보호 확장자 (${ext})`);
    return false;
  }

  return true;
}

function warn(callerBot: string, filePath: string, reason: string): void {
  console.error(`🚨 [file-guard] ${callerBot} → ${filePath} 쓰기 차단 (${reason})`);
}

async function notifyBlockedWrite(callerBot: string, filePath: string): Promise<void> {
  await publishToWebhook({
    event: {
      from_bot: 'file-guard',
      team: 'general',
      event_type: 'blocked_write',
      alert_level: 4,
      message: `🚨 [보안] 소스코드 수정 시도 차단!\n봇: ${callerBot}\n파일: ${filePath}\n→ 마스터 확인 필요`,
      payload: {
        title: '소스코드 수정 시도 차단',
        summary: `${callerBot} → ${filePath}`,
        details: [
          `bot: ${callerBot}`,
          `file: ${filePath}`,
        ],
      },
    },
  });
}

function safeWriteFile(
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  callerBot = 'unknown',
  encoding: BufferEncoding = 'utf8',
): void {
  if (!canWrite(filePath, callerBot)) {
    notifyBlockedWrite(callerBot, filePath).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[file-guard] 보안 알람 발송 실패: ${message}`);
    });

    throw new Error(`[file-guard] ${callerBot}의 소스코드 수정 시도 차단: ${filePath}`);
  }

  fs.writeFileSync(filePath, content, encoding);
}

async function safeWriteFileAsync(
  filePath: string,
  content: string | NodeJS.ArrayBufferView,
  callerBot = 'unknown',
  encoding: BufferEncoding = 'utf8',
): Promise<void> {
  if (!canWrite(filePath, callerBot)) {
    try {
      await notifyBlockedWrite(callerBot, filePath);
    } catch {
      // ignore alarm failure
    }

    throw new Error(`[file-guard] ${callerBot}의 소스코드 수정 시도 차단: ${filePath}`);
  }

  await fs.promises.writeFile(filePath, content, encoding);
}

export = {
  canWrite,
  safeWriteFile,
  safeWriteFileAsync,
  PROTECTED_EXTENSIONS,
  BLOCKED_FILENAMES,
  ALLOWED_WRITE_PATTERNS,
  DEXTER_ALLOWED_PATTERNS,
};
