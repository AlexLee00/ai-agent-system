# 테스트 결과 이력

> Day별 테스트 통과/실패 누적 기록

## 2026-03-21

### 스카 수동등록 후속 차단 원장화 + 취소 스킵 버그 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/db.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `node --check bots/reservation/auto/monitors/pickko-kiosk-monitor.js` | ✅ |
| `node --check bots/reservation/manual/reservation/pickko-register.js` | ✅ |
| `node --check bots/reservation/migrations/006_kiosk_block_attempts.js` | ✅ |
| `node bots/reservation/scripts/check-n8n-command-path.js` | ✅ 이제 실제 nested error(`EPERM ... 5432`) 출력 확인 |
| `node bots/reservation/scripts/migrate.js --status` | ✅ `v006 kiosk_block_attempts` 미적용 상태 확인 |
| `node bots/reservation/scripts/migrate.js` | ✅ `v006 kiosk_block_attempts` 적용 완료, 스키마 `v6` 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.ska.naver-monitor` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.ska.kiosk-monitor` | ✅ |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `naver-monitor`, `kiosk-monitor`, `ska command webhook` 정상 유지 확인 |
| `민경수 2026-03-27 12:00~14:00 A1 원장 조회` | ✅ `manual 등록 완료 + naver_blocked=false` 확인, false alert가 아니라 실제 후속 차단 누락으로 분류 |
| `최근 manual 등록 미래 예약 8건 운영 점검` | ✅ 네이버 예약관리에서 직접 확인 후 모두 처리 완료 |

---

## 2026-03-20

### 스카 세션 만료 알림 문구 개선 + headed 운영 가이드 보강

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `rg -n "playwright-headed|reload-monitor|네이버 로그인 세션 만료" bots/reservation/auto/monitors/naver-monitor.js bots/reservation/context/HANDOFF.md` | ✅ 알림 문구와 운영 가이드 반영 확인 |

### 스카 Playwright/Puppeteer headless 기본화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/lib/browser.js` | ✅ |
| `node --check packages/playwright-utils/src/browser.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `node --check bots/reservation/src/check-naver.js` | ✅ |
| `node --check bots/reservation/src/init-naver-booking-session.js` | ✅ |
| `node --check bots/reservation/src/inspect-naver.js` | ✅ |
| `node --check bots/reservation/src/analyze-booking-page.js` | ✅ |
| `node --check bots/reservation/src/get-naver-html.js` | ✅ |
| `bash -n bots/reservation/auto/monitors/start-ops.sh` | ✅ |
| `node -e "const b=require('./bots/reservation/lib/browser'); ..."` | ✅ 기본값 `headless='new'` 확인 |
| `PLAYWRIGHT_HEADLESS=false node -e "const b=require('./bots/reservation/lib/browser'); ..."` | ✅ headed 디버그 모드 전환 확인 |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ `ai.ska.naver-monitor` 재시작, PID `45377` 확인 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `naver-monitor`, `kiosk-monitor`, `health-check`, `daily_summary 무결성` 모두 정상 확인 |
| `node --check bots/reservation/lib/study-room-pricing.js` | ✅ 스터디룸 시간 기반 산출 helper 문법 확인 |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ 새 스터디룸 산출식 반영 후 문법 확인 |
| `node --check bots/reservation/scripts/pickko-revenue-backfill.js` | ✅ backfill 스크립트 문법 확인 (`exportCsv` await 포함) |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ 3월 전체 재집계, `2026-03-18` 스터디룸 7건 → `87,500원`, `2026-03-10` timeout 잔여 복구 기준 확보 |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-02 --to=2026-02` | ✅ 2월 전체 재집계, `2026-02-27` stale `pickko_study_room=7,000` → `122,000원` 복구 |
| `node --input-type=module -e \"... syncSkaSalesToWorker('test-company') ...\"` | ✅ worker `test-company` 미러 재동기화 (`expectedRows: 288`) |
| `node bots/reservation/scripts/health-report.js --json` | ✅ 새 정책 기준 `dailySummaryIntegrityHealth.issueCount=0`, `policyDivergenceCount=14` 확인 |
| `node --input-type=module -e \"... reservation.daily_summary vs worker.sales(test-company) 전체 diff ...\"` | ✅ 과거 전체 범위 diff `0건` 확인 |

### 비디오팀 과제 1 — 프로젝트 스캐폴딩 + DB 스키마 + config

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/src/index.js` | ✅ |
| `tail -n 3 bots/video/docs/CLAUDE.md` | ✅ 마지막 줄이 `24Mbps로 업로드하면 유튜브 재인코딩 후에도 디테일이 최대한 보존됨.` 으로 종료됨 확인 |
| `grep -n "\*.mp4\|\*.m4a\|\*.mp3\|\*.wav\|\*.srt\|dfd_\*/" .gitignore` | ✅ 비디오팀 미디어 ignore 규칙 반영 확인 |
| `mkdir -p bots/video/temp bots/video/exports` | ✅ 디렉토리 생성 완료 |
| `node --input-type=module -e "... pgPool.run('public', sql) ..."` | ✅ `bots/video/migrations/001-video-schema.sql`을 `jay` DB에 직접 적용 (`migration_ok`) |
| `node bots/video/src/index.js` | ✅ `config 로드 성공`, `DB 연결 성공` 출력 확인 |
| `node --input-type=module -e "... SELECT * FROM video_edits LIMIT 1 ..."` | ✅ `public.video_edits` 조회 성공, 빈 결과(`rowCount: 0`) 확인 |
| `rg -n "render_bitrate: 24M" bots/video/config/video-config.yaml` | ✅ |
| `test -f bots/video/context/IDENTITY.md` | ✅ |
| `ls -ld bots/video/config bots/video/context bots/video/migrations bots/video/src bots/video/temp bots/video/exports` | ✅ 필요한 디렉토리/파일 존재 확인 |

### 비디오팀 과제 2 — FFmpeg 전처리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/ffmpeg-preprocess.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-preprocess.js` | ✅ 통과 |
| `ffmpeg -version \| head -n 1 && ffprobe -version \| head -n 1` | ✅ FFmpeg/ffprobe 8.1 사용 가능 확인 |
| `node bots/video/scripts/test-preprocess.js` | ✅ `removeAudio`, `normalizeAudio`, `syncVideoAudio`, `preprocess 통합`, `LUFS 측정 -14.9` 전체 통과 |
| `test -f bots/video/temp/synced.mp4` | ✅ 생성 확인 |
| `ffprobe 기반 stream 검증` | ✅ `1920x1080 60fps` video + `48000Hz stereo AAC` audio 확인 |

### 비디오팀 과제 3 — Whisper STT

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/whisper-client.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-whisper.js` | ✅ 통과 |
| `node bots/video/scripts/test-whisper.js` | ✅ 실제 OpenAI Whisper 호출, `67 segments`, `subtitle_raw.srt`, 비용 `$0.026119` 전체 통과 |
| `test -f bots/video/temp/subtitle_raw.srt` | ✅ 생성 확인 |
| `node --input-type=module -e "... llm_usage_log WHERE team='video' ..."` | ✅ `model=whisper-1`, `request_type=audio_transcription`, `cost_usd=0.026119` 확인 |

### 비디오팀 과제 4 — LLM 자막 교정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/subtitle-corrector.js` | ✅ 통과 |
| `node --check bots/video/scripts/test-subtitle-corrector.js` | ✅ 통과 |
| `node bots/video/scripts/test-subtitle-corrector.js` | ✅ 실제 LLM 호출 기준 `67 entries 유지`, `67/67 타임스탬프 보존`, `subtitle_corrected.srt`, 비용 `$0.002` 확인 |
| `test -f bots/video/temp/subtitle_corrected.srt` | ✅ 생성 확인 |
| `node --input-type=module -e "... llm_usage_log WHERE team='video' ..."` | ✅ `model=gpt-4o-mini`, `request_type=subtitle_correction`, 성공 로그 확인 |

### 아처 자동화 리포트 재검증 + 비용 표 source 보정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/claude/lib/archer/analyzer.js` | ✅ |
| `node bots/claude/src/archer.js` | ✅ 실네트워크 수집/분석 후 `archer-2026-03-20.md` 재생성 |
| `node --input-type=module -e "... from claude.billing_snapshots ..."` | ✅ 최근 10일 snapshot이 provider별 동일 누적값으로 저장됨 확인 (`anthropic=16.417`, `openai=3.564`) |
| `node --input-type=module -e "... from reservation.llm_usage_log ..."` | ✅ 실제 일별 사용량은 날짜별로 변동함 확인 |
| `sed -n '52,68p' bots/claude/reports/archer-2026-03-20.md` | ✅ 최근 7일 비용 표가 `YYYY-MM-DD` 형식과 usage 기반 일별 값으로 출력됨 확인 |

### 어제자 리포트 후속: KIS 과속 완화 + 아처 비용 리포트 정합성 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/kis-client.js` | ✅ |
| `node --check bots/claude/lib/archer/analyzer.js` | ✅ |
| `launchctl list \| egrep 'ai\.investment\.(commander\|crypto\|domestic\|overseas\|reporter)'` | ✅ `domestic`, `crypto`, `overseas`, `commander`, `reporter` launchd 라벨 존재 확인 |
| `tail -n 120 /tmp/investment-domestic.log` | ✅ 최신 국내 수집/판단 사이클에서 `failed=0`, `coreFailed=0`, `enrichFailed=0` 정상 마감 확인 |
| `tail -n 120 /tmp/investment-domestic.err.log` | ✅ 과거 `초당 거래건수를 초과하였습니다.` 오류 흔적은 남아 있으나, 최신 정상 사이클 존재 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `serviceHealth.okCount=13`, `guardHealth: 투자 LLM guard 없음` 확인 |

### 루나 LLM guard 범위 정밀화 + TTL 자동 해제

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ |
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --check packages/core/lib/llm-logger.js` | ✅ |
| `node --check bots/investment/shared/llm-client.js` | ✅ |
| `node --check bots/investment/shared/secrets.js` | ✅ |
| `node --check bots/investment/markets/crypto.js` | ✅ |
| `node --check bots/investment/markets/domestic.js` | ✅ |
| `node --check bots/investment/markets/overseas.js` | ✅ |

## 2026-03-21

### worker-web `/video` 세션 복원 + 프리뷰 렌더 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/app/_shell.js` | ✅ hydration 전 빈 화면 대신 로딩 셸 렌더 문법 확인 |
| `node --check bots/worker/web/app/video/page.js` | ✅ idle 업로드 노출, 세션 URL/localStorage 복원 로직 문법 확인 |
| `node --check bots/worker/web/routes/video-api.js` | ✅ 파일명 UTF-8 복원, start fallback, edit 생성 검증 문법 확인 |
| `node --check bots/video/lib/edl-builder.js` | ✅ transition 렌더 임시 비활성화 문법 확인 |
| `cd bots/worker/web && npx next build` | ✅ `/video`, `/video/history` 포함 build 재통과 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ worker API 재기동 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 재기동 |
| `SELECT id, status FROM public.video_sessions WHERE id = 1` | ✅ `id=1`, `status=processing` 세션 존재 확인 |
| `SELECT id, status, trace_id FROM public.video_edits WHERE session_id = 1` | ✅ 초기 `0건` 확인 후 direct recovery 뒤 `id=16`, `status=correction_done`, `trace=f84aa3f6-329e-43af-8eac-ae6f8eeaf474` 확인 |
| `ffprobe bots/video/temp/run-f84aa3f6/synced.mp4` | ✅ 원본 합성본은 정상 비디오 스트림 확인 |
| `ffprobe bots/video/temp/run-f84aa3f6/preview.mp4` | ✅ 프리뷰 파일 자체는 생성되지만 bitrate가 비정상적으로 낮아 검은 화면 의심 |
| `preview/synced 첫 프레임 추출 비교` | ✅ `synced.mp4`는 정상 화면, `preview.mp4`는 완전 검정으로 transition 필터 체인 원인 분리 확인 |

### 비디오팀 Phase 1 마감 — worker-web `/video` 빌드 반영

| 테스트 | 결과 |
|--------|------|
| `cd bots/worker/web && npx next build` | ✅ `/video`, `/video/history` 포함 production build 통과 |
| `launchctl list \| egrep 'ai\.worker\.(web\|nextjs)'` | ✅ 재기동 전 `ai.worker.nextjs`가 예전 빌드를 물고 있던 상태 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 런타임 재기동 |
| `curl -I http://127.0.0.1:4001/video` | ✅ `200 OK` |
| `curl -I http://127.0.0.1:4001/video/history` | ✅ `200 OK` |

### worker-web 비디오 업로드 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/worker/web/app/video/page.js` | ✅ |
| `cd bots/worker/web && npx next build` | ✅ 업로드 UI 보강 후 build 통과 |
| `node --input-type=module -e \"... ALTER TABLE public.video_sessions ALTER COLUMN company_id TYPE TEXT ...\"` | ✅ `video_sessions.company_id`가 실제 `text`로 보정됨 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ worker API 재기동 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ Next.js 재기동 |

### 비디오팀 과제 13 — 5세트 전체 파이프라인 검증 (`--skip-render`)

| 테스트 | 결과 |
|--------|------|
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_파라미터.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_파라미터.m4a" --skip-render` | ✅ `preview_ready`, trace `05b1bc91-7251-401f-a6db-2cd53604404c`, `total_ms=214732` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_컴포넌트스테이트.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_컴포넌트스테이트.m4a" --skip-render` | ✅ `preview_ready`, trace `5e18ef34-7841-4faa-9981-7023eef51d36`, `total_ms=522694` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_동적데이터.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_동적데이터.m4a" --skip-render` | ✅ `preview_ready`, trace `68c204d7-a99a-404d-bc23-8ed411e114b3`, `total_ms=417838` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_서버인증.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_서버인증.m4a" --skip-render` | ✅ `preview_ready`, trace `3017b788-e0b9-4e09-9235-dfce5127804b`, `total_ms=712327` |
| `node bots/video/scripts/run-pipeline.js --source-video="bots/video/samples/raw/원본_DB생성.mp4" --source-audio="bots/video/samples/narration/원본_나레이션_DB생성.m4a" --skip-render` | ✅ `preview_ready`, trace `a4acc396-b9bf-4a43-ae30-b8ddb296d566`, `total_ms=334298` |
| `ffprobe bots/video/temp/run-05b1bc91/synced.mp4 / preview.mp4` | ✅ 세트 1 `261.2s`, `1920x1080 -> 1280x720` 및 video/audio duration 정합성 확인 |
| `node - <<'NODE' ... runQualityLoop(...) ... NODE` (세트 1 최신 run 기준) | ✅ `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `pass=false` |
| `node - <<'NODE' ... estimateWithRAG(5, 481.9, 224.3) ... NODE` | ✅ `estimated_ms=373360`, `confidence=high`, `sample_count=5` |
| `SELECT COUNT(*) FROM reservation.rag_video` | ✅ `7건` 확인 |
| `bots/video/temp/validation_report.json` 재생성 | ✅ `successful=5`, `failed=0`, `avg_total_ms=440378`, `total_cost_usd=0.2756` |

### 비디오팀 과제 12 — Evaluator + quality loop

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/evaluator-agent.js` | ✅ |
| `node --check bots/video/lib/quality-loop.js` | ✅ |
| `node --check bots/video/scripts/test-quality-loop.js` | ✅ |
| `node bots/video/scripts/test-quality-loop.js` | ✅ 실제 quality loop 실행, `iteration0 score=80`, `iteration1 score=80`, `recommendation=ACCEPT_BEST`, `final_score=80`, `loop_result.json` 생성 |
| `node --input-type=module -e "... runEvaluator('./bots/video/temp/refiner_result.json', './bots/video/temp/synced.mp4', config) ..."` | ✅ standalone `refiner_result.json` 기준 `analysis.json` 자동 추론, `score=71`, `recommendation=ACCEPT_BEST` 확인 |

### 비디오팀 과제 9 — n8n 연동

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/n8n-runner.js` | ✅ |
| `node --check bots/video/n8n/setup-video-workflow.js` | ✅ |
| `node --check bots/worker/web/routes/video-internal-api.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/video/lib/video-n8n-config.js` | ✅ |
| `node --check bots/video/scripts/check-n8n-video-path.js` | ✅ |
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node -e "JSON.parse(fs.readFileSync('bots/video/n8n/video-pipeline-workflow.json','utf8'))"` | ✅ workflow JSON 파싱 확인 |
| `VIDEO_N8N_TOKEN=video-local-test-20260321 WORKER_API_INTERNAL_URL=http://127.0.0.1:4000 N8N_BASE_URL=http://127.0.0.1:5678 node bots/video/n8n/setup-video-workflow.js` | ✅ 기존 inactive workflow 정리 후 새 workflow 생성/활성화, live webhook path 출력 확인 |
| `curl -i -s -X POST http://127.0.0.1:4000/api/video/internal/run-pipeline -H 'Content-Type: application/json' -H 'X-Video-Token: video-local-test-20260321' -d '{"_healthProbe":true}'` | ✅ 내부 dispatch API `200 {"ok":true,"status":"probe_ok"}` 확인 |
| `VIDEO_N8N_TOKEN=video-local-test-20260321 node bots/video/scripts/check-n8n-video-path.js` | ✅ `n8nHealthy=true`, `webhookRegistered=true`, `webhookStatus=200`, live resolved webhook 확인 |
| `node --check bots/video/n8n/setup-video-workflow.js` (보강 후) | ✅ `N8N_BASE_URL` 파싱 + registry 실패 degrade 문법 확인 |
| `node bots/video/n8n/setup-video-workflow.js` | ✅ `bots/worker/secrets.json`의 `video_n8n_token` fallback만으로 workflow 재생성/활성화 성공 |
| `node bots/video/scripts/check-n8n-video-path.js` | ✅ env 없이도 `n8nHealthy=true`, `webhookRegistered=true`, `webhookStatus=200` 확인 |

### 비디오팀 RAG 피드백 루프

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/rag.js` | ✅ |
| `node --check bots/video/lib/video-rag.js` | ✅ |
| `node --check bots/video/lib/critic-agent.js` | ✅ |
| `node --check bots/video/lib/edl-builder.js` | ✅ |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ |
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/video/scripts/test-video-rag.js` | ✅ |
| `node bots/video/scripts/test-video-rag.js` | ✅ `rag_video` 초기화, `storeEditResult`, `storeEditFeedback`, `searchSimilarEdits`, `searchEditPatterns`, `estimateWithRAG`, `enhanceCriticWithRAG`, `enhanceEDLWithRAG` 확인 |

### 비디오팀 과제 11 — Refiner Agent

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/refiner-agent.js` | ✅ |
| `node --check bots/video/scripts/test-refiner-agent.js` | ✅ |
| `node bots/video/scripts/test-refiner-agent.js` | ✅ `critic_report.json` 기준 실제 Refiner 실행, `subtitle changes=12`, `edl changes=0`, `audio=null`, `subtitle_corrected_v2.srt`, `refiner_result.json` 생성 |
| `node -e "... parseSrt(load subtitle_corrected_v2.srt) ..."` | ✅ 수정된 SRT `67 entries` 재파싱 확인 |
| `node -e "... loadEDL(edit_decision_list.json) ..."` | ✅ 수정 후 EDL 로드 확인 |

### 비디오팀 과제 10 — Critic Agent

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/critic-agent.js` | ✅ |
| `node --check bots/video/scripts/test-critic-agent.js` | ✅ |
| `node - <<'EOF' ... parseSrt / analyzeVideoStructure / calculateOverallScore ... EOF` | ✅ `67 entries`, `videoScore=100`, `sceneIssues=10` 확인 |
| `node bots/video/scripts/test-critic-agent.js` | ✅ 코드 점검 후 재실행, `score=78`, `pass=false`, `subtitle issues=18`, `audio LUFS=-14.96`, `scene issues=10`, `temp/critic_report.json` 생성 |

### 워커 웹 영상 편집 API + 프론트엔드

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/routes/video-api.js` | ✅ |
| `node --check bots/video/scripts/render-from-edl.js` | ✅ |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ `--session-id`, `--pair-index` 확장 후 문법 확인 |
| `node --check bots/worker/web/server.js` | ✅ `/api/video` 라우터 연결 후 문법 확인 |
| `npm --prefix bots/worker/web run build` | ✅ `/video`, `/video/history` 포함 Next.js production build 통과 |
| `node -e "... 002-video-sessions.sql ..."` | ✅ `video_sessions`, `video_upload_files`, `video_edits` 확장 컬럼 마이그레이션 적용 |
| `node -e "... information_schema.columns ..."` | ✅ `video_sessions`, `video_upload_files`, `video_edits(session_id/pair_index/confirm_status/reject_reason)` 생성 확인 |
| `node --check bots/investment/team/athena.js` | ✅ |
| `node --check bots/investment/team/oracle.js` | ✅ |
| `node --check bots/investment/team/hermes.js` | ✅ |
| `node --check bots/investment/team/sophia.js` | ✅ |
| `node --check bots/investment/team/nemesis.js` | ✅ |
| `node --check bots/investment/team/luna.js` | ✅ |
| `node bots/investment/scripts/health-report.js --json` | ✅ `commander`, `crypto`, `domestic`, `overseas`, `reporter` 포함 13개 서비스 정상 확인 |
| `node --input-type=module -e "import { getBlockReason } from './packages/core/lib/billing-guard.js'; ..."` | ✅ `crypto`, `domestic`, `overseas` 모두 active guard 없음 확인 |
| `node --input-type=module -e "import fs from 'fs'; import billingGuard from './packages/core/lib/billing-guard.js'; ..."` | ✅ 오래된 `.llm-emergency-stop`가 자동 만료/삭제됨 확인 |

### /ops-health 루나 guard 범위·만료 시각 표시

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --check bots/orchestrator/lib/night-handler.js` | ✅ |
| `node --check bots/investment/scripts/health-report.js` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.orchestrator` | ✅ |
| `node bots/orchestrator/scripts/health-report.js --json` | ✅ `ai.orchestrator`, `gateway`, `ai.n8n.server` 정상 및 orchestrator health 정상 확인 |
| `node bots/investment/scripts/health-report.js --json` | ✅ `guardHealth.okCount=1`, `투자 LLM guard 없음` 정상 출력 확인 |
| `node --check bots/orchestrator/src/router.js` | ✅ |
| `node --check bots/orchestrator/lib/night-handler.js` | ✅ guard 본문 축약 포맷 유지 확인 |
| `node --check bots/investment/scripts/health-report.js` | ✅ guard 본문 축약 포맷 유지 확인 |

### 일간 매매 한도 차단 문구 명확화

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/capital-manager.js` | ✅ |
| `node --check bots/investment/team/hephaestos.js` | ✅ |
| `node --input-type=module -e "import { formatDailyTradeLimitReason } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ `초과: 현재 10건 / 한도 8건`, `도달: 현재 8건 / 한도 8건` 출력 확인 |

### 루나 알림 카드 구분선 10칸 축소

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --input-type=module -e "import { readFileSync } from 'fs'; ..."` | ✅ `DIVIDER='──────────'`, 길이 `10` 확인 |

### 모바일 알림 short-title 정리 + 스카 모니터 리로드 복구

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ |
| `node --check bots/investment/markets/crypto.js` | ✅ |
| `node --check bots/investment/markets/domestic.js` | ✅ |
| `node --check bots/investment/markets/overseas.js` | ✅ |
| `node --check bots/orchestrator/n8n/setup-ska-workflows.js` | ✅ |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ |
| `bash -n bots/reservation/scripts/reload-monitor.sh` | ✅ |
| `node bots/orchestrator/n8n/setup-ska-workflows.js` | ✅ `SKA-WF-01 일간 매출 요약`, `SKA-WF-03 주간 매출 트렌드` 재생성/활성화 확인 |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.crypto` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.domestic` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.overseas` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.investment.commander` | ✅ |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ `ai.ska.naver-monitor` 재기동, PID `88807` 확인 |

### 워커 재무 탭 확장 + 업체 비활성화 운영 완결

| 테스트 | 결과 |
|--------|------|
| `node bots/worker/migrations/020-expenses.js` | ✅ `worker.expenses` 테이블 추가 완료 |
| `node bots/worker/migrations/021-company-deactivation-meta.js` | ✅ `deactivated_reason`, `deactivated_by` 컬럼 실제 반영 확인 |
| `node bots/worker/scripts/import-expenses-from-excel.js "...2025년 스터디카페_고정지출관리_월별.xlsx" "...2026년 스터디카페_고정지출관리_월별.xlsx"` | ✅ 2025 파일 `126건 적재 / 2건 skip`, 2026 파일 `63건 적재 / 0건 skip`, 총 매입 `189건 / 47,427,532원` 확인 |
| `node --input-type=module ... worker.companies count` | ✅ 활성 업체 `4건`, 비활성 `0건`, 전체 `4건` 확인 |
| `node --input-type=module ... worker.companies active rows` | ✅ `sssssss`, `test-company`, `test_company`, `master` 활성 업체 조회 확인 |
| `node --check bots/worker/lib/expenses-ai.js` | ✅ |
| `node --check bots/worker/lib/expenses-import.js` | ✅ |
| `node --check bots/worker/scripts/import-expenses-from-excel.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/companies/page.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner`, API, websocket 정상 확인 |

### 워커 web 운영 화면 공용화 + 업무/일정/근태/매출 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/components/PromptAdvisor.js` | ✅ |
| `node --check bots/worker/web/components/DataTable.js` | ✅ |
| `node --check bots/worker/web/lib/document-attachment.js` | ✅ |
| `node --check bots/worker/web/app/dashboard/page.js` | ✅ |
| `node --check bots/worker/web/app/work-journals/page.js` | ✅ |
| `node --check bots/worker/web/app/schedules/page.js` | ✅ |
| `node --check bots/worker/web/app/attendance/page.js` | ✅ |
| `node --check bots/worker/web/app/sales/page.js` | ✅ |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ 프로세스(`web`, `nextjs`, `lead`, `task-runner`) 정상 확인. 재시작 직후 endpoint 경고는 warm-up 상태로 관측됨 |

### 워커 블로그 URL 입력의 발행일 경계 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --input-type=module ... blog.posts 54/55 정규화 재현` | ✅ `54`, `55`가 `publishDate=2026-03-19`, `needsUrl=true`, `publishDue=true`로 계산됨 확인 |
| `npm --prefix bots/worker/web run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ `web`, `nextjs`, `lead`, `task-runner` 정상 확인 |

### 투자 validation 성과 반영 + 국내장 normal 2차 승격

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/billing-guard.js` | ✅ |
| `node --input-type=module -e "import { isBlocked } from './packages/core/lib/billing-guard.js'; ..."` | ✅ 레거시 `investment` stop 파일 기준 `investment.normal=true`, `investment.validation=false` 확인 |
| `INVESTMENT_TRADE_MODE=validation node bots/investment/markets/domestic.js --force` | ✅ `214390 BUY 500000 자동 승인`, `최종 결과: 1개 신호 승인` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `crypto VALIDATION: PAPER 2건`, `domestic VALIDATION: LIVE 1건`, `validation 승격 후보` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 세 시장 `NORMAL / VALIDATION` 통합 피드백 및 validation 후보 출력 확인 |
| `node --check bots/investment/scripts/runtime-config-suggestions.js` | ✅ |
| `node bots/investment/scripts/runtime-config-suggestions.js --days=7` | ✅ domestic validation `approved 1 / executed 1 / LIVE 1` 반영 및 `normal 승격 후보` 출력 확인 |
| `node --input-type=module -e "import { getInvestmentRuntimeConfig } from './bots/investment/shared/runtime-config.js'; ..."` | ✅ `stockStarterApproveDomestic=450000`, `stockStarterApproveOverseas=300` 확인 |

### blog / worker 상시 서비스 복구

| 테스트 | 결과 |
|--------|------|
| `node --check bots/blog/api/node-server.js` | ✅ |
| `node --check bots/worker/src/worker-lead.js` | ✅ |
| `node --check bots/worker/src/task-runner.js` | ✅ |
| `node bots/blog/scripts/health-report.js --json` | ✅ `node-server`, `node-server API` 정상 확인 |
| `node bots/worker/scripts/health-report.js --json` | ✅ `lead`, `task-runner` 정상 확인 |

### 재부팅 절차 개편

| 테스트 | 결과 |
|--------|------|
| `bash -n scripts/pre-reboot.sh` | ✅ |
| `bash -n scripts/post-reboot.sh` | ✅ |
| `bash scripts/post-reboot.sh --dry-run` | ✅ 드라이런 종료, `/tmp/post-reboot-followup.txt` 생성 및 전사 launchd 점검 흐름 확인 |
| `tail -n 80 /tmp/post-reboot.log` | ✅ 현재 로컬 상태 기준 `OK 5 / WARN 16 / FAIL 12`로 보고, 후속 `health-report --json` 재확인 필요 메시지 확인 |

### 루나 퍼널 계측 + 바이낸스 보수성 조정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ |
| `node --check bots/investment/team/luna.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --input-type=module -e "...getLunaRuntimeConfig(), getLunaParams()..."` | ✅ `binance live minConfidence=0.44`, `crypto debate=0.56/0.18`, `fastPath minCryptoConfidence=0.40` 확인 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `decision 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ `의사결정 퍼널 병목` 섹션에 시장별 `BUY / SELL / HOLD / executed / weak / risk / saved` 출력 확인 |

## 2026-03-18

### 자동화 리포트 개선

| 테스트 | 결과 |
|--------|------|
| `node --check bots/orchestrator/scripts/log-jay-gateway-experiment.js` | ✅ |
| `node --check scripts/reviews/jay-gateway-experiment-daily.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node scripts/reviews/jay-gateway-experiment-daily.js --json` | ✅ fallback 저장 보강 후 `snapshot / persisted / fallbackUsed / review` 확인 |
| `node -e "const {buildRun}=require('./scripts/reviews/jay-gateway-experiment-daily.js'); ..."` | ✅ `persisted=true`, `fallbackUsed=true`, `tmp/jay-gateway-experiments.jsonl` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ `activeIssues / historicalIssues / inputFailures` 분리 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ 텍스트 리포트 섹션 분리 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbStatsStatus=partial`, `dbSourceErrors`, `llmUsageSource=session_usage_fallback` 확인 |
| `node scripts/reviews/jay-llm-daily-review.js` | ✅ partial 상태와 fallback 모델별 사용량 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ no-trade 운영 요약 + 주간 usage / 비용 경고 출력 확인 |
| `node scripts/reviews/ska-sales-forecast-weekly-review.js --days=7 --json` | ✅ `requestedDays / effectiveDays` 및 `actionItems` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `actionItems` 출력 확인 |

### 모바일 알림 UX 정리

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/scripts/market-alert.js` | ✅ |
| `node --check bots/investment/scripts/pre-market-screen.js` | ✅ |
| 개인 Telegram 직접 전송 `ok=true` | ✅ |
| 그룹 Telegram 직접 전송 `ok=true` | ✅ |
| 루나 토픽 15 직접 전송 `ok=true` | ✅ |
| 실제 수신 화면에서 15자 구분선 1줄 유지 확인 | ✅ |
| 실제 수신 화면에서 테스트 메시지 헤더 중복 제거 확인 | ✅ |

### 워커 웹 `LLM API 현황` / `블로그 URL 입력` 운영 콘솔 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/page.js` | ✅ |
| `node --check bots/worker/web/app/admin/monitoring/blog-links/page.js` | ✅ |
| `node --check bots/worker/web/components/Sidebar.js` | ✅ |
| `node --check bots/worker/web/components/AdminQuickNav.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ |

### 워커 모니터링 + LLM API 선택

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/llm-api-monitoring.js` | ✅ |
| `node --check bots/worker/lib/ai-client.js` | ✅ |
| `node --check bots/worker/web/server.js` | ✅ |
| `node --check bots/worker/scripts/setup-worker.js` | ✅ |
| `cd bots/worker/web && npm run build` | ✅ |
| `node bots/worker/migrations/017-system-preferences.js` | ✅ |
| `node bots/worker/scripts/health-report.js --json` | ✅ |
| `curl -s http://127.0.0.1:4001/admin/monitoring` | ✅ |

### 투자 실행 모드 / 실패 원인 구조화 / 덱스터 경고 보정

| 테스트 | 결과 |
|--------|------|
| `node bots/investment/scripts/trading-journal.js --days=7` | ✅ |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` (실제 PostgreSQL 환경) | ✅ |
| `node bots/claude/scripts/health-report.js --json` | ✅ |

### 스카 shadow 비교 모델 + 운영 리뷰 입력 구조

| 테스트 | 결과 |
|--------|------|
| `python3 -m py_compile bots/ska/src/runtime_config.py bots/ska/src/forecast.py` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-weekly-review.js` | ✅ |
| 스카 daily forecast 실행 | ✅ |
| `forecast_results.predictions.shadow_model_name = knn-shadow-v1` 저장 확인 | ✅ |
| `forecast_results.predictions.shadow_yhat / shadow_confidence` 저장 확인 | ✅ |

### 워커 문서 재사용 상세/성과 추적

| 테스트 | 결과 |
|--------|------|
| `cd bots/worker/web && npm run build` | ✅ |
| `/documents` 목록 빌드 | ✅ |
| `/documents/[id]` 상세 빌드 | ✅ |
| 문서 재사용 이력/성과 카드 렌더링 경로 빌드 | ✅ |

### 문서 체계 정리

| 테스트 | 결과 |
|--------|------|
| `SESSION_CONTEXT_INDEX.md`에서 새 문서 체계 링크 확인 | ✅ |
| `README.md` 문서 시작 순서 반영 확인 | ✅ |
| `PLATFORM_IMPLEMENTATION_TRACKER.md` rename 후 링크 경로 확인 | ✅ |

---

## 2026-03-08

### RAG 활용 완성 테스트 (커밋: 7630fc8)

| 테스트 | 항목 | 결과 |
|--------|------|------|
| A-1 | reporter.js → rag_operations 코드 존재 | ✅ |
| A-2 | doctor.js → rag_operations 코드 존재 | ✅ |
| A-3 | archer.js → rag_tech 코드 존재 | ✅ |
| A-4 | luna.js → rag_trades 코드 존재 | ✅ |
| A-5 | nightly git log → rag_tech | 🚫 의도적 제거 (아처와 중복) |
| B-1 | claude-lead-brain.js RAG 검색→LLM 프롬프트 주입 | ✅ |
| B-3 | claude-lead-brain.js shadow_log 후 RAG 저장 | ✅ |
| B-5 | luna.js RAG 검색→getSymbolDecision 프롬프트 주입 | ✅ |
| C-1 | Python 프로세스 0개 | ✅ |
| C-2 | 기존 plist 없음 | ✅ |
| C-3 | rag-system.deprecated 존재 | ✅ |
| C-4 | rag-server /health 응답 | ✅ |
| C-5 | 컬렉션 통계 (ops:1, trades:1, tech:1, docs:12) | ✅ |
| C-6 | system_docs 검색 정상 | ✅ |
| D-1 | 5개 파일 try-catch 보호 패턴 | ✅ |
| D-2 | 핵심 파일 5개 Node.js 문법 검사 | ✅ |
| D-3 | TP/SL OCO 안전장치 (luna, hephaestus) | ✅ |
| D-4 | archer.js RAG 삽입 순서 정상 | ✅ |
| E-1 | trades/ops/tech 실 저장·검색 동작 | ✅ |
| E-2 | operations 컬렉션 검색 응답 | ✅ |

**총계: 19/19 PASS (A-5 의도적 제외)**

---

## 2026-03-07

### Day 4 — 루나팀 매매일지 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| insertJournalEntry 기록 | ✅ |
| insertRationale (tradeId, review) 기록 | ✅ |
| closeJournalEntry 청산 | ✅ |
| insertReview 사후평가 | ✅ |
| DuckDB 5개 테이블 생성 확인 | ✅ |
| schema_migrations v4 등록 | ✅ |

### Day 5 — OpenClaw 멀티에이전트 (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| team-comm sendToTeamLead | ✅ |
| team-comm getPendingMessages 수신 | ✅ |
| heartbeat.js require 정상 | ✅ |
| openclaw.json teamLeads 등록 | ✅ |
| SOUL.md 3개 생성 (ska/claude-lead/luna) | ✅ |
| 통합 검증 24/24 | ✅ |

### Day 6 — 독터 + 보안 + OPS/DEV (2026-03-07)

| 테스트 | 결과 |
|--------|------|
| doctor.js 화이트리스트 5개 canRecover | ✅ |
| rm-rf 블랙리스트 차단 | ✅ |
| DROP TABLE 블랙리스트 차단 | ✅ |
| 미등록 작업 거부 | ✅ |
| doctor_log 테이블 생성 + 이력 기록 | ✅ |
| mode-guard ensureOps DEV에서 차단 | ✅ |
| mode-guard ensureDev DEV에서 통과 | ✅ |
| deploy-ops.sh 5단계 확인 | ✅ |
| pre-commit secrets.json/config.yaml 차단 | ✅ |
| .gitignore secrets/config.yaml/db/key | ✅ |
| security.js pre-commit 훅 점검 추가 | ✅ |
| Day 6 검증 15/15 | ✅ |

### Day 7 — 통합 테스트 (2026-03-07)

| 카테고리 | 테스트 | 결과 |
|----------|--------|------|
| 스카팀 State Bus | emitEvent→markProcessed 사이클 | ✅ |
| 스카팀 State Bus | createTask→completeTask 사이클 | ✅ |
| 클로드팀 | 덱스터 퀵체크 | ✅ 이상 없음 |
| 클로드팀 | 독터 canRecover / 블랙리스트 / getAvailableTasks | ✅ |
| 클로드팀 | DexterMode Normal→Emergency→Normal | ✅ |
| 루나팀 | 매매일지 전체 사이클 (기록→판단→청산→평가) | ✅ |
| 크로스팀 | team-comm 클로드→스카 메시지 | ✅ |
| LLM 인프라 | llm-router selectModel | ✅ |
| LLM 인프라 | llm-cache 저장→히트 | ✅ |
| LLM 인프라 | llm-logger logLLMCall | ✅ |

### 안정화 기준선 v3.2.0 (2026-03-07)

| 항목 | 값 | 비고 |
|------|-----|------|
| 버전 | v3.2.0 | |
| state.db 테이블 수 | 17개 | reservations~doctor_log |
| 덱스터 체크 모듈 수 | 15개 | 11 기존 + 4 v2 신규 |
| 덱스터 전시스템 점검 | ✅ 이상 없음 | 2026-03-07 실행 |
| 덱스터 퀵체크 | ✅ 이상 없음 | |
| 스카팀 E2E | ✅ | State Bus 포함 |
| 루나팀 크립토 | ✅ OPS | PAPER_MODE=false |
| TP/SL OCO 설정률 | 100% | OPS 진입 시 필수 |
| 독터 화이트리스트 | 5개 | |
| 독터 블랙리스트 | 9개 | |
| LLM 일간 비용 | $0.00 | 기준일 기준 |
| 월간 예산 사용률 | 0% / $10 | |
| secrets 노출 | 0건 | |
| pre-commit 훅 | 설치됨 | |

---

## 2026-03-06

### Day 1 — State Bus + TP/SL OCO (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| State Bus emitEvent/getUnprocessedEvents | ✅ |
| State Bus createTask/completeTask | ✅ |
| TP/SL OCO 가격 계산 정확도 | ✅ |
| OCO PAPER_MODE 생략 | ✅ |
| 기존 E2E 27/27 | ✅ |

### Day 2 — 덱스터 v2 (16/16 ✅)

| 테스트 | 결과 |
|--------|------|
| DexterMode Normal→Emergency 전환 | ✅ |
| DexterMode Emergency→Normal 복귀 | ✅ |
| DexterMode 상태 파일 지속 | ✅ |
| team-leads.js 핵심 봇 점검 | ✅ |
| openclaw.js launchd+포트+메모리 | ✅ |
| llm-cost.js 예산 임계 | ✅ |
| workspace-git.js uncommitted 감지 | ✅ |
| dexter.js v2 모듈 통합 | ✅ |
| dexter-quickcheck.js v2 팀장 점검 | ✅ |

### Day 3 — llm-logger + llm-router + llm-cache (2026-03-06)

| 테스트 | 결과 |
|--------|------|
| llm-logger: logLLMCall DB 기록 | ✅ |
| llm-logger: getDailyCost 비용 집계 | ✅ |
| llm-router: ska status_check → simple/Groq | ✅ |
| llm-router: luna trade_decision → complex/Sonnet | ✅ |
| llm-router: claude architecture_review → deep/Opus | ✅ |
| llm-router: 긴급도 상향 (ska simple → medium) | ✅ |
| llm-cache: getCached 미스 → null | ✅ |
| llm-cache: setCache + getCached 히트 | ✅ |
| llm-cache: getCacheStats 집계 | ✅ |
| llm-cache: cleanExpired 만료 삭제 | ✅ |
| state.db 테이블 자동 생성 (llm_usage_log, llm_cache) | ✅ |

### False Positive 수정 (2026-03-06)

| 수정 | 결과 |
|------|------|
| openclaw.js IPv6 `[::1]` 파싱 수정 | ✅ 실행 시 status: ok |
| dexter-quickcheck.js 수동 실행 | ✅ 이상 없음 |

---

## 2026-03-18

### 모바일 알림 최적화

| 테스트 | 결과 |
|--------|------|
| `node --check packages/core/lib/reporting-hub.js` | ✅ |
| `node --check packages/core/lib/telegram-sender.js` | ✅ |
| `node --check bots/orchestrator/lib/batch-formatter.js` | ✅ |
| `node --check bots/investment/shared/report.js` | ✅ |
| `node --check bots/investment/team/reporter.js` | ✅ |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ |
| `renderNoticeEvent/buildReportEvent` 모바일 샘플 출력 확인 | ✅ 헤더/구분선/디테일 축약 확인 |

### 투자 설정 실험 적용/검증

| 테스트 | 결과 |
|--------|------|
| `apply-runtime-config-suggestion.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --write` | ✅ 실제 운영 `config.yaml` 반영 |
| `validate-runtime-config-apply.js --id=498d9f9c-4725-460a-a5ea-129e82f3be19 --days=7 --json` | ✅ `review_status=applied`, 판단 `observe` |
| `launchctl list | egrep 'ai\\.investment\\.commander'` | ✅ commander 재기동 확인 |

### 세션 종료 정합성

| 테스트 | 결과 |
|--------|------|
| 세션 문서 업데이트 (`SESSION_HANDOFF`, `WORK_HISTORY`, `RESEARCH_JOURNAL`, `CHANGELOG`) | ✅ |
| `node bots/claude/src/dexter.js --update-checksums` | ✅ 65개 파일 갱신 |

### 자동화 리포트 해석력 보강

### 비디오팀 신규 문서 과제 정리

| 테스트 | 결과 |
|--------|------|
| `find /Users/alexlee/projects/ai-agent-system/bots/video/docs -maxdepth 1 -type f | sort` | ✅ `SESSION_HANDOFF_VIDEO.md`, `VIDEO_HANDOFF.md`, `video-automation-tech-plan.md`, `video-team-design.md`, `video-team-tasks.md` 존재 확인 |
| `find /Users/alexlee/projects/ai-agent-system/bots/video -maxdepth 2 -type d | sort` | ✅ `bots/video/scripts` 제거 후 `config/context/docs/lib/migrations/src`만 남은 폴더 구조 확인 |
| `rg -n "비디오팀 세션 컨텍스트|과제 1" /Users/alexlee/projects/ai-agent-system/docs/SESSION_HANDOFF.md` | ✅ handoff 문서의 비디오팀 섹션이 `문서 정리 완료 / 구현 스캐폴딩 시작 전` 상태와 과제 1 다음 단계로 갱신됨 |

| 테스트 | 결과 |
|--------|------|
| `node --check scripts/reviews/jay-llm-daily-review.js` | ✅ |
| `node --check packages/core/lib/health-runner.js` | ✅ |
| `node --check scripts/reviews/ska-sales-forecast-daily-review.js` | ✅ |
| `node --check scripts/reviews/daily-ops-report.js` | ✅ |
| `node scripts/reviews/jay-llm-daily-review.js --json` | ✅ `dbSourceStatus`에 `sandbox_restricted` 노출 확인 |
| `ls /Users/alexlee/projects/ai-agent-system/tmp/jay-llm-daily-review-db-snapshot.json` | ✅ 제이 DB snapshot fallback 파일 생성 확인 |
| `node scripts/reviews/jay-llm-daily-review.js --json` 재실행 | ✅ `dbSource=snapshot_fallback`, `dbSnapshotFallback=true` 확인 |
| `node scripts/reviews/ska-sales-forecast-daily-review.js --days=5 --json` | ✅ `requestedDays=5`, `effectiveDays=7` 확인 |
| `node scripts/reviews/daily-ops-report.js --json` | ✅ investment / reservation `localFallback.enabled=true` 확인 |
| `node scripts/reviews/daily-ops-report.js` | ✅ `보조 신호: local fallback 활동 신호 1건` 텍스트 출력 확인 |
| `node scripts/reviews/daily-ops-report.js --json` 재실행 | ✅ `sourceMode=unavailable(local teams) / local_fallback(investment,reservation) / auxiliary_review(global)` 확인 |
| `node scripts/reviews/daily-ops-report.js` 재실행 | ✅ active issue / input failure에 `sourceMode` 텍스트 출력 확인 |
| `plutil -lint bots/investment/launchd/ai.investment.crypto.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.crypto.validation.plist` | ✅ OK |
| `bash -n scripts/pre-reboot.sh` | ✅ 통과 |
| `bash -n scripts/post-reboot.sh` | ✅ 통과 |
| `node --check bots/investment/shared/capital-manager.js` | ✅ 통과 |
| `node --check bots/investment/team/nemesis.js` | ✅ 통과 |
| `node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ normal 바이낸스 정책 `reserve_ratio=0.02`, `max_position_pct=0.18`, `max_concurrent_positions=6`, `max_daily_trades=16` 확인 |
| `INVESTMENT_TRADE_MODE=validation node --input-type=module -e "import { getCapitalConfig } from './bots/investment/shared/capital-manager.js'; ..."` | ✅ validation 바이낸스 정책 `reserve_ratio=0.01`, `risk_per_trade=0.01`, `max_position_pct=0.08`, `max_concurrent_positions=3`, `max_daily_trades=8` 확인 |
| `node --check bots/investment/shared/db.js` | ✅ 통과 |
| `node --check bots/investment/shared/trade-journal-db.js` | ✅ 통과 |
| `node --check bots/investment/shared/pipeline-decision-runner.js` | ✅ 통과 |
| `node --check bots/investment/scripts/trading-journal.js` | ✅ 통과 |
| `node --check bots/investment/scripts/weekly-trade-review.js` | ✅ 통과 |
| `node bots/investment/scripts/trading-journal.js --days=1` | ✅ `trade_journal.trade_mode` 마이그레이션 선행 후 `[LIVE][NORMAL]`, `[PAPER][NORMAL]` 태그와 `mode NORMAL` 퍼널 출력 확인 |
| `node bots/investment/scripts/weekly-trade-review.js --dry-run` | ✅ 주간 퍼널에 `mode NORMAL ...` 운영모드 집계 출력 확인 |
| `node --check bots/investment/markets/crypto.js` | ✅ `trade_mode`별 상태 파일 분리 로직 문법 확인 |
| `plutil -lint bots/investment/launchd/ai.investment.domestic.validation.plist` | ✅ OK |
| `plutil -lint bots/investment/launchd/ai.investment.overseas.validation.plist` | ✅ OK |

### 워커 매출 / 스카 동기화 및 페이지네이션 정리

| 테스트 | 결과 |
|--------|------|
| `node --check bots/worker/lib/ska-sales-sync.js` | ✅ 통과 |
| `node --check bots/worker/web/server.js` | ✅ 통과 |
| `node --check bots/worker/web/app/sales/page.js` | ✅ 통과 |
| `node --check bots/worker/web/components/DataTable.js` | ✅ 통과 |
| `node -e "syncSkaSalesToWorker('test-company')"` 1차 실행 | ✅ 누락분 `inserted: 124` backfill 확인 |
| `node --input-type=module -e "... worker.sales / reservation.daily_summary 총액 대조 ..."` | ✅ `28,847,500원`, 최신일 `2026-03-19` 일치 확인 |
| `PICKKO_HEADLESS=1 node bots/reservation/scripts/pickko-revenue-backfill.js --from=2026-03 --to=2026-03` | ✅ `2026-03-16~2026-03-18` 원천 데이터 복구 확인, 종료 시 CSV export `rows is not iterable` 잔여 오류 확인 |
| `node --input-type=module -e "... 2026-03-16~2026-03-19 daily_summary 확인 ..."` | ✅ `pickko_total/general_revenue` 기준 저장 확인 |
| `node --input-type=module -e "... 2026-01-01~2026-01-12 worker.sales 확인 ..."` | ✅ `test-company`의 1월 초 데이터가 이미 존재함을 확인 |
| `node -e "... daily_summary vs worker.sales mismatch check ..."` | ✅ `2026-03-19` 1건 mismatch 확인 후 `mismatchCount: 0`으로 재검증 완료 |
| `node -e "... room_amounts_json 있는데 pickko_study_room=0 인 날짜 탐지 ..."` | ✅ 이상치 37건 확인 |
| `node -e "... daily_summary pickko_study_room / pickko_total 원천 보정 ..."` | ✅ 원천 37건 복구 완료 |
| `node -e "syncSkaSalesToWorker('test-company')"` 2차 실행 | ✅ room JSON 기반 스터디룸 매출 `inserted: 37`, 최종 `expectedRows: 274` 확인 |
| `node -e "... room_amounts_json 기준 suspicious 재검사 ..."` | ✅ `suspiciousCount: 0` |
| `node --check bots/reservation/lib/db.js` | ✅ 통과 |
| `node --check bots/reservation/auto/scheduled/pickko-daily-summary.js` | ✅ 통과 |
| `node --check bots/reservation/scripts/health-report.js` | ✅ 통과 |
| `node bots/reservation/scripts/health-report.js --json` | ✅ `dailySummaryIntegrityHealth.issueCount=0`, `daily_summary 무결성: 스터디룸/일반/합계 구조 정상` 확인 |
| `node --check bots/investment/shared/pipeline-market-runner.js` | ✅ 통과 |
| `node --check bots/investment/markets/crypto.js` | ✅ 통과 |
| `node --check bots/investment/markets/domestic.js` | ✅ 통과 |
| `node --check bots/investment/markets/overseas.js` | ✅ 통과 |
| `node --check bots/investment/shared/kis-client.js` | ✅ 통과 |
| `node --check bots/investment/team/hanul.js` | ✅ 통과 |
| `node bots/investment/scripts/health-report.js --json` | ✅ 현재 `warnCount=0`, 루나 health 자체는 정상이나 최근 collect 경고는 enrichment/LLM 차단 계열 로그로 분리 확인 |
| `npm --prefix bots/worker/web run build` | ✅ 통과 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.web` | ✅ 실행 |
| `launchctl kickstart -k gui/$(id -u)/ai.worker.nextjs` | ✅ 실행 |

### 스카 수동 처리 완료 루프 / 재시작 경고 정정

| 테스트 | 결과 |
|--------|------|
| `node --check bots/reservation/manual/reports/pickko-alerts-resolve.js` | ✅ 통과 |
| `node --check bots/reservation/auto/monitors/naver-monitor.js` | ✅ 통과 |
| `node --check bots/reservation/lib/db.js` | ✅ 통과 |
| `node --check bots/orchestrator/src/router.js` | ✅ 통과 |
| `node bots/reservation/manual/reports/pickko-alerts-resolve.js --phone=010-4697-3620 --date=2026-03-20 --start=16:00` | ✅ 기존 미해결 오류 알림 `8건` 해결 처리 완료 확인 |
| `node --input-type=module -e "... reservation.alerts by phone/date/start ..."` | ✅ 동일 예약 과거 오류 알림이 모두 `resolved=1`, `resolved_at` 채워짐 확인 |
| `node --input-type=module -e "... reservation.reservations by phone/date/start ..."` | ✅ 대상 예약 `status=completed`, `pickko_status=time_elapsed`, `marked_seen=1` 확인 |
| `node --input-type=module -e "... unresolved error alerts ..."` | ✅ 현재 PostgreSQL 기준 unresolved error alerts `0건` 확인 |
| `bash bots/reservation/scripts/reload-monitor.sh` | ✅ 스카 모니터 재시작 완료 (`PID: 6546`) |
| `node bots/orchestrator/scripts/health-report.js --json` | ✅ orchestrator / gateway / critical webhook 정상 |
| `launchctl kickstart -k gui/$(id -u)/ai.orchestrator` | ✅ 제이 완료 문구 처리 로직 라이브 반영 |

### 스카 headless 운영 문서 정합화

| 테스트 | 결과 |
|--------|------|
| `rg -n "PLAYWRIGHT_HEADLESS|playwright-headed|PICKKO_HEADLESS|NAVER_HEADLESS" docs/team-indexes/TEAM_SKA_REFERENCE.md docs/coding-guide.md docs/SYSTEM_DESIGN.md` | ✅ 스카 참조/가이드/설계 문서가 최신 headless 토글 정책을 공통 참조하도록 반영 확인 |
| `rg -n "PICKKO_HEADLESS=1" docs/team-indexes/TEAM_SKA_REFERENCE.md docs/coding-guide.md docs/SYSTEM_DESIGN.md` | ✅ `SYSTEM_DESIGN.md`의 고정 표현 제거, `coding-guide.md`는 legacy 호환 설명만 유지됨을 확인 |

### 비디오팀 CapCut readiness 체크

| 테스트 | 결과 |
|--------|------|
| `node bots/video/scripts/check-capcut-readiness.js` | ✅ `CapCut.app` 실행, `CapCutAPI` 응답, `create_draft / save_draft` 성공 확인 |
| `find /Users/alexlee/projects/CapCutAPI -maxdepth 2 -type d -name 'dfd_cat_*'` | ✅ repo 내부 `dfd_cat_*` draft 폴더 생성 확인 |
| `find "/Users/alexlee/Movies/CapCut/User Data/Projects/com.lveditor.draft" -maxdepth 2 -name 'dfd_*'` | ✅ Desktop 프로젝트 경로에는 새 draft 미생성 확인 |

### 비디오팀 과제 5 — CapCutAPI 드래프트 생성

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/capcut-draft-builder.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-capcut-draft.js` | ✅ 문법 통과 |
| `node bots/video/scripts/test-capcut-draft.js` | ✅ `healthCheck / createDraft / addVideo / addAudio / addSubtitle / saveDraft / findDraftFolder / copyToCapCut / buildDraft` 전체 통과 |
| `find /Users/alexlee/projects/CapCutAPI -maxdepth 2 -type d -name 'dfd_cat_1774019905_8be75a35'` | ✅ repo 내부 draft 생성 확인 |
| `find "/Users/alexlee/Movies/CapCut/User Data/Projects/com.lveditor.draft" -maxdepth 2 -name 'dfd_cat_1774019905_8be75a35'` | ✅ CapCut Desktop 프로젝트 디렉토리 복사 확인 |
| CapCut Desktop 프로젝트 목록 확인 | ✅ 새 draft 카드 표시 확인 |

### 비디오팀 과제 6 — 영상 분석 + EDL + FFmpeg 렌더링

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/lib/video-analyzer.js` | ✅ 문법 통과 |
| `node --check bots/video/lib/edl-builder.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-video-analyzer.js` | ✅ 문법 통과 |
| `node --check bots/video/scripts/test-edl-builder.js` | ✅ 문법 통과 |
| `node -e "getMediaInfo('./bots/video/temp/synced.mp4')"` | ✅ `1920x1080`, `60fps`, `h264`, `48000Hz stereo`, `duration=4416.8` 확인 |
| `analyzer-smoke.mp4` 120초 샘플 생성 후 `analyzeVideo()` 실행 | ✅ `duration=120.033333`, `scenes=1`, 메타데이터 구조 확인 |
| smoke clip EDL 생성 + `buildPreviewCommand()` + `convertSrtToVtt()` | ✅ EDL 저장, preview 명령 생성, VTT 변환 확인 |
| smoke clip `renderPreview()` | ✅ `1280x720`, `60fps`, `AAC 128k`, `faststart` 확인 |
| smoke clip `renderFinal()` | ✅ `2560x1440`, `60fps`, `H.264 High`, `48kHz stereo`, `faststart` 확인 |
| `ffmpeg -hide_banner -filters | rg "drawtext|subtitles"` | ✅ 현재 로컬 FFmpeg에서 두 필터 미지원 확인, overlay / burn-in fallback 동작 확인 |

### 비디오팀 과제 7 — run-pipeline 1차 통합

| 테스트 | 결과 |
|--------|------|
| `node --check bots/video/src/index.js` | ✅ `loadConfig()` export 리팩터링 문법 통과 |
| `node --check bots/video/scripts/run-pipeline.js` | ✅ 문법 통과 |
| `node -e "... parseArgs/resolveSources ..."` | ✅ `--source=1`이 `원본_파라미터.mp4` + `원본_나레이션_파라미터.m4a`로 매핑됨 확인 |
| `node -e "... pgPool.query('public', 'SELECT 1') ..."` | ✅ 로컬 DB 연결 확인 |
| `node bots/video/scripts/run-pipeline.js --source=1 --skip-render` | ⚠️ 실자산 기준 전처리 / STT / 자막교정 / 영상분석 / EDL 생성까지 통과, preview 렌더는 실제로 진행되지만 wall-clock이 길어 최종 종료까지는 추가 최적화 필요 |
| `analysis.json`, `edit_decision_list.json`, session temp 산출물 확인 | ✅ 실검증 session dir에 생성 확인 |
| 동시 2회 `node bots/video/scripts/run-pipeline.js --source=1 --skip-render` 실행 | ✅ 두 번째 실행이 `다른 video pipeline 실행이 이미 진행 중입니다`로 즉시 차단됨 확인 |
| lock 파일 `/Users/alexlee/projects/ai-agent-system/bots/video/temp/.run-pipeline.lock.json` | ✅ 검증 후 자동 해제 확인 |
