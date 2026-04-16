defmodule TeamJay.Investment.StrategyAdjuster do
  @moduledoc """
  CODEX_LUNA_AUTONOMOUS_LOOP Phase C — 전략 자동 조정 GenServer.

  feedback / condition / loop_cycle / market_mode 이벤트를 통합해
  ALLOW / ESCALATE / BLOCK 경계 안에서 strategy_update 이벤트를 발행한다.

  proposals는 absolute value (config 기준 + delta 반영) 형태로 발행.
  → RuntimeOverrideStore가 수신해 investment.runtime_overrides 테이블에 저장.
  → capital-manager.ts의 getCapitalConfigWithOverrides()가 trade 시점마다 로드.

  market_mode 구독 추가 (Phase E): 시장 레짐에 따라 tp_pct/sl_pct 자동 조정.
  """

  use GenServer

  require Logger

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  # config.yaml 기준 baseline 수치 (절대값 계산 기준)
  @baseline_risk_per_trade   0.02
  @baseline_tp_pct           0.06
  @baseline_sl_pct           0.03
  @baseline_position_pct     0.10

  # 시장 레짐별 tp/sl 프로파일 (Phase E)
  @regime_profiles %{
    trending:       %{tp_pct: 0.09, sl_pct: 0.04},  # 장기 보유 — TP 넓게
    ranging:        %{tp_pct: 0.04, sl_pct: 0.02},  # 단기 매매 — TP 좁게
    volatile:       %{tp_pct: 0.05, sl_pct: 0.025}, # 리스크 최소화
    position_trade: %{tp_pct: 0.09, sl_pct: 0.04},
    swing:          %{tp_pct: 0.06, sl_pct: 0.03},
  }

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
      [
        Topics.feedback(symbol),
        Topics.condition_checks(symbol),
        Topics.loop_cycles(symbol),
        Topics.market_modes(symbol)   # Phase E: 레짐 기반 tp/sl 조정
      ],
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
       last_loop_cycle: nil,
       last_market_mode: nil,
       current_tp_pct: @baseline_tp_pct,
       current_sl_pct: @baseline_sl_pct,
       current_risk_per_trade: @baseline_risk_per_trade,
       current_position_pct: @baseline_position_pct
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
       loop_cycle_seen?: not is_nil(state.last_loop_cycle),
       market_mode: state.last_market_mode,
       current_tp_pct: state.current_tp_pct,
       current_sl_pct: state.current_sl_pct,
       current_risk_per_trade: state.current_risk_per_trade,
       current_position_pct: state.current_position_pct
     }, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 이벤트 핸들러
  # ────────────────────────────────────────────────────────────────

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

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, market_mode}}, state) do
    # Phase E: 레짐 변경 → tp/sl 자동 조정 (ALLOW 범위 내)
    {tp, sl} = regime_tp_sl(market_mode)
    next_state = %{state |
      last_market_mode: market_mode,
      current_tp_pct: tp,
      current_sl_pct: sl
    }

    if tp != state.current_tp_pct or sl != state.current_sl_pct do
      Logger.info("[StrategyAdjuster:#{state.symbol}] 레짐 전환 → tp=#{tp} sl=#{sl}")
      {update, next_state2} = publish_regime_update(next_state, market_mode)
      {:noreply, merge_status(next_state2, update)}
    else
      {:noreply, next_state}
    end
  end

  # ────────────────────────────────────────────────────────────────
  # 제안 발행 (absolute value)
  # ────────────────────────────────────────────────────────────────

  defp publish_update(state) do
    {tier, action, reason, proposals} =
      classify(state.last_feedback, state.last_condition, state.last_loop_cycle, state)

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

  defp publish_regime_update(state, _market_mode) do
    proposals = %{
      "rr_fallback.tp_pct" => state.current_tp_pct,
      "rr_fallback.sl_pct" => state.current_sl_pct
    }

    update =
      Events.strategy_update(state.symbol,
        governance_tier: :allow,
        action: :adjust_tp_sl,
        reason: :regime_change,
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

  # ────────────────────────────────────────────────────────────────
  # 분류 → absolute proposals
  # ────────────────────────────────────────────────────────────────

  # delta → absolute 변환 헬퍼 (ALLOW 범위 클램프)
  defp apply_delta(current, delta, min_val, max_val) do
    Float.round(min(max_val, max(min_val, current + delta)), 4)
  end

  defp classify(nil, _condition, _cycle, _state), do: {:block, :hold, :missing_feedback, %{}}

  defp classify(_feedback, %{reason: :take_profit}, _cycle, state) do
    tp = apply_delta(state.current_tp_pct, -0.01, 0.02, 0.15)
    sl = apply_delta(state.current_sl_pct, 0.005, 0.01, 0.08)
    {:allow, :adjust_tp_sl, :lock_in_profit,
     %{"rr_fallback.tp_pct" => tp, "rr_fallback.sl_pct" => sl}}
  end

  defp classify(_feedback, %{reason: :trail_profit}, _cycle, state) do
    pos = apply_delta(state.current_position_pct, -0.02, 0.05, 0.50)
    tp  = apply_delta(state.current_tp_pct, 0.005, 0.02, 0.15)
    {:allow, :adjust_position_size, :trail_profit,
     %{"max_position_pct" => pos, "rr_fallback.tp_pct" => tp}}
  end

  defp classify(_feedback, %{reason: :risk_watch}, _cycle, state) do
    pos  = apply_delta(state.current_position_pct, -0.02, 0.05, 0.50)
    risk = apply_delta(state.current_risk_per_trade, -0.005, 0.01, 0.05)
    {:allow, :adjust_risk, :risk_watch,
     %{"max_position_pct" => pos, "risk_per_trade" => risk}}
  end

  defp classify(feedback, %{reason: :stop_loss}, %{mode: :mode3_manage}, _state) do
    {:escalate, :review_drawdown, :stop_loss_cluster,
     %{review_scope: :drawdown, approval_required: true, feedback_action: feedback.action}}
  end

  defp classify(%{action: :exit}, _condition, %{mode: :mode3_manage}, _state) do
    {:allow, :rebalance_weights, :post_exit_feedback, %{}}
  end

  defp classify(%{action: :entry}, _condition, _cycle, _state) do
    {:block, :hold, :entry_feedback_only, %{}}
  end

  defp classify(_feedback, _condition, _cycle, _state) do
    {:block, :hold, :insufficient_context, %{}}
  end

  # ────────────────────────────────────────────────────────────────
  # 레짐 → tp/sl 프로파일 (Phase E)
  # ────────────────────────────────────────────────────────────────

  defp regime_tp_sl(%{mode: mode}) when is_atom(mode) do
    profile = Map.get(@regime_profiles, mode, %{tp_pct: @baseline_tp_pct, sl_pct: @baseline_sl_pct})
    {profile.tp_pct, profile.sl_pct}
  end

  defp regime_tp_sl(%{"mode" => mode}) when is_binary(mode) do
    atom_mode = String.to_existing_atom(mode)
    regime_tp_sl(%{mode: atom_mode})
  rescue
    ArgumentError -> {@baseline_tp_pct, @baseline_sl_pct}
  end

  defp regime_tp_sl(_), do: {@baseline_tp_pct, @baseline_sl_pct}
end
