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
│ rag.js                  │ 편집 패턴 벡터 검색 (Phase 2)       │ 없음           │
│ rag-safe.js             │ RAG 안전 래퍼                       │ 없음           │
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
│ capcut-draft-builder.js  │ CapCutAPI MCP 연동 → 드래프트 생성  │ P0 (W1)  │
│ draft-parser.js          │ draft_info.json 파싱 → 편집정보 추출│ P0 (W1)  │
│ ffmpeg-renderer.js       │ 파싱된 편집정보 → 1440p/60fps 렌더링│ P0 (W1)  │
│ quality-loop.js          │ Critic-Refiner-Evaluator 순환 검증  │ P1 (W2)  │
│ critic-agent.js          │ RED: 드래프트 분석 → 문제점 리포트   │ P1 (W2)  │
│ refiner-agent.js         │ BLUE: CapCutAPI로 드래프트 패치     │ P1 (W2)  │
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
│   │   ├─ capcut-draft-builder.js     — CapCutAPI MCP 드래프트 생성
│   │   ├─ draft-parser.js             — draft_info.json → 편집정보
│   │   ├─ ffmpeg-renderer.js          — 편집정보 → 1440p/60fps MP4
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
영상+나레이션 합성             │ bots/video/lib/ffmpeg-preprocess.js │ child_process (ffmpeg)
Whisper API STT → SRT         │ bots/video/lib/whisper-client.js    │ llm-keys.js (OpenAI키)
LLM 자막 교정                  │ bots/video/lib/subtitle-corrector.js│ llm-router.js, llm-fallback.js
SRT 파일 읽기/쓰기            │ bots/video/lib/subtitle-corrector.js│ fs
```

### 3-2. CapCut 편집 계층

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
CapCutAPI MCP 서버 연결        │ bots/video/lib/capcut-draft-builder.js │ http (localhost:9001)
create_draft                  │ bots/video/lib/capcut-draft-builder.js │ CapCutAPI
add_video/audio/subtitle      │ bots/video/lib/capcut-draft-builder.js │ CapCutAPI
save_draft → dfd_ 폴더        │ bots/video/lib/capcut-draft-builder.js │ CapCutAPI, fs
dfd_ → CapCut 드래프트 복사   │ bots/video/lib/capcut-draft-builder.js │ fs (cp)
```

### 3-3. FFmpeg 최종 렌더링 (CapCut Export 우회)

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
draft_info.json 파싱           │ bots/video/lib/draft-parser.js │ fs, JSON
클립 순서/in-out 포인트 추출   │ bots/video/lib/draft-parser.js │ -
FFmpeg 명령어 생성             │ bots/video/lib/ffmpeg-renderer.js │ draft-parser.js
자막 번인 (ASS 스타일)         │ bots/video/lib/ffmpeg-renderer.js │ child_process (ffmpeg)
1440p/60fps 렌더링            │ bots/video/lib/ffmpeg-renderer.js │ child_process (ffmpeg)
```

### 3-4. 품질 검증 루프 (Phase 2)

```
기능                          │ 파일 위치                      │ 의존 모듈
─────────────────────────────│────────────────────────────────│──────────────
Critic: 자막 싱크 분석         │ bots/video/lib/critic-agent.js │ llm-router.js
Critic: 오디오 밸런스 검증     │ bots/video/lib/critic-agent.js │ child_process (ffmpeg)
Refiner: SRT 수정              │ bots/video/lib/refiner-agent.js │ subtitle-corrector.js
Refiner: CapCutAPI 패치        │ bots/video/lib/refiner-agent.js │ capcut-draft-builder.js
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
  audio_lra: 11
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
  fallback_model: gemini-2.0-flash
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

### 7-3. ★ 대화형 UX 시나리오 (9단계)

```
제작팀이 /video 페이지에 접속하면, 채팅 형태의 대화형 UI가 표시됨.
각 단계마다 시스템이 다음 작업을 안내하고, 필요 시 편집 의도를 수집.

════════════════════════════════════════════════════════════
 Step 1: 파일 업로드
════════════════════════════════════════════════════════════

  시스템: "안녕하세요! 영상 편집을 시작합니다.
          영상 파일(.mp4)과 음성 파일(.m4a)을 순서대로 업로드해주세요.
          여러 파일을 올릴 수 있으며, 업로드 순서가 편집 순서가 됩니다."

  [드래그앤드롭 영역]
  ├─ 영상 파일 (mp4): 여러 개 순서대로 추가 가능
  │   📄 원본_1.mp4 (73분, 142MB) ✅
  │   📄 원본_2.mp4 (47분, 115MB) ✅
  │   📄 원본_3.mp4 (33분, 64MB) ✅
  │
  └─ 음성 파일 (m4a): 여러 개 순서대로 추가 가능
      🎵 나레이션_1.m4a (8분, 4.1MB) ✅
      🎵 나레이션_2.m4a (8분, 3.9MB) ✅
      🎵 나레이션_3.m4a (14분, 6.9MB) ✅

  ★ 순서 변경: 드래그로 순서 재배치 가능
  ★ 파일 삭제: X 버튼으로 개별 제거 가능
  ★ 영상-음성 매칭: 같은 순번끼리 자동 매칭 (1-1, 2-2, 3-3)
    → 개수 불일치 시 안내: "영상 3개, 음성 2개입니다. 확인해주세요"

  시스템: "다음은 편집 의도를 확인합니다.
          [업로드] 버튼을 눌러주세요."

════════════════════════════════════════════════════════════
 Step 1.5: 편집 의도 수집 (선택)
════════════════════════════════════════════════════════════

  시스템: "편집에 참고할 사항이 있으면 알려주세요. (선택사항)
          예: '자막 크기를 크게', '전환 효과 많이', '인트로 추가' 등"

  [텍스트 입력 영역]
  제작팀: "FlutterFlow DB 생성 강의입니다. 자막은 크게 해주세요."

  시스템: "감사합니다! 편집 참고사항을 저장했습니다.
          → 다음 작업: 파일 업로드를 진행합니다."

════════════════════════════════════════════════════════════
 Step 2: 업로드 진행
════════════════════════════════════════════════════════════

  [업로드] 버튼 클릭

  시스템: "파일을 업로드하고 있습니다..."
          ████████████░░░░░░ 65% (원본_2.mp4 전송 중)
          예상 남은 시간: 약 2분 30초

  시스템: "✅ 모든 파일 업로드가 완료되었습니다!
          영상 3개 (321MB) + 음성 3개 (14.9MB)
          → 다음 작업: 자동 편집을 시작합니다."

════════════════════════════════════════════════════════════
 Step 3: 파일 수집 확인 (프로토타입: 맥북 로컬)
════════════════════════════════════════════════════════════

  시스템: "파일이 편집 서버에 정상 수신되었습니다.
          저장 위치: sources/20260320_001/
          영상-음성 매칭:
            세트 1: 원본_1.mp4 ↔ 나레이션_1.m4a
            세트 2: 원본_2.mp4 ↔ 나레이션_2.m4a
            세트 3: 원본_3.mp4 ↔ 나레이션_3.m4a
          → 다음 작업: AI 자동 편집을 시작합니다."

════════════════════════════════════════════════════════════
 Step 4: 영상 편집 진행 + 예상 시간 안내
════════════════════════════════════════════════════════════

  시스템: "🎬 영상 편집이 진행 중입니다.

          [세트 1] 원본_1 + 나레이션_1
            ├─ ✅ 오디오 정규화 완료 (12초)
            ├─ ✅ 자막 추출 완료 (45초)
            ├─ ⏳ 자막 교정 중...
            ├─ ⬜ CapCut 드래프트 생성
            └─ ⬜ 품질 검증

          [세트 2] 원본_2 + 나레이션_2
            └─ ⬜ 대기 중

          [세트 3] 원본_3 + 나레이션_3
            └─ ⬜ 대기 중

          ⏱️ 예상 소요 시간: 약 15분
             (과거 유사 영상 3건 기준 — RAG 분석)"

  ★ RAG 예상 시간 판단:
    → video_edits 테이블의 과거 편집 이력 조회
    → 유사한 길이/파일 크기의 편집 소요 시간 평균 계산
    → 과거 데이터 없으면: "예상 시간은 편집 이력이 쌓이면 더 정확해집니다"

  ★ 실시간 상태 업데이트:
    → 폴링 (5초 간격) 또는 SSE(Server-Sent Events)
    → 각 세트별 단계별 진행 상태 + 경과 시간 표시

════════════════════════════════════════════════════════════
 Step 5: 1차 작업 완료
════════════════════════════════════════════════════════════

  시스템: "✅ AI 자동 편집이 완료되었습니다!

          [세트 1] 원본_1 + 나레이션_1 — 품질 점수: 87/100
          [세트 2] 원본_2 + 나레이션_2 — 품질 점수: 91/100
          [세트 3] 원본_3 + 나레이션_3 — 품질 점수: 85/100

          총 소요 시간: 12분 34초
          총 비용: $0.16

          → 다음 작업: CapCut에서 편집 상태를 확인해주세요.
            CapCut Desktop을 열면 드래프트 3개가 보입니다."

════════════════════════════════════════════════════════════
 Step 6: CapCut 편집 상태 확인 안내
════════════════════════════════════════════════════════════

  시스템: "CapCut Desktop에서 다음 드래프트를 확인해주세요:
          📂 [DB생성_20260320] — 세트 1
          📂 [동적데이터_20260320] — 세트 2
          📂 [서버인증_20260320] — 세트 3

          확인할 사항:
            ✓ 자막이 올바르게 표시되는지
            ✓ 오디오-영상 싱크가 맞는지
            ✓ 전환 효과가 적절한지

          CapCut에서 수정이 필요하면 직접 수정하셔도 됩니다.
          수정 내용은 최종본에 자동 반영됩니다.

          확인 완료 후 아래 [컨펌] 버튼을 눌러주세요."

════════════════════════════════════════════════════════════
 Step 7: 웹에서 컨펌 입력
════════════════════════════════════════════════════════════

  [세트별 컨펌]
  ├─ 세트 1: [✅ 컨펌] [❌ 재편집 요청]
  │   재편집 시 사유 입력: "자막 타이밍이 1분대에서 밀려요"
  ├─ 세트 2: [✅ 컨펌]
  └─ 세트 3: [✅ 컨펌]

  시스템: "세트 1은 재편집을 진행합니다.
          세트 2, 3은 최종본 제작을 시작합니다.
          → 다음 작업: 최종 렌더링을 진행합니다."

════════════════════════════════════════════════════════════
 Step 8: 최종본 제작 (FFmpeg 렌더링)
════════════════════════════════════════════════════════════

  시스템: "🎬 최종본을 제작하고 있습니다...

          [세트 1] 재편집 중 → 품질 검증 → 렌더링 대기
          [세트 2] ████████████████ 100% 렌더링 완료 ✅
          [세트 3] ████████░░░░░░░░ 52% 렌더링 중...

          → 1440p / 60fps / H.264로 렌더링합니다.
          → 예상 완료: 약 8분"

════════════════════════════════════════════════════════════
 Step 9: 완료 + 다운로드
════════════════════════════════════════════════════════════

  시스템: "🎉 모든 영상 편집이 완료되었습니다!

          [세트 1] 편집_DB생성.mp4 (485MB, 22분)     [⬇️ 다운로드]
          [세트 2] 편집_동적데이터.mp4 (302MB, 12분)  [⬇️ 다운로드]
          [세트 3] 편집_서버인증.mp4 (738MB, 34분)    [⬇️ 다운로드]

                                            [📦 전체 다운로드 ZIP]

          총 소요: 업로드 → 완료까지 28분 12초
          총 비용: $0.21

          수고하셨습니다! 새 영상 편집을 시작하시겠습니까?
          [🎬 새 편집 시작]"
```

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
