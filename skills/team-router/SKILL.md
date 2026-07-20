---
name: team-router
description: 사용자 요청을 Blog, Luna, Darwin, Sigma, Ska, Hub/Orchestrator 등 적절한 팀과 런타임으로 라우팅할 때 사용.
---

# Team Router

## 목적

요청을 바로 구현하기 전에 담당 팀, 데이터 경로, 금지 동작, 검증 방법을 빠르게 결정한다.

## 라우팅 규칙

| 신호 | 팀 |
| --- | --- |
| 매매, 포지션, KIS, Binance, TradingView, 시황 | Luna |
| 블로그, Edu-X, 콘텐츠, SEO, 게시/삭제 | Blog/Edu-X |
| 법률, 감정, 판례, 손해 | Jay (수동 판단) |
| 리서치, 논문, GitHub 분석 | Darwin |
| 데이터 품질, 실험, 백테스트 품질 | Sigma |
| 예약, 키오스크, 매출, 매장 운영 | Ska |
| Hub, secret, gateway, n8n, dashboard | Hub/Orchestrator |

## 절차

1. 요청 키워드 추출
2. 담당 팀과 보조 팀 결정
3. 금지 동작 확인
4. 검증 명령과 완료 조건 선택
5. 필요 시 전문 스킬로 위임

## 팀 제이 규칙

- Luna live-fire와 protected PID는 라우팅 단계에서 먼저 식별한다.
- secret-store 요청은 Hub 경로로만 라우팅한다.
- 게시/삭제/실거래/rollback은 승인 필요 여부를 먼저 분리한다.
