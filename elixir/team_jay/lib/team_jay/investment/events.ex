defmodule TeamJay.Investment.Events do
  @moduledoc """
  투자팀 Elixir 네이티브 파이프라인에서 사용하는 이벤트 payload 헬퍼.

  현재는 스캐폴드 Worker들이 동일한 키 구조를 공유하도록 만드는 역할만 한다.
  실제 브로커/LLM 연동 전까지는 lightweight map builder로 유지한다.
  """

  def indicator(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :indicator_scaffold,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def price_tick(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :price_watcher_scaffold,
        price: 0.0,
        observed_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def analysis(symbol, analyst_type, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        analyst_type: analyst_type,
        source: :analyst_scaffold,
        confidence: 0.0,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def signal(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        action: :hold,
        source: :decision_scaffold,
        confidence: 0.0,
        generated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def approved_signal(signal, attrs \\ %{}) do
    Map.merge(
      %{
        signal: signal,
        source: :risk_scaffold,
        approved: true,
        reviewed_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def trade_result(symbol, approved_signal, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :execution_scaffold,
        executed: true,
        executed_at: DateTime.utc_now(),
        approved_signal: approved_signal
      },
      Map.new(attrs)
    )
  end

  def position_snapshot(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :position_manager_scaffold,
        status: :flat,
        quantity: 0.0,
        entry_price: nil,
        current_price: nil,
        pnl_pct: 0.0,
        updated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def condition_check(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :condition_checker_scaffold,
        action: :hold,
        reason: :monitoring,
        score: 0.0,
        checked_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def loop_cycle(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :trading_loop_scaffold,
        mode: :mode1_explore,
        stages: [:collect, :analyze, :evaluate, :decide, :execute, :feedback],
        cycle_count: 0,
        completed_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def strategy_update(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :strategy_adjuster_scaffold,
        action: :hold,
        reason: :no_change,
        governance_tier: :block,
        proposals: %{},
        updated_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def runtime_override(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :runtime_override_store_scaffold,
        status: :idle,
        approved: false,
        overrides: [],
        history_count: 0,
        recorded_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def memory_snapshot(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :agent_memory_scaffold,
        episodic: [],
        semantic: [],
        procedural: [],
        snapshot_count: 0,
        recorded_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def reflection(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :self_reflection_scaffold,
        status: :observed,
        insight: "pattern not stable yet",
        confidence: 0.0,
        recommended_strategy: :hold,
        reflected_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def market_mode(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :market_mode_selector_scaffold,
        mode: :swing,
        horizon: :mid_term,
        rationale: :stable_pattern,
        selected_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end

  def strategy_profile(symbol, attrs \\ %{}) do
    Map.merge(
      %{
        symbol: symbol,
        source: :strategy_profile_manager_scaffold,
        profile: :balanced,
        trade_style: :hold,
        parameter_set: %{},
        selected_at: DateTime.utc_now()
      },
      Map.new(attrs)
    )
  end
end
