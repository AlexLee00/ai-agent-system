# 에디팀(Edit Team) 전략 문서 v1.0

> 작성일: 2026-03-25
> 전략 담당: Claude (claude.ai) — 팀 제이 전략
> 마스터: Alex
> 위치: ai-agent-system/bots/video/
> 상태: 설계 확정, 구현 대기

---

## 0. 팀명 변경 선언

**비디오팀(Video Team) → 에디팀(Edit Team)으로 변경한다.**

변경 사유:
- "비디오"는 수동적 소재를 의미하지만, "에디"는 능동적 편집 행위를 의미
- 멀티 에이전트 기반 "AI가 제안하고 사람이 판단하는" 편집 시스템이 팀의 본질
- 2026년 산업 트렌드인 "에이전틱 영상 편집(Agentic Video Editing)"과 정체성 일치
- 기존 코드 경로(bots/video/)는 유지, 팀 정체성만 변경

변경 범위:
- IDENTITY.md → 팀 이름 "에디팀(Edit Team)"으로 수정
- 텔레그램 포럼 토픽 → "에디팀" 채널명
- 문서 내 "비디오팀" 언급 → "에디팀"으로 통일
- 코드 디렉토리(bots/video/) → 변경 없음 (혼란 방지)

---

## 1. 비전

### 1-1. 한 줄 정의

> CapCut의 타임라인 UI + AI 스텝별 제안 + RED/BLUE 품질 검증 + RAG 자기학습 = **"쓸수록 똑똑해지는 강의 영상 편집기"**

### 1-2. 핵심 차별점

```
CapCut/Premiere : 사람이 전부 수동 → 품질 높지만 시간 많이 소요
OneTake/OpusClip: AI가 원클릭 처리 → 빠르지만 커스터마이징 불가 (블랙박스)
Phase 2 (현재)  : AI가 일괄 처리 후 통째로 보여줌 → 빠르지만 품질 불안정
에디팀 Phase 3  : AI가 스텝별 제안 → RED/BLUE 검증 → 사람이 핵심만 판단 → RAG 학습
                  → "처음엔 좀 느리지만, 할수록 빨라지는" 화이트박스 시스템
```

### 1-3. 산업 트렌드 정합성 (2026.03 리서치 기준)

| 트렌드 | 에디팀 대응 |
|--------|-----------|
| a16z: "Cursor가 코딩에 한 것을 에이전트가 영상에 할 것" | 스텝별 AI 제안 + 사용자 판단 구조 |
| VideoAgent: 30+ 전문 에이전트 오케스트레이션 | 12봇 멀티에이전트 + n8n 오케스트레이션 |
| Reddit 컨센서스: "AI 슬롭 반대, 전투력 증폭기" | Human-in-the-Loop 필수 |
| persistent memory가 최대 미해결 문제 | video-rag.js + feedback-rag.js 이미 구현 |
| 멀티모델 "스택" 접근이 주류 | 봇별 최적 LLM 배분 (GPT-4o/mini/Groq) |

---

## 2. 아키텍처 — 3계층 구조

```
┌─────────────────────────────────────────────────────────────┐
│                    마스터 (Alex)                              │
│              텔레그램 / 워커 웹 /video                        │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  [계층 1] 오케스트레이션                                     │
│  n8n 워크플로우(6개) + 웹훅 HitL 게이트 + 에러 핸들링        │
│  RAG 파이프라인 (pgvector): 커리큘럼|용어집|브랜드|히스토리|에셋│
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  [계층 2] 에이전트 레이어 (12봇)                             │
│  Phase 2: 스캔, 보이스, 아이, 매치, 캡                       │
│  Phase 3: 에디, 레드, 블루, 큐레, 에펙, 렌더                 │
└──────────────────────┬──────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────┐
│  [계층 3] 도구 + 인프라                                      │
│  FFmpeg | Whisper | tesseract.js | PostgreSQL | Twick SDK    │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. 봇별 상세 설계

### 3-1. 에이전트 ↔ 기존 코드 매핑

| 봇 | 기존 파일 | 줄 수 | LLM | RAG 컬렉션 |
|----|----------|------|-----|-----------|
| **에디(Edi)** 팀장 | step-proposal-engine.js | ~300 | GPT-4o | 히스토리 |
| **스캔(Scan)** | ffmpeg-preprocess.js + video-analyzer.js | 300+ | 불필요 | — |
| **레드(Red)** | critic-agent.js | 663 | Gemini Flash | 커리큘럼+히스토리 |
| **블루(Blue)** | refiner-agent.js | 771 | Groq 무료 | 커리큘럼+히스토리 |
| **아이(Eye)** | scene-indexer.js | 581 | GPT-4o mini | — |
| **에펙(Efx)** | edl-builder.js | 971 | 불필요 | 브랜드 |
| **큐레(Cure)** | reference-quality.js | — | GPT-4o mini | 에셋+히스토리 |
| **보이스(Vox)** | whisper-client.js + narration-analyzer.js | 511+ | 불필요 | — |
| **매치(Match)** | sync-matcher.js | 463 | GPT-4o mini | 용어집 |
| **캡(Cap)** | subtitle-corrector.js | — | GPT-4o mini | 용어집 |
| **렌더(Rend)** | edl-builder.js (렌더링 부분) | (공유) | 불필요 | — |

### 3-2. 스텝 생명주기 (Phase 3 핵심)

```
① AI 제안 (step-proposal-engine)
   → { type: "cut", from: 30, to: 90, reason: "무음 구간", confidence: 0.72 }
② RED 평가 (critic-agent) ◄── RAG: 커리큘럼
③ BLUE 대안 (refiner-agent) ◄── RAG: 히스토리
④ 사용자 판단 → 컨펌 | 수정 | 건너뛰기 | BLUE 채택
⑤ RAG 축적 (feedback-rag) → 다음 영상에서 학습
```

### 3-3. confidence 기반 자동/수동 분류 + 자동 조정 (고도화)

```
confidence ≥ 0.8  → 자동 컨펌 (사람에게 안 물어봄)
0.5 ≤ conf < 0.8  → 사람에게 제안 (기본)
confidence < 0.5  → RED 경고 + BLUE 대안 필수 표시

자동화율 목표:
  1~5번째 영상: 자동 20% → 30번째 이후: 자동 95%
```

자동 조정 로직 (매 10개 영상마다):
- 자동컨펌 되돌림률 > 10% → 임계값 +0.05 상향 (더 보수적)
- 자동컨펌 되돌림률 < 2% → 임계값 -0.05 하향 (더 공격적)

---

## 4. RAG 설계 — 5개 컬렉션

### 4-1. 벡터 DB 결정: pgvector 유지

pgvector 선택 이유: PostgreSQL 이미 운영 중, rag.js+rag-safe.js 구현 완료, 10만 벡터 이하 충분.
Qdrant 전환 시점: 10만 벡터 초과 시 마이그레이션 검토.

### 4-2. 5개 컬렉션 (video-rag.js type 필드로 구분)

| 컬렉션 (type) | 소스 | 활용 |
|--------------|------|------|
| curriculum | 더백클래스 강의 실라버스 | 1단계: 핵심 vs 불필요 판단 |
| terminology | FlutterFlow/AI 전문용어 사전 | 4단계: STT 오류 자동 교정 |
| brand_guide | CLAUDE.md 렌더링 확정값 | 2단계: 효과 스타일 일관성 |
| edit_history | ai_feedback_sessions/events | 1단계: 임계값 자동 조정, 패턴 학습 |
| assets | 인트로/아웃트로, B-roll | 3단계: 재활용 에셋 추천 |

---

## 5. n8n 워크플로우 설계 (기존 1개 → 6개)

| 워크플로우 | 역할 | 상태 |
|-----------|------|------|
| ① video-pipeline | Phase 2 자동 처리 (전처리→STT→싱크매칭) | 구현완료 |
| ② edit-step-loop | Phase 3 스텝별 대화형 편집 루프 | 신규 |
| ③ quality-check | 최종 렌더링 전 품질 검증 | 신규 |
| ④ render-final | 최종 파일 생성 (1440p/24Mbps) | 신규 |
| ⑤ rag-maintenance | RAG 정리 + confidence 자동 조정 (주 1회) | 신규 |
| ⑥ health-monitor | 인프라 상태 점검 | 신규 |

---

## 6. OCR 고도화 계획

현재: tesseract.js (ocr_lang: eng) → 한글 인식률 미검증

벤치마크 대상:
| OCR 엔진 | 한글 | 코드 | 다이어그램 | 비고 |
|----------|------|------|----------|------|
| tesseract.js + kor | △ | △ | ✕ | P0: 최소 비용 |
| EasyOCR | ✅ | ○ | △ | P1: Python 필요 |
| PaddleOCR | ✅ | ○ | ○ | P1: Python 필요 |
| DeepSeek-OCR 2 | ✅ | ✅ | ✅ | P2: GPU 권장 |

테스트: samples/에서 10프레임 추출 (한글3 + 코드4 + 다이어그램3), CER 측정.

---

## 7. 출력물 정의 (유튜브 업로드 제외)

```
/exports/
├── {title}_final_1440p.mp4        — 자막 미포함 최종본
├── {title}_final_subtitled.mp4    — 자막 하드코딩 버전
├── {title}_subtitles.srt          — 자막 파일 (별도)
└── {title}_edit_report.json       — 편집 로그
```

---

## 8. 파이프라인 전체 흐름 (Phase 2 + Phase 3 통합)

```
Phase 2 자동 처리 (기존):
  1. normalizeAudio → 2. STT+자막교정 → 3. OCR장면인덱싱
  → 4. 나레이션분석 → 5. AI싱크매칭 → 6. 인트로/아웃트로

Phase 3 대화형 편집 (에디팀 보강):
  7. generateSteps (sync_map → 스텝 목록)
  8. for each step: AI제안 → RED/BLUE → 사용자판단 → RAG축적
  9. confirmedSteps → EDL 조립
  10. 프리뷰 렌더링 (720p)
  11. 최종 컨펌 → 파일 생성 (1440p/24Mbps)
  12. edit_history RAG 업데이트 + confidence 자동 조정
```

---

## 9. KPI

| 지표 | 목표 |
|------|------|
| accepted_without_edit | 30번째 영상에서 95% |
| 편집 소요 시간 절감률 | 안정화 후 80% |
| 세트당 비용 | $0.06 이하 |
| quality_score | 85/100 이상 |
| OCR 한글 정확도 (CER) | 10% 이하 |
| confidence 되돌림률 | 5% 이하 |

---

## 10. 구현 로드맵

### Phase 2 잔여 (현재 → 2주)
- A: ffmpeg-preprocess 안정화 — 구현완료, 테스트 중
- B: sync-matcher 정확도 개선 — 구현완료, 튜닝 중
- C: 워커 웹 대화형 UX (5단계) — 설계완료
- D: n8n video-pipeline 안정화 — 구현완료
- E: DB 마이그레이션 007 적용 — 준비완료

### Phase 3 구현 (2주 → 4주)
- F: step-proposal-engine.js (~300줄)
- G: video-feedback-service.js (~200줄)
- H: Twick 타임라인 UI 통합 (~800줄)
- I: AI 채팅 패널 + WebSocket (~500줄)
- J: RED/BLUE 스텝별 연결 (~200줄)
- K: EDL 조립 + 렌더링 연결 (~200줄)
- L: n8n edit-step-loop 워크플로우

### 에디팀 고도화 (4주 → 8주)
- M: OCR 벤치마크 (P0)
- N: RAG 5개 컬렉션 시딩 (P0)
- O: confidence 자동 조정 (P1)
- P: 스텝 간 persistent memory (P1)
- Q: 스텝별 자기반성 루프 (P1)
- R: 더백클래스 시청 데이터 연동 (P2)
- S: 5세트 검증 + 자동화율 측정 (P0)

---

## 11. 리스크 및 대응

| 리스크 | 확률 | 대응 |
|--------|------|------|
| OCR 한글 정확도 부족 | 높음 | P0 벤치마크 + EasyOCR 대체 준비 |
| 초기 RAG 데이터 부족 | 확실 | 수동 시딩 + 초기 고통 감수 안내 |
| Twick SDK 한계 발견 | 중간 | Remotion 백업 계획 |
| 사용자 피드백 미제공 | 중간 | 최소 피드백 강제 (컨펌/수정 필수) |
| LLM 비용 초과 | 낮음 | Groq 무료 + GPT-4o mini 유지 |

---

## 12. packages/core 재사용 모듈 (15개, 수정 0줄)

pg-pool.js, llm-router.js, llm-model-selector.js, llm-fallback.js,
llm-logger.js, llm-keys.js, telegram-sender.js, n8n-runner.js,
n8n-webhook-registry.js, heartbeat.js, kst.js, trace.js,
tool-logger.js, rag.js, rag-safe.js

---

*전략 문서 v1.0 작성 완료*
*작성: Claude (팀 제이 전략 담당) | 2026-03-25*
*검토 필요: Alex (마스터)*
