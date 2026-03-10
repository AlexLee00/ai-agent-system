# 세션 핸드오프

> 다음 Claude Code 세션에서 이 파일을 먼저 읽어주세요.

## 이번 세션 완료 내역 (2026-03-11)

### 1. 전 팀 LLM 모델 최적화 (7개 변경)

| 변경 | 파일 | 내용 |
|------|------|------|
| 1+2 | `llm-client.js` | GROQ_AGENTS→[nemesis,oracle] / MINI_FIRST_AGENTS 신규[hermes,sophia,zeus,athena] / callOpenAIMini() 추가 / callGroq 폴백 gpt-4o-mini |
| 3 | `pos-writer.js`, `gems-writer.js` | 2순위 gpt-oss-20b → gpt-4o-mini |
| 4 | `star.js` | gpt-4o-mini + scout 폴백 추가 |
| 5 | `claude-lead-brain.js` | sonnet 제거 → gpt-4o → gpt-4o-mini → scout |
| 6 | `archer/config.js` | gpt-4o → gpt-4o-mini |
| 7 | `screening-monitor.js`(신규), `pre-market-screen.js`, 3개 market 파일 | RAG 폴백(24h) + 장애 알림 |

### 2. 루나팀 아르고스 RAG 폴백 인프라

**흐름:**
```
아르고스 실시간 스크리닝
  ✅ 성공 → savePreScreened() 저장 (캐시 갱신)
  ❌ 실패 → loadPreScreenedFallback() (24h TTL)
              ✅ 캐시 있음 → "📚 [RAG 폴백] 재사용 (N분 전)"
              ❌ 없음     → 빈 배열 (domestic/overseas) or config.yaml 기본 (crypto)
           → recordScreeningFailure() — 3회+ 시 텔레그램
```

**신규 파일:** `bots/investment/scripts/screening-monitor.js`
**변경 파일:** `pre-market-screen.js` (PRESCREENED_FILE에 crypto 추가, loadPreScreenedFallback 신규)

### 3. 스카팀 완전 재가동
- 이전 프로세스 정리 + Chrome SingletonLock 제거
- kickstart: ska.commander(59200) / naver-monitor(59205) / kiosk-monitor(59390)

### 4. 이전 세션에서 이어받은 완료 항목
- KIS EXCD 코드 추가 (NIO 등 NYSE 12종목 + 자동 탐색 폴백)
- 종목 기본값 제거 (config.yaml, secrets.js, domestic/overseas.js)
- 제이 커맨드 curriculum_approve/curriculum_status 연동 (intent-parser.js, router.js)
- img-gen.js: gpt-image-1 medium 메인 + Nano Banana 폴백
- 루나팀 LLM 재배치 (luna→gpt-4o, nemesis/oracle→Groq dual)

---

## 다음 세션 할 일

### 루나팀
- [ ] 스크리닝 모니터링 결과 확인 (실제 아르고스 실패 시 RAG 폴백 동작 검증)
- [ ] KIS domestic/overseas PAPER_MODE 30일 검증 지속

### 블로그팀
- [ ] 실제 운영 발행 결과 확인 (내부 링킹 Phase 1 동작 확인)
- [ ] 도서리뷰 네이버 책 API 연동 (book-research.js 테스트)

### 기타
- [ ] 맥미니 M4 Pro 도착 예정: 4월 중순 (이관 준비)

---

## 현재 시스템 상태 (2026-03-11 기준)

| 팀 | 상태 | 주요 프로세스 |
|----|------|-------------|
| 제이팀 | ✅ OPS | OpenClaw 포트18789, 오케스트레이터, TG long-poll |
| 스카팀 | ✅ OPS (재가동) | ska.commander(59200), naver-monitor(59289), kiosk-monitor(59398) |
| 루나팀 | ✅ OPS (크립토) | ai.investment.crypto (PAPER_MODE=false), domestic/overseas PAPER |
| 클로드팀 | ✅ OPS | ai.claude.dexter.quick(5분) + ai.claude.dexter(1h) |
| 블로그팀 | ✅ OPS | ai.blog.daily (06:00 KST) |
| 워커팀 | ✅ OPS | ai.worker.web (포트4000) |
