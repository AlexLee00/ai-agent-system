# 핸드오프: 루나 대체 데이터 신호 발견 + 신호 학습 SHADOW (2026-06-01)

> 작성: 메티 · 다음 세션 착수용 · 미커밋 변경 있음

## 1. 이번 세션 결과

### 1-1. 신호 견고성 학습 SHADOW (구현·검증 완료, 미커밋)
- 설계: docs/strategy/LUNA_SIGNAL_ROBUST_LEARNING_DESIGN_2026-06-01.md (55줄).
- 구현(코덱스): migration 20260601000003_luna_signal_policy_shadow.sql + shared/luna-signal-robust-learning.ts + scripts/runtime-luna-signal-policy-shadow.ts + smoke + bootstrap.ts/package.json.
- 메티 검증 5/5 통과: 프로덕션(grid/promotion/entry/refresh/counterfactual) 0 변경, write 4중 게이트(enabled && --apply && confirm===TOKEN && !dryRun), magic number 0(앙상블/gap/regime/학습률/epsilon 환경변수), 데이터 누수 없음(IS 선택 sharpe_is / OOS 평가 sharpe_oos, adjustedScore=oosSharpe-gapPenalty), disabled write 0 / DB rows 0.
- **dry-run 결과(sourceRows 184, 18정책×2시장=36행)**: 3 개선축(앙상블 1/3/5, gap penalty 0/0.25/0.5, regime none/trend_filter) 전부 baseline 대비 OOS 개선 0.
  - 앙상블 1=3=5 동일: trial_sharpes는 184건 전부 채워짐(각 129개)이나, isSharpe는 gap penalty 경로로만 영향 + trial들이 다 과적합 고sharpe라 top N 평균 비슷 + gap0에선 isSharpe 완전 무영향.
  - 근본: 정책이 후보를 "선택"하지 않고 통과분 전체를 "집계"(score=mean(adjustedScore)) → 모든 정책 OOS가 baseline 근처. 앙상블은 IS만 변형, OOS sharpe는 후보별 고정.
  - 본질: 후보 풀 OOS 음수(domestic -1.40 / overseas -1.09)면 재집계로 양수 불가.
- LUNA_SIGNAL_LEARNING_ENABLED 기본 false. launchd 미등록.

### 1-2. [핵심] 대체 데이터 신호 발견 (5세션 진단 정정)
- **메티가 5세션간 반복한 "투자 신호 R&D 부재 + 대체 데이터 없음"은 핵심적으로 틀렸음.** candidate_backtest_status(기술적 4전략 grid)만 본 탓.
- 실제 루나 대체 데이터 신호 인프라(광범위):
  - 스크립트: runtime-luna-opendart-financial-refresh / -financial-batch-refresh / -disclosure-refresh, runtime-luna-fundamental-quant-trading, runtime-luna-earnings-surprise-trading, luna-community-sentiment, luna-news-symbol-mapper, luna-news-credential-resolver.
  - 노드: nodes/l03-sentinel.ts, l04-sentiment.ts, l05-onchain.ts.
  - a2a 스킬: earnings-surprise-trading, factor-model-shadow, disclosure-event-driven, fundamental-quant-trading, cross-agent-validation.
  - DB 적재: corp_fundamentals 5,531 / corp_disclosures 3,885 / finbert_sentiment_log 6,786 / korean_factor_log 10,360 / luna_factor_model_shadow 1,614.
- **단 launchd 자동 가동 0개** → 대체 데이터 갱신/평가가 멈춘 상태.

## 2. 다음 세션 착수점 (우선순위)
1. **luna_factor_model_shadow 1,614건 성과 점검**: 팩터 모델 OOS가 기술적 4전략(candidate_backtest_status)보다 나은지. 컬럼/지표 먼저 확인.
2. **대체 데이터 신호가 멈춘 이유**: launchd 미등록이 의도(폐기)인지 미완인지. 각 스크립트 최종 실행/산출 시점.
3. **연결 경로**: 대체 데이터 신호(팩터/펀더멘털/감성)가 왜 candidate/promotion(기술적)과 분리돼 healthy 후보로 안 이어지나.
4. **신호 학습 SHADOW 처리**: 효과 0 확인됨 → (A) 진짜 "선택" 정책 재구현(IS robust 상위 K 종목, 단 과적합 때문에 OOS 개선 미보장) vs 대체 데이터 활용 우선. 미커밋 6파일 커밋/보류 결정.

## 3. 정직 메모 (진단 오류)
- 메티가 candidate_backtest_status만 보고 "신호 R&D 부재"를 5세션 단정 → 대체 데이터 자산(수천~만 건) 놓침.
- 다음 세션은 **루나 전체 신호 맵**(기술적 grid + 대체 데이터 + 팩터 SHADOW)부터 그리고 시작할 것.

## 4. 불변 컨텍스트
- 3역할(메티 설계·검증 / 코덱스 구현 / 마스터 승인). 메티 코드·DB·git·launchd 직접 실행 금지.
- DB jay(investment 스키마). 경로 /Users/alexlee/projects/ai-agent-system. crypto live 무중단.
- 미커밋: 신호 학습 SHADOW 6파일 + 핸드오프 문서들. 커밋은 마스터.
