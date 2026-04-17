# TRACKER.md — 다윈팀 작업 추적

> 최종 업데이트: 2026-04-18 (40차 세션)

## 현재 상태 요약

```
자율 레벨: L4 (path_error_fixed_prototypes_allowed)
연속 성공: 0 (리모델링 후 리셋)
적용 성공: 0
마지막 스캔: -
마지막 구현: -
```

## 40차 세션 작업 내역

### 완료
- [x] CODEX_DARWIN_REMODEL Phase 0-6 전체 구현
- [x] bots/darwin/elixir/ 독립 구조 확립
- [x] Darwin.V2.* 네임스페이스 40+ 모듈 생성
- [x] Phase 7: 커뮤니티 스캐너 (ArxivRSS/HackerNews/Reddit/OpenReview 센서 4종 + CommunityScanner)
- [x] Phase 8: 테스트 335개 (0 failures) — `mix test` 통과
- [x] DB 마이그레이션 5개 생성 (priv/repo/migrations/)
  - 20260418000001: darwin_v2_llm_routing_log + darwin_llm_cost_tracking
  - 20260418000002: darwin_papers_embeddings (pgvector 1024차원)
  - 20260418000003: darwin_v2_shadow_runs
  - 20260418000004: darwin_v2_principle_violations
  - 20260418000005: darwin_v2_reflexion_memory
- [x] rollback_scheduler.ex 컴파일 경고 2건 수정
- [x] test/test_helper.exs integration/db/pending 태그 exclude 설정

### 다음 작업 (41차 세션)
- [ ] Shadow Mode 7일 관찰 (avg_match ≥ 95% 달성 확인)
- [ ] `DARWIN_V2_ENABLED=true` OPS 환경변수 설정 (마스터 승인 후)
- [ ] DB 마이그레이션 OPS 적용 (`mix darwin.migrate`)
- [ ] Tier 1 → Tier 2 자동 승급 조건 모니터링

## 파일 목록 (Darwin V2)

```
bots/darwin/elixir/lib/darwin/v2/
├── supervisor.ex           ✅ (기존)
├── kill_switch.ex          ✅ (기존)
├── signal.ex               ✅ 신규
├── autonomy_level.ex       ✅ 신규
├── reflexion.ex            ✅ 신규
├── self_rag.ex             ✅ 신규
├── espl.ex                 ✅ 신규
├── memory.ex               ✅ 신규
├── memory/
│   ├── l1_session.ex       ✅ 신규
│   └── l2_pgvector.ex      ✅ 신규
├── llm/
│   ├── selector.ex         ✅ 신규
│   ├── cost_tracker.ex     ✅ 신규
│   └── routing_log.ex      ✅ 신규
├── principle/
│   └── loader.ex           ✅ 신규
├── skill/
│   ├── evaluate_paper.ex   ✅ 신규
│   ├── plan_implementation.ex ✅ 신규
│   └── learn_from_cycle.ex ✅ 신규
├── cycle/
│   ├── discover.ex         ✅ 신규
│   ├── evaluate.ex         ✅ 신규
│   ├── plan.ex             ✅ 신규
│   ├── implement.ex        ✅ 신규
│   ├── verify.ex           ✅ 신규
│   ├── apply.ex            ✅ 신규
│   └── learn.ex            ✅ 신규
├── mcp/
│   └── server.ex           ✅ 신규
└── commander.ex            ✅ 신규
```
