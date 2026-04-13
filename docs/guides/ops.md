# 운영 런북

> 마지막 업데이트: 2026-03-19
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
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js --json
bash /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/reload-monitor.sh
node /Users/alexlee/projects/ai-agent-system/scripts/reviews/ska-sales-forecast-daily-review.js --days=7
```

취소 누락 복구 표준 절차:

1. health / drift 확인

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js --json
```

- `cancelCounterDriftHealth`
- `naver-monitor 로그`
- `ai.ska.naver-monitor`
를 먼저 확인한다.

2. 예약/취소 이력 대조

- `reservation.reservations`
- `reservation.cancelled_keys`
- `reservation.alerts`
에서 전화번호 + 날짜 + 시작시간 기준으로 조회한다.
- 취소가 실제로 누락됐다면 보통 아래 패턴으로 보인다.
  - reservation row는 `completed / verified`
  - `cancelled_keys` 없음
  - 관련 `alerts` 없음

3. 수동 취소 실행

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/manual/reservation/pickko-cancel-cmd.js \
  --phone=01000000000 \
  --date=YYYY-MM-DD \
  --start=HH:MM \
  --end=HH:MM \
  --room=A1|A2|B \
  --name=고객명
```

- 슬롯 시간은 네이버/DB 기준 실제 저장값으로 맞춘다.
- 메모와 10분 차이가 있어도 DB/픽코가 보는 실제 슬롯 기준을 우선한다.

4. 내부 상태 정합성 복구

- 수동 취소 래퍼는 실제 픽코/네이버 취소는 처리하지만, reservation DB 상태는 자동으로 `cancelled`로 바꾸지 않을 수 있다.
- 아래 항목을 함께 맞춰야 한다.
  - `reservations.status = cancelled`
  - `reservations.pickko_status = cancelled`
  - `marked_seen = 1`
  - `cancelled_keys`에 `cancelid|...`, `cancel_done|...` 반영
  - 관련 `alerts` resolve

5. 최종 검증

- 두 축을 모두 확인한다.
  - 실제 운영 화면: 픽코 취소 / 네이버 예약가능 복구
  - 내부 상태: DB `cancelled`, `cancelled_keys` 반영, health drift 경고 해소

주의:

- 동일 슬롯 duplicate row가 있으면 한 건만 취소하지 말고 같은 슬롯의 관련 row를 함께 점검한다.
- 취소 누락 복구 후에는 다음 사이클에서 `cancelCounterDriftHealth`와 `/tmp/naver-ops-mode.log`를 한 번 더 확인한다.

duplicate slot cleanup policy:

1. 먼저 health 기준으로 분류

```bash
node /Users/alexlee/projects/ai-agent-system/dist/ts-runtime/bots/reservation/scripts/health-report.js --json
node /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/audit-duplicate-slots.js --json
```

- `duplicateSlotHealth.riskyCount > 0`
  - 같은 슬롯에 `non-cancelled` row가 2개 이상인 상태
  - 운영 정합성 위험이 있으므로 즉시 점검 대상이다.
- `duplicateSlotHealth.historicalCount > 0`
  - 보통 `completed + cancelled` 또는 `cancelled + cancelled`
  - 과거 취소/재예약 또는 수동 복구 잔여 이력일 가능성이 높다.

2. risky duplicate 처리 기준

- 같은 `phone + date + start_time + room` 슬롯을 직접 조회한다.
- 아래 패턴이면 즉시 정리 후보다.
  - `completed + completed`
  - `pending/processing + completed`
  - `non-cancelled` row가 2건 이상
- 이 경우:
  - 실제 운영 화면(네이버/픽코) 기준 최종 상태를 먼저 확정
  - 살아 있어야 하는 canonical row 1건만 남기고 나머지는 `cancelled` 또는 `seen_only` 등 내부 정책에 맞게 정리 검토
  - 단, 즉시 삭제보다는 상태 정합성 복구가 우선이다.

3. historical duplicate 처리 기준

- `completed + cancelled`
  - 과거 취소 후 재예약 이력으로 간주 가능
  - 즉시 정리하지 않아도 된다.
- `cancelled + cancelled`
  - 수동 취소 복구나 bookingId 변경 과정의 잔여 이력일 수 있다.
  - 운영 리스크는 낮지만, 장기적으로는 cleanup 후보로 기록한다.

4. 지금 당장 정리하지 않는 이유

- 예약 운영에서는 원본 이력 보존 가치가 있다.
- duplicate가 모두 위험한 것은 아니다.
- 따라서 현재 기본 원칙은:
  - `risky`만 즉시 대응
  - `historical`은 audit 대상으로 유지

운영 팁:

- `health-report`는 요약/count를 본다.
- `audit-duplicate-slots.js`는 실제 row id, status, 권장 조치를 본다.
- 현재 기준 historical sample은 아래 두 패턴이 정상 후보다.
  - `completed + cancelled`
  - `cancelled + cancelled`

5. 후속 개선 후보

- `historical duplicate` 전용 audit 스크립트
- `cancelled + cancelled` pair 압축 정책
- duplicate row를 별도 history 테이블로 이동하는 구조

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

## 5. 대표 launchd / 로그 / 엔드포인트

### Worker

- 대표 launchd
  - `ai.worker.web`
  - `ai.worker.nextjs`
  - `ai.worker.lead`
  - `ai.worker.task-runner`
- 대표 로그
  - `~/.openclaw/workspace/logs/worker-web.log`
  - `~/.openclaw/workspace/logs/worker-web-error.log`
  - `~/.openclaw/workspace/logs/worker-nextjs.log`
  - `~/.openclaw/workspace/logs/worker-lead.log`

- API health
  - `http://127.0.0.1:4000/api/health`
- Next.js web
  - `http://127.0.0.1:4001`
- OCR 테스트
  - `http://127.0.0.1:4001/admin/ocr-test`
- 워커 모니터링
  - `http://127.0.0.1:4001/admin/monitoring`
- 운영 설정 마이그레이션
  - `node /Users/alexlee/projects/ai-agent-system/bots/worker/migrations/017-system-preferences.js`

### Orchestrator / OpenClaw / N8N

- 대표 launchd
  - `ai.orchestrator.mainbot`
  - `ai.openclaw.gateway`
  - `ai.orchestrator.health-check`
- 대표 로그
  - `~/.openclaw/workspace/logs/openclaw-gateway.log`
  - `~/.openclaw/workspace/logs/openclaw-gateway-error.log`
  - `~/.openclaw/workspace/logs/mainbot.log`
  - `~/.openclaw/workspace/logs/mainbot-error.log`

- critical path와 webhook은 config 기준으로 점검
  - [bots/orchestrator/config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)
  - [bots/orchestrator/scripts/check-n8n-critical-path.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-n8n-critical-path.js)
- 제이 모델 정책 확인 순서
  - OpenClaw gateway 기본 모델: [openclaw.json](/Users/alexlee/.openclaw/openclaw.json)
  - 제이 앱 레벨 모델 정책: [jay-model-policy.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/lib/jay-model-policy.js)
  - 운영 오버라이드 값: [config.json](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/config.json)의 `runtime_config.jayModels`
  - 정합성 점검 스크립트: [check-jay-gateway-primary.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/check-jay-gateway-primary.js)
  - 실험 로그 스냅샷: [log-jay-gateway-experiment.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/log-jay-gateway-experiment.js)
  - 실험 리뷰: [jay-gateway-experiment-review.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-review.js)
  - 자동화 진입점: [jay-gateway-experiment-daily.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-experiment-daily.js)
  - 전환 전후 비교: [jay-gateway-change-compare.js](/Users/alexlee/projects/ai-agent-system/scripts/reviews/jay-gateway-change-compare.js)
  - 전환 준비 계획: [prepare-jay-gateway-switch.js](/Users/alexlee/projects/ai-agent-system/bots/orchestrator/scripts/prepare-jay-gateway-switch.js)
  - 변경 원칙: 정합성이 맞고 헬스가 안정이면 즉시 변경보다 유지가 우선, 전환은 비교 근거 확보 후 진행
  - 전환 단계:
    - `hold`: 정합성 일치 + 오케스트레이터 health-report 안정
    - `compare`: rate limit 재발 / fallback 진입률 증가 / 응답속도 불만 발생
    - `switch`: 비교 로그에서 대체 후보 우위 확인 후 `runtime_config` 변경 → `--apply` 동기화 → 헬스 재관찰
  - 권장 운영 순서:
    1. `check-jay-gateway-primary.js --json`
    2. `jay-gateway-experiment-daily.js --hours=24 --days=7`
    3. 필요하면 `jay-llm-daily-review.js --days=1`과 함께 비교
    4. 그 뒤에만 실제 primary 변경 검토
  - 실제 전환이 있었다면:
    1. 전환 시각 기록
    2. `jay-gateway-change-compare.js --pivot=<전환시각> --before-hours=24 --after-hours=24`
    3. `improved / neutral / regressed` 판정 후 유지 여부 결정
  - 실제 전환 전에:
    1. `prepare-jay-gateway-switch.js --candidate=groq_speed --json`
    2. 사전 점검 통과 후에만 runtime_config 변경 검토

### Claude / Dexter

- 대표 launchd
  - `ai.claude.dexter`
  - `ai.claude.dexter.daily`
  - `ai.claude.dexter.quick`
- 대표 로그
  - `bots/claude/dexter.log`
  - `bots/claude/dexter.err.log`
  - `bots/claude/dexter-quick.log`

### Reservation / Ska

- 대표 launchd
  - `ai.ska.naver-monitor`
  - `ai.ska.kiosk-monitor`
  - `ai.ska.pickko-verify`
  - `ai.ska.rebecca`
  - `ai.ska.eve`
- 대표 로그
  - `~/.openclaw/workspace/logs/naver-monitor.log`
  - `~/.openclaw/workspace/logs/naver-monitor-error.log`
  - `~/.openclaw/workspace/logs/kiosk-monitor.log`
  - `~/.openclaw/workspace/logs/kiosk-monitor-error.log`

### Investment

- 대표 launchd
  - `ai.investment.commander`
  - `ai.investment.crypto` (`normal` 거래 레일)
  - `ai.investment.crypto.validation` (`validation` 검증거래 레일, 선택적)
  - `ai.investment.domestic`
  - `ai.investment.domestic.validation` (`validation` 검증거래 레일, 선택적)
  - `ai.investment.overseas`
  - `ai.investment.overseas.validation` (`validation` 검증거래 레일, 선택적)
  - `ai.investment.argos`
- 대표 로그
  - `~/.openclaw/workspace/logs/luna-commander.log`
  - `~/.openclaw/workspace/logs/luna-commander-error.log`
  - `/tmp/investment-crypto.log`
  - `/tmp/investment-crypto.err.log`
  - `/tmp/investment-crypto-validation.log`
  - `/tmp/investment-crypto-validation.err.log`

### Investment validation 레일 활성화 / 비활성화

- validation 레일은 기본 상시 서비스가 아니라 `선택적 canary`로 취급한다.
- 현재 범위:
  - `ai.investment.crypto.validation`
  - `ai.investment.domestic.validation`
  - `ai.investment.overseas.validation`
- 활성화 전 확인:
  - [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
  - [bots/investment/scripts/trading-journal.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js) `--days=1`
  - [bots/investment/scripts/weekly-trade-review.js](/Users/alexlee/projects/ai-agent-system/bots/investment/scripts/weekly-trade-review.js) `--dry-run`
- 암호화폐 validation 활성화 명령:

```bash
launchctl bootstrap gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.crypto.validation.plist
launchctl kickstart -k gui/$(id -u)/ai.investment.crypto.validation
launchctl list | egrep 'ai\.investment\.(crypto|crypto\.validation)'
```

- 국내장 validation 활성화 명령:

```bash
launchctl bootstrap gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.domestic.validation.plist
launchctl kickstart -k gui/$(id -u)/ai.investment.domestic.validation
launchctl list | egrep 'ai\.investment\.(domestic|domestic\.validation)'
```

- 해외장 validation 활성화 명령:

```bash
launchctl bootstrap gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.overseas.validation.plist
launchctl kickstart -k gui/$(id -u)/ai.investment.overseas.validation
launchctl list | egrep 'ai\.investment\.(overseas|overseas\.validation)'
```

- 비활성화 명령 예시:

```bash
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.crypto.validation.plist
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.domestic.validation.plist
launchctl bootout gui/$(id -u) /Users/alexlee/projects/ai-agent-system/bots/investment/launchd/ai.investment.overseas.validation.plist
```

- 활성화 후 점검:
  - `/tmp/investment-crypto-validation.log`
  - `/tmp/investment-crypto-validation.err.log`
  - `/tmp/investment-domestic-validation.log`
  - `/tmp/investment-domestic-validation.err.log`
  - `/tmp/investment-overseas-validation.log`
  - `/tmp/investment-overseas-validation.err.log`
  - `node /Users/alexlee/projects/ai-agent-system/bots/investment/scripts/trading-journal.js --days=1`
  - 리포트에서 `[NORMAL]`, `[VALIDATION]`, `[LIVE]`, `[PAPER]` 태그 및 `mode NORMAL / VALIDATION` 집계 확인
  - `/tmp/investment-domestic.log`
  - `/tmp/investment-domestic.err.log`

### Blog

- 대표 launchd
  - `ai.blog.node-server`
  - `ai.blog.daily`
  - `ai.blog.health-check`
- 대표 로그
  - `bots/blog/blog-node-server.log`
  - `bots/blog/blog-node-server.err.log`
  - `bots/blog/blog-daily.log`
  - `bots/blog/blog-daily.err.log`

---

## 6. 재시작 원칙

### 6.1 재시작 전

- 먼저 `health-report --json`으로 현재 상태를 남긴다.
- known issue인지 신규 이슈인지 확인한다.
- 설정값 문제면 재시작보다 `runtime_config` 점검을 우선한다.
- 노트북에는 `ai-agent-system` 외 다른 시스템도 있을 수 있으므로, 재부팅 스크립트는 **ai-agent-system 준비/정리까지만 수행**하고 최종 OS 재시작은 사용자가 직접 결정한다.

### 6.2 재시작 우선순위

1. 팀 공식 reload/restart 스크립트
2. launchd kickstart/reload
3. 직접 프로세스 재기동

### 6.3 노트북 재부팅 표준 절차

1. 준비 단계
   - `bash /Users/alexlee/projects/ai-agent-system/scripts/pre-reboot.sh`
   - 이 단계는 아래만 수행한다.
     - Git 상태 확인
     - 현재 `ai.*` launchd 스냅샷 저장
     - 필수 문서 최신성 점검
       - `SESSION_HANDOFF.md`
       - `WORK_HISTORY.md`
       - `CHANGELOG.md`
       - `TEST_RESULTS.md`
       - `PLATFORM_IMPLEMENTATION_TRACKER.md`
     - 재부팅 준비 로그/텔레그램 기록
   - **이 단계에서는 서비스 정지나 OS 종료를 자동으로 하지 않는다.**
   - 문서/세션 인수인계가 최신 상태가 아니면 재부팅 직전 정리 단계로 넘어가지 않는다.

2. 재부팅 직전 정리 단계
   - 사용자가 실제 재부팅하기 직전에만 실행
   - `bash /Users/alexlee/projects/ai-agent-system/scripts/pre-reboot.sh --drain-now`
   - 이 단계는 `ai-agent-system` 관련 서비스만 정지 신호를 보내고 대기한다.
   - 다른 로컬 시스템은 이 스크립트가 건드리지 않는다.

3. 사용자의 최종 재시작
   - Apple 메뉴 또는 사용자가 선택한 방식으로 직접 재시작
   - Codex나 스크립트가 자동 종료를 실행하지 않는다.

4. 부팅 후 자동 점검
   - `ai.agent.post-reboot` launchd가 [post-reboot.sh](/Users/alexlee/projects/ai-agent-system/scripts/post-reboot.sh)를 자동 실행한다.
   - 점검 대상은 현재 운영 기준으로 아래를 포함한다.
     - orchestrator / OpenClaw / n8n
     - worker web / nextjs / lead / task-runner
     - investment commander / markets / reporter / argos / alerts / prescreen
     - blog node-server / daily / health-check
     - claude commander / dexter / archer / health-dashboard
     - ska monitors

5. 수동 후속 검증
   - `/tmp/post-reboot.log`
   - `/tmp/post-reboot.err.log`
   - `/tmp/post-reboot-followup.txt`
   - 필요 시
     - `bash /Users/alexlee/projects/ai-agent-system/scripts/post-reboot.sh --dry-run`
     - 팀별 `health-report --json`
   - 재부팅 후 상태 변화나 복구 조치가 있으면 반드시 아래 문서를 다시 갱신한다.
     - [SESSION_HANDOFF.md](/Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md)
     - [WORK_HISTORY.md](/Users/alexlee/projects/ai-agent-system/docs/WORK_HISTORY.md)
     - [CHANGELOG.md](/Users/alexlee/projects/ai-agent-system/docs/CHANGELOG.md)
     - [TEST_RESULTS.md](/Users/alexlee/projects/ai-agent-system/docs/TEST_RESULTS.md)
     - [PLATFORM_IMPLEMENTATION_TRACKER.md](/Users/alexlee/projects/ai-agent-system/docs/PLATFORM_IMPLEMENTATION_TRACKER.md)

### 6.4 대표 재시작 경로

- Reservation/Ska monitor
  - `bash /Users/alexlee/projects/ai-agent-system/bots/reservation/scripts/reload-monitor.sh`
- Worker web
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.web`
  - `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs`
- Claude/Dexter
  - quickcheck/dexter 결과를 본 뒤 필요한 경우만 재시작
  - `launchctl kickstart -k gui/$(id -u)/ai.claude.dexter`
- Orchestrator/OpenClaw
  - `launchctl kickstart -k gui/$(id -u)/ai.orchestrator`
  - `launchctl kickstart -k gui/$(id -u)/ai.openclaw.gateway`
- Blog node server
  - `launchctl kickstart -k gui/$(id -u)/ai.blog.node-server`

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

권장 순서 예:
- worker 화면 불가
  - `node bots/worker/scripts/health-report.js --json`
  - `curl -s http://127.0.0.1:4000/api/health`
  - `curl -s -I http://127.0.0.1:4001`
  - `curl -s http://127.0.0.1:4001/admin/monitoring`
  - `tail -n 100 ~/.openclaw/workspace/logs/worker-web-error.log`
- blog API 불가
  - `node bots/blog/scripts/health-report.js --json`
  - `curl -s http://127.0.0.1:3100/health`
  - `tail -n 100 bots/blog/blog-node-server.err.log`

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

대표 점검:
- `node bots/reservation/scripts/health-report.js --json`
- `node dist/ts-runtime/bots/reservation/manual/admin/pickko-verify.js`
- `bash bots/reservation/scripts/reload-monitor.sh`

---

## 7.1 장애 체크리스트 요약

| 증상 | 먼저 볼 것 | 다음 조치 |
|---|---|---|
| 워커 웹 접속 불가 | `worker health-report`, `4000/4001 curl`, `/admin/monitoring`, `worker-web-error.log` | `ai.worker.web`, `ai.worker.nextjs` kickstart |
| 제이/오케스트레이터 응답 이상 | `orchestrator health-report`, gateway log, critical path check | `ai.orchestrator.mainbot`, `ai.openclaw.gateway` kickstart |
| 예약 경고 반복 | `reservation health-report`, `pickko-verify`, alerts state | monitor reload, alert resolve, DB 상태 동기화 |
| 스카 예측 리포트 이상 | daily/weekly review, `ska.forecast_results` 최근값 | config 보정, shadow 비교 확인 |
| 루나 거래 0건 지속 | investment health, trading journal, paper/live mode | runtime_config/threshold 점검 |
| 덱스터 과장 경고 | claude health, dexter quickcheck, recent logs | false positive 규칙/리포트 입력 점검 |

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

- launchd 서비스명과 로그 경로를 실제 운영 환경 기준으로 더 촘촘히 표준화
- 장애 유형별 decision tree를 간단한 표 또는 mermaid로 추가
- 야간 대응용 최소 체크셋을 별도 부록으로 분리
