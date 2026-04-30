// @ts-nocheck
'use strict';

const TEAMS = [
  { id: 'jay', name: '제이', lead: '제이', status: 'active', priority: 1 },
  { id: 'luna', name: '루나팀', lead: '루나', status: 'active', priority: 2 },
  { id: 'ska', name: '스카팀', lead: '스카', status: 'active', priority: 3 },
  { id: 'claude', name: '클로드팀', lead: '클로드', status: 'active', priority: 4 },
  { id: 'blog', name: '블로팀', lead: '블로', status: 'active', priority: 5 },
  { id: 'darwin', name: '다윈팀', lead: '다윈', status: 'active', priority: 6 },
  { id: 'sigma', name: '시그마팀', lead: '시그마', status: 'active', priority: 7 },
  { id: 'justin', name: '저스틴팀', lead: '저스틴', status: 'active', priority: 8 },
  { id: 'research', name: '연구팀', lead: '(예정)', status: 'planned', priority: 9 },
  { id: 'forensic', name: '감정팀', lead: '(예정)', status: 'planned', priority: 10 },
];

// 팀 키워드 매핑 (태스크 자동 배분용)
const TEAM_KEYWORDS = {
  luna: ['투자', '매매', 'crypto', '트레이딩', '포지션', '수익률', 'DCA'],
  ska: ['예약', '스터디카페', '매출', '좌석'],
  claude: ['모니터링', '헬스체크', '덱스터', '복구', '시스템', '보안'],
  blog: ['블로그', '포스팅', '네이버', '글쓰기', '발행'],
  darwin: ['연구', '논문', 'R&D', '실험', '기술'],
  sigma: ['시그마', '편성', '메타', '품질', '실험설계'],
  justin: ['법률', '계약', '감정', '판례', '저스틴'],
  research: ['연구', 'R&D', '실험', '기술'],
  forensic: ['감정', '법원', '소프트웨어'],
};

// 팀 상태 조회
function getTeamStatus(teamId) {
  const team = TEAMS.find((t) => t.id === teamId);
  if (!team) {
    console.warn(`[skills/team-orchestrator] 알 수 없는 팀: ${teamId}`);
    return null;
  }

  return {
    id: team.id,
    name: team.name,
    healthy: team.status === 'active',
    lastCheck: null, // 실제 헬스체크 연동 시 업데이트
    issues: team.status === 'planned' ? ['아직 구현 전'] : [],
  };
}

// 태스크를 적절한 팀에 배분
function distributeTask(task) {
  const t = task || {};
  const desc = (t.description || '').toLowerCase();
  const taskType = (t.type || '').toLowerCase();

  // relatedTeams가 지정되어 있으면 첫 번째 팀 사용
  if (Array.isArray(t.relatedTeams) && t.relatedTeams.length > 0) {
    const teamId = t.relatedTeams[0];
    const team = TEAMS.find((tm) => tm.id === teamId);
    if (team) {
      return { team: team.id, assignedTo: team.lead, priority: t.urgency || 'MEDIUM' };
    }
  }

  // 키워드 기반 자동 매칭
  for (const [teamId, keywords] of Object.entries(TEAM_KEYWORDS)) {
    const matched = keywords.some((kw) => desc.includes(kw.toLowerCase()) || taskType.includes(kw.toLowerCase()));
    if (matched) {
      const team = TEAMS.find((tm) => tm.id === teamId);
      if (team) {
        return { team: team.id, assignedTo: team.lead, priority: t.urgency || 'MEDIUM' };
      }
    }
  }

  // 매칭 안 되면 제이(총괄)에게
  return { team: 'jay', assignedTo: '제이', priority: t.urgency || 'LOW' };
}

// 태스크 간 의존성 확인
function checkDependencies(tasks) {
  const taskList = Array.isArray(tasks) ? tasks : [];
  const order = [];
  const blocked = [];
  const ready = [];

  for (const task of taskList) {
    if (!task) continue;
    const deps = Array.isArray(task.dependsOn) ? task.dependsOn : [];
    if (deps.length === 0) {
      ready.push(task);
      order.push(task);
    } else {
      const allResolved = deps.every((dep) =>
        taskList.some((t) => t && t.id === dep && t.status === 'done')
      );
      if (allResolved) {
        ready.push(task);
        order.push(task);
      } else {
        blocked.push(task);
      }
    }
  }

  // blocked 태스크는 뒤에 추가
  order.push(...blocked);

  return { order, blocked, ready };
}

// 전체 팀 현황 리포트
function generateTeamReport() {
  const teams = TEAMS.map((t) => ({
    id: t.id,
    name: t.name,
    lead: t.lead,
    status: t.status,
    healthy: t.status === 'active',
  }));

  const activeCount = teams.filter((t) => t.healthy).length;
  const plannedCount = teams.filter((t) => !t.healthy).length;
  const recommendations = [];

  if (plannedCount > 0) {
    recommendations.push(`${plannedCount}개 팀 아직 미구현 (연구팀, 감정팀)`);
  }

  return {
    teams,
    overall: { active: activeCount, planned: plannedCount, total: teams.length },
    recommendations,
  };
}

module.exports = { TEAMS, getTeamStatus, distributeTask, checkDependencies, generateTeamReport };
