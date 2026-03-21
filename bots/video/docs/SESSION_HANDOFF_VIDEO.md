# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-21
> 담당: 메티 (claude.ai Opus) + Codex
> 상태: ★ Phase 1 전체 완료 — 과제 1~13 + RAG 피드백 루프

---

## Phase 1 완료 요약

### 구현된 과제 (13 + RAG)
- 과제 1: 스캐폴딩 + DB (`video_edits` 테이블)
- 과제 2: FFmpeg 전처리 (오디오 정규화 + 48kHz + 합성)
- 과제 3: Whisper STT (한국어 SRT)
- 과제 4: LLM 자막 교정 (`gpt-4o-mini` + `gemini` fallback)
- 과제 5: CapCutAPI 드래프트 (선택적 보조, `--with-capcut`)
- 과제 6: 영상 분석 + EDL JSON + FFmpeg 렌더링
- 과제 7: 파이프라인 통합 (`run-pipeline.js` + single-flight lock + watchdog)
- 과제 8: 워커 웹 대화형 영상 편집 (16 API + 대화형 채팅 UI)
- 과제 9: n8n 워크플로우 연동 (webhook + internal dispatch + fallback)
- 과제 10: Critic Agent / RED Team (자막+오디오+영상 구조 분석)
- 과제 11: Refiner Agent / BLUE Team (SRT 수정 + EDL 생성 + 부분 실패 허용)
- 과제 12: Evaluator + 품질 루프 (Critic→Refiner→Evaluator 순환)
- RAG: 피드백 루프 (`video-rag.js`, `rag_video` 컬렉션)
- 과제 13: 5세트 검증 (5/5 성공, 평균 440초, 총 `$0.28`)

### 아키텍처 변경 이력
- CapCut `draft_info.json` 암호화 → EDL JSON 기반으로 전환
- RED/BLUE 팀이 영상 편집(컷/효과/전환)까지 확장
- 프리뷰: FFmpeg 720p + 워커 웹 HTML5 Video+VTT
- n8n: `ExecuteCommand` 거부 → `HTTP Request + internal dispatch API`로 전환

### 5세트 검증 결과
- 세트 1: 파라미터 — 215초, `$0.028`, 71 entries
- 세트 2: 컴포넌트스테이트 — 523초, `$0.051`, 107 entries
- 세트 3: 동적데이터 — 418초, `$0.051`, 101 entries
- 세트 4: 서버인증 — 712초, `$0.091`, 247 entries
- 세트 5: DB생성 — 334초, `$0.054`, 143 entries
- 총 비용: `$0.28 / 5세트` → 월 20영상 환산 `$1.10`

### RAG 축적 현황
- `rag_video`: 7건 (결과 6 + 피드백 1)
- `estimateWithRAG` confidence: `high` (5건 기준)

### 워커 웹 반영 상태
- `npx next build` 성공
- `ai.worker.nextjs` launchd 재기동 완료
- `http://127.0.0.1:4001/video` → `200 OK`
- `http://127.0.0.1:4001/video/history` → `200 OK`

---

## 프로젝트 구조

```text
ai-agent-system/bots/video/
├─ config/video-config.yaml
├─ context/IDENTITY.md
├─ docs/ (CLAUDE.md, VIDEO_HANDOFF.md, design.md, tasks.md, ANALYSIS.md, SESSION_HANDOFF_VIDEO.md)
├─ lib/
│   ├─ ffmpeg-preprocess.js (과제 2)
│   ├─ whisper-client.js (과제 3)
│   ├─ subtitle-corrector.js (과제 4)
│   ├─ capcut-draft-builder.js (과제 5, 선택적)
│   ├─ video-analyzer.js (과제 6)
│   ├─ edl-builder.js (과제 6)
│   ├─ critic-agent.js (과제 10)
│   ├─ refiner-agent.js (과제 11)
│   ├─ evaluator-agent.js (과제 12)
│   ├─ quality-loop.js (과제 12)
│   ├─ video-rag.js (RAG 피드백 루프)
│   └─ video-n8n-config.js (과제 9)
├─ migrations/ (001, 002)
├─ n8n/ (video-pipeline-workflow.json, setup-video-workflow.js)
├─ scripts/ (run-pipeline.js, render-from-edl.js, test-*.js, check-n8n-video-path.js)
├─ src/index.js
├─ samples/ (5세트 raw + narration)
├─ exports/
└─ temp/ (run-* 세션 디렉토리)
```

워커 웹 연동:

```text
bots/worker/web/routes/video-api.js (16 엔드포인트)
bots/worker/web/routes/video-internal-api.js (n8n dispatch)
bots/worker/web/app/video/page.js (대화형 UI)
bots/worker/web/app/video/history/page.js (이력)
```

---

## 현재 상태

### 완료된 구조
- `run-pipeline.js --skip-render` 기준 5세트 preview 원장 복구 완료
- worker-web `/video`, `/video/history` 빌드와 런타임 반영 완료
- n8n live webhook + direct fallback + worker secret 영속화 완료
- Critic / Refiner / Evaluator / quality-loop / RAG feedback loop 구현 완료

### 남은 핵심 과제
- `preview_ms`를 `video_edits` 원장에 별도 저장
- 5세트 기준 final render 다세트 실검증
- 품질 루프 수렴률 개선
- RAG 샘플 수를 늘려 추천 품질과 예상 시간 정확도 향상

---

## 다음 세션에서 해야 할 것

### 즉시
- `preview_ms` 원장 고도화
- final render 다세트 검증
- worker-web 세트별 상태/예상시간 표시 세분화

### 이후
- 품질 루프 수렴률 개선
- RAG 축적량 확대 후 추천/추정 품질 재평가
- 비디오팀 local LLM 계층 도입 준비 (맥미니 도착 이후)

---

## 인수인계 메모

- Phase 1 범위는 구현/검증/문서 기준으로 닫혔다.
- 다음 세션은 새 기능 추가보다 먼저 `final render` 운영 검증과 원장 고도화부터 보는 것이 자연스럽다.
- 비디오팀은 워커 웹과 강하게 연결되지만, 도메인 로직은 별도 팀으로 유지하는 현재 구조가 맞다.
