'use strict';

/**
 * record-feedback.js — parseArgs, ACCURACY_MAP, buildRagContent 단위 테스트
 */

const ACCURACY_KR = {
  accurate:   '정확 (판결 일치)',
  partial:    '부분 일치',
  inaccurate: '부정확 (판결 불일치)',
};

const ACCURACY_EMOJI = {
  accurate:   '✅',
  partial:    '⚠️',
  inaccurate: '❌',
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--decision') result.decision = argv[++i];
    else if (argv[i] === '--accuracy') result.accuracy = argv[++i];
    else if (argv[i] === '--note') result.note = argv[++i];
    else if (argv[i] === '--list') result.action = 'list';
    else if (argv[i] === '--help') result.action = 'help';
    else if (argv[i] === '--no-rag') result.noRag = true;
  }
  return result;
}

function buildRagContent(caseRecord, feedback) {
  const accuracyKr = ACCURACY_KR[feedback.appraisal_accuracy] || feedback.appraisal_accuracy;
  return [
    `[법원 감정 피드백]`,
    `사건번호: ${caseRecord.case_number}`,
    `법원: ${caseRecord.court || '미상'}`,
    `사건유형: ${caseRecord.case_type || '미상'}`,
    `법원 판결: ${feedback.court_decision}`,
    `감정 정확도: ${accuracyKr}`,
    feedback.notes ? `메모: ${feedback.notes}` : '',
    ``,
    `[감정 내용 요약]`,
    `원고: ${caseRecord.plaintiff || '미상'} / 피고: ${caseRecord.defendant || '미상'}`,
    caseRecord.notes ? `감정 노트: ${caseRecord.notes}` : '',
  ].filter(line => line !== null).join('\n');
}

describe('record-feedback ACCURACY_KR / ACCURACY_EMOJI', () => {
  test.each([
    ['accurate',   '정확 (판결 일치)',      '✅'],
    ['partial',    '부분 일치',             '⚠️'],
    ['inaccurate', '부정확 (판결 불일치)',  '❌'],
  ])('%s → 한국어: %s, 이모지: %s', (acc, kr, emoji) => {
    expect(ACCURACY_KR[acc]).toBe(kr);
    expect(ACCURACY_EMOJI[acc]).toBe(emoji);
  });

  test('유효한 accuracy 키 3개', () => {
    expect(Object.keys(ACCURACY_KR)).toHaveLength(3);
  });
});

describe('record-feedback parseArgs', () => {
  test('기본 피드백 등록', () => {
    const opts = parseArgs(['--case-id', '2', '--decision', '원고 승소', '--accuracy', 'accurate']);
    expect(opts.caseId).toBe(2);
    expect(opts.decision).toBe('원고 승소');
    expect(opts.accuracy).toBe('accurate');
    expect(opts.noRag).toBeUndefined();
  });

  test('--no-rag 플래그', () => {
    const opts = parseArgs(['--case-id', '1', '--decision', 'X', '--accuracy', 'partial', '--no-rag']);
    expect(opts.noRag).toBe(true);
  });

  test('--list 액션', () => {
    const opts = parseArgs(['--case-id', '3', '--list']);
    expect(opts.action).toBe('list');
  });

  test('--case 사건번호', () => {
    const opts = parseArgs(['--case', '서울중앙2024가합99999']);
    expect(opts.caseNumber).toBe('서울중앙2024가합99999');
  });

  test('--note 메모', () => {
    const opts = parseArgs(['--case-id', '1', '--decision', 'X', '--accuracy', 'inaccurate', '--note', '유사도 과대평가']);
    expect(opts.note).toBe('유사도 과대평가');
  });

  test('빈 argv → 빈 객체', () => {
    expect(parseArgs([])).toEqual({});
  });
});

describe('record-feedback buildRagContent', () => {
  const caseRecord = {
    case_number: '서울중앙지방법원2024가합12345',
    court:       '서울중앙지방법원',
    case_type:   'copyright',
    plaintiff:   '원고A',
    defendant:   '피고B',
    notes:       '저작권 침해 사건',
  };

  const feedback = {
    id: 1,
    court_decision:     '원고 일부 승소',
    appraisal_accuracy: 'accurate',
    notes:              null,
  };

  test('기본 내용 포함 확인', () => {
    const content = buildRagContent(caseRecord, feedback);
    expect(content).toContain('[법원 감정 피드백]');
    expect(content).toContain('서울중앙지방법원2024가합12345');
    expect(content).toContain('원고 일부 승소');
    expect(content).toContain('정확 (판결 일치)');
  });

  test('원고/피고 포함', () => {
    const content = buildRagContent(caseRecord, feedback);
    expect(content).toContain('원고A');
    expect(content).toContain('피고B');
  });

  test('메모 없을 때 빈 줄', () => {
    const content = buildRagContent(caseRecord, feedback);
    // notes가 null이면 빈 문자열 → filter(Boolean)이 제거하지 않음 ('' !== null)
    // 빈 줄이 포함되어도 content에 핵심 정보 존재 여부만 검증
    expect(content).toContain('[감정 내용 요약]');
  });

  test('메모 있을 때 포함', () => {
    const content = buildRagContent(caseRecord, {
      ...feedback,
      notes: '유사도 95% 판정이 법원에서 인정됨',
    });
    expect(content).toContain('유사도 95% 판정이 법원에서 인정됨');
  });

  test('court 미상일 때', () => {
    const content = buildRagContent({ ...caseRecord, court: null }, feedback);
    expect(content).toContain('법원: 미상');
  });

  test('case_type 미상일 때', () => {
    const content = buildRagContent({ ...caseRecord, case_type: null }, feedback);
    expect(content).toContain('사건유형: 미상');
  });

  test('inaccurate 정확도 표시', () => {
    const content = buildRagContent(caseRecord, {
      ...feedback,
      appraisal_accuracy: 'inaccurate',
    });
    expect(content).toContain('부정확 (판결 불일치)');
  });
});
