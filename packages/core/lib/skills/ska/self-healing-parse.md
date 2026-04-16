# SKA Skill: Self-Healing Parse

## 목적
웹페이지 파싱 실패 시 3단계 자동 폴백으로 99%+ 파싱 성공률 유지.
CSS 실패 → XPath 폴백 → LLM 자동 분석 → 셀렉터 자동 재생성.

## 3단계 폴백 체인
```
Level 1: CSS 셀렉터 (빠름, 99% 정상 케이스)
  → 성공: 완료
  → 실패: Level 2로 강등

Level 2: XPath 대안 셀렉터 (CSS 실패 시)
  → 성공: 완료
  → 실패: Level 3으로 강등

Level 3: LLM 파싱 (DOM 변경 대응, on-demand!)
  → Claude Opus → GPT-4o → Groq 폴백 체인
  → 성공: 새 CSS 셀렉터 자동 생성 → candidate 등록
  → 실패: 텔레그램 CRITICAL 알림
```

## 핵심 API

### ParsingGuard (Elixir GenServer)
```elixir
TeamJay.Ska.ParsingGuard.parse(
  html: html_string,
  target: "naver_list",       # 타겟 식별자
  agent: "andy",              # 호출 에이전트
  validate: fn data -> ...    # 검증 함수 (선택)
)
# 반환: {:ok, data, :css | :xpath | :llm} | {:error, :all_failed}
```
- `TeamJay.Ska.ParsingGuard.get_stats/0` — Level별 성공/실패 카운터

### SelectorManager (Elixir GenServer)
- `TeamJay.Ska.SelectorManager.get_active/1` — 타겟의 active 셀렉터 목록
- `TeamJay.Ska.SelectorManager.get_all/1` — 모든 버전 조회
- `TeamJay.Ska.SelectorManager.record_result/2` — 성공/실패 기록
- `TeamJay.Ska.SelectorManager.register_candidate/4` — LLM 생성 셀렉터 등록
- `TeamJay.Ska.SelectorManager.invalidate_cache/1` — 캐시 무효화

## 셀렉터 상태 전이
```
candidate → (5회 연속 성공) → promoted
candidate → (10회 시도 미승격) → deprecated
active    → (5회 연속 실패) → deprecated
promoted  → (5회 연속 실패) → deprecated
```

## Circuit Breaker
- LLM 연속 3회 실패 → 10분 차단
- 차단 중 Level 3 요청 → 즉시 :all_failed 반환

## DB 테이블
- `ska.selector_history` — 셀렉터 버전 이력 (status, consecutive_ok/fail 포함)

## LLM 호출 방식
- `ska-llm-parse.js` Node.js 스크립트 (System.cmd 경유)
- `--payload=<base64>` 인수로 JSON 전달
- 체인: `ska.parsing.level3` | `ska.selector.generate`
- 타임아웃: 15초

## 지원 타겟
- `naver_list_rows` — 네이버 예약 리스트
- `booking_name/phone/date/host/id` — 예약 상세 필드
- `pickko_order_rows` — 픽코 주문 리스트
- `pickko_detail_link/date/start/end/member` — 주문 상세 필드
