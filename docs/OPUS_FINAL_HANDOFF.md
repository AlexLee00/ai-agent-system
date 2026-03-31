# Opus 세션 인수인계 — Skills 재설계 필요 (2026-03-31)

> 작성일: 2026-03-31 | 모델: Claude Opus 4.6 (메티)

---

## 이번 세션 성과 + 방향 전환

### Skills Phase 1 구현 (커밋 c18c640)
- .claude/skills/ 5개 SKILL.md 생성 (222줄)
- /plan, /tdd, /code-review, /verify-loop, /handoff-verify

### ⚠️ 마스터 피드백 — 방향 전환 필요!
```
"스킬, 훅스를 반드시 클로드 코드로 사용하도록 하는것은 아니야!
 우리 에이전트가 이것을 사용할 수 있도록 구현하는거야!!
 프레임워크에 종속되지 않도록 하자!!"
```

### 재설계 방향
```
현재 (프레임워크 종속):
  .claude/skills/plan/SKILL.md → Claude Code 전용 슬래시 커맨드
  → 우리 30+ 봇(Node.js)이 사용 불가

목표 (프레임워크 독립):
  "팀 제이 표준 절차서" = 봇도 읽고, 코덱스도 읽는 범용 문서+코드
  → 덱스터가 /code-review 체크리스트를 자동 실행
  → 닥터가 /verify-loop 패턴으로 자동 수정+재시도
  → 리뷰어가 /code-review 규칙으로 코드 검토
  → 코덱스(Claude Code)도 동일 절차서 참조

구현 방안 (다음 세션에서 설계):
  A) packages/core/lib/skills/ 에 Node.js 모듈로 구현
     → 체크리스트를 함수로 export
     → 봇이 require()로 사용
     → Claude Code는 SKILL.md로도 참조 가능 (이중 인터페이스)

  B) docs/skills/ 에 범용 YAML/JSON+Markdown으로
     → 봇이 파싱해서 사용
     → Claude Code도 읽기 가능

  C) 하이브리드: 코어 로직은 Node.js, 절차서는 Markdown
     → packages/core/lib/skills/code-review.js (실행 코드)
     → .claude/skills/code-review/SKILL.md (Claude Code 참조)
     → 둘이 같은 체크리스트를 공유
```

---

## 다음 세션

```
1순위: Skills 재설계 — 프레임워크 독립적 구현
  → A/B/C 방안 중 결정
  → 현재 .claude/skills/ 5개를 범용 모듈로 전환
  → 핵심: 봇(Node.js)이 사용 가능 + Claude Code도 참조 가능

2순위: OpenClaw 기술 연구 + Phase 1 (C안, 연구팀 첫 과제)

3순위: D 분해 — 인프라+루나 우선

4순위: 블로팀 P1~P5 코덱스 프롬프트
```

## 핵심 결정 (이번 세션 누적)

```
[DECISION] Skills/Hooks는 프레임워크 독립적으로 구현 (Claude Code 종속 금지)
[DECISION] 우리 에이전트(30+ 봇)가 직접 사용할 수 있어야 함
[DECISION] Chronos Phase A 완전 검증 완료 (Layer 1~3)
[DECISION] 닥터+패처 A안 (닥터에 흡수, L1→L2→L3)
[DECISION] 클로드팀 신설: 리뷰어+가디언+빌더
[DECISION] OpenClaw C안: Phase1+고급연구, 연구팀 첫 과제
[DECISION] 일일 성장 환류: 데이터→분석→피드백 (루나팀 첫 대상)
[DECISION] 팀 적용순서 9팀, 팀 역할 확정
[DECISION] team-jay-strategy.md 삭제 (히스토리에 있음)
```
