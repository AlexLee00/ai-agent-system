# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-08)

### 1. 제이 자연어 능력 향상 v2.0 (`4c9efa1`)
- intent-parser.js: 53개 intent (기존 36 + 17 신규), CoT+Few-shot, loadDynamicExamples()
- router.js: 17개 신규 핸들러, chat 폴백 2단계, unrecognized_intents 자동학습
- 테스트: 24/24 통과
- 체크섬 갱신 완료, push 완료

### 2. OpenClaw 게이트웨이 설정 오류 수정
- 원인: `agents.teamLeads` 미인식 키 → `openclaw doctor --fix` 제거
- 덱스터 ❌ 0건 확인

### 3. 5주차 통합 안정화 검증 (이전 세션)
- 28/28 전체 통과
- Telegram long-polling mainbot.js 추가
- router.js await 버그 13곳 수정

---

## 다음 세션에서 할 것

### 우선순위 1: 2주차 — 스카팀 Shadow Mode 적용
```
1. bots/reservation/lib/shadow-mode.js 구현
   - 규칙 엔진 + LLM 병렬 실행
   - shadow_log 테이블 (reservation 스키마)
   - LLM: Groq llama-4-scout (무료)
2. 스카 Groq API 연동 (config.yaml groq 키 확인)
3. Shadow Mode 일치율 모니터링
```

### 우선순위 2: OpenClaw 메모리 누수 모니터링
- 재시작 직후 518MB (임계 500MB) — 빠른 누수 가능성
- 덱스터 quick 5분 주기가 감시 중
- 다음 세션 시작 시 메모리 추이 확인 필요

### 우선순위 3: unrecognized_intents 데이터 검토
- 제이 v2.0 배포 후 미인식 명령 패턴 축적 중
- `/unrec` 명령으로 조회, `/promote` 로 즉시 승격 가능

---

## 현재 시스템 상태 (2026-03-08 기준)

| 팀 | 상태 | 모드 | 비고 |
|----|------|------|------|
| 스카팀 | ✅ OPS | 예약관리 정상 | 앤디·지미 실행 중 |
| 루나팀 크립토 | ✅ OPS | PAPER_MODE=false | 30분 사이클 |
| 루나팀 국내/해외 | ✅ DEV | PAPER_MODE=true | 모의투자 |
| 클로드팀 덱스터 | ✅ OPS | 5분+1시간 주기 | ❌ 0건 정상 |
| 제이 OpenClaw | ✅ OPS | 포트 18789 | 재시작 후 518MB |
| 제이 오케스트레이터 | ✅ OPS | PID 769 | long-polling 활성 |

## 알려진 이슈
- KI-001~004: KNOWN_ISSUES.md 참조
- OpenClaw 메모리 누수: 재시작 직후 518MB — 추이 관찰 중
- `agents.teamLeads` 키가 openclaw.json에서 제거됨 → 다음 업데이트 시 재삽입 금지

## 커밋 이력 (이번 세션)
```
4c9efa1  feat: 제이 자연어 능력 향상 v2.0 — Intent 확장 + CoT + 자동학습
(이전)   feat: 5주차 통합 안정화 검증 28/28 통과 + Telegram long-polling
```

## 주의사항
- tmux 세션명: `ska`
- Gemini API: 스카팀 전용 (루나팀 사용 불가)
- OPS 전환은 반드시 마스터 확인 후
- insertReview(tradeId, review) — tradeId 첫 번째 인자
