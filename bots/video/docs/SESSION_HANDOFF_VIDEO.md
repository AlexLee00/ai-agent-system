# 비디오팀 세션 인수인계

> 세션 날짜: 2026-03-21
> 담당: 메티 (claude.ai Opus) + Codex
> 상태: ★ Phase 1 전체 완료 — 과제 1~13 + RAG 피드백 루프
> Phase 2 전환: 2026-03-21
> syncVideoAudio() 폐기 → AI 싱크 매칭 파이프라인으로 전환
> 과제 A(scene-indexer) + B(narration-analyzer) + C(sync-matcher) + D(intro-outro) 구현 중

---

## Phase 2 현재 상태

- `scene-indexer.js`, `narration-analyzer.js`, `sync-matcher.js`, `intro-outro-handler.js`가 추가됐다.
- `run-pipeline.js`는 이제 `scene-indexer -> narration-analyzer -> sync-matcher -> intro/outro -> syncMapToEDL` 흐름을 사용한다.
- worker-web `/video`는 5단계 흐름(업로드 → 인트로 → 아웃트로 → 의도 → 시작)으로 확장됐다.
- `video_sessions`에는 `intro_mode`, `intro_prompt`, `intro_duration_sec`, `outro_mode`, `outro_prompt`, `outro_duration_sec` 컬럼이 추가됐다.
- 현재 런타임 검증 경계:
  - OCR은 `tesseract.js` 기본 경로에 더해 로컬 `tesseract` CLI fallback을 테스트 레일에 붙였다.
  - STT/LLM은 샌드박스 네트워크 제약 시 오프라인 fixture fallback으로 테스트를 이어간다.

### 2026-03-22 검증 메모

- `test-scene-indexer.js --source-video=원본_파라미터.mp4`
  - `duration_s=1410.45`
  - `total_frames_captured=141`
  - `unique_frames=42`
  - `scene_count=42`
- `test-narration-analyzer.js --source-audio=원본_나레이션_파라미터.m4a`
  - 샌드박스 네트워크 제약으로 `offline fixture fallback`
  - fallback 세그먼트를 3등분 고정에서 공용 fixture 5세그먼트 구조로 보강
  - `total_entries=5`, `total_segments=5`
- `test-sync-matcher.js`
  - 더미 기준 `matched_keyword=2/2`
  - `overall_confidence=0.8334`
- `test-full-sync-pipeline.js`
  - `scene_count=42`
  - `segment_count=5`
  - `keyword=5`, `embedding=0`, `hold=0`, `unmatched=0`
  - `sync_confidence=0.6`
  - `intro_prompt.mp4` 생성 확인

해석:
- 원본 장면 인덱싱 품질 자체는 usable 수준이다.
- 현재 가장 큰 병목은 `scene-indexer`가 아니라 샌드박스 제약 시 narration 분석이 live STT가 아니라 fallback으로 내려간다는 점이다.
- fallback 세그먼트 granularity 보강 후 첫 구간 `unmatched`는 해소됐다.
- 다음 Phase 2 보강 1순위는 `preview_ms` 원장화와 실제 preview/final render 품질 검증으로 옮겨간다.

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
- `video_sessions.company_id`를 worker 회사 ID 체계와 맞춰 `TEXT`로 보정 완료
- 업로드 UI는 드래그앤드롭 + 아이콘 클릭 + 버튼 클릭 3가지 입력 경로를 모두 지원하도록 보강 완료
- 한글 파일 업로드 시 `original_name`이 깨지던 문제를 UTF-8 복원 경계로 보정 완료
- `/video`는 현재 세션 ID를 URL `?session=` + `localStorage`에 동기화해 새로고침 후에도 진행 세션 복원이 가능하도록 보강 완료
- `POST /sessions/:id/start`는 n8n 응답만 신뢰하지 않고 실제 `video_edits(session_id, pair_index)` 생성까지 확인하며, 미생성 시 direct fallback으로 재실행하도록 보강 완료

### 이번 세션 운영 복구 메모
- 실제 테스트 세션은 `video_sessions.id=1`
- 새로고침과 첨부파일 수정이 겹치며 세션 컨텍스트가 끊겼고, 한동안 `video_edits`가 생성되지 않아 worker-web 화면에는 `자동 편집 진행중`만 남는 상태가 발생했다
- 세션 1은 direct recovery로 `video_edits.id=16`, trace `f84aa3f6-329e-43af-8eac-ae6f8eeaf474`를 다시 생성해 파이프라인을 복구했다
- 세션 1 프리뷰 검은 화면 원인은 `edl-builder.js`의 연속 `fade in/out` transition 렌더 로직이었다
- 임시 조치로 렌더 단계에서는 `transition` edit를 적용하지 않고 EDL 원장에만 유지하도록 바꿨다
- 다음 세션 시작점은 세션 1 `preview.mp4` 재검증과 올바른 segment 기반 transition 렌더(`xfade` 계열) 설계다

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
- worker-web `/video` 세션 복원, 업로드 파일명 복구, n8n start 검증 fallback까지 운영 경계 보강 완료

### 남은 핵심 과제
- `preview_ms`를 `video_edits` 원장에 별도 저장
- 5세트 기준 final render 다세트 실검증
- 품질 루프 수렴률 개선
- RAG 샘플 수를 늘려 추천 품질과 예상 시간 정확도 향상
- transition 렌더를 다시 도입하되 검은 화면이 생기지 않도록 segment 기반 설계로 교체

---

## 다음 세션에서 해야 할 것

### 즉시
- `preview_ms` 원장 고도화
- final render 다세트 검증
- worker-web 세트별 상태/예상시간 표시 세분화
- 세션 1 (`id=1`, edit `id=16`, trace `f84aa3f6-329e-43af-8eac-ae6f8eeaf474`) 프리뷰 재렌더 결과 시각 검증
- `transition` 렌더 임시 비활성화 상태를 `xfade` 또는 구간 분할 기반 구현으로 대체
- `preview_ms` 원장 저장
- `sync_map` 기준선으로 실제 preview/final render 품질 검증

### 이후
- 품질 루프 수렴률 개선
- RAG 축적량 확대 후 추천/추정 품질 재평가
- 비디오팀 local LLM 계층 도입 준비 (맥미니 도착 이후)

---

## 인수인계 메모

- Phase 1 범위는 구현/검증/문서 기준으로 닫혔다.
- 다음 세션은 새 기능 추가보다 먼저 `final render` 운영 검증과 원장 고도화부터 보는 것이 자연스럽다.
- 비디오팀은 워커 웹과 강하게 연결되지만, 도메인 로직은 별도 팀으로 유지하는 현재 구조가 맞다.
