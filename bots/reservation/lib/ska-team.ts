import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFileSync } from 'child_process';
const { safeWriteFile } = require('../../../packages/core/lib/file-guard');

export interface SkaTeamMember {
  id: string;
  name: string;
  launchd: string | null;
  team: string;
  role: string;
  mission: string;
  continuous?: boolean;
}

export const BOT_ID_DIR = path.join(os.homedir(), '.openclaw', 'workspace', 'bot-identities');

export const SKA_TEAM: SkaTeamMember[] = [
  {
    id: 'andy', name: '앤디', launchd: 'ai.ska.naver-monitor',
    team: '스카팀',
    role: '네이버 스마트플레이스 모니터링',
    mission: '5분마다 예약 현황 수집 및 이상 감지 알람 발송',
    continuous: true,
  },
  {
    id: 'jimmy', name: '지미', launchd: 'ai.ska.kiosk-monitor',
    team: '스카팀',
    role: '픽코 키오스크 예약 모니터링',
    mission: '키오스크 신규 예약 감지 및 알람 발송',
    continuous: false,
  },
  {
    id: 'rebecca', name: '레베카', launchd: null,
    team: '스카팀',
    role: '매출 예측 분석',
    mission: '과거 데이터 기반 매출·입장수 예측 모델 실행',
  },
  {
    id: 'eve', name: '이브', launchd: null,
    team: '스카팀',
    role: '공공API 환경요소 수집',
    mission: '공휴일·날씨·학사·축제 데이터 수집 및 저장',
  },
];

export function inspectLaunchdService(label: string) {
  try {
    const service = `gui/${process.getuid()}/${label}`;
    const output = execFileSync('launchctl', ['print', service], {
      encoding: 'utf8',
      timeout: 5000,
    });
    const stateMatch = output.match(/^\s*state = ([^\n]+)$/m);
    const exitMatch = output.match(/^\s*last exit code = ([^\n]+)$/m);
    const pidMatch = output.match(/^\s*pid = ([^\n]+)$/m);
    return {
      ok: true,
      state: stateMatch?.[1]?.trim() || 'unknown',
      lastExitCode: exitMatch?.[1]?.trim() || '',
      pid: pidMatch?.[1]?.trim() || '',
    };
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  }
}

export function checkSkaTeamIdentity() {
  if (!fs.existsSync(BOT_ID_DIR)) fs.mkdirSync(BOT_ID_DIR, { recursive: true });

  const results = [];
  for (const member of SKA_TEAM) {
    const issues: string[] = [];
    let trained = false;

    if (member.launchd) {
      const inspected = inspectLaunchdService(member.launchd);
      if (!inspected.ok) {
        issues.push('프로세스 상태 확인 실패');
      } else if (member.continuous && inspected.state !== 'running') {
        const exitInfo = inspected.lastExitCode ? ` (exit=${inspected.lastExitCode})` : '';
        issues.push(`프로세스 비실행${exitInfo}`);
      } else if (!member.continuous && inspected.lastExitCode && !['0', '-9', '-15', '(never)'].includes(inspected.lastExitCode)) {
        issues.push(`최근 실행 비정상 종료 (exit=${inspected.lastExitCode})`);
      }
    }

    const idFile = path.join(BOT_ID_DIR, `${member.id}.json`);
    if (!fs.existsSync(idFile)) {
      safeWriteFile(idFile, JSON.stringify({
        name: member.name,
        team: member.team,
        role: member.role,
        mission: member.mission,
        launchd: member.launchd,
        updated_at: new Date().toISOString(),
      }, null, 2), 'ska');
      trained = true;
      issues.push('→ 정체성 파일 생성');
    } else {
      const data = JSON.parse(fs.readFileSync(idFile, 'utf8')) as Record<string, unknown>;
      const ageMs = Date.now() - new Date(String(data.updated_at || 0)).getTime();
      const missing = ['name', 'role', 'mission'].filter((field) => !data[field]);
      if (missing.length > 0 || ageMs > 30 * 24 * 3600 * 1000) {
        if (missing.length > 0) issues.push(`누락 필드: ${missing.join(', ')}`);
        Object.assign(data, {
          name: member.name,
          team: member.team,
          role: member.role,
          mission: member.mission,
          updated_at: new Date().toISOString(),
        });
        safeWriteFile(idFile, JSON.stringify(data, null, 2), 'ska');
        trained = true;
        issues.push('→ 정체성 갱신');
      }
    }

    results.push({ name: member.name, issues, trained });
  }

  const problems = results.filter((result) => result.issues.some((issue) => !issue.startsWith('→')));
  if (problems.length > 0) {
    console.log(`[스카] 팀원 정체성 점검: ${problems.length}건 이슈`);
    for (const result of problems) {
      console.log(`  ${result.name}: ${result.issues.filter((issue) => !issue.startsWith('→')).join(' | ')}`);
    }
  } else {
    console.log('[스카] 팀원 정체성 점검: 정상');
  }
  return results;
}
