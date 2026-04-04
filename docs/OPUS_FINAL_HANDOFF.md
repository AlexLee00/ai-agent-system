# 세션 인수인계 — 2026-04-04

> 이전 세션: /mnt/transcripts/2026-04-04-02-42-42-2026-04-04-blog-stabilize-gemma4-image.txt
> 이전 트랜스크립트 카탈로그: /mnt/transcripts/journal.txt

---

## 오늘 세션 완료 작업 (13커밋!)

### 1. 블로팀 3대 이슈 검증 ✅
- 인사말 반복 금지 (Group B/C/D) — 코덱스 적용 확인
- 도서 선정 완화 (uniqueSources 2→1) — 적용 확인
- ε-greedy 자율적 고용 (EPSILON=0.2 + taskHint) — 테스트 통과

### 2. 도서리뷰 ISBN 수정 ✅
- 원인: 스케줄 도서에 ISBN 미저장 → quality-checker error 거부
- 수정1: blo.js scheduledBook 정규화 + ISBN 보충 (resolveBookForReview)
- 수정2: quality-checker.js ISBN error→warn 완화
- 실전 확인: 품질 ✅ 9936자, AI리스크 low, 이슈 0건, ISBN 9791186659489

### 3. 이미지 품질 향상 — 3단계 완료 ✅
- Step 1: ComfyUI CPU→MPS 전환 (devices: mps) ✅
- Step 2: 설정 최적화 (플래그 + runtime fallback 보강) ✅
- Step 3: FLUX 모델 설치 + 동작 확인 ✅
  - flux1-dev-Q8_0.gguf + ComfyUI-GGUF + clip_l + t5xxl + ae
  - FLUX 10-step: ~195초 (MPS)
  - 이중 경로 확정: 도서리뷰 대표=FLUX, 나머지=SDXL

### 4. Phase A 기반안정화 100% 완료 ✅
- A-1: book_info 정규화 ✅
- A-2: 이미지 안정화 ✅
- A-3: blog-utils.js 공용 함수 추출 ✅ (ea66034)
  - weatherToContext (detailed 옵션으로 차이 보존)
  - estimateCost
  - loadPersonaGuide

### 5. Gemma 4 도입 검토 + 프롬프트 ✅
- 커뮤니티 서칭: 출시 2일차, Apache 2.0, 4모델
- 26B MoE (3.8B active) = M4 Max 36GB 최적
- 마스터 판단 "올라마 테스트만, MLX는 아직" = 100% 적절
- Phase1(Ollama)→Phase2(MLX 2주후)→Phase3(본격운영)

### 6. 블로팀 전략기획서 v2 ✅
- docs/strategy/blog-strategy-v2.md (382줄)
- 26에이전트, 일일 파이프라인, 커뮤니티 벤치마크
- 5 Phase 로드맵: A→B→C→D→E + 일정 확정

### 7. 네이버 API/MCP 조사 ✅
- MCP 서버 8개+ 존재 (전부 오픈소스 MIT)
- 결론: MCP보다 직접 API 호출이 우리 시스템에 적합
- 블로그 글쓰기 API: 있음 (OAuth 필요), 임시저장: 불가
- 예약 발행: 공식 API에 없음
- 발행 방식: 현재 유지 (구글드라이브 → 제이 검토 → 수동 발행)

### 8. 클로드 코드 유출 분석 + 전체 아키텍처 비교 ✅
- docs/research/RESEARCH_CLAUDE_CODE_LEAK.md (391줄)
- docs/research/RESEARCH_TEAM_ARCHITECTURE_REVIEW.md (349줄)
- 9영역 비교: 에이전트/메모리/도구/컨텍스트/보안/실패처리
- Top3 Gap: 컨텍스트압축 + 연속실패제한 + 야간메모리증류
- Top5 강점: 멀티팀경쟁 + 도메인특화 + Doctor자율복구 + 4단계폴백 + StandingOrders

---

## 핵심 결정 사항

```
[DECISION] 카테고리 7개 순환 = 의도된 정상 동작 (도서리뷰 재발행 = 이전 품질 미달)
[DECISION] 이미지: SDXL(기본) + FLUX(도서리뷰 대표만) 이중 경로
[DECISION] ComfyUI: CPU→MPS 전환 완료
[DECISION] Gemma 4: Ollama 테스트 → 2주 후 MLX 시범 배치
[DECISION] 네이버 API: MCP보다 직접 호출 적합, 임시저장 불가
[DECISION] 블로그 발행: 현재 방식 유지 (구글드라이브 → 제이 검토 → 수동 발행)
[DECISION] 클로드 코드 패턴: 연구 문서로 정리, 추가 검토 후 점진 적용
```

---

## PENDING 작업

### 블로팀 일정 (확정)

```
✅ Phase A: 기반 안정화  — 04-04 완료!!
📋 Phase B: 피드백 루프  — 04-07 (월) ~ 04-11 (금)
   B-1 성과→RAG, B-2 생성반영, B-3 Standing Orders, B-4 대시보드
📋 Phase C: SEO + GEO    — 04-14 (월) ~ 04-18 (금)
   C-1 네이버키워드API, C-2 SEO스킬, C-3 GEO스킬, C-4 이중채점
📋 Phase D: 콘텐츠 심화  — 04-21 (월) ~ 05-02 (금)
   D-1 팩트체크, D-2 아웃라인, D-3 멀티모달, D-4 크로스플랫폼
📋 Phase E: 자율 진화    — 05-05 (월) ~ 지속
```

### 전체 시스템 (CC 패턴 적용)

```
📋 P0: llm-fallback.js 연속 실패 제한 (3줄 추가)
📋 P0: self-improving Strict Write Discipline
📋 P1: context-compactor.js (MicroCompact)
📋 P1: nightly-distill.js (야간 메모리 증류)
📋 각 팀별 심층 딥 분석 (순차 진행)
```

### 기타

```
📋 FLUX steps 28→10 미반영 원인 추적
📋 Gemma 4 Ollama 테스트 (e4b + 26b MoE)
📋 첫 경쟁 결과 확인 (월요일)
📋 LLM 모델 재편성 수정 2건 검증
```

---

## 핵심 파일 경로

```
전략:
  docs/strategy/blog-strategy-v2.md (382줄) — 블로팀 전략기획서 v2

연구:
  docs/research/RESEARCH_CLAUDE_CODE_LEAK.md (391줄) — CC vs TJ 비교
  docs/research/RESEARCH_TEAM_ARCHITECTURE_REVIEW.md (349줄) — 9팀 전수 분석

코덱스 프롬프트:
  docs/codex/CODEX_PHASE_A_STABILIZE.md — Phase A 기반안정화
  docs/codex/CODEX_PHASE_A3_BLOG_UTILS.md — 공용 함수 추출
  docs/codex/CODEX_BOOK_REVIEW_ISBN_FIX.md — ISBN 보충 + 품질 완화
  docs/codex/CODEX_IMAGE_QUALITY_IMPROVE.md — MPS + FLUX + 최적화
  docs/codex/CODEX_GEMMA4_ROLLOUT.md — Gemma 4 도입 3Phase
  docs/codex/CODEX_BLOG_THREE_ISSUES.md — 3대 이슈 수정

구현:
  packages/core/lib/blog-utils.js — 공용 함수 (신규!)
  bots/blog/lib/img-gen.js — SDXL+FLUX 이중 경로
  bots/blog/config/comfyui-workflow-flux.json — FLUX 워크플로우
  bots/hub/lib/runtime-profiles.js — image-local-flux 프로필
  packages/core/lib/runtime-selector.js — Hub fallback 보강

인수인계: docs/OPUS_FINAL_HANDOFF.md (본 문서)

연구:
  docs/research/RESEARCH_CLAUDE_CODE_LEAK.md (391줄) — CC vs TJ 아키텍처 비교
  docs/research/RESEARCH_TEAM_ARCHITECTURE_REVIEW.md (349줄) — 9팀 전수 분석
  docs/research/RESEARCH_AGENT_HARNESS.md (417줄) — 에이전트 하네스 & 에이전틱 AI 심층 연구
```

---

## 에이전트 하네스 연구 핵심 (신규!)

```
"에이전트 루프는 20줄. 하네스는 512,000줄." — CC에서 증명

5대 난제 + CC 해법 + 우리 적용:
  ① 권한: "시도 vs 허용" 분리 → 스킬별 permission 필드
  ② 도구: "80% 제거하니 결과 좋아짐" → 팀별 도구 서브셋 제한
  ③ 서브에이전트: 격리 워크트리 + 캐시 공유 → AgentTool 패턴
  ④ 메모리: Strict Write Discipline + autoDream → 성공시만 기록 + 야간 증류
  ⑤ 컨텍스트: 4단계 압축 → context-compactor.js

적용 로드맵 11건:
  P0: 연속실패제한 + Strict Write Discipline
  P1: 도구권한 + 야간증류 + Progressive Disclosure
  P2: 컨텍스트압축 + 메일박스 + AgentTool
  P3: AutoCompact + 프롬프트오케스트레이션 + Build to Delete

상세: docs/research/RESEARCH_AGENT_HARNESS.md 참조
```
