defmodule TeamJay.Investment.StrategyProfileManager do
  @moduledoc """
  Phase 5-E 전략별 파라미터 세트 관리 스캐폴드.

  market_mode를 받아 balanced/aggressive/defensive profile과 parameter set을 선택한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_strategy_profile_manager, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.market_modes(symbol))

    {:ok,
     %{
       symbol: symbol,
       selection_count: 0,
       last_profile: :balanced,
       last_trade_style: :hold,
       last_selected_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       selection_count: state.selection_count,
       last_profile: state.last_profile,
       last_trade_style: state.last_trade_style,
       last_selected_at: state.last_selected_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, mode}}, state) do
    {profile, trade_style, parameter_set} = select_profile(mode)

    selection =
      Events.strategy_profile(state.symbol,
        profile: profile,
        trade_style: trade_style,
        parameter_set: parameter_set,
        market_mode: mode
      )

    PubSub.broadcast_strategy_profile(state.symbol, {:strategy_profile, selection})

    {:noreply,
     %{
       state
       | selection_count: state.selection_count + 1,
         last_profile: profile,
         last_trade_style: trade_style,
         last_selected_at: selection.selected_at
     }}
  end

  defp select_profile(%{mode: :position_trade}) do
    {:aggressive, :short_term,
     %{max_position_pct: 0.15, risk_per_trade: 0.03, max_concurrent_positions: 4}}
  end

  defp select_profile(%{mode: :defensive}) do
    {:defensive, :capital_preserve,
     %{max_position_pct: 0.08, risk_per_trade: 0.01, max_concurrent_positions: 2}}
  end

  defp select_profile(%{mode: :swing}) do
    {:balanced, :long_term,
     %{max_position_pct: 0.12, risk_per_trade: 0.02, max_concurrent_positions: 3}}
  end

  defp select_profile(_mode) do
    {:aggressive, :short_term,
     %{max_position_pct: 0.1, risk_per_trade: 0.02, max_concurrent_positions: 3}}
  end
end
