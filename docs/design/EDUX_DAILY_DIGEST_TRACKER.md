# EDUX 일일 다이제스트 + 게이트 복구 추적 (TRACKER)

> 설계: docs/design/EDUX_DAILY_DIGEST_DESIGN.md | 시작 2026-06-22

## 현황 (2026-06-22 세션, 메티)
- 게시 미등록 근본 원인 규명 완료: promotion gate report 갱신 launchd 부재 -> 24h stale -> 06-21~ 전 슬롯 skipped
- 알람 설계 완료 (edux_publish_log 재사용, 7/6/5 가변, 새 텔레그램 봇/채널, 10:00 KST)
- 추적 방식 검토 완료: DB(edux_publish_log) 재사용 확정 (별도 JSON 불필요)

## 작업 항목

### P0 — promotion gate 복구 [선행, 게시 재개] — ✅ 완료 (2026-06-22)
- [x] 즉시 복구: dry-run 1회 부트스트랩 -> check1(34->35) + check4(JWT 0->1) 동시 충족 -> allPass 7/7
- [x] 영구: ai.edux.promotion-gate launchd 이중화(05:00+17:00) 신설 + launchctl. kickstart 7/7 PASS, exit 0
- [~] 검증: report generatedAt 신선 ✅ / 16:00 kis success 확인 대기 (첫 실 발행)

### P1 — 일일 다이제스트 알람 [게이트 복구 후]
- [ ] runtime-edux-daily-digest.ts 신설 (edux_publish_log success 조회 -> 예문 포맷 -> 새 봇 발송)
- [ ] ai.edux.daily-digest launchd 신설 (10:00 KST)
- [ ] 새 텔레그램 봇 토큰 + 채널 ID env 주입 (마스터)
- [ ] smoke-edux-daily-digest.ts (가변건수 7/6/5 + 링크 + 포맷)
- [ ] 검증: 10:00 발송 + 가변건수 + post_url 첨부

## 검증 기준 (메티 독립)
- promotion gate: report 신선화 후 발행 success 재개
- 알람: edux_publish_log success N건 -> N블록 발송, post_url 정확, 휴장일 자동 축소(7->6->5)

## 다음 진입점
1. promotion gate 즉시 복구 (마스터 수동) -> 발행 재개 확인
2. promotion gate launchd + 다이제스트 코덱스 프롬프트 작성 (메티)
3. 코덱스 구현 -> 메티 독립검증 -> 마스터 커밋·launchctl
4. 새 텔레그램 봇/채널 준비 (마스터)
