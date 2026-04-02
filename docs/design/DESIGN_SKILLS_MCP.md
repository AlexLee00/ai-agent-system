# 팀별 스킬 + MCP 외부연동 설계서

> 작성: 메티 (Claude Opus 4.6)
> 작성일: 2026-04-03
> 근거: MCP 공식 레지스트리(177K+ 도구), arXiv 2603.23802,
>       Frase/altFINS/Nansen/VectCutAPI/네이버 검색광고 MCP 등
> 상태: 설계 단계

---

## 1. 아키텍처 개요

```
에이전트가 작업을 수행하는 두 가지 도구:

  스킬 (Skill) = 내부 Node.js 모듈
    packages/core/lib/skills/에 위치
    에이전트가 "언제, 어떻게" 사용하는지 학습
    비용 $0, 완전 제어 가능

  MCP (Model Context Protocol) = 외부 서비스 연결
    표준화된 프로토콜로 외부 도구/API에 접근
    "USB-C for AI" — 한 번 연결하면 모든 에이전트가 사용 가능
    2026년 업계 표준 (Anthropic+OpenAI+Google 채택)

  스킬 + MCP 조합:
    스킬 = 에이전트의 "내부 능력" (직접 실행)
    MCP = 에이전트의 "외부 도구" (API 경유)
    → 에이전트는 스킬로 판단하고, MCP로 실행
```

---

## 2. 팀별 스킬 + MCP 상세 설계


### 2-1. 루나팀 (투자) — 6 스킬 + 4 MCP

```
스킬 (packages/core/lib/skills/luna/):

  technical-analysis.js
    역할: RSI, MACD, 볼린저밴드, ADX, EMA 계산
    입력: 캔들 데이터 배열
    출력: { indicators, signal, confidence }
    사용 에이전트: 아리아(모멘텀), 에코(역추세)

  fundamental-analysis.js
    역할: PER/PBR/ROE/어닝 파싱 + 가치 평가
    입력: 재무제표 JSON
    출력: { valuation, rating, metrics }
    사용 에이전트: 펀더, 헤라(가치투자)

  risk-calculator.js
    역할: 켈리공식 + ATR 동적손절 + VaR + 포지션 사이징
    입력: { win_rate, rr_ratio, volatility, balance }
    출력: { position_size, stop_loss, take_profit }
    사용 에이전트: 네메시스(하드룰), 이지스(적응형)

  signal-aggregator.js
    역할: 다중 분석가 시그널 가중 합산 → 최종 결정
    입력: [{ agent, signal, confidence, weight }]
    출력: { final_signal, aggregated_confidence, reasoning }
    사용 에이전트: 루나(팀장)

  backtest-runner.js
    역할: VectorBT 백테스팅 실행 + 결과 리포트
    입력: { strategy, params, period }
    출력: { sharpe, max_drawdown, win_rate, equity_curve }
    사용 에이전트: 크로노스

  debate-engine.js
    역할: Bull vs Bear 토론 실행 (TradingAgents ICML 패턴)
    입력: { topic, analyst_reports, max_rounds: 2 }
    출력: { rounds[], final_verdict, confidence }
    사용 에이전트: 불리쉬+베어리쉬 → 루나 종합
```

```
MCP 연동:

  Alpha Vantage MCP (무료, 즉시 적용)
    URL: https://mcp.alphavantage.co/mcp
    도구: 60+ (주식시세, 기업개요, 어닝, 외환, 암호화폐, 기술지표, 뉴스감성)
    사용: 펀더(재무), 매크로(경제지표), 센티널(뉴스감성)
    비용: 무료 API키 (일 500호출)

  altFINS MCP (유료, 중기)
    도구: 2,000+ 코인, 150 기술지표, 50 온체인 메트릭
    사용: 체인아이(온체인), 아리아/에코(기술지표), 바이브(감성)
    비용: 유료 (월 $49~)

  Nansen API (유료, 중기)
    도구: Smart Money 추적, 18+ 체인, 웨일 추적, 스테이블코인 유입
    사용: 체인아이(웨일), 하운드(스마트머니)
    비용: 유료 (월 $100+)

  binance-mcp (무료, 즉시)
    도구: 실시간 바이낸스 시장 데이터 (가격, 오더북, 거래내역)
    사용: 제우스/스위프트(실행), 아리아(실시간 데이터)
    비용: 무료
```

### 2-2. 블로팀 (블로그) — 5 스킬 + 3 MCP

```
스킬 (packages/core/lib/skills/blog/):

  seo-optimizer.js
    역할: 키워드 밀도 분석 + 메타태그 생성 + 시맨틱 커버리지 점수
    입력: { html, target_keywords[], competitor_urls[] }
    출력: { seo_score, geo_score, suggestions[], meta_tags }
    사용 에이전트: 스타일(SEO편집), 시그널(SEO수집), 훅커(CTR)

  content-scorer.js
    역할: SEO점수 + GEO점수(AI검색 가시성) 이중 채점
    입력: { content, keywords, format }
    출력: { seo_score, geo_score, combined, details }
    사용 에이전트: 프루프B(품질), 크리틱(비판)
    참고: Frase 패턴 — SEO+GEO 이중 채점이 2026 업계 표준

  quality-gate.js
    역할: AI탐지 리스크 + 글자수 + 코드검증 + 팩트체크
    입력: { content, min_chars, code_blocks[] }
    출력: { passed, issues[], ai_risk_level, char_count }
    사용 에이전트: 프루프B, 크리틱
    기존: quality-checker.js 확장

  social-adapter.js
    역할: 블로그→인스타/트위터/네이버카페 크로스플랫폼 변환
    입력: { blog_content, platforms[] }
    출력: { instagram_caption, twitter_thread, cafe_post }
    사용 에이전트: 소셜

  performance-tracker.js
    역할: 7일 후 조회수/체류시간/공감수 수집 → 작가+편집 조합 추천
    입력: { post_url, published_date }
    출력: { views, avg_time, likes, writer_id, editor_id, score }
    사용 에이전트: 메트릭스
```

```
MCP 연동:

  네이버 검색광고 MCP (무료, 즉시 적용!)
    도구: 키워드 검색량, 경쟁강도, 연관키워드, 트렌드
    사용: 시그널(SEO수집), 커리/트렌디(기획), 스타일(SEO편집)
    비용: 무료 (네이버 검색광고 API키 필요)
    출처: 오픈소스 (retn.kr, 2026.01)
    핵심: "한국 검색 시장 55~60% = 네이버 데이터가 유입 품질 직결"

  GitHub MCP (무료, 즉시)
    도구: 레포지토리 검색, 코드 예제, 트렌딩
    사용: 딥서치(심층수집), 리처(IT뉴스)
    비용: 무료

  Frase MCP (유료, 중기)
    도구: 6단계 SEO 파이프라인 (리서치→생성→최적화→모니터링→발행→자동화)
    사용: 전체 블로팀 파이프라인 자동화
    비용: 유료 (월 $49~)
    핵심: 업계 유일 Read-Write MCP
```

### 2-3. 클로드팀 (시스템 모니터링) — 3 스킬 + 2 MCP

```
스킬 (packages/core/lib/skills/claude/):

  health-checker.js
    역할: 프로세스/포트/디스크/메모리 점검 + 이상 감지
    입력: { targets: ['hub', 'blog', 'investment'] }
    출력: { status_map, alerts[], healthy_count, unhealthy_count }
    사용 에이전트: 덱스터(점검), 닥터(복구)

  log-analyzer.js
    역할: 에러 패턴 분류 + 빈도 분석 + 자동 알림 임계값
    입력: { log_lines[], time_range, severity_filter }
    출력: { patterns[], top_errors[], trend, alert_needed }
    사용 에이전트: 덱스터

  auto-recover.js
    역할: scanAndRecover 자율 복구 + 재시작 + 알림
    입력: { target_process, error_type }
    출력: { action_taken, success, restart_count, notification_sent }
    사용 에이전트: 닥터
```

```
MCP 연동:

  Desktop Commander MCP (이미 연결!)
    도구: 파일시스템, 프로세스 관리, 명령 실행
    사용: 덱스터/닥터 (시스템 점검+복구)

  PostgreSQL MCP (즉시)
    도구: DB 직접 쿼리 + 성능 모니터링
    사용: 덱스터 (DB 상태 점검)
```

### 2-4. 데이터팀 — 4 스킬 + 2 MCP

```
스킬 (packages/core/lib/skills/data/):

  etl-pipeline.js
    역할: 각 팀 데이터 수집 → 정제 → 중앙 DB 저장
    입력: { source_team, raw_data, schema }
    출력: { cleaned_rows, quality_report, stored_count }
    사용 에이전트: 파이프

  stats-analyzer.js
    역할: 통계 분석 + 상관관계 + 이상치 탐지
    입력: { dataset, analysis_type: 'correlation|anomaly|trend' }
    출력: { results, insights[], visualizations[] }
    사용 에이전트: 피벗

  ml-trainer.js
    역할: MLX 로컬 모델 학습 + 평가 + 추론
    입력: { model_type, training_data, hyperparams }
    출력: { model_path, metrics, predictions[] }
    사용 에이전트: 오라클DS

  chart-generator.js
    역할: Recharts/D3 기반 시각화 자동 생성
    입력: { data, chart_type, title, config }
    출력: { svg_path, html_path, image_url }
    사용 에이전트: 캔버스
```

```
MCP 연동:

  PostgreSQL + pgvector (이미 구축!)
    도구: SQL 쿼리 + 벡터 검색 + JSONB 동적 쿼리
    사용: 전체 데이터팀

  Chroma MCP (선택적)
    도구: 시맨틱 문서 관리 + 벡터 검색
    사용: 큐레이터(거버넌스)
```

### 2-5. 감정팀 (법률 SW 감정) — 4 스킬 + 1 MCP

```
스킬 (packages/core/lib/skills/legal/):

  case-analyzer.js
    역할: 감정 요청서 파싱 + 쟁점 추출 + 14단계 분석 계획 수립
    입력: { request_doc, parties, software_info }
    출력: { issues[], analysis_plan, timeline, team_assignment }
    사용 에이전트: 저스틴(팀장), 브리핑(사건분석)

  code-differ.js
    역할: 소스코드 유사도 비교 + 복사 패턴 탐지 + diff 리포트
    입력: { source_a_path, source_b_path, language }
    출력: { similarity_score, copy_patterns[], diff_html, evidence[] }
    사용 에이전트: 렌즈(코드분석)

  precedent-searcher.js
    역할: 국내/해외 판례 검색 + 요약 + 적용점 도출
    입력: { keywords[], jurisdiction: 'kr|us|eu', case_type }
    출력: { cases[], summaries[], applicability_score }
    사용 에이전트: 가람(국내), 아틀라스(해외)

  report-generator.js
    역할: 법원 감정서 양식 자동 생성 (14단계 구조화)
    입력: { analysis_results, precedents, expert_opinions }
    출력: { docx_path, pdf_path, summary }
    사용 에이전트: 퀼(감정서), 밸런스(검증)
```

```
MCP 연동:

  대법원 판례 API (자체 MCP 서버 구축)
    도구: 판례 검색, 전문 조회, 키워드 추출
    사용: 가람(국내판례), 저스틴(검토)
    구현: Node.js MCP 서버 자체 개발 (대법원 OpenAPI 래핑)
    비용: 무료 (공개 API)
```

### 2-6. 연구팀 — 4 스킬 + 3 MCP

```
스킬 (packages/core/lib/skills/research/):

  paper-scanner.js
    역할: arXiv/SSRN 일일 신규 논문 스캔 + 핵심 기법 추출
    입력: { categories: ['cs.AI', 'q-fin'], days: 1 }
    출력: { papers[], key_techniques[], relevance_scores }
    사용 에이전트: 뉴런(AI), 골드(투자), 매트릭스(데이터)

  tech-tracker.js
    역할: GitHub 트렌딩 + npm/PyPI 신규 패키지 모니터링
    입력: { languages: ['js', 'python'], min_stars: 100 }
    출력: { trending[], new_packages[], breaking_changes[] }
    사용 에이전트: 기어(인프라), 프레임(영상), 잉크(콘텐츠)

  experiment-runner.js
    역할: 프로토타입 코드 실행 + 벤치마크 + 결과 평가
    입력: { code_path, test_cases[], metrics[] }
    출력: { results, benchmark, comparison, recommendation }
    사용 에이전트: 에디슨(구현), 프루프R(검증)

  knowledge-integrator.js
    역할: 연구 결과 → 에이전트 프롬프트/스킬 자동 적용
    입력: { research_findings, target_team, target_agent }
    출력: { prompt_diff, skill_update, applied, rollback_plan }
    사용 에이전트: 그래프트(적용), 멘토(재교육)
```

```
MCP 연동:

  GitHub MCP (무료, 즉시)
    도구: 레포지토리 검색/분석/이슈/PR/트렌딩
    사용: 전체 서칭 에이전트 8명

  Context7 MCP (무료, 즉시)
    도구: 개발자 문서 실시간 접근 (React, Node, Python 등)
    사용: 에디슨(구현), 기어(인프라)

  Semgrep MCP (무료, 즉시)
    도구: 코드 보안 분석 + 취약점 탐지 + 패턴 매칭
    사용: 가디언(코드리뷰, 클로드팀 겸임)
```

### 2-7. 에디팀 (영상) — 4 스킬 + 2 MCP

```
스킬 (packages/core/lib/skills/video/):

  video-cutter.js
    역할: FFmpeg 기반 자동 컷 + 트림 + 병합 + 인코딩
    입력: { input_path, cuts: [{ start, end }], output_format }
    출력: { output_path, duration, size, thumbnail }
    사용 에이전트: 비디오(팀장)

  subtitle-generator.js
    역할: Whisper 기반 자막 생성 + SRT/VTT 출력 + 스타일링
    입력: { video_path, language: 'ko', style }
    출력: { srt_path, vtt_path, word_count, accuracy }
    사용 에이전트: 비디오

  thumbnail-creator.js
    역할: AI 이미지 생성 + 텍스트 오버레이 + 최적 크기 조정
    입력: { title, style, platform: 'youtube|tiktok' }
    출력: { image_path, dimensions }
    사용 에이전트: 비디오

  social-repurposer.js
    역할: 긴 영상 → 쇼트/릴스/TikTok 자동 변환 (하이라이트 감지)
    입력: { video_path, target_duration: 60, platform }
    출력: { clips: [{ path, start, end, score }] }
    사용 에이전트: 비디오
```

```
MCP 연동:

  CapCut MCP (VectCutAPI, 무료 오픈소스, 즉시 적용!)
    URL: http://localhost:9001 (로컬 서버)
    도구: 11개 (create_draft, add_video, add_audio, add_text,
          add_image, add_effect, add_sticker, add_video_keyframe,
          trim_video, save_draft, get_draft_info)
    사용: 비디오팀 전체
    핵심: "자연어 명령으로 영상 편집 자동화"
    설치: pip install + python mcp_server.py

  ElevenLabs MCP (유료, 중기)
    도구: TTS + 음성 클로닝 + 오디오 처리
    사용: 나레이션 자동 생성
    비용: 유료 (월 $5~)
```

### 2-8. 워커팀 (SaaS) — 3 스킬 + 3 MCP

```
스킬 (packages/core/lib/skills/worker/):

  form-processor.js
    역할: 신청서/계약서 자동 처리 + 유효성 검증
    입력: { form_data, template_id, validation_rules }
    출력: { processed, validated, errors[], document_path }
    사용 에이전트: 워커

  report-builder.js
    역할: 일일/주간/월간 리포트 자동 생성 (Markdown/PDF)
    입력: { report_type, period, data_sources[] }
    출력: { markdown_path, pdf_path, charts[] }
    사용 에이전트: 워커

  notification-router.js
    역할: 텔레그램/슬랙/이메일 알림 라우팅 + 우선순위 분류
    입력: { message, severity, channels[], recipient }
    출력: { sent_to[], delivery_status }
    사용 에이전트: 워커
```

```
MCP 연동 (이미 연결됨!):

  Notion MCP ✅ — 페이지/DB 관리
  Google Calendar MCP ✅ — 일정 관리
  Gmail MCP ✅ — 이메일 관리
```

---

## 3. 구현 우선순위

```
Phase S-1: 즉시 적용 가능 (비용 $0)
━━━━━━━━━━━━━━━━━━━━━━

  MCP 연결 (5건):
  ✅ Desktop Commander — 이미 연결
  ✅ Notion/Calendar/Gmail — 이미 연결
  📋 Alpha Vantage MCP — 무료 API키, 루나팀 60+ 금융 도구
  📋 네이버 검색광고 MCP — 오픈소스, 블로팀 키워드 분석
  📋 GitHub MCP — 연구팀 + 블로팀 코드 수집
  📋 binance-mcp — 루나팀 실시간 시장 데이터
  📋 CapCut MCP (VectCutAPI) — 에디팀 영상 편집 자동화
  📋 Context7 MCP — 연구팀 개발자 문서 접근
  📋 Semgrep MCP — 연구팀 코드 보안 분석

Phase S-2: 핵심 스킬 구현 (1~2주)
━━━━━━━━━━━━━━━━━━━━

  루나팀 (6 스킬):
  📋 technical-analysis.js — 기술지표 계산
  📋 risk-calculator.js — 켈리+ATR+VaR
  📋 signal-aggregator.js — 다중 시그널 합산
  📋 debate-engine.js — Bull vs Bear 토론
  📋 fundamental-analysis.js — 재무 분석
  📋 backtest-runner.js — VectorBT 래퍼

  블로팀 (5 스킬):
  📋 seo-optimizer.js — SEO+GEO 이중 최적화
  📋 content-scorer.js — 콘텐츠 이중 채점
  📋 quality-gate.js — 기존 quality-checker 확장
  📋 performance-tracker.js — 성과 수집
  📋 social-adapter.js — 크로스플랫폼 변환

Phase S-3: 나머지 팀 스킬 (2~4주)
━━━━━━━━━━━━━━━━━━━━

  📋 클로드팀 3 스킬 (health-checker, log-analyzer, auto-recover)
  📋 데이터팀 4 스킬 (etl-pipeline, stats-analyzer, ml-trainer, chart-generator)
  📋 감정팀 4 스킬 (case-analyzer, code-differ, precedent-searcher, report-generator)
  📋 연구팀 4 스킬 (paper-scanner, tech-tracker, experiment-runner, knowledge-integrator)
  📋 에디팀 4 스킬 (video-cutter, subtitle-generator, thumbnail-creator, social-repurposer)
  📋 워커팀 3 스킬 (form-processor, report-builder, notification-router)

Phase S-4: 유료 MCP 연동 (필요시)
━━━━━━━━━━━━━━━━━━━━

  📋 altFINS MCP (루나팀, 월 $49~)
  📋 Nansen API (루나팀, 월 $100+)
  📋 Frase MCP (블로팀, 월 $49~)
  📋 ElevenLabs MCP (에디팀, 월 $5~)
```

---

## 4. 총괄 통계

```
전체 스킬 + MCP:
  스킬: 33개 (8팀 × 3~6개)
  MCP 무료: 9개 (즉시 적용 가능)
  MCP 유료: 4개 (필요시)
  이미 연결: 4개 (Desktop Commander, Notion, Calendar, Gmail)

팀별:
  루나팀:   6 스킬 + 4 MCP (가장 풍부)
  블로팀:   5 스킬 + 3 MCP
  클로드팀: 3 스킬 + 2 MCP
  데이터팀: 4 스킬 + 2 MCP
  감정팀:   4 스킬 + 1 MCP (자체 구축)
  연구팀:   4 스킬 + 3 MCP
  에디팀:   4 스킬 + 2 MCP
  워커팀:   3 스킬 + 3 MCP (이미 연결)
```
