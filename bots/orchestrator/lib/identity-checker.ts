'use strict';

const kst = require('../../../packages/core/lib/kst') as {
  today: () => string;
};
const fs = require('fs') as typeof import('node:fs');
const path = require('path') as typeof import('node:path');
const os = require('os') as typeof import('node:os');
const { execSync } = require('child_process') as typeof import('node:child_process');

const PROJECT_ROOT = path.join(os.homedir(), 'projects', 'ai-agent-system');
const TODAY = (): string => kst.today();

type CommanderCheckResult = {
  id: string;
  name: string;
  running: boolean;
  issues: string[];
  trained: boolean;
};

type CommanderRegistryItem = {
  id: 'ska' | 'luna' | 'claude';
  name: string;
  launchd: string;
  identity: string;
};

function isProcessRunning(launchdId: string): boolean {
  try {
    const out = execSync(`launchctl list ${launchdId} 2>&1`, {
      encoding: 'utf8',
      timeout: 5000,
    });
    return !out.includes('Could not find');
  } catch {
    return false;
  }
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

const REQUIRED_SECTIONS = ['## 역할', '## 임무', '## 팀원', '## 지원 명령'];

const TEMPLATES: Record<CommanderRegistryItem['id'], () => string> = {
  ska: () => `# 스카 커맨더 — 스카팀 팀장

> 최종 업데이트: ${TODAY()}

## 역할
스카팀 팀장. 제이(Jay)의 bot_commands 명령을 받아 스카팀 봇들을 지휘하고 결과를 반환한다.

## 임무
- bot_commands 테이블 폴링 (30초 간격)
- 스카팀 봇 상태 모니터링 및 재시작 처리
- 예약 조회·매출 통계·알람 조회 명령 처리
- 팀원 정체성·역할·임무 주기적 점검 및 학습 (6시간 주기)

## 팀원

| 봇 | 역할 | launchd |
|----|------|---------|
| 앤디 | 네이버 스마트플레이스 모니터링 | ai.ska.naver-monitor |
| 지미 | 픽코 키오스크 예약 모니터링 | ai.ska.kiosk-monitor |
| 레베카 | 매출 예측 분석 | — |
| 이브 | 공공API 환경요소 수집 | — |

## 지원 명령

| command | 설명 |
|---------|------|
| query_reservations | 오늘 예약 현황 조회 |
| query_today_stats  | 오늘 매출·입장 통계 |
| query_alerts       | 미해결 알람 목록 |
| restart_andy       | 앤디 재시작 |
| restart_jimmy      | 지미 재시작 |
`,
  luna: () => `# 루나 커맨더 — 루나팀 팀장

> 최종 업데이트: ${TODAY()}

## 역할
루나팀 팀장. 제이(Jay)의 bot_commands 명령을 받아 루나팀 자동매매 시스템을 지휘하고 결과를 반환한다.

## 임무
- bot_commands 테이블 폴링 (30초 간격)
- 바이낸스 암호화폐 자동매매 시스템 제어 (Phase 3-A OPS)
- 거래 정지·재개·리포트·상태 명령 처리
- 팀원 정체성·역할·임무 주기적 점검 및 학습 (6시간 주기)

## 팀원

| 봇 | 역할 | LLM |
|----|------|-----|
| 루나 | 최종 매수/매도 판단 | gpt-4o |
| 오라클 | 온체인·파생 데이터 분석 | gpt-4o |
| 네메시스 | 리스크 평가 APPROVE/ADJUST/REJECT | gpt-4o |
| 아테나 | 매도 관점 근거·손절가 제시 | gpt-4o |
| 제우스 | 매수 관점 근거·목표가 제시 | gpt-4o |
| 헤르메스 | 뉴스 수집·감성 분류 | Groq |
| 소피아 | 커뮤니티 감성 분석 | Groq |
| 아르고스 | Reddit 전략 추천 수집 | Groq |
| 헤파이스토스 | 자동화·주문 실행 | — |
| 한울 | 국내 주식 담당 | Groq |

## 지원 명령

| command | 설명 |
|---------|------|
| pause_trading  | 거래 일시정지 |
| resume_trading | 거래 재개 |
| force_report   | 투자 리포트 즉시 발송 |
| get_status     | 현재 상태·잔고 조회 |
`,
  claude: () => `# 클로드 커맨더 — 클로드팀 팀장

> 최종 업데이트: ${TODAY()}

## 역할
클로드팀 팀장. 제이(Jay)의 bot_commands 명령을 받아 시스템 점검·기술 분석·AI 직접 소통 작업을 지휘하고 결과를 반환한다.

## 임무
- bot_commands 테이블 폴링 (30초 간격)
- 덱스터 점검 명령 처리 (run_check, run_full, run_fix, daily_report)
- 아처 기술 트렌드 분석 명령 처리 (run_archer)
- 클로드 AI 직접 질문 처리 (ask_claude)
- 미인식 명령 분석·NLP 자동 개선 (analyze_unknown)
- 팀원 정체성·역할·임무 주기적 점검 및 학습 (6시간 주기)

## 팀원

| 봇 | 역할 | 실행 주기 |
|----|------|----------|
| 덱스터 | 시스템 점검 (코드·보안·DB) | 1시간 (launchd) |
| 아처 | 기술 인텔리전스 수집·분석 | 매주 월요일 09:00 KST |
| 에릭 | Explore 에이전트 | 수동 |
| 케빈 | Plan 에이전트 | 수동 |
| 브라이언 | Bash 에이전트 | 수동 |

## 지원 명령

| command | 설명 |
|---------|------|
| run_check       | 덱스터 기본 점검 |
| run_full        | 덱스터 전체 점검 (npm audit) |
| run_fix         | 덱스터 자동 수정 |
| daily_report    | 덱스터 일일 보고 |
| run_archer      | 아처 기술 트렌드 수집·분석 |
| ask_claude      | 클로드 AI 직접 질문 |
| analyze_unknown | 미인식 명령 분석·NLP 개선 |
`,
};

const COMMANDER_REGISTRY: CommanderRegistryItem[] = [
  {
    id: 'ska',
    name: '스카 커맨더',
    launchd: 'ai.ska.commander',
    identity: path.join(PROJECT_ROOT, 'bots/reservation/context/COMMANDER_IDENTITY.md'),
  },
  {
    id: 'luna',
    name: '루나 커맨더',
    launchd: 'ai.investment.commander',
    identity: path.join(PROJECT_ROOT, 'bots/investment/context/COMMANDER_IDENTITY.md'),
  },
  {
    id: 'claude',
    name: '클로드 커맨더',
    launchd: 'ai.claude.commander',
    identity: path.join(PROJECT_ROOT, 'bots/claude/context/COMMANDER_IDENTITY.md'),
  },
];

function checkAndTrain(commander: CommanderRegistryItem): CommanderCheckResult {
  const result: CommanderCheckResult = {
    id: commander.id,
    name: commander.name,
    running: false,
    issues: [],
    trained: false,
  };

  result.running = isProcessRunning(commander.launchd);
  if (!result.running) {
    result.issues.push(`프로세스 미실행 (${commander.launchd})`);
  }

  let needsWrite = false;
  if (!fs.existsSync(commander.identity)) {
    result.issues.push('COMMANDER_IDENTITY.md 없음');
    needsWrite = true;
  } else {
    const content = fs.readFileSync(commander.identity, 'utf8');
    const missing = REQUIRED_SECTIONS.filter((section) => !content.includes(section));
    if (missing.length > 0) {
      result.issues.push(`필수 섹션 누락: ${missing.join(', ')}`);
      needsWrite = true;
    }
  }

  if (needsWrite && TEMPLATES[commander.id]) {
    ensureDir(path.dirname(commander.identity));
    fs.writeFileSync(commander.identity, TEMPLATES[commander.id]());
    result.trained = true;
    result.issues.push('→ COMMANDER_IDENTITY.md 자동 복원 완료');
  }

  return result;
}

function runCommanderIdentityCheck(): CommanderCheckResult[] {
  const results: CommanderCheckResult[] = [];
  for (const commander of COMMANDER_REGISTRY) {
    try {
      results.push(checkAndTrain(commander));
    } catch (error) {
      results.push({
        id: commander.id,
        name: commander.name,
        running: false,
        issues: [`체크 오류: ${(error as Error).message}`],
        trained: false,
      });
    }
  }
  return results;
}

function buildIdentityReport(results: CommanderCheckResult[]): string | null {
  const hasIssues = results.some(
    (result) => !result.running || result.issues.filter((issue) => !issue.startsWith('→')).length > 0
  );
  if (!hasIssues) {
    return null;
  }

  const lines = ['🔍 팀장 정체성 점검 결과'];
  for (const result of results) {
    const realIssues = result.issues.filter((issue) => !issue.startsWith('→'));
    const icon = !result.running || realIssues.length > 0 ? '🔴' : '✅';
    if (realIssues.length === 0 && result.running) {
      lines.push(`✅ ${result.name}: 정상`);
    } else {
      lines.push(`${icon} ${result.name}:`);
      for (const issue of result.issues) {
        lines.push(`  • ${issue}`);
      }
    }
  }

  const trained = results.filter((result) => result.trained).map((result) => result.name);
  if (trained.length > 0) {
    lines.push(`\n📚 자동 학습 완료: ${trained.join(', ')}`);
  }

  return lines.join('\n');
}

module.exports = { buildIdentityReport, runCommanderIdentityCheck };
