# 블로팀 — Claude Code 컨텍스트

## 팀 구조
블로(팀장/마에스트로) → 포스(POS작가) + 젬스(GEMS작가) + 리처(RAG+내부링킹)
→ 퍼블(발행+중복방지) + 비주(이미지, 계획)

## 핵심 파일
- lib/maestro.js(342줄), pos-writer.js(632줄), richer.js(252줄)
- lib/blo.js(714줄), publ.js(342줄), ai-feedback.js(207줄)
- lib/bonus-insights.js(171줄), section-ratio.js(149줄)

## 현재 상태
- 기본 운영 중 (Node.js 120강 33강 진행)
- 딥분석 완료: F1~F6 발견, P1~P5 수립 (docs/strategy/blog-analysis.md)
- P1~P5 코덱스 프롬프트 작성 대기

## 전략: docs/strategy/blog-strategy.md + blog-analysis.md
