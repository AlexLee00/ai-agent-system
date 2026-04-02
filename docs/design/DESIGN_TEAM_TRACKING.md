# DB 아키텍처 전환 설계 — 에이전트 추적 → 팀 성과 추적

> 작성: 메티 (Claude Opus 4.6) + 마스터 (Jay)
> 작성일: 2026-04-02
> 상태: 설계 단계
> 우선순위: Phase B (시딩 완료 후 다음)

---

## 1. 문제 정의

```
현재 (에이전트 하드코딩):
  trade_journal_results:
    aria_signal VARCHAR, sophia_signal VARCHAR,
    oracle_signal VARCHAR, hermes_signal VARCHAR
    aria_accurate BOOLEAN, sophia_accurate BOOLEAN, ...

  analyst-accuracy.js:
    ANALYSTS = [
      { name: 'aria',   column: 'aria_accurate',   weight: 0.30 },
      { name: 'sophia', column: 'sophia_accurate', weight: 0.25 },
      { name: 'oracle', column: 'oracle_accurate', weight: 0.30 },
      { name: 'hermes', column: 'hermes_accurate', weight: 0.15 },
    ]

문제:
  ① 에이전트 추가/삭제 시 ALTER TABLE + 코드 수정 필요
  ② deprecated 에이전트 컬럼이 영원히 잔존 (sophia, hermes)
  ③ 20에이전트 루나팀 → 컬럼 40개? 불가능!
  ④ 팀 성과 집계 불가 (개별 컬럼 합산 필요)
  ⑤ 고용 조합에 따른 전략 비교 불가
  ⑥ 동적 고용 모델과 근본적 충돌
```

---

## 2. 목표 아키텍처

```
핵심 전환:
  에이전트 이름 컬럼 → JSONB 동적 구조 + agent.traces 연동

신규 (팀 성과 추적):
  trade_journal_results:
    analyst_signals JSONB     ← {"echo": "BUY", "hera": "HOLD", "funder": "BUY"}
    analyst_accuracy JSONB    ← {"echo": true, "hera": false, "funder": true}
    strategy_config JSONB     ← {"short": "echo", "long": "hera", "risk": "nemesis"}
    team_score NUMERIC(4,2)   ← 팀 전체 성과 점수

  → 에이전트 추가해도 ALTER TABLE 불필요!
  → 어떤 조합이든 JSONB에 자유롭게 저장!
  → 팀 성과 = strategy_config별 집계!
```


---

## 3. DB 마이그레이션 설계

### 3-1. 기존 테이블에 JSONB 컬럼 추가 (비파괴적)

```sql
-- Phase B-1: JSONB 컬럼 추가 (기존 컬럼 유지, 병행 운영)
ALTER TABLE investment.trade_journal_results
  ADD COLUMN IF NOT EXISTS analyst_signals JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS analyst_accuracy JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS strategy_config JSONB DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS team_score NUMERIC(4,2);

-- 기존 데이터 마이그레이션 (기존 컬럼 → JSONB)
UPDATE investment.trade_journal_results SET
  analyst_signals = jsonb_build_object(
    'aria', aria_signal,
    'oracle', oracle_signal,
    'sentinel', COALESCE(hermes_signal, sophia_signal)
  ),
  analyst_accuracy = jsonb_build_object(
    'aria', aria_accurate,
    'oracle', oracle_accurate,
    'sentinel', COALESCE(hermes_accurate, sophia_accurate)
  )
WHERE analyst_signals = '{}';
```

### 3-2. 하드코딩 제거 대상 (5곳)

```
① analyst-accuracy.js — 완전 재작성
  BEFORE: ANALYSTS = [{ name: 'aria', column: 'aria_accurate' }, ...]
  AFTER:  Registry에서 동적 로드 + JSONB 쿼리

② trade-journal-db.js — JSONB 사용으로 전환
  BEFORE: aria_signal, hermes_signal (개별 컬럼)
  AFTER:  analyst_signals JSONB (동적)

③ billing-guard.js — team 기반 매핑
  BEFORE: hermes → 'investment' (에이전트 이름)
  AFTER:  team === 'luna' → 'investment' (팀 기반)

④ llm-model-selector.js — Registry 기반 동적 로드
  BEFORE: hermes → 'groq_scout' (하드코딩)
  AFTER:  agent.registry.llm_model 참조

⑤ nodes/ 파이프라인 — 팀+역할 기반 동적 로드
  BEFORE: import { analyzeNews } from '../team/hermes.js'
  AFTER:  팀장(루나)이 고용 계약으로 에이전트 선택 → 동적 호출
```

---

## 4. 팀 성과 추적 쿼리 예시

```sql
-- 전략 조합별 승률 (핵심!)
SELECT
  strategy_config->>'short' AS short_analyst,
  strategy_config->>'long' AS long_analyst,
  strategy_config->>'risk' AS risk_manager,
  count(*) AS trades,
  ROUND(AVG(CASE WHEN team_score >= 7 THEN 1 ELSE 0 END)::numeric, 2) AS win_rate,
  ROUND(AVG(team_score)::numeric, 2) AS avg_score
FROM investment.trade_journal_results
WHERE strategy_config != '{}'
GROUP BY 1, 2, 3
ORDER BY win_rate DESC;

-- 결과 예시:
-- short  | long   | risk     | trades | win_rate | avg_score
-- echo   | hera   | nemesis  | 15     | 0.73     | 7.82
-- aria   | oracle | aegis    | 12     | 0.67     | 7.15
-- aria   | hera   | nemesis  | 8      | 0.63     | 6.90

-- 에이전트별 기여도 (JSONB에서 동적 추출)
SELECT
  agent_name,
  count(*) AS participated,
  ROUND(AVG(CASE WHEN (analyst_accuracy->>agent_name)::boolean THEN 1 ELSE 0 END)::numeric, 2) AS accuracy
FROM investment.trade_journal_results,
  LATERAL jsonb_object_keys(analyst_signals) AS agent_name
WHERE analyst_signals != '{}'
GROUP BY agent_name
ORDER BY accuracy DESC;

-- 팀 전체 성과 트렌드
SELECT
  date_trunc('week', created_at) AS week,
  count(*) AS total_trades,
  ROUND(AVG(team_score)::numeric, 2) AS avg_score,
  count(*) FILTER (WHERE team_score >= 7) AS wins
FROM investment.trade_journal_results
GROUP BY week ORDER BY week DESC;
```

---

## 5. analyst-accuracy.js 재설계

```js
// 현재 (하드코딩):
const ANALYSTS = [
  { name: 'aria', column: 'aria_accurate', weight: 0.30 },
  // ... 고정 4명
];

// 전환 후 (Registry 동적):
const { getAgentsByTeam } = require('./agent-registry');

async function getActiveAnalysts() {
  const lunaAgents = await getAgentsByTeam('luna');
  return lunaAgents
    .filter(a => a.role === 'analyst' && a.status !== 'archived')
    .map(a => ({
      name: a.name,
      specialty: a.specialty,
      weight: 1 / lunaAgents.length,  // 균등 배분 초기값
    }));
}

async function getAccuracy(tradeId) {
  const row = await pgPool.get('investment',
    'SELECT analyst_accuracy FROM trade_journal_results WHERE id = $1',
    [tradeId]);
  return row?.analyst_accuracy || {};
  // → { "echo": true, "hera": false, "funder": true }
}
```

---

## 6. 구현 순서

```
Phase B-1: 비파괴적 JSONB 추가 (안전)
  → trade_journal_results에 JSONB 컬럼 4개 추가
  → 기존 컬럼 유지 (병행 운영)
  → 기존 데이터 마이그레이션 (기존 → JSONB 복사)
  → 기존 코드 정상 동작 유지!

Phase B-2: 새 코드에서 JSONB 사용
  → 새 트레이드부터 JSONB에 기록
  → analyst-accuracy.js에 JSONB 읽기 경로 추가
  → 기존 경로(개별 컬럼)도 폴백으로 유지

Phase B-3: 하드코딩 제거
  → billing-guard.js → team 기반 매핑
  → llm-model-selector.js → Registry 기반
  → analyst-accuracy.js → 완전 JSONB 전환
  → trade-journal-db.js → JSONB 전용

Phase B-4: 기존 컬럼 정리 (최종)
  → aria_signal, sophia_signal, oracle_signal, hermes_signal → DROP
  → *_accurate, *_accuracy 컬럼 → DROP
  → 이 단계는 Phase B-3 안정 확인 후 (수주 뒤)
```

---

## 7. 안전 원칙

```
① Phase B-1은 비파괴적 — 기존 코드 100% 호환
② 기존 컬럼은 Phase B-4까지 유지 (최소 2주)
③ Phase B-2에서 신규/기존 모두 기록 (이중 기록)
④ Phase B-3 전환 후에도 기존 컬럼 폴백 유지
⑤ 전략 조합 추적 = agent.contracts + trade_journal 조인으로 해결
⑥ 기존 투자 파이프라인 안정성 최우선
```

---

## 8. 기대 효과

```
전환 완료 후:
  ✅ 에이전트 추가/삭제 시 DB 변경 불필요
  ✅ 전략 조합별 성과 비교 가능 (핵심!)
  ✅ 팀 전체 성과 트렌드 추적
  ✅ deprecated 에이전트 잔존 문제 해소
  ✅ 동적 고용 모델과 완벽 호환
  ✅ 대시보드에서 "어떤 조합이 최고?" 시각화 가능
```
