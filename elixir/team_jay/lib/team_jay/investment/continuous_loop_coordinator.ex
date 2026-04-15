defmodule TeamJay.Investment.ContinuousLoopCoordinator do
  @moduledoc """
  Phase 5.5-9 완전자율 연속 루프 통합 설계용 coordinator scaffold.

  loop / condition / strategy / circuit / resource / mode 이벤트를 묶어서
  하나의 autonomous_cycle snapshot으로 요약한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_continuous_loop_coordinator, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [
        Topics.loop_cycles(symbol),
        Topics.condition_checks(symbol),
        Topics.strategy_updates(symbol),
        Topics.circuit_breakers(symbol),
        Topics.resource_feedback(symbol),
        Topics.market_modes(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_loop_cycle: nil,
       last_condition: nil,
       last_strategy_update: nil,
       last_circuit_breaker: nil,
       last_resource_feedback: nil,
       last_market_mode: nil,
       cycle_count: 0,
       last_action: :hold,
       last_readiness: :partial,
       last_completed_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       cycle_count: state.cycle_count,
       last_action: state.last_action,
       last_readiness: state.last_readiness,
       last_completed_at: state.last_completed_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:loop_cycle, loop_cycle}}, state) do
    {:noreply, maybe_publish(%{state | last_loop_cycle: loop_cycle})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:condition_check, condition}}, state) do
    {:noreply, maybe_publish(%{state | last_condition: condition})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:strategy_update, strategy_update}}, state) do
    {:noreply, maybe_publish(%{state | last_strategy_update: strategy_update})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:circuit_breaker, circuit_breaker}}, state) do
    {:noreply, maybe_publish(%{state | last_circuit_breaker: circuit_breaker})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:resource_feedback, resource_feedback}}, state) do
    {:noreply, maybe_publish(%{state | last_resource_feedback: resource_feedback})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, market_mode}}, state) do
    {:noreply, maybe_publish(%{state | last_market_mode: market_mode})}
  end

  defp maybe_publish(%{last_loop_cycle: nil} = state), do: state
  defp maybe_publish(%{last_condition: nil} = state), do: state
  defp maybe_publish(%{last_strategy_update: nil} = state), do: state
  defp maybe_publish(%{last_circuit_breaker: nil} = state), do: state
  defp maybe_publish(%{last_resource_feedback: nil} = state), do: state
  defp maybe_publish(%{last_market_mode: nil} = state), do: state

  defp maybe_publish(state) do
    {action, phase, readiness} =
      decide(
        state.last_condition,
        state.last_strategy_update,
        state.last_circuit_breaker,
        state.last_resource_feedback,
        state.last_market_mode
      )

    snapshot =
      Events.autonomous_cycle(state.symbol,
        mode: state.last_loop_cycle.mode,
        action: action,
        phase: phase,
        readiness: readiness,
        cycle_count: state.cycle_count + 1,
        loop_cycle: state.last_loop_cycle,
        condition_check: state.last_condition,
        strategy_update: state.last_strategy_update,
        circuit_breaker: state.last_circuit_breaker,
        resource_feedback: state.last_resource_feedback,
        market_mode: state.last_market_mode
      )

    PubSub.broadcast_autonomous_cycle(state.symbol, {:autonomous_cycle, snapshot})

    %{
      state
      | cycle_count: state.cycle_count + 1,
        last_action: action,
        last_readiness: readiness,
        last_completed_at: snapshot.completed_at
    }
  end

  defp decide(_condition, _strategy, %{halted: true}, _resource, _market_mode), do: {:stop, :circuit_guard, :blocked}
  defp decide(_condition, _strategy, %{paper_mode: true}, _resource, _market_mode), do: {:paper_trade, :defensive, :guarded}

  defp decide(%{action: :exit}, _strategy, _circuit, %{ready_resources: ready}, _market_mode) when ready >= 6 do
    {:exit, :manage_position, :ready}
  end

  defp decide(%{action: :hold}, %{governance_tier: :allow}, _circuit, %{ready_resources: ready}, %{mode: mode})
       when ready >= 6 and mode in [:swing, :position_trade] do
    {:adjust, :optimize, :ready}
  end

  defp decide(_condition, _strategy, _circuit, %{ready_resources: ready}, _market_mode) when ready >= 6 do
    {:hold, :observe, :ready}
  end

  defp decide(_condition, _strategy, _circuit, _resource, _market_mode), do: {:hold, :observe, :partial}
end
