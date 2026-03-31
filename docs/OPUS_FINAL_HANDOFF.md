# Opus 세션 인수인계 — Skills 재설계 + CF 15개 분석 완료 (2026-03-31)

> 작성일: 2026-03-31 | 모델: Claude Opus 4.6 (메티)

---

## 이번 세션 핵심 성과 + 방향 전환

### ⚠️ 역할 원칙 위반 발생 + 즉시 수정
- 메티가 packages/core/lib/skills/ 직접 구현 → revert 완료 (커밋 b326439)
- 교훈: 메티는 설계+프롬프트만, 코드 구현은 반드시 코덱스

### ⚠️ 마스터 피드백 — 프레임워크 독립 원칙
```
"스킬, 훅스를 반드시 클로드 코드로 사용하도록 하는것은 아니야!
 우리 에이전트가 이것을 사용할 수 있도록 구현하는거야!!
 프레임워크에 종속되지 않도록 하자!!"
```

### 확정된 방향: A안 (packages/core/lib/skills/ Node.js 모듈)
```
위치: packages/core/lib/skills/ ← 공용 (hub-client, local-llm-client와 동급)
사용: 봇이 require()로 직접 사용 + 코덱스도 참조 가능
원칙: 프레임워크 완전 독립, Single Source of Truth
.claude/: 깃에서 제외 (.gitignore)
```

### Claude Forge 15개 스킬 전체 분석 완료
```
⭐⭐⭐ 필수 4개:
  security-pipeline   → 가디언: CWE Top 25 + STRIDE 보안 체크
  eval-harness        → 일일 성장: 성과 측정 프레임워크
  team-orchestrator   → 제이(메인봇): 9팀 조율 엔진
  session-wrap        → 세션 마무리: HANDOFF 자동 생성 + 일일 리포트

⭐⭐ 높은 가치 5개:
  build-system        → 빌더: 워커 Next.js + npm 빌드
  instinct-learning   → 일일 성장 핵심: 패턴 학습→자동 적용
  pattern-to-skill    → LLM 졸업 엔진 연결: 반복 패턴→규칙 전환
  skill-explorer      → 연구팀: 새 기술 발굴+적용
  session-analyzer    → 리뷰어: 세션 검증 분석

  이전 설계 5개:
  code-review         → 리뷰어: 5단계 코드 리뷰
  verify-loop         → 닥터 L3: 자동 검증 재시도 (3회)
  plan                → 기획: 구현 계획 구조화
  tdd                 → 테스터: RED→GREEN→REFACTOR
  handoff-verify      → 독립 이중 검증

  합계: 14개 공용 스킬 모듈 (packages/core/lib/skills/)
```

---

## 다음 세션

```
1순위: 14개 공용 스킬 모듈 코덱스 구현 프롬프트 작성 (메티의 역할!)
  → 메티가 설계서+프롬프트 작성 → 코덱스가 구현 → 메티가 점검
  → 구현 우선순위:
    Phase 1: code-review + verify-loop + plan (기본 3개)
    Phase 2: security-pipeline + eval-harness + team-orchestrator (핵심 4개)
    Phase 3: 나머지 7개

2순위: OpenClaw 기술 연구 + Phase 1 (C안, 연구팀 첫 과제)

3순위: D 분해 — 인프라+루나 우선

4순위: 블로팀 P1~P5 코덱스 프롬프트
```

## 핵심 결정

```
[DECISION] Skills는 프레임워크 독립 — packages/core/lib/skills/ Node.js 모듈
[DECISION] .claude/는 깃에서 제외 (.gitignore)
[DECISION] 봇이 require()로 직접 사용 + 코덱스도 참조 가능
[DECISION] A안 확정 (Single Source of Truth, Node.js)
[DECISION] CF 15개 스킬 분석 → 14개 공용 모듈 목록 확정
[DECISION] 메티 직접 구현 금지 — 역할 원칙 재확인
```
