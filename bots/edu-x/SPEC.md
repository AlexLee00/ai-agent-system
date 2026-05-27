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
- 블록 구분을 명확히 하기 위해 첫 블록 이후 섹션 헤더 앞에는 빈 문단(`<p>&nbsp;</p>`)을 삽입해 2라인 수준의 간격을 만든다.
- 운영 기본값은 이미지 미첨부. `EDUX_IMAGE_ATTACHMENTS_ENABLED=true`가 아닌 경우 `imageUrl`을 넘겨도 전송하지 않는다.
- 무한 재시도 방지 (최대 3회)

### EduxImageUploader (`lib/edux-image-uploader.ts`)
- 보류 경로. 현재 런타임은 이미지 품질 피드백에 따라 업로드/등록하지 않음
- 필요 시 별도 승인 후 POST /api/community/upload (multipart/form-data)로 순차 업로드

### EduxFormatter (`lib/edux-formatter.ts`)
- BTC/USDT 커뮤니티/뉴스 이슈와 공개 시장 데이터 → crypto/KIS/overseas 모두 5블록 커뮤니티형 시황 카드
- 암호화폐 심볼은 게시글/제목/표에서 `BASE/QUOTE` 형식으로 표시한다. 예: `BTC/USDT`, `ETH/USDT`
- 암호화폐 본문 우선순위는 1순위 BTC/USDT 가격 지도와 상승/하락 시나리오, 2순위 커뮤니티/뉴스 이슈, 3순위 루나팀 자동매매 개발/테스트 메모로 고정한다.
- 암호화폐 5블록은 `⚡ 핵심 3줄`, `📌 BTC/USDT 가격 지도`, `📈 상승/하락 시나리오`, `🌐 커뮤니티·뉴스 이슈 Top 3`, `⚠️ 오늘 체크포인트 + 면책`으로 구성한다.
- 국내주식 5블록은 `⚡ 핵심 3줄`, `📌 지수·수급 지도`, `👀 오늘 볼 섹터`, `🌐 커뮤니티·뉴스 이슈 Top 3`, `⚠️ 오늘 체크포인트 + 면책`으로 구성한다.
- 해외주식 5블록은 `⚡ 핵심 3줄`, `📌 지수·리스크 지도`, `💎 Magnificent 7·섹터 지도`, `🌐 커뮤니티·뉴스 이슈 Top 3`, `⚠️ 오늘 체크포인트 + 면책`으로 구성한다.
- 섹션 헤더는 실제 게시글에서 순번 없이 이모지 아이콘만 줄 맨 앞에 표시한다. 예: `⚡ 핵심 3줄`
- crypto/KIS/overseas 게시글은 기본적으로 Hub LLM Gateway를 사용해 초안을 만들고, 품질 게이트 실패 또는 Hub 호출 실패 시 deterministic formatter로 자동 fallback한다. deterministic 강제 운영은 `EDUX_FORMATTER_MODE=deterministic` 또는 카테고리별 `EDUX_CRYPTO_FORMATTER_MODE`, `EDUX_KIS_FORMATTER_MODE`, `EDUX_OVERSEAS_FORMATTER_MODE`로 수행한다.
- 기본 LLM 설정은 `EDUX_FORMATTER_ABSTRACT_MODEL=anthropic_opus`, `EDUX_FORMATTER_SELECTOR_KEY=investment.reporter`이며, Hub selector의 `investment.reporter`는 고성능 시황 작성 체인으로 라우팅한다.
- PROTECTED Hub 재시작 전에도 Edu-X 요청 단의 `policyOverride`로 `openai-oauth/gpt-5.4 → gemini-2.5-pro → qwen/qwen3-32b → gpt-5.4-mini` 체인을 전달한다. 필요 시 `EDUX_FORMATTER_POLICY_OVERRIDE=false`로 중앙 selector-only 운영으로 되돌릴 수 있다.
- 암호화폐 품질 게이트는 `N/A`, `수집 대기`, `데이터 없음` 같은 placeholder를 거부하고 현재가/지지/저항/상승 시나리오/하락 시나리오/무효화 조건/커뮤니티 이슈가 포함됐는지 확인한다.
- 암호화폐 커뮤니티 이슈의 내부 소스명(`luna-community`, `google_news_crypto_rss` 등)과 raw signal(`positive`, `neutral`, `negative`, `bullish`, `bearish`)은 게시글에 노출하지 않고 `커뮤니티 수집`, `뉴스 RSS`, `긍정/중립/주의` 같은 독자용 라벨로 변환한다.
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
| 실 발행 | 7일 검증 실행 35건+ + 마스터 승인 후만 허용. 검증 실행은 이미지 없는 non-fixture dry-run과 실제 API 성공(`[TEST]` one-off 포함)을 인정한다. |
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
3. launchd 5개 로드. 실제 load/unload는 별도 명시 승인 후만 수행한다. 로드 전에는 doctor가 모든 plist의 dry-run 안전값을 검증해야 한다:
   ```bash
   npm --prefix bots/edu-x run -s launchd:doctor -- --json
   npm --prefix bots/edu-x run -s launchd:install-dry-run -- --json
   ```
   - doctor는 `EDUX_DRY_RUN=true`, `EDUX_LIVE_PUBLISH_APPROVED=false`, `EDUX_PROMOTION_GATE_PASSED=false`, `RunAtLoad=false`일 때만 누락된 `ai.edux.*` LaunchAgent를 bootstrap한다.
   - 이미 로드된 LaunchAgent의 plist 내용이 바뀐 경우 `reload_required`로만 보고한다. unload/restart/kickstart는 별도 명시 승인 없이는 수행하지 않는다.
4. 7일 검증 실행 35건+ 검토 → 실 발행 승인. 이미지는 운영 정책상 첨부하지 않는다.

## 8. 절대 금지

- PROTECTED 58 launchd 중단
- secrets-store.json Git 커밋
- 1주 Dry-run 없이 실 발행
- category: "activity" 사용 (일반 피드 노출 불가)
- Notion API 호출
- 무한 재시도
