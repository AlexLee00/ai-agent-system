const PLAYBOOK_PHASES = ['frame', 'plan', 'review', 'test', 'ship', 'reflect'];

function normalizeText(value, fallback = '') {
  const text = String(value == null ? fallback : value).trim();
  return text || fallback;
}

function getPlaybookPhases() {
  return [...PLAYBOOK_PHASES];
}

function buildPlaybookTemplate(input) {
  const goal = normalizeText(input.goal, '운영 상태 점검 및 조치');
  const team = normalizeText(input.team, 'general').toLowerCase();
  return {
    goal,
    team,
    phases: [
      {
        phase: 'frame',
        objective: '문제를 incident 단위로 재정의하고 범위를 고정한다.',
        checks: [
          'incidentKey가 정의되어 있는가',
          '영향 범위(사용자/돈/데이터/운영)가 명시되었는가',
        ],
      },
      {
        phase: 'plan',
        objective: '최소 리스크 tool sequence를 설계한다.',
        checks: [
          'read-only 점검 step이 먼저 배치되었는가',
          'mutating step에는 idempotency key가 준비되었는가',
        ],
      },
      {
        phase: 'review',
        objective: '권한/중복실행/데이터오염 위험을 검토한다.',
        checks: [
          'unknown tool이 없는가',
          'mutating step이 approval 정책을 위반하지 않는가',
        ],
      },
      {
        phase: 'test',
        objective: 'smoke/health/event evidence로 실행 가능성을 검증한다.',
        checks: [
          '최소 1개 verify step이 정의되었는가',
          'dry-run 결과가 감사 가능한 포맷으로 남는가',
        ],
      },
      {
        phase: 'ship',
        objective: '결과를 실행 또는 승인 큐로 전달한다.',
        checks: [
          'high risk는 승인 게이트로 이동했는가',
          '실행 결과가 audit 카드로 요약되었는가',
        ],
      },
      {
        phase: 'reflect',
        objective: '재발 방지 규칙과 플레이북 개선안을 남긴다.',
        checks: [
          '실패/재시도 원인이 요약되었는가',
          '후속 runbook/task 제안이 생성되었는가',
        ],
      },
    ],
  };
}

module.exports = {
  getPlaybookPhases,
  buildPlaybookTemplate,
};
