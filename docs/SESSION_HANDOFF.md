# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-12)

### 1. 스카팀 LLM 교체 완료
- `bots/registry.json`: reservation/ska → `groq/llama-4-scout-17b-16e-instruct` + fallback `openai/gpt-4o-mini`
- BOOT.md 반영 완료

### 2. dexter_error_log upsert 방식 전환
- `bots/claude/lib/error-history.js`: ON CONFLICT DO UPDATE, occurrence_count 누적
- DB dedup 완료 (106행 → 12행)

### 3. dexter-quickcheck.js 알람 레벨 개선
- 1회 실패: ⚠️ HIGH (alert_level 2)
- 2회+ 연속: 🚨 CRITICAL (alert_level 4)

### 4. dexter.js 신규 오류만 텔레그램 발송
- `getNewErrors(2, 7)` 활용: 최근 2시간 내 처음 등장 오류 + CRITICAL만 발송
- 반복 오류는 더 이상 매시간 울리지 않음

### 5. naver-monitor.js 버그 수정 (이전 세션 연속)
- 취소 성공 시 DB status 미업데이트 수정
- 취소감지4 OBSERVE_ONLY 필터 누락 수정

### 6. 체크섬 갱신
- `bots/claude/.checksums.json` 42개 파일 갱신 (`--update-checksums`)

---

## 미해결 이슈 (다음 세션 처리 필요)

### 🔴 naver-monitor SIGKILL
- `ai.ska.naver-monitor` PID 16035, 상태 -9 (SIGKILL)
- 재시작 필요: `launchctl kickstart -k gui/$(id -u)/ai.ska.naver-monitor`

### 🟡 cancelled_keys 오탐 4건
- 010-3397-3384 (03-28 B 13:30~17:30) — 픽코 미등록, 네이버 활성
- 010-7184-8299 (03-28 A2 16:00~18:00) — 픽코 미등록, 네이버 활성
- 010-2802-8575 2건 — 수동 처리 필요
- 덱스터가 계속 "Picco 취소 실패"로 감지 중 → cancelled_keys 정리 필요

### 🟡 LLM 속도 테스트 결과 반영 고려
- 현재 스카팀: llama-4-scout (464ms, Groq 모델 중 가장 느림)
- gpt-oss-20b (152ms) 또는 llama-3.1-8b (153ms)로 교체 고려

### 🟡 pickko-pay-scan / today-audit exit 1
- 오전 픽코 서버 타임아웃으로 오늘 실패 (하루 1회 스케줄)
- 내일 자동 재실행 예정, 지속되면 Puppeteer 타임아웃 설정 검토

---

## 전체 팀 가동 현황 (세션 마감 시점)

| 팀 | 상태 | 비고 |
|----|------|------|
| 루나팀 | ✅ 정상 | 암호화폐 실투자 SLOWDOWN 중, 헬스체크 13개 이상 없음 |
| 스카팀 | ⚠️ 주의 | commander 정상, naver-monitor -9, kiosk-monitor 정상 |
| 클로드팀 | ✅ 정상 | commander 정상, dexter exit 1 (감지 결과), health-check 6개 이상 없음 |
| 워커팀 | ✅ 정상 | web(52746)/nextjs(60934) 실행 중, health-check 2개 이상 없음 |
