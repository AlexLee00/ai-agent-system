# 운영 런북

> 마지막 업데이트: 2026-03-18
> 목적: 장애 대응, health 확인, 재시작, 운영 점검을 같은 순서로 수행하기 위한 실무 런북이다.

---

## 1. 역할

- 이 문서는 설계 문서가 아니라 운영 실행 문서다.
- 다음 질문에 답하기 위한 문서다.
  - 지금 어디가 아픈가
  - 먼저 어떤 health를 봐야 하는가
  - 어떤 명령으로 재시작/점검하는가
  - 운영 설정은 어디서 보정하는가

---

## 2. 운영 기본 원칙

- 장애 판단은 로그보다 `health-report`를 우선한다.
- 재시작은 습관적으로 하지 않고, 점검 후 실행한다.
- `runtime_config` 변경은 근거가 있을 때만 한다.
- 강한 자동 조치보다 보수적 복구가 우선이다.

함께 읽을 문서:
- [SESSION_CONTEXT_INDEX.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_CONTEXT_INDEX.md)
- [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- [docs/team-indexes/README.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/README.md)

---

## 3. 공통 1차 점검 순서

1. [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
2. [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)
3. 팀별 `health-report --json`
4. 필요한 경우 team reference 문서
5. 필요한 경우 런타임 설정과 최근 리뷰 스크립트 확인

공통 체크 항목:
- launchd 서비스 생존 여부
- HTTP health endpoint 응답 여부
- 최근 오류 반복 여부
- critical webhook / n8n 경로 정상 여부
- stale 상태 또는 queue 누적 여부

---

## 4. 팀별 health 점검 명령

### Worker

```bash
node /Users/alexlee/projects/ai-agent-system/bots/worker/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/worker/scripts/check-n8n-intake-path.js
```

참조:
- [TEAM_WORKER_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_WORKER_REFERENCE.md)

### Investment

```bash
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1
```

참조:
- [TEAM_INVESTMENT_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_INVESTMENT_REFERENCE.md)

### Reservation / Ska

```bash
node /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/health-report.js --json
bash /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/reload-monitor.sh
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js --days=7
```

참조:
- [TEAM_SKA_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_SKA_REFERENCE.md)

### Claude / Dexter

```bash
node /Users/alexlee/projects/ai-agent-system/bots/claude/scripts/health-report.js --json
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter
cd /Users/alexlee/projects/ai-agent-system/bots/claude && npm run dexter:quick
```

참조:
- [TEAM_CLAUDE_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_CLAUDE_REFERENCE.md)

### Orchestrator

```bash
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js
```

참조:
- [TEAM_ORCHESTRATOR_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_ORCHESTRATOR_REFERENCE.md)

### Blog

```bash
node /Users/alexlee/projects/ai-agent-system/bots/blog/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/blog/scripts/check-n8n-pipeline-path.js
```

참조:
- [TEAM_BLOG_REFERENCE.md](/Users/alexlee/projects/ai-agent-system/docs/team-indexes/TEAM_BLOG_REFERENCE.md)

---

## 5. 대표 포트 / 엔드포인트

### Worker

- API health
  - `http://127.0.0.1:4000/api/health`
- Next.js web
  - `http://127.0.0.1:4001`
- OCR 테스트
  - `http://127.0.0.1:4001/admin/ocr-test`

### Orchestrator / N8N

- critical path와 webhook은 config 기준으로 점검
  - [bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
  - [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)

---

## 6. 재시작 원칙

### 6.1 재시작 전

- 먼저 `health-report --json`으로 현재 상태를 남긴다.
- known issue인지 신규 이슈인지 확인한다.
- 설정값 문제면 재시작보다 `runtime_config` 점검을 우선한다.

### 6.2 재시작 우선순위

1. 팀 공식 reload/restart 스크립트
2. launchd kickstart/reload
3. 직접 프로세스 재기동

### 6.3 대표 재시작 경로

- Reservation/Ska monitor
  - `bash /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/reload-monitor.sh`
- Worker web
  - worker launchd/공식 재기동 절차 사용
- Claude/Dexter
  - quickcheck/dexter 결과를 본 뒤 필요한 경우만 재시작

주의:
- 증상 확인 없이 습관적으로 재시작하지 않는다.
- 반복 재시작은 known issue 또는 runtime_config 후보로 연결한다.

---

## 7. 운영 이슈별 기본 대응

### Web 접속 불가

1. 해당 팀 `health-report --json`
2. 포트 엔드포인트 `curl`
3. 최근 로그 확인
4. 공식 재시작
5. 여전히 실패하면 config/network 문제로 분기

### 자동화 결과 이상

1. 리뷰 스크립트 직접 실행
2. 자동화 결과와 실제 health 비교
3. fallback 과장 여부 확인
4. 필요하면 자동화 프롬프트 또는 입력 스크립트 수정

### 예측/분석 품질 저하

1. 리뷰 스크립트 재실행
2. bias/MAPE/hit rate 확인
3. runtime_config 후보 점검
4. 구조 문제인지 데이터 부족인지 분리

### 예약/등록 꼬임

1. reservation health 확인
2. stale/alert/seen 상태 확인
3. DB 상태와 실제 Pickko/Naver 상태 비교
4. 필요 시 manual verify 후 alert resolve

---

## 8. 같이 보는 문서

- 런타임 설정
  - [TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md](/Users/alexlee/projects/ai-agent-system/docs/TEAM_RUNTIME_CONFIG_GUIDE_2026-03-17.md)
- 구현 상태/개선 우선순위
  - [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)
- 테스트 이력
  - [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
- 열린 이슈
  - [KNOWN_ISSUES.md](/Users/alexlee/projects/ai-agent-system/docs/KNOWN_ISSUES.md)

---

## 9. 다음 보강 후보

- 팀별 launchd 서비스명과 재기동 절차를 부록으로 표준화
- 주요 로그 파일 경로를 별도 부록으로 정리
- 장애 유형별 decision tree를 간단한 표로 추가
