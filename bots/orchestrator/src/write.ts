
const { execSync } = require('child_process') as typeof import('node:child_process');

const { publishToWebhook } = require('../../../packages/core/lib/reporting-hub') as {
  publishToWebhook: (payload: { event: { from_bot: string; team: string; event_type: string; alert_level: number; message: string } }) => Promise<{ ok?: boolean }>;
};
const kst = require('../../../packages/core/lib/kst') as { datetimeStr: () => string };
const env = require('../../../packages/core/lib/env') as { PROJECT_ROOT: string };
const aggregator = require('../lib/write/report-aggregator') as {
  collectAll: () => Promise<any>;
  formatDailyReport: (collected: any) => string;
};
const docSyncChecker = require('../lib/write/doc-sync-checker') as {
  checkAll: (changedFiles: string[]) => SyncIssue[];
  findUntrackedFiles: (changedFiles: string[]) => string[];
};
const changelogWriter = require('../lib/write/changelog-writer') as {
  generateEntry: (range: string) => any;
  formatChangelogEntry: (entry: any) => string;
};
const docArchiver = require('../lib/write/doc-archiver') as {
  scanCompletedCodex: () => ArchiveItem[];
  archiveCompletedCodex: (completed: ArchiveItem[]) => ArchiveResult;
  updateTracker: (files: string[]) => TrackerResult;
  scanStaleRootDocs: () => StaleDoc[];
};
const { generateGemmaPilotText } = require('../../../packages/core/lib/gemma-pilot') as {
  generateGemmaPilotText: (payload: Record<string, any>) => Promise<{ ok?: boolean; content?: string }>;
};

type WriteOptions = {
  mode?: string;
  test?: boolean;
};

type SyncIssue = {
  file: string;
  doc: string;
  issue: string;
  suggestion: string;
};

type ArchiveItem = {
  file: string;
  reason?: string;
};

type ArchiveResult = {
  moved?: string[];
  commitHash?: string | null;
};

type TrackerResult = {
  added?: string[];
  commitHash?: string | null;
};

type StaleDoc = {
  file: string;
  refCount: number;
};

const ROOT = env.PROJECT_ROOT;

function parseArgs(argv: string[] = process.argv.slice(2)): WriteOptions {
  const modeArg = argv.find((arg) => arg.startsWith('--mode='));
  return {
    mode: modeArg ? modeArg.split('=')[1] : 'push',
    test: argv.includes('--test'),
  };
}

function safeExec(command: string): string {
  try {
    return execSync(command, {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[write] 명령 실행 실패: ${message}`);
    return '';
  }
}

function getChangedFiles(): string[] {
  const output = safeExec('git diff --name-only HEAD~1');
  if (!output) return [];
  return output.split('\n').map((line) => line.trim()).filter(Boolean);
}

function formatPushReport(syncIssues: SyncIssue[], changelogEntry: any, archiveResult: ArchiveResult = {}, trackerResult: TrackerResult = {}): string {
  const lines = ['📝 라이트 문서 점검 제안', `- 점검 시각: ${kst.datetimeStr()}`];
  lines.push('');
  lines.push(`- 문서 이슈: ${syncIssues.length}건`);
  if (syncIssues.length > 0) {
    syncIssues.slice(0, 10).forEach((item) => {
      lines.push(`  · ${item.file} -> ${item.doc} | ${item.issue}`);
      lines.push(`    제안: ${item.suggestion}`);
    });
  } else {
    lines.push('  · 문서 불일치 없음');
  }

  lines.push('');
  lines.push(`- 자동 아카이빙: ${(archiveResult.moved || []).length}건`);
  if ((archiveResult.moved || []).length > 0) {
    (archiveResult.moved || []).forEach((file) => lines.push(`  · archive 이동: ${file}`));
    if (archiveResult.commitHash) lines.push(`  · commit: ${archiveResult.commitHash}`);
  }
  lines.push(`- TRACKER 자동 갱신: ${(trackerResult.added || []).length}건`);
  if ((trackerResult.added || []).length > 0) {
    (trackerResult.added || []).forEach((file) => lines.push(`  · TRACKER 추가: ${file}`));
    if (trackerResult.commitHash) lines.push(`  · commit: ${trackerResult.commitHash}`);
  }

  lines.push('');
  lines.push('CHANGELOG 초안:');
  lines.push(changelogWriter.formatChangelogEntry(changelogEntry).slice(0, 1800));
  return lines.join('\n');
}

export async function runOnPush(options: WriteOptions = {}): Promise<Record<string, any>> {
  const changedFiles = getChangedFiles();
  const syncIssues = docSyncChecker.checkAll(changedFiles);
  const changelogEntry = changelogWriter.generateEntry('1 day ago');
  const completed = docArchiver.scanCompletedCodex();
  const untrackedFiles = docSyncChecker.findUntrackedFiles(changedFiles);
  const archiveResult = options.test ? { moved: completed.map((item) => item.file), commitHash: null } : docArchiver.archiveCompletedCodex(completed);
  const trackerResult = options.test ? { added: untrackedFiles.slice(0, 5), commitHash: null } : docArchiver.updateTracker(untrackedFiles);
  const message = formatPushReport(syncIssues, changelogEntry, archiveResult, trackerResult);
  const sent = options.test ? false : Boolean((await publishToWebhook({
    event: {
      from_bot: 'write',
      team: 'general',
      event_type: 'write_on_push_report',
      alert_level: 2,
      message,
    },
  })).ok);
  return { changedFiles, syncIssues, changelogEntry, archiveResult, trackerResult, sent, message };
}

export async function runDaily(options: WriteOptions = {}): Promise<Record<string, any>> {
  const collected = await aggregator.collectAll();
  const report = aggregator.formatDailyReport(collected);
  const commits = changelogWriter.generateEntry('yesterday');
  const messageLines = [
    report,
    '',
    '전일 커밋 요약:',
    changelogWriter.formatChangelogEntry(commits).slice(0, 1200),
  ];

  if (new Date().getDay() === 0) {
    const codexStatus = docArchiver.scanCompletedCodex();
    const staleDocs = docArchiver.scanStaleRootDocs();
    messageLines.push('', '주간 문서 정리 리포트:');
    messageLines.push(`- 완료 코덱스 프롬프트: ${codexStatus.length}건`);
    codexStatus.slice(0, 10).forEach((item) => {
      messageLines.push(`  · ${item.file} (${item.reason})`);
    });
    messageLines.push(`- 루트 문서 아카이브 후보: ${staleDocs.length}건`);
    staleDocs.slice(0, 10).forEach((item) => {
      messageLines.push(`  · ${item.file} (참조 ${item.refCount}회)`);
    });
  }

  try {
    const insightPrompt = `당신은 팀 제이의 일일 리포트 분석가입니다.
아래 데이터를 보고 "오늘의 핵심 인사이트"를 한국어 1~3줄로 간결하게 작성하세요.
숫자 나열보다 패턴, 주의사항, 추천을 중심으로 적으세요.

데이터:
${JSON.stringify(collected, null, 2).slice(0, 2000)}`;

    const insight = await generateGemmaPilotText({
      team: 'orchestrator',
      purpose: 'gemma-insight',
      bot: 'write',
      requestType: 'daily-insight',
      prompt: insightPrompt,
      maxTokens: 300,
      temperature: 0.7,
      timeoutMs: 10000,
    });

    if (insight?.ok && insight.content) {
      messageLines.push('', '🔍 AI 인사이트 (gemma4):', insight.content.trim());
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[write] gemma4 인사이트 생략: ${message}`);
  }

  const message = messageLines.join('\n');
  const sent = options.test ? false : Boolean((await publishToWebhook({
    event: {
      from_bot: 'write',
      team: 'general',
      event_type: 'write_daily_report',
      alert_level: 2,
      message,
    },
  })).ok);
  return { collected, sent, message };
}

if (require.main === module) {
  const options = parseArgs();
  const runner = options.mode === 'daily' ? runDaily : runOnPush;
  runner(options)
    .then((result) => {
      console.log(result.message);
      process.exit(0);
    })
    .catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[write] 실행 실패: ${message}`);
      process.exit(0);
    });
}
