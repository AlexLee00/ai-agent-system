defmodule TeamJay.Investment.ConditionChecker do
  @moduledoc """
  Phase 5-A 손절/익절 조건 점검 GenServer 스캐폴드.

  position_state를 받아 HOLD/ADJUST/EXIT 후보를 평가하고
  condition_check 이벤트를 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @stop_loss_pct -5.0
  @take_profit_pct 10.0
  @adjust_threshold_pct 3.0

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_condition_checker, symbol}}}

  def status(symbol) do
    GenServer.call(via(symbol), :status)
  end

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    {:ok, _} = PubSub.subscribe(Topics.position_state(symbol))

    {:ok,
     %{
       symbol: symbol,
       check_count: 0,
       last_action: :hold,
       last_reason: :idle,
       last_checked_at: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       check_count: state.check_count,
       last_action: state.last_action,
       last_reason: state.last_reason,
       last_checked_at: state.last_checked_at
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:position_state, snapshot}}, state) do
    {action, reason, score} = evaluate(snapshot)

    condition =
      Events.condition_check(state.symbol,
        action: action,
        reason: reason,
        score: score,
        position_snapshot: snapshot
      )

    PubSub.broadcast_condition_check(state.symbol, {:condition_check, condition})

    {:noreply,
     %{
       state
       | check_count: state.check_count + 1,
         last_action: action,
         last_reason: reason,
         last_checked_at: condition.checked_at
     }}
  end

  defp evaluate(%{status: :flat}), do: {:hold, :flat_position, 0.0}
  defp evaluate(%{pnl_pct: pnl}) when pnl <= @stop_loss_pct, do: {:exit, :stop_loss, 1.0}
  defp evaluate(%{pnl_pct: pnl}) when pnl >= @take_profit_pct, do: {:exit, :take_profit, 0.95}
  defp evaluate(%{pnl_pct: pnl}) when pnl >= @adjust_threshold_pct, do: {:adjust, :trail_profit, 0.6}
  defp evaluate(%{pnl_pct: pnl}) when pnl <= -2.0, do: {:adjust, :risk_watch, 0.4}
  defp evaluate(_snapshot), do: {:hold, :within_band, 0.2}
end
