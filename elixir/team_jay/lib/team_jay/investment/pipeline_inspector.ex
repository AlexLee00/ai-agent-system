defmodule TeamJay.Investment.PipelineInspector do
  @moduledoc """
  투자팀 Elixir scaffold 파이프라인 상태 진단 헬퍼.

  현재 기동 중인 symbol pipeline과 주요 worker registry 상태를
  한 번에 확인하는 용도다.
  """

  alias TeamJay.Investment.Analyst.Worker, as: AnalystWorker
  def inspect_symbol(exchange, symbol) do
    %{
      pipeline: lookup({:investment_symbol_pipeline, exchange, symbol}),
      streamer: lookup({:investment_streamer, exchange, symbol}),
      price_watcher: lookup({:investment_price_watcher, exchange, symbol}),
      indicator: lookup({:investment_indicator, symbol}),
      analysts: inspect_analysts(symbol),
      decision: lookup({:investment_decision, symbol}),
      risk: lookup({:investment_risk, symbol}),
      execution: lookup({:investment_execution, symbol}),
      position_manager: lookup({:investment_position_manager, symbol}),
      condition_checker: lookup({:investment_condition_checker, symbol}),
      trading_loop: lookup({:investment_trading_loop, symbol}),
      strategy_adjuster: lookup({:investment_strategy_adjuster, symbol}),
      runtime_override_store: lookup({:investment_runtime_override_store, symbol}),
      circuit_breaker: lookup({:investment_circuit_breaker, symbol}),
      agent_memory: lookup({:investment_agent_memory, symbol}),
      self_reflection: lookup({:investment_self_reflection, symbol}),
      market_mode_selector: lookup({:investment_market_mode_selector, symbol}),
      strategy_profile_manager: lookup({:investment_strategy_profile_manager, symbol}),
      resource_feedback_coordinator: lookup({:investment_resource_feedback_coordinator, symbol}),
      continuous_loop_coordinator: lookup({:investment_continuous_loop_coordinator, symbol}),
      feedback: lookup({:investment_feedback_realtime, symbol})
    }
  end

  def inspect_defaults do
    TeamJay.Investment.PipelineStarter.default_pipelines()
    |> Enum.map(fn %{exchange: exchange, symbol: symbol} = item ->
      Map.put(item, :status, inspect_symbol(exchange, symbol))
    end)
  end

  defp inspect_analysts(symbol) do
    Enum.map(AnalystWorker.supported_types(), fn analyst_type ->
      {analyst_type, lookup({:investment_analyst, analyst_type, symbol})}
    end)
    |> Map.new()
  end

  defp lookup(key) do
    case Registry.lookup(TeamJay.AgentRegistry, key) do
      [{pid, _meta}] ->
        %{
          registered: true,
          pid: inspect(pid),
          alive: Process.alive?(pid)
        }

      [] ->
        %{
          registered: false,
          pid: nil,
          alive: false
        }
    end
  end
end
