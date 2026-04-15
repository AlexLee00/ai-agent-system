defmodule TeamJay.Investment.StrategyAdjuster do
  @moduledoc """
  Phase 5-C 전략 자동 적용 GenServer 스캐폴드.

  feedback / condition / loop_cycle 이벤트를 묶어서
  ALLOW / ESCALATE / BLOCK 경계 안에서 strategy_update 이벤트를 발행한다.
  현재는 실전 config 반영 대신 no-op 제안 payload만 고정한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_strategy_adjuster, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [Topics.feedback(symbol), Topics.condition_checks(symbol), Topics.loop_cycles(symbol)],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       update_count: 0,
       last_update_at: nil,
       last_action: :hold,
       last_tier: :block,
       last_reason: :no_change,
       last_feedback: nil,
       last_condition: nil,
       last_loop_cycle: nil
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       update_count: state.update_count,
       last_update_at: state.last_update_at,
       last_action: state.last_action,
       last_tier: state.last_tier,
       last_reason: state.last_reason,
       feedback_seen?: not is_nil(state.last_feedback),
       condition_seen?: not is_nil(state.last_condition),
       loop_cycle_seen?: not is_nil(state.last_loop_cycle)
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:feedback, feedback}}, state) do
    next_state = %{state | last_feedback: feedback}
    {update, next_state} = publish_update(next_state)
    {:noreply, merge_status(next_state, update)}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:condition_check, condition}}, state) do
    {:noreply, %{state | last_condition: condition}}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:loop_cycle, cycle}}, state) do
    {:noreply, %{state | last_loop_cycle: cycle}}
  end

  defp publish_update(state) do
    {tier, action, reason, proposals} =
      classify(state.last_feedback, state.last_condition, state.last_loop_cycle)

    update =
      Events.strategy_update(state.symbol,
        governance_tier: tier,
        action: action,
        reason: reason,
        proposals: proposals,
        feedback: state.last_feedback,
        condition_check: state.last_condition,
        loop_cycle: state.last_loop_cycle
      )

    PubSub.broadcast_strategy_update(state.symbol, {:strategy_update, update})
    {update, state}
  end

  defp merge_status(state, update) do
    %{
      state
      | update_count: state.update_count + 1,
        last_update_at: update.updated_at,
        last_action: update.action,
        last_tier: update.governance_tier,
        last_reason: update.reason
    }
  end

  defp classify(nil, _condition, _cycle), do: {:block, :hold, :missing_feedback, %{}}

  defp classify(_feedback, %{reason: :take_profit}, _cycle) do
    {:allow, :adjust_tp_sl, :lock_in_profit,
     %{tp_pct_delta: -0.01, sl_pct_delta: 0.01, analyst_weight_delta: 0.05}}
  end

  defp classify(_feedback, %{reason: :trail_profit}, _cycle) do
    {:allow, :adjust_position_size, :trail_profit,
     %{position_size_delta: -0.05, tp_pct_delta: 0.005}}
  end

  defp classify(_feedback, %{reason: :risk_watch}, _cycle) do
    {:allow, :adjust_risk, :risk_watch,
     %{position_size_delta: -0.1, risk_per_trade_delta: -0.005}}
  end

  defp classify(feedback, %{reason: :stop_loss}, %{mode: :mode3_manage}) do
    {:escalate, :review_drawdown, :stop_loss_cluster,
     %{review_scope: :drawdown, approval_required: true, feedback_action: feedback.action}}
  end

  defp classify(%{action: :exit}, _condition, %{mode: :mode3_manage}) do
    {:allow, :rebalance_weights, :post_exit_feedback,
     %{ta_weight_delta: -0.05, analyst_weight_delta: 0.05}}
  end

  defp classify(%{action: :entry}, _condition, _cycle) do
    {:block, :hold, :entry_feedback_only, %{}}
  end

  defp classify(_feedback, _condition, _cycle) do
    {:block, :hold, :insufficient_context, %{}}
  end
end
