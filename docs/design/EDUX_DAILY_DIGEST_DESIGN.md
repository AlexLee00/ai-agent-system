# EDUX 일일 다이제스트 알람 + 발행 게이트 복구 설계 (2026-06-22, 메티)

> 발주: 마스터 / 설계: 메티 / 구현: 코덱스 / 커밋·launchctl: 마스터
> 대상: bots/edu-x — Edu-X 커뮤니티 자동 게시 봇

## 1. 배경

### 1-1. 게시 미등록 근본 원인 (긴급)
2026-06-21부터 모든 edu-x 발행이 skipped. 근본 원인:
- 발행 전 promotion gate report(bots/edu-x/output/edux-promotion-gate.json)가 최신이어야 발행 허용 (stale 기준 24h, edux-runtime-support.ts:597 PROMOTION_GATE_MAX_AGE_MS)
- **promotion gate report를 주기 갱신하는 launchd가 없음** (7개 slot 발행 launchd만 존재)
- report 마지막 생성: 06-20 02:28 KST (수동) -> 06-21 02:28 이후 stale -> 전 슬롯 차단
- 타임라인 일치: 06-20 success 6건, 06-21~ 전부 skipped
- dry-run->live 전환 시 gate 갱신 자동화 누락

**★ 악순환 메커니즘 (실제 근본 원인, 2026-06-22 확인)**: 단순 stale이 아니라 **게이트 자체가 HOLD**였음. report stale -> 발행 skipped -> ① 7일 검증 누적 35건 미달(skipped는 카운트 제외 -> 34건) + ② JWT 24h 0건(발행이 없으니 dry_run/success row 없음) -> promotion gate HOLD(5/7) -> 발행 계속 skipped. report 갱신만으로는 allPass가 안 되므로 풀리지 않음.

### 1-2. 알람 요청 (마스터)
edu-x 일일 게시물(최대 7건)을 요약해 텔레그램으로 1일 1회(오전 10시 KST) 발송. 새 텔레그램 봇 + 별도 채널 사용.

## 2. promotion gate 복구 [P0, 선행]

### 2-1. 즉시 복구 (수동) — ✅ 완료 (2026-06-22)
게이트가 HOLD(34/35 + JWT 0)라 report 갱신만으론 부족. **dry-run 발행 1회로 부트스트랩**:
- `EDUX_DRY_RUN=true npm run crypto-daily -- --slot=0600` -> status='dry_run' row 1건 생성
- check1(누적) 34->35 + check4(JWT) 0->1건 동시 충족 (check4는 24h 내 dry_run|success row 존재만 검사하므로 dry_run row로 충족)
- `npm run promotion-gate` 재실행 -> allPass 7/7 -> report 신선 -> 발행 재개

### 2-2. 영구 복구 (launchd 신설) — ✅ 완료 (2026-06-22)
- `ai.edux.promotion-gate.plist` 신설, **이중화 05:00 + 17:00** (StartCalendarInterval 배열 2개) — 단일 실패점 제거.
- 발행 플래그 제외(HOME/PATH만), edux-promotion-gate.ts 실행 -> report만 생성 (자동 promote 없음, 안전).
- 발행 재개 후 success row가 매일 쌓여 게이트 자동 충족 + launchd가 report 갱신 -> 선순환 유지.
- kickstart 검증: 7/7 PASS, generatedAt 신선, exit 0. 매일 05:00+17:00 자동 갱신으로 악순환 구조적 차단.

## 3. 발행 스케줄 (장 상황 반영 — 현행 확인)

| category | 슬롯(KST) | 횟수 | 휴장 처리 |
|---|---|---|---|
| crypto(암호화폐) | 0600·1400·2230 | 3 | 무중단 (24h, 공휴일 무관) |
| kis(국내장) | 0900·1600 | 2 | weekend + holiday Set skip (kis-daily.ts:88-96) |
| overseas(국외장) | 0630·2200 | 2 | 미국 휴장 skip. 장 마감이 국내 익일 새벽이라 0630=마감 요약 |

- 평일(한·미 개장): 3+2+2 = **7건**
- 한국 공휴일 또는 미국 공휴일(한쪽 휴장): **6 또는 5건**
- 즉 발행 건수 가변 -> 알람 건수도 7/6/5 가변 (있는 것만 발송)
- ※ overseas 휴장 로직이 kis와 동일 패턴(holiday Set)인지 코덱스 구현 시 확인

## 4. 일일 다이제스트 알람 [P1, 게이트 복구 후]

### 4-1. 데이터 소스 = edux_publish_log (DB 재사용)
오전 10시 기준 직전 발행분 조회:
- SELECT schedule_slot, category, title, post_url, metadata FROM edux_publish_log
  WHERE status='success' AND published_at >= (오전 10시 기준 직전 윈도우) ORDER BY published_at
- success 건만 -> 휴장 슬롯 자동 제외 -> 7/6/5 가변 자동 반영
- 발송 대상: "오전 10시 이전 직전 7슬롯의 최신 success" (전일 오후~당일 오전)

### 4-2. 필드 매핑 (예문 형식)
| 예문 요소 | 출처 |
|---|---|
| 자산·가격·변동률 | title 파싱 (MM/DD {cat} 시황 카드 \| {자산} {가격} {변동률}) |
| 요약 1줄 | metadata.lunaEvidenceSummary("핵심 3줄")에서 핵심 1줄 압축 |
| 링크 | post_url (edu-x.io/community/posts/{uuid}) |
| 시간대 | schedule_slot -> "(HH:MM 요약)" |

### 4-3. 포맷 (예문 준수)
- 헤더: 🔥[MM/DD] 오늘 꼭 알아야 할 시장 정보 총정리🔥
- 블록(발행 N건 반복, 누락 표기 없음):
  📊{자산} {가격} {변동률} ({슬롯} 요약)
  [{요약 1줄}] ({post_url})
- 푸터: 📌 EduX 커뮤니티 안내 + Google Play 앱 다운로드 링크

### 4-4. 텔레그램 발송 = 새 봇 + 별도 채널 (마스터 지정)
- 기존 edu-x 발행 알림(sendTelegram)과 별개. **신규 봇 토큰 + 채널 ID**
- env: EDUX_DIGEST_TELEGRAM_BOT_TOKEN, EDUX_DIGEST_TELEGRAM_CHANNEL_ID (마스터가 봇 생성·채널 설정 후 주입)
- 발송 함수 신규 (또는 공통 telegram 모듈을 채널 파라미터화)

### 4-5. 스케줄
- 신규 launchd ai.edux.daily-digest — 매일 10:00 KST 1회
- 신규 스크립트 runtime-edux-daily-digest.ts

## 5. 추적 방식 검토 결론 — DB(edux_publish_log) 재사용

| 방안 | 평가 |
|---|---|
| **DB 재사용 (채택)** | edux_publish_log가 발행 추적 SSOT. status/post_url/slot/published_at 기존. 추가 저장 0, 알람은 조회만 |
| 별도 JSON | edux_publish_log와 이중 관리·동기화 부담, SSOT 분산. 불리 |

- 결론: **별도 저장소 신설 불필요.** edux_publish_log 단일 소스로 발행추적 + 링크 + 가변건수 모두 해결.
- 알람 발송 이력이 필요하면 metadata/로그로 충분 (별도 테이블 불필요).

## 6. 구현 항목 (코덱스)

| # | 항목 | 파일 |
|---|---|---|
| 1 | promotion gate launchd | bots/edu-x/launchd/ai.edux.promotion-gate.plist (+등록) |
| 2 | 다이제스트 스크립트 | bots/edu-x/scripts/runtime-edux-daily-digest.ts |
| 3 | 다이제스트 launchd | bots/edu-x/launchd/ai.edux.daily-digest.plist (10:00) |
| 4 | 새 텔레그램 발송 | digest 전용 봇/채널 (env 주입) |
| 5 | smoke | smoke-edux-daily-digest.ts (포맷·가변건수·링크) |

- 제약: PROTECTED 무중단, 기존 7슬롯 발행 영향 없음, env(봇토큰/채널)는 마스터 주입.
- 선행: promotion gate 복구(2) -> 발행 재개 -> 알람 데이터 확보.
