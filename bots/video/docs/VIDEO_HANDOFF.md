# 비디오팀 인수인계 허브

> 최종 업데이트: 2026-03-21
> 상태: ★ Phase 1 전체 완료 (과제 1~13 + RAG 피드백 루프) / worker-web `/video`, `/video/history` 빌드·런타임 반영 완료 / 비디오팀 n8n 연동 live 검증 완료 / worker-web 세션 복원·업로드 경계 복구 완료

---

## 문서 링크

```
★ 현재 위치: bots/video/docs/ (개발 중 코드 옆 배치)
★ 안정화 후: docs/video/ 로 이동 (프로젝트 문서 체계 통합)

┌───────────────────────────────┬────────────────────────────────────────┐
│ 문서                           │ 용도                                    │
├───────────────────────────────┼────────────────────────────────────────┤
│ CLAUDE.md                     │ 구현 규칙 + YouTube 렌더링 확정값       │
│                               │ Claude Code 시작 전 우선 참조 문서      │
├───────────────────────────────┼────────────────────────────────────────┤
│ VIDEO_HANDOFF.md              │ 이 파일 (인수인계 허브)                 │
│                               │ 안정화 후 → docs/VIDEO_HANDOFF.md      │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-automation-tech-plan.md │ 기술 구현 방안 전체 (933행)              │
│                               │ 아키텍처, 비용, RED/BLUE, 로드맵        │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-team-design.md          │ 설계 문서 (모듈 매핑 + 기능목록)        │
│                               │ 기존 15개 모듈 재사용 매핑              │
│                               │ 신규 10개 모듈 목록 + 작업 위치         │
│                               │ DB 스키마, config, 워커 웹 연동 설계    │
├───────────────────────────────┼────────────────────────────────────────┤
│ video-team-tasks.md           │ 소과제 13개 분류 + Claude Code 프롬프트 │
│                               │ Week 1 (7과제) + Week 2 (6과제)        │
│                               │ + Week 3 최종 테스트 + 문서 이동        │
├───────────────────────────────┼────────────────────────────────────────┤
│ SESSION_HANDOFF_VIDEO.md      │ 세션 로그 / LMS 구조 학습 메모          │
│                               │ 현재 상태와 다음 작업 경계 기록         │
└───────────────────────────────┴────────────────────────────────────────┘
```

## 핵심 아키텍처 요약

```
워커 웹 = 대화형 영상 편집 UI (프리뷰 + 프레임 단위 편집 의견 + 다운로드)
FFmpeg = 영상 분석 + 프리뷰 렌더링 + 최종 렌더링
EDL JSON = 편집 결정 목록 (컷/전환/효과/속도/오버레이)
RED Team (Critic) = 자막 + 오디오 + ★영상 구조 분석 → 편집 권고
BLUE Team (Refiner) = 자막 수정 + 오디오 조정 + ★EDL 생성/수정
CapCutAPI = 선택적 보조 프리뷰 (--with-capcut 플래그, 기본 비활성)
비용: 월 $1.12 (Whisper + LLM, 나머지 전부 $0)

파이프라인 흐름:

원본 + 나레이션 업로드
FFmpeg 전처리 (오디오 정규화 + 합성)
Whisper STT → SRT 생성
LLM 자막 교정
FFmpeg 영상 분석 (무음/정지/씬전환 감지)
RED/BLUE 품질 루프 (자막+오디오+영상 편집)
프리뷰 생성 (720p + EDL 적용)
영상제작팀 프리뷰 검토 (프레임 단위 피드백 가능)
피드백 → Refiner 재실행 (필요시)
OK → FFmpeg 최종 렌더링 (1440p/24Mbps)

UX 흐름 (9단계):
  1. 웹에서 영상+음성 다중 업로드 (순서대로)
  2. 편집 의도 수집 ("자막 크게 해주세요")
  3. 파일 수집 확인 (매칭 표시)
  4. AI 편집 진행 (RAG 예상시간 + 실시간 진행률)
  5. 1차 완료 (품질 점수)
  6. 프리뷰 확인 (720p + 자막 + EDL 편집 적용)
  7. 웹에서 컨펌/재편집 입력
  8. FFmpeg 최종 렌더링
  9. 완료본 웹에서 다운로드
```

## 기존 모듈 재사용 (15개, 수정 0줄)

```
pg-pool / llm-router / llm-model-selector / llm-fallback / llm-logger
llm-keys / telegram-sender / n8n-runner / n8n-webhook-registry
heartbeat / kst / trace / tool-logger / rag / rag-safe
```

## 개발 원칙

```
1. 단계적 구현: 과제 단위로 구현, 한번에 전부 만들지 않음
2. 단위 테스트 필수: 각 과제 완료 시 단위 테스트 통과 후 다음 진행
3. 최종 테스트: Week 3에 통합 테스트(4 시나리오) + 품질 테스트 수행
4. 커밋 규칙: 과제 1개 완료 = 1 커밋 (테스트 포함)
5. 모든 개발 종료 시 문서 업데이트 + 커밋 + push까지 완료
```

## 에이전트 역할 경계

```
- Claude (대화형 기획/전략 문맥):
  - bots/video 폴더의 문서를 읽고 구조를 해석하는 역할
  - 구현 프롬프트 작성, 설계 검토, 작업 순서 정리에 집중
  - 코드 직접 수정 주체로 가정하지 않음

- 코덱(Codex) 또는 Claude Code:
  - 실제 파일 생성/수정, 테스트, 문서 업데이트, 커밋/푸시 수행
  - 구현이 끝난 뒤 반드시 문서 반영과 git 마감까지 함께 처리
```

## 현재 상태

```
현재 로컬 상태:
  - 핵심 문서 4개 + SESSION_HANDOFF_VIDEO.md + CLAUDE.md 배치 완료
  - scripts/ 폴더는 다른 bots와 동일한 공통 구조용 예약 상태
  - samples/ 폴더에 raw/narration/edited 테스트 fixture 존재
  - samples/ANALYSIS.md 에 ffprobe/YouTube 권장 분석 결과 정리 완료
  - video-team-design.md config 섹션은 YouTube 권장 렌더링 값(24M / 48kHz / 384k / faststart 등)으로 갱신 완료
  - video-team-tasks.md 과제 프롬프트는 하드코딩 값을 줄이고 config/CLAUDE.md 참조 기준으로 정리 완료
  - ANALYSIS.md 는 초기 분석값(섹션 6~7)과 최종 확정값(섹션 8)을 구분하도록 정리 완료
  - 과제 1 스캐폴딩 완료
    - config/video-config.yaml
    - migrations/001-video-schema.sql
    - context/IDENTITY.md
    - src/index.js
    - temp/, exports/ 디렉토리
  - `public.video_edits` 테이블 생성 및 `index.js` DB 연결 검증 완료
  - 과제 2 FFmpeg 전처리 완료
    - `lib/ffmpeg-preprocess.js`
    - `scripts/test-preprocess.js`
  - 샘플 `원본_파라미터.mp4` + `원본_나레이션_파라미터.m4a` 기준 실전 테스트 완료
    - removeAudio / normalizeAudio / syncVideoAudio / preprocess 통합 통과
    - 오디오 48kHz stereo AAC 리샘플링 확인
    - LUFS `-14.9` 확인 (목표 -14 ± 2)
  - 과제 3 Whisper STT 완료
    - `lib/whisper-client.js`
    - `scripts/test-whisper.js`
  - 샘플 `원본_나레이션_파라미터.m4a` 기준 실제 OpenAI Whisper 호출 검증 완료
    - `67 segments`
    - `temp/subtitle_raw.srt` 생성
    - 비용 `$0.026119`
    - `llm_usage_log` 기록 확인
  - 과제 4 LLM 자막 교정 완료
    - `lib/subtitle-corrector.js`
    - `scripts/test-subtitle-corrector.js`
  - 샘플 `temp/subtitle_raw.srt` 기준 실제 자막 교정 검증 완료
    - entries `67` 유지
    - 타임스탬프 `67/67` 보존
    - `temp/subtitle_corrected.srt` 생성
    - `gpt-4o-mini` 비용 `$0.002` 수준 확인
    - `llm_usage_log`의 `subtitle_correction` 기록 확인
  - 자막 교정 폴백 모델을 `gemini-2.5-flash`로 상향
  - `quality_loop`는 `critic/refiner/evaluator` 역할별 모델 구조로 확장
  - CapCut readiness 확인 완료
    - `CapCutAPI` 서버 `9001` 응답 정상
    - `CapCut.app` 실행 상태 확인
    - `create_draft / save_draft` 성공 응답 확인
    - 실제 draft 저장 위치는 `config.paths.capcut_drafts`가 아니라 `/Users/alexlee/projects/CapCutAPI/dfd_cat_*`
    - 과제 5에서는 `save_draft` 후 `copyToCapCut()` 단계가 필수
  - 과제 5 CapCut 드래프트 완료
    - `lib/capcut-draft-builder.js`
    - `scripts/test-capcut-draft.js`
    - `healthCheck / createDraft / addVideo / addAudio / addSubtitle / saveDraft / findDraftFolder / copyToCapCut / buildDraft` 구현 완료
    - `add_subtitle`는 CapCutAPI upstream `font_type` 버그를 피하기 위해 기본 `font='文轩体'`, `vertical=false`, `alpha=1.0`, `width/height` 명시 전달로 보강
    - repo 내부 `dfd_cat_*` 생성 후 `config.paths.capcut_drafts`로 복사되는 흐름까지 실검증 완료
    - CapCut Desktop 프로젝트 목록에 draft 카드 실제 표시 확인
    - 단, CapCut 7.2.0 draft_info.json 암호화 + CapCutAPI 저장 실패로 메인 파이프라인 의존은 폐기
    - 과제 6부터는 EDL JSON + FFmpeg 중심으로 재정의
  - 과제 6 핵심 모듈 구현 완료
    - `lib/video-analyzer.js`
    - `lib/edl-builder.js`
    - `scripts/test-video-analyzer.js`
    - `scripts/test-edl-builder.js`
  - smoke clip 기준 실검증 완료
    - 120초 샘플에서 `analyzeVideo()`가 메타데이터 + scene 후보 반환
    - EDL 생성 / VTT 변환 / 720p preview 렌더 / 1440p final 렌더 검증
    - 최종 smoke 렌더 결과: `2560x1440`, `60fps`, `H.264 High`, `48kHz stereo`, `faststart`
  - 로컬 FFmpeg 빌드 capability 확인
    - `drawtext`, `subtitles` 필터 미지원
    - 현재 코드는 해당 필터가 없으면 overlay / burn-in을 자동 생략하는 fallback 포함
    - 따라서 이 머신에서 자막 번인 최종 검증은 추가 FFmpeg 빌드 또는 다른 실행 환경이 필요
  - 과제 7 1차 통합 runner 구현 완료
    - `scripts/run-pipeline.js`
    - `src/index.js`는 `loadConfig()` export로 리팩터링
    - `--source=N`, `--source-video`, `--source-audio`, `--skip-render`, `--with-capcut` 지원
    - `video_edits` INSERT/단계별 status UPDATE/trace_id 기록/텔레그램 알림 연결 완료
    - worker-web 연동용 `--session-id`, `--pair-index` 지원 추가
    - 실자산 `--source=1 --skip-render` 검증에서 전처리 → STT → 자막교정 → 영상분석 → EDL 생성까지 완료 확인
    - preview 렌더도 실제로 진행되지만, 현재 transition 수가 많은 실자산에서는 wall-clock이 길어 추가 최적화가 필요
    - single-flight lock 추가로 동시 실행은 즉시 차단되며, SIGINT/SIGTERM 시 lock 정리까지 보강 완료
  - worker-web 영상 편집 연결 완료
    - `migrations/002-video-sessions.sql`
    - `routes/video-api.js`
    - `app/video/page.js`
    - `app/video/history/page.js`
    - session/file/edit 원장은 `video_sessions -> video_upload_files -> video_edits` 구조로 연결
    - confirm 후 final render는 `scripts/render-from-edl.js`가 백그라운드에서 수행
    - preview/subtitle/download는 JWT 헤더 제약 때문에 `fetch + Authorization + blob URL` 방식 사용
  - 과제 10 Critic Agent 구현 완료
    - `lib/critic-agent.js`
    - `scripts/test-critic-agent.js`
    - 코드 점검 후 실제 테스트 결과 `score=78`, `pass=false`
    - 자막 이슈 `18건`, 오디오는 `LUFS=-14.96 / Peak=-3.54`, 영상 구조 이슈 `10건`
    - config provider 준수, JSON 파싱 실패 강등, 인접 scene 병합 보강 완료
    - `temp/critic_report.json` 생성 완료
  - 과제 11 Refiner Agent 구현 완료
    - `lib/refiner-agent.js`
    - `scripts/test-refiner-agent.js`
    - 실제 테스트 결과 `subtitle changes=12`, `edl changes=0`, `audio 변경 없음`
    - 코드 점검 후 단계별 partial failure fallback 보강 완료
    - `temp/subtitle_corrected_v2.srt`, `temp/refiner_result.json` 생성 완료
  - 과제 12 Evaluator + quality loop 구현 완료
    - `lib/evaluator-agent.js`
    - `lib/quality-loop.js`
    - `scripts/test-quality-loop.js`
    - Evaluator는 Refiner 수정본을 기준으로 Critic을 재호출해 점수와 남은 이슈를 재평가
    - 코드 점검 후 standalone `refiner_result.json`에서도 sibling `analysis.json`을 자동 추론하도록 보강
    - quality-loop는 `critic_report_v0.json`, `refiner_result_v1.json`, `evaluation_v1.json`, `loop_result.json`을 temp 원장으로 남김
    - 실제 테스트 결과 `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `pass=false`
    - 현재 샘플에서는 Refiner 추가 변경이 없어 최고 버전은 원본 `subtitle_corrected.srt + edit_decision_list.json` 유지
  - n8n 연동 1차 구현 완료
    - `n8n/video-pipeline-workflow.json`
    - `n8n/setup-video-workflow.js`
    - `scripts/check-n8n-video-path.js`
    - `worker/web/routes/video-api.js`의 `start/confirm` 경로를 `runWithN8nFallback()` 기반으로 전환
    - n8n 장애 시 기존 `fork()` direct fallback 유지
    - `packages/core/lib/n8n-runner.js`에 커스텀 헤더 전달 지원 추가 (`X-Video-Token`)
    - `bots/video/lib/video-n8n-config.js`를 추가해 `VIDEO_N8N_TOKEN`을 env 우선, 없으면 `bots/worker/secrets.json`의 `video_n8n_token` fallback으로 읽도록 통합
    - 현재 n8n 런타임은 `ExecuteCommand` 활성화를 거부해, workflow를 `HTTP Request -> /api/video/internal/*` 구조로 호환 전환
    - `worker/web/routes/video-internal-api.js` 추가로 n8n이 기존 detached `fork()` 경로를 내부 API로 재사용
    - `setup-video-workflow.js`는 registry DB 조회가 막혀도 기본 webhook 경로로 degrade 하며, setup 성공 자체를 불필요하게 실패시키지 않음
    - 임시 `VIDEO_N8N_TOKEN` + worker 재기동 기준 live 검증 결과:
      - `resolvedWebhookUrl=http://127.0.0.1:5678/webhook/eJrK6wh4S8qAkuw9/webhook/video-pipeline`
      - `n8nHealthy=true`
      - `webhookRegistered=true`
      - `webhookStatus=200`
    - 이후 실제 운영 `bots/worker/secrets.json`에 `video_n8n_token`을 반영했고, env 없이도 `setup-video-workflow.js` / `check-n8n-video-path.js`가 정상 동작하는 것까지 확인
  - RAG 피드백 루프 구현 완료
    - `packages/core/lib/rag.js`에 `rag_video` 컬렉션 추가
    - `lib/video-rag.js`
      - 편집 결과 `storeEditResult()`
      - 사용자 승인/반려 `storeEditFeedback()`
      - 유사 편집 검색 `searchSimilarEdits()`
      - 분석 기반 패턴 추천 `searchEditPatterns()`
      - Critic 보강 `enhanceCriticWithRAG()`
      - EDL 보강 `enhanceEDLWithRAG()`
      - 시간 추정 `estimateWithRAG()`
    - `run-pipeline.js`는 preview_ready / completed 시 편집 결과를 RAG에 저장
    - `critic-agent.js`는 점수 산출 후 RAG 인사이트를 병합
    - `edl-builder.js`는 초기 EDL 생성 후 과거 성공 패턴을 반영
    - `worker/web/routes/video-api.js`는 confirm/reject 피드백 저장과 `/estimate`의 RAG 우선 추정을 지원
    - `scripts/test-video-rag.js` 기준 `rag_video` 초기화, 저장/검색/보강/추정 경로 통과 확인

Week 1: 핵심 파이프라인
  ✅ 과제 1: 프로젝트 스캐폴딩 + DB
  ✅ 과제 2: FFmpeg 전처리
  ✅ 과제 3: Whisper STT
  ✅ 과제 4: LLM 자막 교정
  ✅ 과제 5: CapCut 드래프트
  ✅ 과제 6: 영상 분석 + EDL 생성 + FFmpeg 렌더링 (핵심 모듈 구현)
  ✅ 과제 7: 엔드투엔드 통합 1차 (5세트 `--skip-render` preview 검증 완료)

Week 2: 워커웹 + n8n + 품질 루프
  ✅ 과제 8: 워커 웹 대화형 영상 편집 페이지 (API + UI 1차 연결)
  ✅ 과제 9: n8n 연동 (fallback 포함)
  ✅ 과제 10: Critic
  ✅ 과제 11: Refiner
  ✅ 과제 12: Evaluator + quality loop
  ✅ RAG 피드백 루프
  ✅ 과제 13: 5세트 preview 검증 (`--skip-render`)

Week 3: 최종 테스트 + 문서 체계 통합
  ☐ 통합 테스트 (4개 시나리오)
  ✅ 품질 테스트 1차 (5세트 preview 비교 + 세트 1 quality loop)
  ☐ 미달 항목 수정
  ☐ ★ 문서 이동: bots/video/docs/ → docs/video/
  ☐ ★ VIDEO_HANDOFF.md → docs/ 루트 승격
```

## 구현 세션 시작 순서 (코덱 / Claude Code 공통)

```
1. bots/video/docs/CLAUDE.md 읽기 (구현 규칙 + 렌더링 확정값)
2. bots/video/docs/VIDEO_HANDOFF.md 읽기 (전체 맥락 파악)
3. bots/video/docs/video-team-design.md 읽기 (모듈 매핑 + 기능목록)
4. bots/video/samples/ANALYSIS.md 읽기 (샘플 입출력 특성 확인)
5.5. EDL JSON 스펙은 CLAUDE.md 'EDL JSON' 섹션 참조
5. bots/video/docs/video-team-tasks.md에서 현재 과제 프롬프트 실행
6. 과제 7은 전처리 → STT → 교정 → 분석 → EDL → preview/final 렌더 통합부터 진행
7. 세션 마감 직전 VIDEO_HANDOFF.md / SESSION_HANDOFF_VIDEO.md / 전사 SESSION_HANDOFF.md 반영 여부를 다시 확인
```

## 최신 검증 메모

```
- 2026-03-21 5세트 전체 `run-pipeline.js --skip-render` 재검증 완료
- 최초 실패 원인:
  - preview watchdog 자체가 아니라 `ffmpeg-preprocess.syncVideoAudio()`가 나레이션 길이에 맞춰 영상을 자르지 않아
    `synced.mp4`의 video/audio duration이 크게 어긋난 것이 핵심
- 복구 불변식:
  - `syncVideoAudio()`가 audio duration 기준 `-t` + `-shortest`를 적용
  - 이후 5세트 모두 `preview_ready` 복구
  - `subtitle.vtt`도 preview 이전 생성으로 안정화
- 최신 성공 trace:
  - 파라미터: `05b1bc91-7251-401f-a6db-2cd53604404c`
  - 컴포넌트스테이트: `5e18ef34-7841-4faa-9981-7023eef51d36`
  - 동적데이터: `68c204d7-a99a-404d-bc23-8ed411e114b3`
  - 서버인증: `3017b788-e0b9-4e09-9235-dfce5127804b`
  - DB생성: `a4acc396-b9bf-4a43-ae30-b8ddb296d566`
- 종합 리포트:
  - `bots/video/temp/validation_report.json`
  - `successful=5`, `failed=0`, `avg_total_ms=440378`, `rag_records_stored=7`
```

## 더백클래스 LMS 연동 (Phase 2+)

```
더백클래스 (the100class.flutterflow.app)
  - "No.1 AI노코드 개발 강의" FlutterFlow LMS
  - 프로토타입에서는 연동하지 않음
  - Phase 2: LMS 영상 구조/메타데이터 학습
  - Phase 3: 편집 완료 → LMS 자동 발행 연동
  - 상세: video-team-design.md 섹션 8 참조
```
