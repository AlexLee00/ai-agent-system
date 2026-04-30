# 비디오팀 설계 문서

> 작성일: 2026-03-20
> 전략 담당: 메티 (claude.ai)
> 마스터: Jay (Alex)
> 위치: ai-agent-system/bots/video/
> 기획서: video-automation-tech-plan.md (상세 기술 구현 방안)

---

## 1. 팀 제이 기존 모듈 활용 매핑

### 1-1. 재사용 모듈 (packages/core/lib/)

```
┌─────────────────────────┬────────────────────────────────────┬───────────────┐
│ 기존 모듈                │ 비디오팀 활용 용도                   │ 수정 필요 여부 │
├─────────────────────────┼────────────────────────────────────┼───────────────┤
│ pg-pool.js              │ video_edits 테이블 CRUD              │ 없음 (그대로)  │
│ llm-router.js           │ 자막 교정 LLM 복잡도 기반 라우팅     │ 없음           │
│ llm-model-selector.js   │ config.yaml 기반 모델 선택          │ 없음           │
│ llm-fallback.js         │ OpenAI→Gemini→Claude 폴백 체인     │ 없음           │
│ llm-logger.js           │ Whisper/GPT 비용 자동 추적          │ 없음           │
│ llm-keys.js             │ API 키 관리 (OpenAI, Gemini)        │ 없음           │
│ telegram-sender.js      │ 드래프트 완료/품질점수/렌더링 알림   │ 없음           │
│ n8n-runner.js           │ n8n 워크플로우 트리거               │ 없음           │
│ n8n-webhook-registry.js │ 마스터 OK 웹훅 수신                 │ 없음           │
│ heartbeat.js            │ 비디오 봇 생존 확인                  │ 없음           │
│ kst.js                  │ KST 시간 유틸리티                   │ 없음           │
│ trace.js                │ 파이프라인 trace_id 추적             │ 없음           │
│ tool-logger.js          │ FFmpeg/Whisper/CapCutAPI 호출 로깅  │ 없음           │
│ rag.js                  │ 편집 패턴/피드백 벡터 저장·검색     │ 없음           │
│ rag-safe.js             │ RAG 안전 래퍼 + 서킷 브레이커       │ 없음           │
│ shadow-mode.js          │ 품질 검증 루프 참고 패턴             │ 패턴 참고만    │
└─────────────────────────┴────────────────────────────────────┴───────────────┘

★ 총 15개 모듈 재사용, 신규 코드 0줄로 핵심 인프라 확보
```

### 1-2. 신규 구현 모듈 (bots/video/lib/)

```
┌──────────────────────────┬────────────────────────────────────┬──────────┐
│ 신규 모듈                 │ 역할                                │ 우선순위  │
├──────────────────────────┼────────────────────────────────────┼──────────┤
│ ffmpeg-preprocess.js     │ 오디오 정규화 + 추출 + 포맷 변환    │ P0 (W1)  │
│ whisper-client.js        │ Whisper API 호출 → SRT 생성         │ P0 (W1)  │
│ subtitle-corrector.js    │ LLM 셀렉터 → 한글 자막 교정         │ P0 (W1)  │
│ capcut-draft-builder.js  │ CapCutAPI 선택적 보조 프리뷰 (완료) │ P0 (W1) ✅│
│ video-analyzer.js        │ FFmpeg 영상 분석 (무음/정지/씬전환) │ P0 (W1)  │
│ edl-builder.js           │ EDL JSON 생성/수정 + FFmpeg 실행    │ P0 (W1)  │
│ scene-indexer.js         │ OCR 장면 인덱싱 + 장면 분류         │ P0 (W2)  │
│ narration-analyzer.js    │ 나레이션 STT 후 구간 분석           │ P0 (W2)  │
│ sync-matcher.js          │ AI 싱크 매칭 + sync_map/EDL 변환    │ P0 (W2)  │
│ intro-outro-handler.js   │ 인트로/아웃트로 파일/프롬프트 처리  │ P0 (W2)  │
│ step-proposal-engine.js  │ 편집 스텝 생성 + confidence         │ P0 (W3)  │
│ video-feedback-service.js │ 피드백 세션 관리 (schema=video)     │ P0 (W3)  │
│ video-rag.js            │ 편집 결과/피드백 RAG 축적 + 추천    │ P1 (W2)  │
│ quality-loop.js          │ Critic-Refiner-Evaluator 순환 검증  │ P1 (W2)  │
│ critic-agent.js          │ RED: 자막+오디오+영상 구조 분석     │ P1 (W2)  │
│ refiner-agent.js         │ BLUE: SRT 수정 + EDL 생성/수정      │ P1 (W2)  │
│ evaluator-agent.js       │ 품질 점수 판정 (85/100 기준)        │ P1 (W2)  │
└──────────────────────────┴────────────────────────────────────┴──────────┘
```

---

## 2. 디렉토리 구조

```
ai-agent-system/
├─ bots/video/                        ← NEW
│   ├─ docs/                           ← 개발 중 MD 파일 (코드 옆 배치)
│   │   ├─ VIDEO_HANDOFF.md            — 인수인계 허브
│   │   ├─ video-automation-tech-plan.md — 기술 구현 방안
│   │   ├─ video-team-design.md        — 설계 + 모듈 매핑
│   │   ├─ video-team-tasks.md         — 소과제 + 프롬프트
│   │   └─ CLAUDE.md                   — 구현 규칙 + YouTube 렌더링 확정값
│   ├─ context/
│   │   └─ IDENTITY.md                 — 비디오팀 정체성
│   ├─ lib/
│   │   ├─ ffmpeg-preprocess.js        — 오디오 정규화 + 추출
│   │   ├─ whisper-client.js           — Whisper API STT
│   │   ├─ subtitle-corrector.js       — LLM 자막 교정
│   │   ├─ capcut-draft-builder.js     — CapCutAPI 선택적 보조 (완료, --with-capcut)
│   │   ├─ video-analyzer.js           — FFmpeg 영상 분석 (무음/정지/씬전환)
│   │   ├─ edl-builder.js              — EDL JSON 생성/수정 + FFmpeg 렌더링
│   │   ├─ scene-indexer.js            — OCR 장면 인덱싱 (Phase 2)
│   │   ├─ narration-analyzer.js       — 나레이션 구간 분석 (Phase 2)
│   │   ├─ sync-matcher.js             — AI 싱크 매칭 (Phase 2)
│   │   ├─ intro-outro-handler.js      — 인트로/아웃트로 하이브리드 (Phase 2)
│   │   ├─ video-rag.js                — 편집 결과/피드백 RAG 축적 + 패턴 추천
│   │   ├─ quality-loop.js             — Critic-Refiner-Evaluator 루프
│   │   ├─ critic-agent.js             — RED Team 분석
│   │   ├─ refiner-agent.js            — BLUE Team 수정
│   │   └─ evaluator-agent.js          — 품질 점수 판정
│   ├─ config/
│   │   └─ video-config.yaml           — LLM 모델, 경로, CapCut 설정
│   ├─ migrations/
│   │   └─ 001-video-schema.sql        — video_edits 테이블
│   ├─ scripts/
│   │   ├─ run-pipeline.js             — 수동 파이프라인 실행
│   │   └─ test-capcut-api.js          — CapCutAPI 연결 테스트
│   │      ★ 현재는 다른 bots와 동일한 공통 구조를 맞추기 위한 예약 폴더
│   └─ src/
│       └─ index.js                    — 메인 엔트리
│   └─ samples/
│       ├─ raw/                        — 원본 샘플 영상
│       ├─ narration/                  — 샘플 나레이션
│       ├─ edited/                     — 기존 편집본 참고
│       └─ ANALYSIS.md                 — ffprobe/YouTube 분석 결과
│
├─ packages/core/lib/                  (기존 — 수정 없이 재사용)
│   ├─ pg-pool.js
│   ├─ llm-router.js / llm-fallback.js / llm-logger.js
│   ├─ telegram-sender.js
│   ├─ n8n-runner.js
│   ├─ heartbeat.js / kst.js / trace.js
│   └─ ...
│
└─ .gitignore                          (추가: *.mp4, *.m4a, dfd_*/)

외부 경로 (git 밖):
flutterflow_video/
├─ sources/1~N/                        — 원본 + 나레이션
├─ temp/                               — 처리 중 임시 파일
└─ exports/                            — FFmpeg 렌더링 출력

★ 문서 이동 계획 (최종 테스트 완료 후):
  개발 중:  bots/video/docs/에서 코드와 함께 관리
  안정화 후: docs/ 체계로 이동
    bots/video/docs/*.md  →  docs/video/*.md
    VIDEO_HANDOFF.md      →  docs/VIDEO_HANDOFF.md (루트 승격)

★ 현재 경계:
  - `bots/video/docs/CLAUDE.md`는 구현 규칙과 렌더링 확정값을 담는 운영 문서
  - Claude Code는 `CLAUDE.md → VIDEO_HANDOFF.md → video-team-design.md → samples/ANALYSIS.md → video-team-tasks.md` 순서로 읽는 것을 기본으로 한다
  - `bots/video/samples/`는 로컬 fixture/학습 데이터
  - 실제 운영 원본/임시/결과 저장소는 `flutterflow_video/`를 기준으로 유지
```

---

## 3. 기능목록 + 작업 위치 매핑

### 3-1. 전처리 파이프라인

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
원본 오디오 제거               │ bots/video/lib/ffmpeg-preprocess.js │ child_process (ffmpeg)
나레이션 LUFS 정규화 (-14)     │ bots/video/lib/ffmpeg-preprocess.js │ child_process (ffmpeg)
원본 장면 인덱싱 (OCR)         │ bots/video/lib/scene-indexer.js     │ tesseract.js, sharp
나레이션 구간 분석             │ bots/video/lib/narration-analyzer.js│ whisper-client.js, LLM
AI 싱크 매칭                  │ bots/video/lib/sync-matcher.js      │ scene-indexer + narration-analyzer
인트로/아웃트로 생성           │ bots/video/lib/intro-outro-handler.js│ FFmpeg, LLM
Whisper API STT → SRT         │ bots/video/lib/whisper-client.js    │ llm-keys.js (OpenAI키)
LLM 자막 교정                  │ bots/video/lib/subtitle-corrector.js│ llm-router.js, llm-fallback.js
SRT 파일 읽기/쓰기            │ bots/video/lib/subtitle-corrector.js│ fs

※ `영상+나레이션 합성(syncVideoAudio)`는 Phase 1 경로로 남아 있지만,
  Phase 2 메인 파이프라인에서는 더 이상 run-pipeline의 기본 경로로 사용하지 않는다.
```

### 3-2. EDL JSON 편집 계층 (CapCut 대체)

```
★ CapCut 7.2.0 draft 암호화 + CapCutAPI 저장 실패로 파이프라인 변경
기존: CapCut 드래프트 → draft_info.json 파싱 → FFmpeg 렌더링
현재: 영상 분석 → EDL JSON 생성 → FFmpeg 렌더링

기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
FFmpeg 영상 분석              │ bots/video/lib/video-analyzer.js  │ ffmpeg silencedetect, freezedetect, scene
분석 결과 → analysis.json     │ bots/video/lib/video-analyzer.js  │ JSON
Critic 리포트 → critic_report │ bots/video/lib/critic-agent.js    │ LLM + analysis.json
Refiner → EDL JSON 생성       │ bots/video/lib/edl-builder.js     │ critic_report + LLM
EDL → FFmpeg 프리뷰 렌더링    │ bots/video/lib/edl-builder.js     │ ffmpeg (720p)
EDL → FFmpeg 최종 렌더링      │ bots/video/lib/edl-builder.js     │ ffmpeg (1440p/24Mbps)
영상제작팀 피드백 → EDL 수정   │ 워커 웹 + edl-builder.js         │ JSON patch
CapCutAPI 보조 프리뷰 (선택)  │ bots/video/lib/capcut-draft-builder.js │ http (--with-capcut)
AI 싱크 매칭 → sync_map.json  │ bots/video/lib/sync-matcher.js     │ scene-index + narration-segments
sync_map → EDL 변환           │ bots/video/lib/sync-matcher.js     │ edl-builder 형식 호환
인트로/아웃트로 → EDL 삽입    │ bots/video/lib/intro-outro-handler.js │ concat 또는 drawtext
```

### 3-3. FFmpeg 영상 분석 + 렌더링

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
영상 분석 (무음/정지/씬전환)   │ bots/video/lib/video-analyzer.js │ ffmpeg filters
EDL JSON 해석                  │ bots/video/lib/edl-builder.js    │ JSON
FFmpeg 프리뷰 명령어 생성      │ bots/video/lib/edl-builder.js    │ 720p, 빠른 인코딩
FFmpeg 최종 렌더링 명령어      │ bots/video/lib/edl-builder.js    │ 1440p/24Mbps/High Profile
```

### 3-4. 품질 검증 루프 (Phase 2)

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
Critic: 자막/용어/길이 분석     │ bots/video/lib/critic-agent.js │ Gemini/OpenAI
Critic: 오디오 밸런스 검증     │ bots/video/lib/critic-agent.js │ child_process (ffmpeg)
Critic: 영상 구조 분석         │ bots/video/lib/critic-agent.js │ video-analyzer.js (무음/정지/씬전환)
Refiner: SRT 수정              │ bots/video/lib/refiner-agent.js │ subtitle-corrector.js
Refiner: SRT수정 + EDL생성     │ bots/video/lib/refiner-agent.js │ edl-builder.js, subtitle-corrector.js
Evaluator: 가중 평균 판정     │ bots/video/lib/evaluator-agent.js │ -
품질 루프 오케스트레이션       │ bots/video/lib/quality-loop.js │ critic/refiner/evaluator
```

### 3-5. 통합 + 알림

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
비디오 편집 이력 DB 저장       │ bots/video/src/index.js       │ pg-pool.js
텔레그램 알림 (드래프트 완료)  │ bots/video/src/index.js       │ telegram-sender.js
마스터 OK 수신 (웹훅/텔레그램) │ bots/video/src/index.js       │ n8n-webhook-registry.js
n8n 워크플로우 트리거          │ bots/video/src/index.js       │ n8n-runner.js
trace_id 추적                 │ bots/video/src/index.js       │ trace.js
Whisper/LLM 비용 추적         │ 자동 (llm-logger.js 연동)      │ llm-logger.js
```

---

## 4. DB 스키마

```sql
-- migrations/001-video-schema.sql

CREATE TABLE IF NOT EXISTS video_edits (
  id              SERIAL PRIMARY KEY,
  title           TEXT NOT NULL,                    -- 영상 제목 (예: "DB생성")
  source_dir      TEXT NOT NULL,                    -- sources/1/ 경로
  draft_name      TEXT,                             -- CapCut 드래프트 이름
  draft_path      TEXT,                             -- dfd_ 폴더 경로
  output_path     TEXT,                             -- FFmpeg 렌더링 출력 경로
  
  -- 비용 추적
  whisper_cost    NUMERIC(8,4) DEFAULT 0,           -- Whisper API 비용
  llm_cost        NUMERIC(8,4) DEFAULT 0,           -- 자막 교정 LLM 비용
  quality_cost    NUMERIC(8,4) DEFAULT 0,           -- 품질 루프 LLM 비용
  total_cost      NUMERIC(8,4) GENERATED ALWAYS AS 
                  (whisper_cost + llm_cost + quality_cost) STORED,
  
  -- 품질
  quality_score   INTEGER,                          -- 최종 품질 점수 (0-100)
  quality_loops   INTEGER DEFAULT 0,                -- 품질 루프 반복 횟수
  
  -- 처리 시간
  preprocess_ms   INTEGER,                          -- 전처리 시간
  stt_ms          INTEGER,                          -- STT 시간
  correction_ms   INTEGER,                          -- 자막 교정 시간
  draft_ms        INTEGER,                          -- 드래프트 생성 시간
  render_ms       INTEGER,                          -- FFmpeg 렌더링 시간
  total_ms        INTEGER,                          -- 전체 파이프라인 시간
  
  -- 상태
  status          TEXT DEFAULT 'pending',           -- pending/processing/draft_ready/
                                                    --   master_review/rendering/done/failed
  error_message   TEXT,
  trace_id        TEXT,
  
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_video_edits_status ON video_edits(status);
CREATE INDEX idx_video_edits_created ON video_edits(created_at DESC);
```

---

## 5. config 구조

```yaml
# config/video-config.yaml

# 경로
paths:
  sources: /Users/alexlee/projects/flutterflow_video/sources
  temp: /Users/alexlee/projects/flutterflow_video/temp
  exports: /Users/alexlee/projects/flutterflow_video/exports
  capcut_drafts: /Users/alexlee/Movies/CapCut/User Data/Projects/com.lveditor.draft

# CapCutAPI
capcut_api:
  host: http://localhost:9001
  mcp_cwd: /Users/alexlee/projects/CapCutAPI

# FFmpeg
ffmpeg:
  audio_lufs: -14
  audio_tp: -1
  audio_lra: 20
  audio_bitrate: 384k
  audio_sample_rate: 48000
  audio_channels: 2
  render_width: 2560
  render_height: 1440
  render_fps: 60
  render_bitrate: 24M
  render_preset: medium
  render_profile: high
  render_pixel_format: yuv420p
  render_movflags: +faststart
  render_color_space: bt709

# Whisper
whisper:
  provider: openai         # openai | local
  model: whisper-1
  language: ko
  response_format: verbose_json

# 자막 교정 LLM
subtitle_correction:
  llm_provider: openai
  llm_model: gpt-4o-mini
  fallback_provider: google
  fallback_model: gemini-2.5-flash
  max_retries: 2
  temperature: 0.1

# 품질 검증
quality_loop:
  enabled: true            # Phase 1: false → Phase 2: true
  target_score: 85
  max_iterations: 3
  llm_model: gpt-4o-mini

# 텔레그램
telegram:
  topic_id: null           # 비디오팀 Forum Topic ID (생성 후 설정)
```

---

## 6. 외부 의존성

```
CapCutAPI (별도 설치):
  레포: github.com/sun-guannan/VectCutAPI
  라이선스: Apache 2.0
  설치: git clone → pip install -r requirements.txt
  실행: python capcut_server.py (HTTP API, port 9001)
       python mcp_server.py (MCP 프로토콜)

capcut-export (npm):
  패키지: capcut-export
  용도: draft_info.json → FFmpeg 명령어 변환 참조
  설치: npm install capcut-export (또는 코드 참고하여 자체 파서 구현)

FFmpeg:
  설치: brew install ffmpeg (macOS)
  버전: 8.0+ (Whisper 필터 내장, 필수는 아님)

더백클래스 LMS (Phase 2+ 연동 대상):
  URL: the100class.flutterflow.app
  기술: FlutterFlow 기반 LMS (AI 노코드 개발 강의)
  관리: /adminEntry (관리자 패널)
  DB: Firebase 또는 Supabase (FlutterFlow 기본 연동)
  역할: 편집 완료된 강의 영상의 최종 배포 대상
  Phase 2: 영상 구조/메타데이터 학습
  Phase 3: 자동 업로드 연동 (편집 완료 → LMS 발행)
```

---

## 8. 더백클래스 LMS 연동 계획 (Phase 2+)

### 8-1. 현재 구조

```
더백클래스 (the100class.flutterflow.app)
  - "No.1 AI노코드 개발 강의" LMS
  - FlutterFlow로 제작된 웹앱
  - 관리자 패널: /adminEntry
  - 영상 강의 호스팅 + 수강 관리

현재 영상 업로드 프로세스 (수동):
  영상 편집 완료 → 관리자 로그인 → 수동 업로드 → 메타데이터 입력

자동화 목표:
  영상 편집 완료 → 자동으로 LMS에 업로드 + 메타데이터 생성
```

### 8-2. Phase 2 — LMS 영상 구조 학습

```
목표: 더백클래스의 강의 구조를 분석하여 자동화 매핑 준비

학습 항목:
  ☐ 강의 카테고리/코스 구조 (어떤 단위로 구성되는지)
  ☐ 영상 메타데이터 필드 (제목, 설명, 썸네일, 태그 등)
  ☐ 영상 호스팅 방식 (직접 업로드 vs 외부 링크 vs 스토리지)
  ☐ FlutterFlow DB 구조 (Firebase/Supabase 컬렉션/테이블)
  ☐ 기존 영상의 포맷/해상도/인코딩 패턴

RAG 활용:
  → 더백클래스 강의 목록 + 메타데이터를 RAG에 저장
  → 새 영상 편집 시 유사 강의 참조하여 메타데이터 자동 생성
```

### 8-3. Phase 3 — 자동 업로드 연동

```
목표: 편집 완료 → 더백클래스에 자동 발행

구현 방법 (FlutterFlow 연동):
  옵션 A: Firebase/Supabase API 직접 호출
    → FlutterFlow가 사용하는 DB에 직접 INSERT
    → 영상 파일은 Firebase Storage/Supabase Storage 업로드
    → 가장 안정적, DB 구조 파악 필요

  옵션 B: FlutterFlow API 활용
    → FlutterFlow의 Custom API 엔드포인트
    → 관리자 권한으로 API 호출

워커 웹 연동:
  대화형 UI Step 9 (완료 + 다운로드)에 추가:
    [⬇️ 다운로드] [📺 더백클래스 발행]
    → "더백클래스 발행" 클릭 시:
      ① 메타데이터 자동 생성 (제목, 설명, 카테고리)
      ② LLM으로 강의 설명 + 태그 생성
      ③ 썸네일 자동 생성 (영상 캡처 또는 AI)
      ④ LMS에 업로드 + 발행
      ⑤ 알림: "더백클래스에 강의가 발행되었습니다"
```

---

## 7. 워커 웹 연동 — 대화형 영상 편집 페이지

### 7-1. 배경

```
영상 제작팀이 물리적으로 분리되어 있음
→ 워커 웹에 "대화형 영상 편집" 페이지를 추가
→ 클로드 프롬프트처럼 절차 안내 + 편집 의도 수집 + 단계별 진행
→ 제작팀은 웹에서 업로드 → 상태 확인 → 컨펌 → 다운로드까지 완결
```

### 7-2. 워커 웹 기존 인프라 재활용

```
┌──────────────────────────┬────────────────────────────────────┐
│ 기존 워커 웹 기능          │ 비디오 페이지에 활용               │
├──────────────────────────┼────────────────────────────────────┤
│ Express.js 백엔드         │ /api/video/* 엔드포인트 추가       │
│ React 프론트엔드          │ /video 대화형 페이지 추가          │
│ JWT 인증                  │ 제작팀 사용자 인증 (그대로)        │
│ multer 파일 업로드 (✅구현)│ mp4/m4a 다중 업로드               │
│ company_id 멀티테넌트     │ 업체별 영상 분리 (그대로)          │
│ 업체별 메뉴 설정 (✅구현)  │ "영상 관리" 메뉴 추가             │
│ PWA (✅구현)              │ 모바일에서도 업로드 가능           │
│ audit_log (✅구현)        │ 전 과정 이력 자동 기록             │
│ OWASP 보안 (✅구현)       │ 파일 검증 + 보안 그대로           │
│ RAG/pgvector (✅구현)     │ 과거 편집 이력 → 예상 시간 판단   │
└──────────────────────────┴────────────────────────────────────┘
```

### 7-3. ★ 대화형 UX 시나리오 (5단계)

```
제작팀이 /video 페이지에 접속하면, 단계형 대화 UI가 표시된다.
Phase 2에서는 인트로/아웃트로 설정과 AI 싱크 매칭 진행 상태를 함께 보여준다.

════════════════════════════════════════════════════════════
 Step 1: 파일 업로드
════════════════════════════════════════════════════════════

  시스템: "원본 영상 파일과 나레이션 오디오를 업로드해주세요."
  [드래그앤드롭 영역]
  ├─ 원본 영상 (mp4)
  └─ 나레이션 오디오 (m4a)

════════════════════════════════════════════════════════════
 Step 2: 인트로 설정
════════════════════════════════════════════════════════════

  시스템: "인트로를 어떻게 처리할까요?"
  [파일 업로드] [프롬프트로 설명] [인트로 없음]

  파일 업로드 선택 시:
    - intro.mp4 업로드

  프롬프트 선택 시:
    - 설명 입력: "채널 로고 3초 + 강의 제목 페이드인"
    - 강의 제목 자동 채움
    - 로고 업로드 선택
    - 길이 슬라이더 1~10초

════════════════════════════════════════════════════════════
 Step 3: 아웃트로 설정
════════════════════════════════════════════════════════════

  시스템: "아웃트로를 어떻게 처리할까요?"
  [파일 업로드] [프롬프트로 설명] [아웃트로 없음]

════════════════════════════════════════════════════════════
 Step 4: 편집 의도 입력
════════════════════════════════════════════════════════════

  시스템: "추가 편집 요청이 있으면 입력해주세요.
          예: 자막 크게, 배속 1.2배"

════════════════════════════════════════════════════════════
 Step 5: 설정 요약 + 편집 시작
════════════════════════════════════════════════════════════

  시스템: "설정을 확인해주세요."
  ├─ 원본: 원본_파라미터.mp4
  ├─ 나레이션: 원본_나레이션_파라미터.m4a
  ├─ 인트로: 프롬프트 — 채널 로고 3초
  ├─ 아웃트로: 파일 — outro.mp4
  └─ 편집 의도: 자막 크게

  [편집 시작]

════════════════════════════════════════════════════════════
 Step 4 진행 후: AI 싱크 매칭 상태 표시
════════════════════════════════════════════════════════════

  [세트 1] 원본_1 + 나레이션_1
    ├─ ✅ 나레이션 STT 완료
    ├─ ✅ 원본 장면 인덱싱 완료 (35프레임 OCR)
    ├─ ⏳ AI 싱크 매칭 중...
    ├─ ⬜ 인트로/아웃트로 생성
    └─ ⬜ 프리뷰 렌더링

════════════════════════════════════════════════════════════
 Step 5 이후: 프리뷰 + 싱크 매칭 테이블
════════════════════════════════════════════════════════════

  프리뷰 + 싱크 매칭 테이블
  | 구간 | 나레이션 | 매칭 장면 | 점수 | [변경] |
  매칭 수정 → confirm → 최종 렌더링
```

### 7-3-1. Phase 3 대화형 편집 모드

```
┌─────────────────────────────────────────────────────┐
│ 워커 웹 /video (Next.js)                             │
├─────────────┬───────────────────────────────────────┤
│             │  @twick/video-editor                   │
│  AI 채팅    │  ┌─────────────────────────────────┐   │
│  패널       │  │     프리뷰 캔버스               │   │
│             │  │     (@twick/canvas)              │   │
│  스텝 제안  │  └─────────────────────────────────┘   │
│  RED 평가   │  ┌─────────────────────────────────┐   │
│  BLUE 대안  │  │     멀티트랙 타임라인            │   │
│             │  │     (@twick/timeline)            │   │
│  컨펌/수정  │  │     비디오 | 오디오 | 자막       │   │
│  버튼       │  └─────────────────────────────────┘   │
├─────────────┴───────────────────────────────────────┤
│  스텝 진행 바: ● ● ● ○ ○ ○ ○ ○ (3/8 완료)          │
└─────────────────────────────────────────────────────┘
```

UI 구조:
- 좌측: AI 채팅 패널 (스텝 제안 + RED 평가 + BLUE 대안 + 사용자 판단)
- 우측: Twick 기반 타임라인 편집기
- 하단: 스텝 진행 바와 자동화율 상태

### 7-4. 다중 파일 업로드 설계

```
DB 구조 변경 — 1:N 관계:
  video_sessions (세션 — 1건의 편집 요청)
    ├─ video_upload_files (업로드 파일 — 순서대로 여러 개)
    └─ video_edits (세트별 편집 결과 — 여러 개)

video_sessions:
  id, company_id, uploaded_by, title, edit_notes (편집 의도),
  estimated_time_ms (RAG 예상 시간), total_cost,
  status (uploading/processing/draft_ready/confirming/
          rendering/done/partial_done/failed),
  created_at

video_upload_files:
  id, session_id, file_type ('video'|'audio'), 
  original_name, stored_name, file_size_mb,
  sort_order (순서), pair_index (매칭 번호: 1,2,3...),
  created_at

video_edits (기존 테이블 확장):
  + session_id (세션 연결)
  + pair_index (세트 번호)
  + confirm_status ('pending'|'confirmed'|'rejected')
  + reject_reason (재편집 사유)
  + download_path (최종 렌더링 파일 경로)
  + download_count (다운로드 횟수)
```

### 7-5. API 엔드포인트

```
세션 관리:
  POST   /api/video/sessions              — 새 편집 세션 생성
  GET    /api/video/sessions              — 세션 목록 (company_id 필터)
  GET    /api/video/sessions/:id          — 세션 상세 (파일+편집 포함)
  GET    /api/video/sessions/:id/status   — 실시간 상태 (폴링/SSE)

파일 업로드:
  POST   /api/video/sessions/:id/upload   — 파일 업로드 (multer, 다중)
  PUT    /api/video/sessions/:id/reorder  — 파일 순서 변경
  DELETE /api/video/sessions/:id/files/:fileId — 파일 삭제

편집 제어:
  POST   /api/video/sessions/:id/start    — 편집 시작 트리거
  PUT    /api/video/sessions/:id/notes    — 편집 의도 수정
  POST   /api/video/edits/:id/confirm     — 세트별 컨펌
  POST   /api/video/edits/:id/reject      — 세트별 재편집 요청 (사유 포함)
  POST   /api/video/edits/:id/render      — 최종 렌더링 트리거

다운로드:
  GET    /api/video/edits/:id/download    — 최종본 개별 다운로드
  GET    /api/video/sessions/:id/download-all — 전체 ZIP 다운로드

예상 시간:
  GET    /api/video/estimate              — RAG 기반 예상 시간
         ?video_count=3&total_size_mb=321&total_duration_min=153
```

### 7-6. 프론트엔드 페이지

```
/video — 대화형 영상 편집 (메인 페이지)
  컴포넌트: VideoEditorPage.js
  UI: 채팅 형태 대화형 인터페이스
    ├─ 메시지 영역 (시스템 안내 + 사용자 입력)
    ├─ 파일 업로드 드래그앤드롭 (다중, 순서 변경)
    ├─ 편집 의도 입력란
    ├─ 실시간 진행 상태 (단계별 + 세트별)
    ├─ 컨펌/재편집 버튼 (세트별)
    └─ 다운로드 버튼 (개별 + 전체 ZIP)

  상태 머신 (React state):
    idle → uploading → uploaded → processing →
    draft_ready → confirming → rendering → done

  각 상태 전환 시 시스템 메시지 자동 생성:
    "다음 작업: ○○○을 진행합니다."

/video/history — 과거 편집 이력
  컴포넌트: VideoHistoryPage.js
  UI: 세션 목록 + 상태 + 다운로드 링크

사이드바: "📹 영상 편집" 메뉴 (enabled_menus에 'video')
```

### 7-7. RAG 예상 시간 판단

```
video_edits 테이블의 과거 이력을 RAG로 활용:

쿼리: 유사한 조건의 과거 편집 검색
  → 파일 크기 ±30% 범위
  → 영상 길이 ±20% 범위
  → 최근 30일 이내 데이터 우선

계산:
  estimated_time = AVG(total_ms) of similar past edits
  confidence = COUNT of similar edits (많을수록 정확)

표시:
  과거 데이터 3건 이상: "예상 소요 시간: 약 15분 (과거 유사 영상 기준)"
  과거 데이터 1~2건:   "예상 소요 시간: 약 15분 (참고 데이터 부족, 실제와 다를 수 있음)"
  과거 데이터 0건:     "예상 시간은 편집 이력이 쌓이면 제공됩니다"
```

### 7-8. 보안 + 파일 제한

```
업로드 제한:
  mp4: 최대 500MB/파일, 세션당 최대 10파일
  m4a: 최대 50MB/파일, 세션당 최대 10파일
  총합: 세션당 최대 5GB

보안: 기존 워커 웹 패턴 그대로
  확장자 화이트리스트 + MIME 이중 검증 + UUID 리네이밍
  audit_log 전 과정 기록
  다운로드: 인증 필수 + company_id 검증
```
