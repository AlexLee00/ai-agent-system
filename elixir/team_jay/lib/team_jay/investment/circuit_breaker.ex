defmodule TeamJay.Investment.CircuitBreaker do
  @moduledoc """
  Phase 5.5-5 3단계 서킷 브레이커 + PAPER/LIVE 자동 전환 스캐폴드.

  feedback와 market_mode 이벤트를 받아
  - Level 1: size 50% 축소
  - Level 2: PAPER 모드 전환
  - Level 3: 완전 중지
  를 materialize 한다.

  현재는 실전 secrets/config 반영 대신 circuit_breaker 이벤트와 상태 snapshot만 발행한다.
  """

  use GenServer

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_release_wait_ms 30 * 60 * 1_000

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_circuit_breaker, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [Topics.feedback(symbol), Topics.market_modes(symbol)],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    {:ok,
     %{
       symbol: symbol,
       release_wait_ms: Keyword.get(opts, :release_wait_ms, @default_release_wait_ms),
       current_level: 0,
       max_level_seen: 0,
       paper_mode: false,
       halted: false,
       size_multiplier: 1.0,
       loss_streak: 0,
       paper_win_streak: 0,
       switch_count: 0,
       auto_release_count: 0,
       last_action: :live,
       last_market_mode: nil,
       last_feedback: nil,
       circuit_started_at: nil,
       last_transition_at: nil,
       last_updated_at: nil,
       history: []
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       current_level: state.current_level,
       max_level_seen: state.max_level_seen,
       paper_mode: state.paper_mode,
       halted: state.halted,
       size_multiplier: state.size_multiplier,
       loss_streak: state.loss_streak,
       paper_win_streak: state.paper_win_streak,
       switch_count: state.switch_count,
       auto_release_count: state.auto_release_count,
       last_action: state.last_action,
       last_transition_at: state.last_transition_at,
       history_count: length(state.history)
     }, state}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:market_mode, market_mode}}, state) do
    next_state = %{state | last_market_mode: market_mode}
    {:noreply, maybe_release(next_state)}
  end

  @impl true
  def handle_info({:investment_event, _topic, {:feedback, feedback}}, state) do
    next_state =
      state
      |> Map.put(:last_feedback, feedback)
      |> apply_feedback(feedback)
      |> maybe_release()

    {:noreply, emit_snapshot(next_state, feedback)}
  end

  defp apply_feedback(state, feedback) do
    outcome = infer_outcome(feedback)
    loss_streak = next_loss_streak(state.loss_streak, outcome)
    paper_win_streak = next_paper_win_streak(state.paper_mode, state.paper_win_streak, outcome)

    {level, action, paper_mode, halted, size_multiplier} =
      decide_level(state.current_level, loss_streak, state.paper_mode)

    circuit_started_at =
      cond do
        level >= 2 and is_nil(state.circuit_started_at) -> DateTime.utc_now()
        level < 2 -> nil
        true -> state.circuit_started_at
      end

    %{
      state
      | current_level: level,
        max_level_seen: max(state.max_level_seen, level),
        paper_mode: paper_mode,
        halted: halted,
        size_multiplier: size_multiplier,
        loss_streak: loss_streak,
        paper_win_streak: paper_win_streak,
        last_action: action,
        circuit_started_at: circuit_started_at,
        last_transition_at: DateTime.utc_now()
    }
  end

  defp maybe_release(%{current_level: 2, paper_mode: true} = state) do
    if release_ready?(state) do
      %{
        state
        | current_level: 0,
          paper_mode: false,
          halted: false,
          size_multiplier: 1.0,
          loss_streak: 0,
          paper_win_streak: 0,
          auto_release_count: state.auto_release_count + 1,
          last_action: :live,
          circuit_started_at: nil,
          last_transition_at: DateTime.utc_now()
      }
    else
      state
    end
  end

  defp maybe_release(state), do: state

  defp emit_snapshot(state, feedback) do
    snapshot =
      Events.circuit_breaker(state.symbol,
        level: state.current_level,
        action: state.last_action,
        paper_mode: state.paper_mode,
        halted: state.halted,
        size_multiplier: state.size_multiplier,
        loss_streak: state.loss_streak,
        paper_win_streak: state.paper_win_streak,
        release_ready: release_ready?(state),
        feedback: feedback,
        market_mode: state.last_market_mode,
        circuit_started_at: state.circuit_started_at
      )

    PubSub.broadcast_circuit_breaker(state.symbol, {:circuit_breaker, snapshot})

    %{
      state
      | switch_count: state.switch_count + 1,
        last_updated_at: snapshot.updated_at,
        history: [snapshot | state.history] |> Enum.take(20)
    }
  end

  defp infer_outcome(%{outcome: outcome}) when outcome in [:win, :loss, :flat], do: outcome
  defp infer_outcome(%{"outcome" => outcome}) when outcome in [:win, :loss, :flat], do: outcome

  defp infer_outcome(%{evaluation: %{score: score}}) when is_number(score) do
    cond do
      score > 0 -> :win
      score < 0 -> :loss
      true -> :flat
    end
  end

  defp infer_outcome(_feedback), do: :observe

  defp next_loss_streak(_streak, :win), do: 0
  defp next_loss_streak(_streak, :flat), do: 0
  defp next_loss_streak(streak, :loss), do: streak + 1
  defp next_loss_streak(streak, :observe), do: streak

  defp next_paper_win_streak(true, streak, :win), do: streak + 1
  defp next_paper_win_streak(true, _streak, :loss), do: 0
  defp next_paper_win_streak(true, streak, :observe), do: streak
  defp next_paper_win_streak(true, _streak, :flat), do: 0
  defp next_paper_win_streak(false, _streak, _outcome), do: 0

  defp decide_level(3, _loss_streak, _paper_mode), do: {3, :stop, false, true, 0.0}
  defp decide_level(_current_level, loss_streak, _paper_mode) when loss_streak >= 5, do: {3, :stop, false, true, 0.0}
  defp decide_level(current_level, _loss_streak, true) when current_level >= 2, do: {2, :paper, true, false, 1.0}
  defp decide_level(_current_level, loss_streak, _paper_mode) when loss_streak >= 3, do: {2, :paper, true, false, 1.0}
  defp decide_level(_current_level, loss_streak, _paper_mode) when loss_streak >= 2, do: {1, :live, false, false, 0.5}
  defp decide_level(_current_level, _loss_streak, _paper_mode), do: {0, :live, false, false, 1.0}

  defp release_ready?(%{current_level: 2, paper_mode: true} = state) do
    state.paper_win_streak >= 3 and market_normal?(state.last_market_mode) and wait_elapsed?(state)
  end

  defp release_ready?(_state), do: false

  defp market_normal?(%{mode: mode}) when mode in [:swing, :position_trade], do: true
  defp market_normal?(%{"mode" => mode}) when mode in [:swing, :position_trade], do: true
  defp market_normal?(_mode), do: false

  defp wait_elapsed?(%{circuit_started_at: nil}), do: false

  defp wait_elapsed?(state) do
    DateTime.diff(DateTime.utc_now(), state.circuit_started_at, :millisecond) >= state.release_wait_ms
  end
end
