defmodule TeamJay.Investment.MarketModeSelector do
  @moduledoc """
  Phase 5-E 시장 상황 -> 매매 모드 자동 선택 스캐폴드.

  reflection / loop_cycle 이벤트를 받아 장기/단기 운용 모드를 고정한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_market_mode_selector, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [Topics.reflections(symbol), Topics.loop_cycles(symbol)],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       last_reflection: nil,
       last_loop_cycle: nil,
       selection_count: 0,
       last_mode: :swing,
       last_horizon: :mid_term,
       last_selected_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       selection_count: state.selection_count,
       last_mode: state.last_mode,
       last_horizon: state.last_horizon,
       last_selected_at: state.last_selected_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:reflection, reflection}}, state) do
    {:noreply, maybe_select(%{state | last_reflection: reflection})}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:loop_cycle, cycle}}, state) do
    {:noreply, maybe_select(%{state | last_loop_cycle: cycle})}
  end

  defp maybe_select(%{last_reflection: nil} = state), do: state
  defp maybe_select(%{last_loop_cycle: nil} = state), do: state

  defp maybe_select(state) do
    {mode, horizon, rationale} = decide_mode(state.last_reflection, state.last_loop_cycle)

    selection =
      Events.market_mode(state.symbol,
        mode: mode,
        horizon: horizon,
        rationale: rationale,
        reflection: state.last_reflection,
        loop_cycle: state.last_loop_cycle
      )

    PubSub.broadcast_market_mode(state.symbol, {:market_mode, selection})

    %{
      state
      | selection_count: state.selection_count + 1,
        last_mode: mode,
        last_horizon: horizon,
        last_selected_at: selection.selected_at
    }
  end

  defp decide_mode(%{recommended_strategy: :scale_allow_pattern}, %{mode: :mode3_manage}) do
    {:position_trade, :short_term, :volatile_manage_mode}
  end

  defp decide_mode(%{recommended_strategy: :wait_master_review}, _cycle) do
    {:defensive, :mid_term, :approval_boundary}
  end

  defp decide_mode(%{recommended_strategy: :hold}, %{mode: :mode1_explore}) do
    {:swing, :long_term, :trend_follow}
  end

  defp decide_mode(_reflection, _cycle) do
    {:scalp, :short_term, :reactive_loop}
  end
end
