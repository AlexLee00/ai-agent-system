# bots/edu-x — Edu-X 커뮤니티 자동 기여 봇 SPEC

> 작성: 2026-05-20 | 버전: v1.0 | 팀: 팀 제이 7번째 봇

## 1. Problem

Edu-X (edu-x.io) 플랫폼 자유게시판에 BTC/USDT 커뮤니티/뉴스 이슈와 공개 시장 데이터를 기반으로 일일 5회 자동 게시글 작성.
비용 $0, 기존 수집 데이터와 공개 API를 활용, Dry-run 1주 검증 후 실 발행.

## 2. Components

### EduxClient (`lib/edux-client.ts`)
- JWT 인증 (login / refreshAccess / health / logout)
- 401 자동 갱신, 429 retryAfter 백오프
- POST /api/community/posts (category: "free" 고정)
- 게시 본문은 웹 렌더링용 HTML 블록(`<h3>`, `<p>`)으로 전송해 줄바꿈을 보존
- 운영 기본값은 이미지 미첨부. `imageUrl`은 명시적으로 URL이 있을 때만 전송
- 무한 재시도 방지 (최대 3회)

### EduxImageUploader (`lib/edux-image-uploader.ts`)
- 보류 경로. 현재 런타임은 이미지 품질 피드백에 따라 업로드/등록하지 않음
- 필요 시 별도 승인 후 POST /api/community/upload (multipart/form-data)로 순차 업로드

### EduxFormatter (`lib/edux-formatter.ts`)
- BTC/USDT 커뮤니티/뉴스 이슈와 공개 시장 데이터 → 암호화폐는 5블록 커뮤니티형 시황 카드, KIS/overseas는 10섹션 표준 게시글
- 암호화폐 심볼은 게시글/제목/표에서 `BASE/QUOTE` 형식으로 표시한다. 예: `BTC/USDT`, `ETH/USDT`
- 암호화폐 본문 우선순위는 1순위 BTC/USDT 가격 지도와 상승/하락 시나리오, 2순위 커뮤니티/뉴스 이슈, 3순위 루나팀 자동매매 개발/테스트 메모로 고정한다.
- 암호화폐 5블록은 `⚡ 핵심 3줄`, `📌 BTC/USDT 가격 지도`, `📈 상승/하락 시나리오`, `🌐 커뮤니티·뉴스 이슈 Top 3`, `⚠️ 오늘 체크포인트 + 면책`으로 구성한다.
- 섹션 헤더는 실제 게시글에서 순번 없이 이모지 아이콘만 줄 맨 앞에 표시한다. 예: `⚡ 핵심 3줄`
- 암호화폐 게시글은 번역 오류 방지를 위해 기본 deterministic formatter를 사용한다. LLM 초안은 `EDUX_CRYPTO_FORMATTER_MODE=llm`일 때만 사용한다.
- 암호화폐 품질 게이트는 `N/A`, `수집 대기`, `데이터 없음` 같은 placeholder를 거부하고 현재가/지지/저항/상승 시나리오/하락 시나리오/무효화 조건/커뮤니티 이슈가 포함됐는지 확인한다.
- 암호화폐 커뮤니티 이슈의 내부 소스명(`luna-community`, `google_news_crypto_rss` 등)과 raw signal(`positive`, `neutral`, `negative`, `bullish`, `bearish`)은 게시글에 노출하지 않고 `커뮤니티 수집`, `뉴스 RSS`, `긍정/중립/부정` 같은 독자용 라벨로 변환한다.
- 글자수 hard gate는 두지 않고 중복 없는 자연스러운 본문을 우선한다.
- 루나팀 자동매매는 개발/테스트 중인 내부 자동화로만 언급하며, 권위 있는 매매 근거처럼 표현하지 않는다.
- 3 카테고리 차별: crypto / kis / overseas
- 제목은 슬롯 지역명(아시아/유럽/미국)을 넣지 않고 날짜 + 자산/지수 중심으로 생성
- Hub LLM Gateway (Sonnet 4.6, M 매핑)

### EduxImageGenerator (`lib/edux-image-generator.ts`)
- 보류 경로. smoke 검증용으로 유지하되 runtime 게시에는 사용하지 않음
- matplotlib 차트: `python/chart-generator.py` subprocess 호출
- TradingView read-only bars: PROTECTED `ai.luna.tradingview-ws`의 `/latest`를 조회하고 실패 시 matplotlib fallback 사용
- /tmp/edux-images/{date}/{slot}_{type}.png 임시 저장

### Runtime Scripts
| 파일 | 슬롯 | 카테고리 |
|------|------|----------|
| `runtime-edux-crypto-daily.ts` | 06:00, 14:00, 22:30 KST | 암호화폐 |
| `runtime-edux-kis-daily.ts` | 09:00 KST | 국내주식 |
| `runtime-edux-overseas-daily.ts` | 22:00 KST | 해외주식 |

## 3. Control Plane

```
루나팀 DB (investment.external_evidence_events community BTC evidence)
  → runtime-edux-*.ts
  → EduxFormatter (Hub LLM Sonnet 4.6)
  → HTML 블록 변환 (웹 줄바꿈 보존)
  → EduxClient (POST /api/community/posts)
  → edux_publish_log (PostgreSQL jay DB)
  → Telegram 알림
```

## 4. 발행 일정 (launchd, KST)

| launchd Label | 슬롯 | 카테고리 |
|---------------|------|----------|
| `ai.edux.crypto-daily-0600` | 06:00 | 암호화폐 #1 |
| `ai.edux.kis-daily-0900` | 09:00 | 국내주식 (장시작 30분 전) |
| `ai.edux.crypto-daily-1400` | 14:00 | 암호화폐 #2 |
| `ai.edux.overseas-daily-2200` | 22:00 | 해외주식 (NY 30분 전) |
| `ai.edux.crypto-daily-2230` | 22:30 | 암호화폐 #3 |

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
| Live 차단 | `EDUX_DRY_RUN=false`만으로는 불가. `EDUX_LIVE_PUBLISH_APPROVED=true`, `EDUX_PROMOTION_GATE_PASSED=true`, promotion report PASS 필요 |

## 6. DB 테이블

```
jay DB → edux_publish_log
  - category: crypto / kis / overseas
  - schedule_slot: 0600 / 0900 / 1400 / 2200 / 2230
  - status: success / fail / skipped / dry_run
```

## 7. 마스터 필요 작업

1. edu-x.io 봇 계정 생성 (일반 회원가입)
2. Hub secret `edux`에 아래 값을 등록한다. 구현/검증 중에는 secret 파일을 직접 수정하지 않는다:
   ```json
   "edux": {
     "base_url": "https://edu-x.io",
     "bot_email": "실제 이메일",
     "bot_password": "실제 비밀번호"
   }
   ```
3. launchd 5개 로드. 실제 load/unload는 별도 명시 승인 후만 수행:
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
