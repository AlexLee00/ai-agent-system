# PATCH_REQUEST.md
> 아처 자동 생성 — 2026-03-03 (2026-03-03 02:50:10 KST)
> ⚠️ Claude Code 세션 시작 시 자동 처리 대상

## 주간 요약
이번 주 npm 패키지는 전반적으로 최신 상태이나 tar의 Unicode Ligature 경로 충돌 Race Condition을 포함한 high 심각도 취약점 5건이 발견되어 즉시 npm audit fix 및 수동 검토가 필요합니다. MCP 생태계 관련 HumanMCP 벤치마크 논문이 발표되어 현재 사용 중인 MCP SDK의 툴 검색 품질을 정량 평가할 수 있는 기회가 생겼습니다. GGML/llama.cpp의 HuggingFace 합류로 로컬 AI 추론 생태계 안정성이 높아졌으며, 멀티 프로바이더 및 온프레미스 폴백 전략 수립 시 긍정적으로 참고할 수 있습니다.

## 패키지 업데이트 요청

| 우선순위 | 패키지 | 현재 | 최신 | Breaking | 이유 |
|---------|--------|------|------|----------|------|
| medium | `anthropic-sdk-py` | 알 수 없음 | v0.84.0 | NO | Python SDK가 v0.84.0으로 업데이트되어 최신 Claude API 기능 및 안정성 개선이 포함됨 |
| low | `node` | 현재 버전 확인 필요 | v25.7.0 | NO | Node.js v25.7.0 출시로 최신 V8 엔진 및 성능 개선 사항 반영 가능 |
| low | `claude-code` | 현재 버전 확인 필요 | v2.1.63 | NO | Claude Code CLI가 v2.1.63으로 업데이트되어 개발 생산성 도구 개선 포함 |

### 실행 명령
```bash
pip install --upgrade anthropic
nvm install 25.7.0 && nvm use 25.7.0
npm update -g @anthropic-ai/claude-code
```

## 보안 취약점 조치 요청

### ⚠️ [high] `tar`
- **내용**: node-tar에서 Unicode Ligature Collision을 이용한 Path Reservations Race Condition 취약점으로 임의 파일 덮어쓰기 가능
- **조치**: npm audit fix 또는 tar 최신 버전으로 수동 업그레이드 (npm install tar@latest)

### ⚠️ [high] `duckdb`
- **내용**: duckdb 패키지에서 high 심각도 취약점 감지됨 (세부 CVE 정보 npm audit --json으로 확인 필요)
- **조치**: npm audit --json으로 CVE 상세 확인 후 패치 버전 존재 시 npm install duckdb@latest 적용

### ⚠️ [high] `cacache`
- **내용**: cacache 패키지에서 high 심각도 취약점 감지됨, npm 내부 캐시 처리 과정에서 잠재적 보안 위험
- **조치**: npm audit fix --force 실행 후 회귀 테스트 수행, node-gyp 및 make-fetch-happen 의존성 함께 검토

### ⚠️ [high] `make-fetch-happen / node-gyp`
- **내용**: make-fetch-happen과 node-gyp에서 high 취약점 감지됨, 네이티브 모듈 빌드 및 네트워크 요청 처리 과정에 영향
- **조치**: npm audit fix 실행 후 의존성 트리 확인 (npm ls make-fetch-happen node-gyp), 자동 수정 불가 시 수동 overrides 설정 검토

## LLM API 변경사항

### [Anthropic] anthropic-sdk-py v0.84.0 릴리스 (2026-02-25)
- **영향**: Python 기반 서비스가 있다면 최신 API 기능 및 버그픽스 적용 필요, JS SDK는 현재 최신 상태이나 py SDK 변경 사항이 이후 JS SDK에 반영될 수 있음
- **대응**: Python 환경에서 pip install --upgrade anthropic 적용 및 changelog 검토

### [Google] gemini-js v1.43.0 릴리스 (2026-02-26)
- **영향**: Gemini JS SDK가 빠른 속도로 버전업 중이며, 현재 프로젝트에서 Gemini를 사용 중이라면 API 인터페이스 변경 여부 확인 필요
- **대응**: npm install @google/generative-ai@latest 및 CHANGELOG 검토, 멀티 프로바이더 전략 수립 시 참고

### [Anthropic] MCP SDK v1.27.1 안정화 (2026-02-24)
- **영향**: 현재 사용 버전이 최신과 동일하여 영향 없음, 단 MCP 생태계가 빠르게 확장 중이므로 주간 모니터링 권장
- **대응**: 없음

## AI 기술 트렌드

### HumanMCP: MCP Tool Retrieval 평가 데이터셋
- **출처**: arXiv CS.AI, 2026-03-02
- **요약**: MCP 툴 검색 성능을 인간 유사 쿼리로 평가하는 벤치마크 데이터셋으로, 실제 사용자 패턴을 반영한 MCP 에이전트 성능 측정이 가능함. 현재 프로젝트에서 MCP SDK v1.27.1을 사용 중이므로 툴 라우팅 품질 진단에 즉시 활용 가능.
- **적용 가능성**: 높음 — MCP 기반 에이전트 툴 선택 로직의 정확도를 정량적으로 측정하고 개선 포인트 도출 가능

### Mixture of Experts (MoE) in Transformers
- **출처**: HuggingFace 블로그, 2026-02-26
- **요약**: MoE 아키텍처의 실무 구현 방법과 트레이드오프를 정리한 튜토리얼로, 특정 태스크에 특화된 서브 모델 라우팅 전략을 설명함. 멀티 LLM 프로바이더 환경에서 태스크별 최적 모델 선택 로직 설계에 참고 가능.
- **적용 가능성**: 중간 — 단일 LLM 사용 시 직접 적용 어렵지만, 멀티 프로바이더 라우팅 전략 설계 시 MoE 개념 차용 가능

### Agentic LLM Framework for AML Compliance (Adverse Media Screening)
- **출처**: arXiv CS.AI, 2026-03-02
- **요약**: 자금세탁방지(AML) 컴플라이언스를 위한 에이전틱 LLM 프레임워크로, 외부 미디어 스크리닝 태스크를 LLM 에이전트로 자동화하는 아키텍처를 제시함. 금융 데이터 처리 파이프라인에 에이전트를 통합하는 실무 패턴으로 활용 가능.
- **적용 가능성**: 중간 — 금융/컴플라이언스 도메인 프로젝트라면 높음, 범용 에이전트 파이프라인 설계 참고용으로도 유용

### GGML & llama.cpp의 HuggingFace 합류
- **출처**: HuggingFace 블로그, 2026-02-20
- **요약**: 로컬 AI 추론의 핵심 라이브러리인 GGML과 llama.cpp가 HuggingFace 조직에 합류하여 장기적 생태계 지원이 강화됨. 로컬 LLM 추론 파이프라인의 안정성과 지속 가능성이 높아졌음을 의미.
- **적용 가능성**: 중간 — 온프레미스 또는 엣지 추론이 필요한 경우 llama.cpp 기반 로컬 폴백 전략 수립에 긍정적 신호

## 주간 웹 하이라이트

- **[arXiv CS.AI]** [HumanMCP: A Human-Like Query Dataset for Evaluating MCP Tool Retrieval Performance](https://arxiv.org/search/?searchtype=all&query=HumanMCP&start=0) — 우리 스택의 핵심인 MCP SDK를 직접 평가하는 벤치마크로, 툴 검색 품질 개선에 즉시 활용 가능한 실무 연구
- **[HuggingFace Blog]** [GGML and llama.cpp join HuggingFace to ensure long-term progress of Local AI](https://huggingface.co/blog/ggml-llama-cpp) — 로컬 AI 추론 생태계의 거버넌스 변화로 llama.cpp 의존 프로젝트의 장기 유지보수 전략에 중요한 시그널
- **[HuggingFace Blog]** [Deploying Open Source Vision Language Models (VLM) on Jetson](https://huggingface.co/blog/vlm-jetson) — 엣지 디바이스에서의 VLM 배포 실전 가이드로, 멀티모달 기능 확장 계획 시 하드웨어 요구사항 사전 검토에 유용
- **[GitHub Releases]** [claude-code v2.1.63 릴리스 (2026-02-28)](https://github.com/anthropics/claude-code/releases/tag/v2.1.63) — 팀 개발 워크플로우에 직접 영향을 주는 Claude Code CLI 최신 버전으로, 코딩 보조 기능 개선 사항 즉시 적용 가능
- **[arXiv CS.AI]** [An Agentic LLM Framework for Adverse Media Screening in AML Compliance](https://arxiv.org/search/?searchtype=all&query=Agentic+LLM+AML+Compliance&start=0) — 실제 엔터프라이즈 컴플라이언스 도메인에 에이전틱 LLM을 적용한 사례로 에이전트 설계 패턴 벤치마킹에 참고 가치가 높음

---

> 이 파일은 아처가 자동 생성합니다. 직접 수정 금지.
> Claude Code가 세션 시작 시 내용을 확인하고 필요한 조치를 취합니다.