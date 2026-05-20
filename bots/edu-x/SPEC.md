# bots/edu-x — Edu-X 커뮤니티 자동 기여 봇 SPEC

> 작성: 2026-05-20 | 버전: v1.0 | 팀: 팀 제이 7번째 봇

## 1. Problem

Edu-X (edu-x.io) 플랫폼 자유게시판에 루나팀 분석 데이터를 기반으로 일일 5회 자동 게시글 작성.
비용 $0, 루나팀 기존 데이터 100% 활용, Dry-run 1주 검증 후 실 발행.

## 2. Components

### EduxClient (`lib/edux-client.ts`)
- JWT 인증 (login / refreshAccess / health / logout)
- 401 자동 갱신, 429 retryAfter 백오프
- POST /api/community/posts (category: "free" 고정)
- 무한 재시도 방지 (최대 3회)

### EduxImageUploader (`lib/edux-image-uploader.ts`)
- POST /api/community/upload (multipart/form-data)
- 순차 업로드 (Rate Limit 준수)
- URL 반환 → EduxClient.post()의 imageUrl에 삽입

### EduxFormatter (`lib/edux-formatter.ts`)
- 루나팀 데이터 → 10 섹션 표준 게시글 (1,800~2,500자)
- 3 카테고리 차별: crypto / kis / overseas
- Hub LLM Gateway (Sonnet 4.6, M 매핑)

### EduxImageGenerator (`lib/edux-image-generator.ts`)
- matplotlib 차트: `python/chart-generator.py` subprocess 호출
- TradingView 캡처: 루나팀 tradingview-ws 활용
- /tmp/edux-images/{date}/{slot}_{type}.png 임시 저장

### Runtime Scripts
| 파일 | 슬롯 | 카테고리 |
|------|------|----------|
| `runtime-edux-crypto-daily.ts` | 06:00, 14:00, 22:30 KST | 암호화폐 |
| `runtime-edux-kis-daily.ts` | 09:00 KST | 국내주식 |
| `runtime-edux-overseas-daily.ts` | 22:00 KST | 해외주식 |

## 3. Control Plane

```
루나팀 DB (investment.signals community_sentiment)
  → runtime-edux-*.ts
  → EduxFormatter (Hub LLM Sonnet 4.6)
  → EduxImageGenerator (matplotlib + TradingView)
  → EduxImageUploader (POST /api/community/upload)
  → EduxClient (POST /api/community/posts)
  → edux_publish_log (PostgreSQL jay DB)
  → Telegram 알림
```

## 4. 발행 일정 (launchd, KST)

| launchd Label | 슬롯 | 카테고리 |
|---------------|------|----------|
| `ai.edux.crypto-daily-0600` | 06:00 | 암호화폐 #1 (아시아) |
| `ai.edux.kis-daily-0900` | 09:00 | 국내주식 (장시작 30분 전) |
| `ai.edux.crypto-daily-1400` | 14:00 | 암호화폐 #2 (유럽) |
| `ai.edux.overseas-daily-2200` | 22:00 | 해외주식 (NY 30분 전) |
| `ai.edux.crypto-daily-2230` | 22:30 | 암호화폐 #3 (미국) |

## 5. Safety

| 항목 | 내용 |
|------|------|
| pre-rollback 태그 | `pre-edux-integration-YYYYMMDD-HHMM` |
| Shadow Mode | `EDUX_DRY_RUN=true` — 1주 검증 후 실 발행 |
| PROTECTED launchd | 기존 58개 무중단, 신규 5개만 추가 |
| Hub LLM Gateway | 모든 LLM → hub-client.ts 경유 |
| BillingGuard | Hub LLM 비정상 호출 시 자동 정지 |
| Rate Limit | 429 retryAfter 준수, 최대 3회 재시도 |
| 실 발행 | 1주 Dry-run + 마스터 승인 후만 허용 |

## 6. DB 테이블

```
jay DB → edux_publish_log
  - category: crypto / kis / overseas
  - schedule_slot: 0600 / 0900 / 1400 / 2200 / 2230
  - status: success / fail / skipped / dry_run
```

## 7. 마스터 필요 작업

1. edu-x.io 봇 계정 생성 (일반 회원가입)
2. `secrets-store.json`에 추가:
   ```json
   "edux": {
     "base_url": "https://edu-x.io",
     "bot_email": "실제 이메일",
     "bot_password": "실제 비밀번호"
   }
   ```
3. launchd 5개 로드:
   ```bash
   for f in bots/edu-x/launchd/ai.edux.*.plist; do
     cp "$f" ~/Library/LaunchAgents/ && launchctl load "$f"
   done
   ```
4. 1주 Dry-run 검토 → 실 발행 승인

## 8. 절대 금지

- PROTECTED 58 launchd 중단
- secrets-store.json Git 커밋
- 1주 Dry-run 없이 실 발행
- category: "activity" 사용 (일반 피드 노출 불가)
- Notion API 호출
- 무한 재시도
