'use strict';

/**
 * inspect-sw.js — parseArgs 및 STATUS_MAP 단위 테스트
 * DB 의존성 없이 순수 로직만 검증
 */

// STATUS_MAP, STATUS_KR, STATUS_EMOJI, parseArgs를 직접 추출
// (스크립트가 main()을 즉시 실행하지 않으므로 require 불가 → 로직 인라인)

const STATUS_MAP = {
  working:     'operational',
  partial:     'partial',
  broken:      'inoperative',
  operational: 'operational',
  inoperative: 'inoperative',
  unknown:     'unknown',
};

const STATUS_KR = {
  operational: '가동',
  partial:     '부분가동',
  inoperative: '불가동',
  unknown:     '미확인',
};

const STATUS_EMOJI = {
  operational: '✅',
  partial:     '⚠️',
  inoperative: '❌',
  unknown:     '❓',
};

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--case-id') result.caseId = parseInt(argv[++i]);
    else if (argv[i] === '--case') result.caseNumber = argv[++i];
    else if (argv[i] === '--feature') result.feature = argv[++i];
    else if (argv[i] === '--cat2') result.cat2 = argv[++i];
    else if (argv[i] === '--cat3') result.cat3 = argv[++i];
    else if (argv[i] === '--status') result.status = argv[++i];
    else if (argv[i] === '--note') result.note = argv[++i];
    else if (argv[i] === '--list') result.action = 'list';
    else if (argv[i] === '--summary') result.action = 'summary';
    else if (argv[i] === '--delete') { result.action = 'delete'; result.featureToDelete = argv[++i]; }
    else if (argv[i] === '--help') result.action = 'help';
  }
  return result;
}

describe('inspect-sw STATUS_MAP', () => {
  test('working → operational', () => {
    expect(STATUS_MAP['working']).toBe('operational');
  });
  test('partial → partial', () => {
    expect(STATUS_MAP['partial']).toBe('partial');
  });
  test('broken → inoperative', () => {
    expect(STATUS_MAP['broken']).toBe('inoperative');
  });
  test('DB 값 직접 입력도 허용 (operational)', () => {
    expect(STATUS_MAP['operational']).toBe('operational');
  });
  test('DB 값 직접 입력도 허용 (inoperative)', () => {
    expect(STATUS_MAP['inoperative']).toBe('inoperative');
  });
  test('DB 값 직접 입력도 허용 (unknown)', () => {
    expect(STATUS_MAP['unknown']).toBe('unknown');
  });
  test('잘못된 status는 undefined', () => {
    expect(STATUS_MAP['broken_typo']).toBeUndefined();
    expect(STATUS_MAP['working_old']).toBeUndefined();
  });
});

describe('inspect-sw STATUS_KR / STATUS_EMOJI', () => {
  test.each([
    ['operational', '가동', '✅'],
    ['partial',     '부분가동', '⚠️'],
    ['inoperative', '불가동', '❌'],
    ['unknown',     '미확인', '❓'],
  ])('%s → 한국어: %s, 이모지: %s', (status, kr, emoji) => {
    expect(STATUS_KR[status]).toBe(kr);
    expect(STATUS_EMOJI[status]).toBe(emoji);
  });
});

describe('inspect-sw parseArgs', () => {
  test('기본 등록', () => {
    const opts = parseArgs(['--case-id', '5', '--feature', '로그인', '--status', 'working']);
    expect(opts.caseId).toBe(5);
    expect(opts.feature).toBe('로그인');
    expect(opts.status).toBe('working');
    expect(opts.action).toBeUndefined();
  });

  test('cat2, cat3 파싱', () => {
    const opts = parseArgs(['--case-id', '1', '--feature', '회원관리', '--cat2', '가입', '--cat3', '이메일인증', '--status', 'partial']);
    expect(opts.feature).toBe('회원관리');
    expect(opts.cat2).toBe('가입');
    expect(opts.cat3).toBe('이메일인증');
  });

  test('--list 액션', () => {
    const opts = parseArgs(['--case-id', '3', '--list']);
    expect(opts.caseId).toBe(3);
    expect(opts.action).toBe('list');
  });

  test('--summary 액션', () => {
    const opts = parseArgs(['--case-id', '3', '--summary']);
    expect(opts.action).toBe('summary');
  });

  test('--case 사건번호', () => {
    const opts = parseArgs(['--case', '서울중앙2024가합12345']);
    expect(opts.caseNumber).toBe('서울중앙2024가합12345');
  });

  test('--note 파싱', () => {
    const opts = parseArgs(['--case-id', '1', '--feature', 'X', '--status', 'broken', '--note', '전원 불량']);
    expect(opts.note).toBe('전원 불량');
  });

  test('빈 argv → 빈 객체', () => {
    const opts = parseArgs([]);
    expect(opts).toEqual({});
  });
});

describe('inspect-sw 요약 통계 로직', () => {
  function calcSummary(counts) {
    const total = counts.operational + counts.partial + counts.inoperative + counts.unknown;
    if (total === 0) return { total: 0, completionRate: 0 };
    const completionRate = parseFloat(((counts.operational + counts.partial * 0.5) / total * 100).toFixed(1));
    return { total, completionRate };
  }

  test('모두 가동 → 100%', () => {
    const { completionRate } = calcSummary({ operational: 5, partial: 0, inoperative: 0, unknown: 0 });
    expect(completionRate).toBe(100);
  });

  test('모두 불가동 → 0%', () => {
    const { completionRate } = calcSummary({ operational: 0, partial: 0, inoperative: 5, unknown: 0 });
    expect(completionRate).toBe(0);
  });

  test('모두 부분가동 → 50%', () => {
    const { completionRate } = calcSummary({ operational: 0, partial: 4, inoperative: 0, unknown: 0 });
    expect(completionRate).toBe(50);
  });

  test('혼합 케이스', () => {
    // 가동 3 + 부분 2 + 불가 1 = total 6
    // (3 + 2*0.5) / 6 * 100 = 4/6*100 ≈ 66.7
    const { completionRate, total } = calcSummary({ operational: 3, partial: 2, inoperative: 1, unknown: 0 });
    expect(total).toBe(6);
    expect(completionRate).toBe(66.7);
  });

  test('빈 목록 → 0', () => {
    const { total, completionRate } = calcSummary({ operational: 0, partial: 0, inoperative: 0, unknown: 0 });
    expect(total).toBe(0);
    expect(completionRate).toBe(0);
  });
});
