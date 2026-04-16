defmodule TeamJay.Jay.Topics do
  @moduledoc """
  JayBus PubSub 토픽 정의
  9팀 일일 성장 환류 사이클 + 팀 간 데이터 파이프라인
  """

  # ────────────────────────────────────────────────────────────────
  # 팀 간 크로스 파이프라인 토픽 (7개)
  # ────────────────────────────────────────────────────────────────
  @cross_topics [
    :ska_to_blog,       # 스카 매출 15%+ 하락 → 블로팀 프로모션 요청
    :luna_to_blog,      # 루나 시장 급변 → 블로 투자 콘텐츠
    :blog_to_ska,       # 블로 고성과 키워드 → 스카 SEO 반영
    :ska_to_luna,       # 스카 캐시플로우 → 루나 투자 강도
    :claude_to_all,     # 클로드 시스템 위험 → 전체 작업 축소
    :blog_to_luna,      # 블로 트렌드 → 루나 종목 분석
    :luna_to_ska,       # 루나 수익 실현 → 스카 운영비
  ]

  # ────────────────────────────────────────────────────────────────
  # 성장 사이클 토픽
  # ────────────────────────────────────────────────────────────────
  @growth_topics [
    :growth_cycle_started,    # 06:30 사이클 시작
    :team_data_collected,     # 팀 데이터 수집 완료 (per team)
    :growth_cycle_completed,  # 전체 수집 완료
    :briefing_ready,          # 종합 브리핑 생성 완료
    :weekly_report_ready,     # 주간 리포트 완료
    # ── 블로팀 운영 하드닝 토픽 ──
    :blog_publish_failed,     # 발행 실패 → PublishGuard 재시도 큐
    :blog_publish_recovered,  # 발행 재시도 성공 → PublishGuard 복구
    :blog_content_planned,    # D-1 주제 후보 선정 완료 → TopicCurator
    :blog_token_renewed,      # 인스타 토큰 자동 갱신 완료 → TokenRenewal
    # ── 블로팀 자율 루프 토픽 (Phase B) ──
    :blog_insights_collected, # 성과 수집 완료 → InsightsCollector
    :blog_strategy_updated,   # 전략 자동 조정 완료 → StrategyLearner
  ]

  # ────────────────────────────────────────────────────────────────
  # Decision Engine 토픽
  # ────────────────────────────────────────────────────────────────
  @decision_topics [
    :decision_allow,      # 규칙 내 자동 실행
    :decision_modify,     # 정책 범위 내 조정
    :decision_escalate,   # 마스터 알림 + 컨텍스트
    :decision_block,      # 위험 차단
  ]

  @all_topics @cross_topics ++ @growth_topics ++ @decision_topics

  def all_topics, do: @all_topics
  def cross_topics, do: @cross_topics
  def growth_topics, do: @growth_topics
  def decision_topics, do: @decision_topics

  @doc "JayBus에 브로드캐스트"
  def broadcast(topic, payload) when topic in @all_topics do
    Registry.dispatch(TeamJay.JayBus, topic, fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_bus, topic, payload})
      end
    end)
  end

  @doc "JayBus 토픽 구독"
  def subscribe(topic) when topic in @all_topics do
    Registry.register(TeamJay.JayBus, topic, nil)
  end

  # ────────────────────────────────────────────────────────────────
  # 크로스 파이프라인 헬퍼
  # ────────────────────────────────────────────────────────────────

  def broadcast_ska_revenue_drop(drop_pct, details \\ %{}) do
    broadcast(:ska_to_blog, %{
      event: :ska_revenue_drop,
      drop_pct: drop_pct,
      details: details,
      action_requested: :create_promotion_content
    })
  end

  def broadcast_luna_market_shock(regime, details \\ %{}) do
    broadcast(:luna_to_blog, %{
      event: :luna_market_shock,
      regime: regime,
      details: details,
      action_requested: :create_investment_content
    })
  end

  def broadcast_blog_keyword_hit(keywords, details \\ %{}) do
    broadcast(:blog_to_ska, %{
      event: :blog_keyword_hit,
      keywords: keywords,
      details: details,
      action_requested: :apply_seo
    })
  end

  def broadcast_system_risk(risk_level, affected_services) do
    broadcast(:claude_to_all, %{
      event: :system_risk,
      risk_level: risk_level,
      affected_services: affected_services,
      action_requested: :reduce_workload
    })
  end

  # ────────────────────────────────────────────────────────────────
  # 성장 사이클 헬퍼
  # ────────────────────────────────────────────────────────────────

  def broadcast_growth_cycle_started(date) do
    broadcast(:growth_cycle_started, %{date: date, started_at: DateTime.utc_now()})
  end

  def broadcast_team_data_collected(team, data) do
    broadcast(:team_data_collected, %{team: team, data: data, collected_at: DateTime.utc_now()})
  end

  def broadcast_briefing_ready(briefing) do
    broadcast(:briefing_ready, %{briefing: briefing, ready_at: DateTime.utc_now()})
  end

  # ────────────────────────────────────────────────────────────────
  # Decision Engine 헬퍼
  # ────────────────────────────────────────────────────────────────

  def broadcast_decision(level, context) when level in [:allow, :modify, :escalate, :block] do
    topic = :"decision_#{level}"
    broadcast(topic, Map.put(context, :decided_at, DateTime.utc_now()))
  end
end
