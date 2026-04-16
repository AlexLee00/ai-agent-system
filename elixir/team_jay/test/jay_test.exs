defmodule TeamJay.JayTest do
  # DB 불필요한 순수 로직 테스트 (async: true 가능)
  use ExUnit.Case, async: true

  alias TeamJay.Jay.{Topics, DailyBriefing, DecisionEngine}

  # ────────────────────────────────────────────────────────────────
  # Topics
  # ────────────────────────────────────────────────────────────────

  describe "Topics" do
    test "16개 토픽 정의 확인 (크로스 7 + 성장 5 + 결정 4)" do
      topics = Topics.all_topics()
      assert length(topics) == 16
    end

    test "크로스 파이프라인 7개 포함" do
      cross = Topics.cross_topics()
      assert length(cross) == 7
      assert :ska_to_blog in cross
      assert :luna_to_blog in cross
      assert :blog_to_ska in cross
      assert :ska_to_luna in cross
      assert :claude_to_all in cross
      assert :blog_to_luna in cross
      assert :luna_to_ska in cross
    end

    test "성장 사이클 토픽 5개 포함" do
      growth = Topics.growth_topics()
      assert length(growth) == 5
      assert :growth_cycle_started in growth
      assert :briefing_ready in growth
    end

    test "결정 엔진 토픽 4개 포함" do
      decision = Topics.decision_topics()
      assert length(decision) == 4
      assert :decision_allow in decision
      assert :decision_block in decision
      assert :decision_escalate in decision
      assert :decision_modify in decision
    end
  end

  # ────────────────────────────────────────────────────────────────
  # DailyBriefing — 순수 포맷 함수
  # ────────────────────────────────────────────────────────────────

  describe "DailyBriefing.generate/2" do
    test "기본 브리핑 생성 — 필수 섹션 포함" do
      team_data = %{
        luna: %{
          metric_type: :trading_ops,
          trades_7d: 5, pnl_usdt_7d: 100.0,
          traded_usdt_7d: 500.0, win_count: 3,
          live_positions: 2, market_regime: "bull"
        },
        ska: %{
          metric_type: :reservation_ops,
          bookings_today: 8, completed: 7,
          pending: 1, failed: 0, revenue_7d: 350_000
        },
        blog: %{
          metric_type: :content_ops,
          published_7d: 3, ready_count: 2, draft_count: 1
        }
      }

      briefing = DailyBriefing.generate(team_data, "2026-04-16")
      assert is_binary(briefing)
      assert String.contains?(briefing, "2026-04-16")
      assert String.contains?(briefing, "루나팀")
      assert String.contains?(briefing, "스카팀")
      assert String.contains?(briefing, "블로팀")
    end

    test "nil 팀 데이터 — 크래시 없음" do
      briefing = DailyBriefing.generate(%{luna: nil, ska: nil}, "2026-04-16")
      assert is_binary(briefing)
      assert String.contains?(briefing, "데이터 수집 실패")
    end

    test "빈 map — 크래시 없음" do
      briefing = DailyBriefing.generate(%{}, "2026-04-16")
      assert is_binary(briefing)
    end

    test "bull 시장 → 🚀 이모지" do
      data = %{luna: %{metric_type: :trading_ops, market_regime: "bull",
                       trades_7d: 1, pnl_usdt_7d: 10.0, traded_usdt_7d: 100.0,
                       win_count: 1, live_positions: 0}}
      briefing = DailyBriefing.generate(data, "2026-04-16")
      assert String.contains?(briefing, "🚀")
    end

    test "crisis 시장 → 🚨 이모지" do
      data = %{luna: %{metric_type: :trading_ops, market_regime: "crisis",
                       trades_7d: 0, pnl_usdt_7d: -500.0, traded_usdt_7d: 0.0,
                       win_count: 0, live_positions: 1}}
      briefing = DailyBriefing.generate(data, "2026-04-16")
      assert String.contains?(briefing, "🚨")
    end

    test "포지션 10개+ → 크로스 알림" do
      data = %{
        luna: %{metric_type: :trading_ops, market_regime: "ranging",
                trades_7d: 10, pnl_usdt_7d: 0.0, traded_usdt_7d: 1000.0,
                win_count: 5, live_positions: 12}
      }
      briefing = DailyBriefing.generate(data, "2026-04-16")
      assert String.contains?(briefing, "포지션") and String.contains?(briefing, "12")
    end

    test "PnL 양수 → +$ 형식" do
      data = %{luna: %{metric_type: :trading_ops, market_regime: "bull",
                       trades_7d: 3, pnl_usdt_7d: 123.45, traded_usdt_7d: 300.0,
                       win_count: 2, live_positions: 0}}
      briefing = DailyBriefing.generate(data, "2026-04-16")
      assert String.contains?(briefing, "+$")
    end

    test "PnL 음수 → -$ 형식" do
      data = %{luna: %{metric_type: :trading_ops, market_regime: "bear",
                       trades_7d: 2, pnl_usdt_7d: -50.0, traded_usdt_7d: 200.0,
                       win_count: 0, live_positions: 0}}
      briefing = DailyBriefing.generate(data, "2026-04-16")
      assert String.contains?(briefing, "-$")
    end
  end

  # ────────────────────────────────────────────────────────────────
  # DecisionEngine — 순수 판단 로직
  # ────────────────────────────────────────────────────────────────

  describe "DecisionEngine — ska_revenue_drop" do
    test "5% 하락 → :block (임계치 미달)" do
      result = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: 5, revenue: 400_000})
      assert result == :block
    end

    test "15% 하락 → :allow (자동 프로모션)" do
      result = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: 15, revenue: 200_000})
      assert result == :allow
    end

    test "25% 하락 → :allow (15~30% 범위)" do
      result = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: 25, revenue: 150_000})
      assert result == :allow
    end

    test "30% 하락 → :escalate (마스터 알림)" do
      result = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: 30, revenue: 100_000})
      assert result == :escalate
    end

    test "50% 하락 → :escalate (심각)" do
      result = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: 50, revenue: 50_000})
      assert result == :escalate
    end
  end

  describe "DecisionEngine — luna_market_shock" do
    test "bull → :allow" do
      assert DecisionEngine.evaluate(:luna_market_shock, %{regime: "bull"}) == :allow
    end

    test "bear → :allow" do
      assert DecisionEngine.evaluate(:luna_market_shock, %{regime: "bear"}) == :allow
    end

    test "volatile → :allow" do
      assert DecisionEngine.evaluate(:luna_market_shock, %{regime: "volatile"}) == :allow
    end

    test "crisis → :escalate" do
      assert DecisionEngine.evaluate(:luna_market_shock, %{regime: "crisis"}) == :escalate
    end

    test "unknown → :modify (컨텍스트 보강)" do
      assert DecisionEngine.evaluate(:luna_market_shock, %{regime: "unknown"}) == :modify
    end
  end

  describe "DecisionEngine — system_risk" do
    test "레벨 3 → :modify (모니터링 강화만, 5 미달)" do
      assert DecisionEngine.evaluate(:system_risk, %{risk_level: 3, count: 1}) == :modify
    end

    test "레벨 5 → :allow (자동 워크로드 축소)" do
      assert DecisionEngine.evaluate(:system_risk, %{risk_level: 5, count: 2}) == :allow
    end

    test "레벨 7 → :escalate (마스터 긴급)" do
      assert DecisionEngine.evaluate(:system_risk, %{risk_level: 7, count: 3}) == :escalate
    end

    test "레벨 9 → :block (긴급 차단)" do
      assert DecisionEngine.evaluate(:system_risk, %{risk_level: 9, count: 4}) == :block
    end

    test "레벨 10 → :block (최대 차단)" do
      assert DecisionEngine.evaluate(:system_risk, %{risk_level: 10, count: 5}) == :block
    end
  end

  describe "DecisionEngine — 미분류 이벤트" do
    test "알 수 없는 이벤트 → :allow (안전 기본값)" do
      assert DecisionEngine.evaluate(:some_new_event, %{}) == :allow
    end
  end
end
