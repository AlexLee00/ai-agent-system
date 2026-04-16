defmodule TeamJay.Investment.TradingLoop do
  @moduledoc """
  CODEX_LUNA_AUTONOMOUS_LOOP Phase A/B — 유기적 연속 루프 오케스트레이터.

  signal -> approved_signal -> trade_result -> position_state -> condition_check -> feedback
  흐름을 묶어 Mode 1/2/3 전환과 cycle_complete 이벤트를 고정한다.

  Mode 1 (탐색): 포지션 없음 → 5분마다 market_modes 토픽에 mode1_cycle_tick 발행
  Mode 2 (분석): signal 감지 후 analyze 진행 중
  Mode 3 (포지션 관리): 포지션 보유 → 30초마다 mode3_cycle_tick 발행
  """

  use GenServer

  require Logger

  alias TeamJay.Investment.Events
  alias TeamJay.Investment.PubSub
  alias TeamJay.Investment.Topics

  @default_stages [:collect, :analyze, :evaluate, :decide, :execute, :feedback]

  # Mode 1: 5분 탐색 주기
  @mode1_interval_ms 5 * 60 * 1_000
  # Mode 3: 30초 포지션 관리 주기
  @mode3_interval_ms 30 * 1_000

  def start_link(opts) do
    symbol = Keyword.fetch!(opts, :symbol)
    GenServer.start_link(__MODULE__, opts, name: via(symbol))
  end

  def via(symbol), do: {:via, Registry, {TeamJay.AgentRegistry, {:investment_trading_loop, symbol}}}

  def status(symbol), do: GenServer.call(via(symbol), :status)

  @impl true
  def init(opts) do
    symbol = Keyword.fetch!(opts, :symbol)

    Enum.each(
      [
        Topics.signal(symbol),
        Topics.approved_signal(symbol),
        Topics.trade_result(symbol),
        Topics.position_state(symbol),
        Topics.condition_checks(symbol),
        Topics.feedback(symbol)
      ],
      fn topic -> {:ok, _} = PubSub.subscribe(topic) end
    )

    mode1_timer = schedule_mode1()

    {:ok,
     %{
       symbol: symbol,
       current_mode: :mode1_explore,
       cycle_count: 0,
       last_cycle_at: nil,
       last_stage: nil,
       position_open?: false,
       pending_cycle: %{},
       mode1_timer: mode1_timer,
       mode3_timer: nil,
       mode1_tick_count: 0,
       mode3_tick_count: 0
     }}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       symbol: state.symbol,
       current_mode: state.current_mode,
       cycle_count: state.cycle_count,
       last_cycle_at: state.last_cycle_at,
       last_stage: state.last_stage,
       position_open?: state.position_open?,
       completed_stages: Map.keys(state.pending_cycle),
       mode1_tick_count: state.mode1_tick_count,
       mode3_tick_count: state.mode3_tick_count
     }, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 스케줄 루프 핸들러
  # ────────────────────────────────────────────────────────────────

  @impl true
  def handle_info(:mode1_cycle, state) do
    if state.current_mode == :mode1_explore do
      Logger.debug("[TradingLoop:#{state.symbol}] Mode1 탐색 주기 tick ##{state.mode1_tick_count + 1}")

      PubSub.broadcast(
        Topics.market_modes(state.symbol),
        {:mode_tick, %{mode: :mode1_explore, symbol: state.symbol, tick: state.mode1_tick_count + 1, at: DateTime.utc_now()}}
      )

      timer = schedule_mode1()
      {:noreply, %{state | mode1_timer: timer, mode1_tick_count: state.mode1_tick_count + 1}}
    else
      # 모드가 바뀌었으면 Mode 1 루프 중단 (mode3_cycle 핸들러가 인계)
      {:noreply, %{state | mode1_timer: nil}}
    end
  end

  @impl true
  def handle_info(:mode3_cycle, state) do
    if state.current_mode == :mode3_manage do
      Logger.debug("[TradingLoop:#{state.symbol}] Mode3 포지션 관리 주기 tick ##{state.mode3_tick_count + 1}")

      PubSub.broadcast(
        Topics.market_modes(state.symbol),
        {:mode_tick, %{mode: :mode3_manage, symbol: state.symbol, tick: state.mode3_tick_count + 1, at: DateTime.utc_now()}}
      )

      timer = schedule_mode3()
      {:noreply, %{state | mode3_timer: timer, mode3_tick_count: state.mode3_tick_count + 1}}
    else
      # 포지션 청산 → Mode 3 루프 중단, Mode 1 재시작
      {:noreply, %{state | mode3_timer: nil}}
    end
  end

  # ────────────────────────────────────────────────────────────────
  # 이벤트 기반 사이클 추적
  # ────────────────────────────────────────────────────────────────

  @impl true
  def handle_info({:investment_event, topic, payload}, state) do
    stage = stage_from_topic(state.symbol, topic)
    pending_cycle = Map.put(state.pending_cycle, stage, payload)
    prev_mode = state.current_mode
    next_mode = next_mode(state.current_mode, stage, payload, state.position_open?)
    position_open? = position_open?(state.position_open?, stage, payload)

    next_state =
      state
      |> Map.merge(%{
        current_mode: next_mode,
        last_stage: stage,
        position_open?: position_open?,
        pending_cycle: pending_cycle
      })
      |> maybe_switch_timers(prev_mode, next_mode)

    if cycle_complete?(pending_cycle) do
      cycle =
        Events.loop_cycle(state.symbol,
          mode: next_mode,
          cycle_count: state.cycle_count + 1,
          position_open?: position_open?,
          details: Map.take(pending_cycle, @default_stages)
        )

      PubSub.broadcast(Topics.loop_cycles(state.symbol), {:loop_cycle, cycle})

      {:noreply,
       %{
         next_state
         | cycle_count: state.cycle_count + 1,
           last_cycle_at: cycle.completed_at,
           pending_cycle: %{}
       }}
    else
      {:noreply, next_state}
    end
  end

  # ────────────────────────────────────────────────────────────────
  # 모드 전환 시 타이머 교체
  # ────────────────────────────────────────────────────────────────

  defp maybe_switch_timers(state, prev_mode, next_mode) when prev_mode == next_mode, do: state

  defp maybe_switch_timers(state, _prev, :mode3_manage) do
    _ = cancel_timer(state.mode1_timer)
    timer = schedule_mode3()
    Logger.info("[TradingLoop:#{state.symbol}] Mode1 → Mode3 전환: 30초 루프 시작")
    %{state | mode1_timer: nil, mode3_timer: timer}
  end

  defp maybe_switch_timers(state, :mode3_manage, :mode1_explore) do
    _ = cancel_timer(state.mode3_timer)
    timer = schedule_mode1()
    Logger.info("[TradingLoop:#{state.symbol}] Mode3 → Mode1 전환: 5분 루프 재시작")
    %{state | mode3_timer: nil, mode1_timer: timer}
  end

  defp maybe_switch_timers(state, _prev, _next), do: state

  # ────────────────────────────────────────────────────────────────
  # 헬퍼
  # ────────────────────────────────────────────────────────────────

  defp schedule_mode1, do: Process.send_after(self(), :mode1_cycle, @mode1_interval_ms)
  defp schedule_mode3, do: Process.send_after(self(), :mode3_cycle, @mode3_interval_ms)

  defp cancel_timer(nil), do: :ok
  defp cancel_timer(ref), do: Process.cancel_timer(ref)

  defp stage_from_topic(symbol, topic) do
    cond do
      topic == Topics.signal(symbol) -> :analyze
      topic == Topics.approved_signal(symbol) -> :decide
      topic == Topics.trade_result(symbol) -> :execute
      topic == Topics.position_state(symbol) -> :evaluate
      topic == Topics.condition_checks(symbol) -> :decide
      topic == Topics.feedback(symbol) -> :feedback
      true -> :collect
    end
  end

  defp next_mode(_current_mode, :feedback, _payload, true), do: :mode3_manage
  defp next_mode(_current_mode, :feedback, _payload, false), do: :mode1_explore
  defp next_mode(_current_mode, :analyze, _payload, false), do: :mode2_analyze
  defp next_mode(current_mode, :execute, _payload, _open?), do: current_mode
  defp next_mode(_current_mode, _stage, _payload, true), do: :mode3_manage
  defp next_mode(current_mode, _stage, _payload, false), do: current_mode

  defp position_open?(_current_open?, :evaluate, {:position_state, %{status: :open}}), do: true
  defp position_open?(_current_open?, :evaluate, {:position_state, %{status: :flat}}), do: false
  defp position_open?(current_open?, _stage, _payload), do: current_open?

  defp cycle_complete?(pending_cycle) do
    Enum.all?([:analyze, :execute, :evaluate, :feedback], &Map.has_key?(pending_cycle, &1))
  end
end
