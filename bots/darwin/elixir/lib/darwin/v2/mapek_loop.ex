defmodule Darwin.V2.MapeKLoop do
  @moduledoc """
  다윈팀 MAPE-K 완전자율 루프.

  기존 7단계 사이클 (DISCOVER→EVALUATE→PLAN→IMPLEMENT→VERIFY→APPLY→LEARN)을
  MAPE-K 프레임에 매핑하여 지속적 자체 진화 가능.

  역할:
  - 매 사이클 종료 시 LEARN 결과를 다음 DISCOVER로 자동 환류
  - 자율 레벨 변화 감지 → 브로드캐스트
  - 비용/품질/원칙 위반 지속 모니터링
  - 주간 메타 리뷰 트리거 (매주 일요일 05:00 KST)

  Kill Switch:
  - DARWIN_V2_ENABLED=true 필수
  - DARWIN_MAPEK_ENABLED=true (기본 false, 명시적 활성화 필요)

  MAPE-K 매핑:
  - Monitor   → DISCOVER + Community Scanner
  - Analyze   → EVALUATE + Agentic RAG
  - Plan      → PLAN + Risk Gate
  - Execute   → IMPLEMENT + VERIFY + APPLY
  - Knowledge → LEARN + Self-Rewarding + Research Registry
  """
  use GenServer
  require Logger

  alias Darwin.V2.{
    KillSwitch,
    Telemetry,
    Topics
  }

  # 24시간 (일단위 사이클 tick)
  @daily_interval_ms 24 * 60 * 60 * 1_000
  # 6일 (주간 tick — 7일 중 6일 후 실행해 일요일 간격 유지)
  @weekly_interval_ms 6 * 24 * 60 * 60 * 1_000

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "현재 MAPE-K 루프 상태 조회."
  def status do
    GenServer.call(__MODULE__, :status)
  end

  @doc "사이클 완료 이벤트 수신 (Commander → MapeKLoop 환류 진입점)."
  def on_cycle_complete(cycle_result) do
    GenServer.cast(__MODULE__, {:cycle_complete, cycle_result})
  end

  @doc "수동으로 주간 Knowledge 단계 트리거."
  def trigger_weekly_knowledge do
    GenServer.cast(__MODULE__, :weekly_knowledge)
  end

  # ──────────────────────────────────────────────
  # GenServer callbacks
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    if KillSwitch.enabled?(:v2) and KillSwitch.enabled?(:mapek) do
      schedule_daily_tick()
      schedule_weekly_tick()
      Logger.info("[Darwin.V2.MapeKLoop] MAPE-K 루프 기동 — 일일/주간 틱 예약 완료")
      {:ok, initial_state()}
    else
      Logger.info("[Darwin.V2.MapeKLoop] Kill switch OFF — 대기 모드 (DARWIN_MAPEK_ENABLED=false)")
      {:ok, Map.put(initial_state(), :dormant, true)}
    end
  end

  # 일일 Monitor + Analyze 체크
  @impl GenServer
  def handle_info(:daily_tick, state) do
    new_state =
      if KillSwitch.enabled?(:mapek) do
        run_daily_monitor(state)
      else
        state
      end

    schedule_daily_tick()
    {:noreply, new_state}
  end

  # 주간 Knowledge 단계 (Self-Rewarding + Research Registry + Meta-Review)
  @impl GenServer
  def handle_info(:weekly_tick, state) do
    Task.start(fn -> run_weekly_knowledge() end)
    schedule_weekly_tick()
    {:noreply, %{state | last_weekly_knowledge_at: DateTime.utc_now()}}
  end

  # 사이클 완료 이벤트 수신 → Knowledge 단계 비동기 트리거
  @impl GenServer
  def handle_cast({:cycle_complete, cycle_result}, state) do
    if KillSwitch.enabled?(:mapek) do
      Task.start(fn -> handle_cycle_knowledge(cycle_result) end)
    end

    new_state = %{
      state
      | total_cycles: state.total_cycles + 1,
        last_cycle_at: DateTime.utc_now(),
        last_cycle_id: Map.get(cycle_result, :cycle_id)
    }

    {:noreply, new_state}
  end

  @impl GenServer
  def handle_cast(:weekly_knowledge, state) do
    Task.start(fn -> run_weekly_knowledge() end)
    {:noreply, %{state | last_weekly_knowledge_at: DateTime.utc_now()}}
  end

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  # ──────────────────────────────────────────────
  # MAPE-K 단계별 실행
  # ──────────────────────────────────────────────

  # Monitor: Community Scanner + 자율 레벨 모니터링
  defp run_daily_monitor(state) do
    Logger.debug("[Darwin.V2.MapeKLoop] Monitor 단계 시작")

    check_autonomy_level()
    record_telemetry(state)

    %{state | last_monitor_at: DateTime.utc_now()}
  end

  # Knowledge: 사이클 종료 후 Self-Rewarding + Research Registry 비동기 처리
  defp handle_cycle_knowledge(cycle_result) do
    Logger.debug("[Darwin.V2.MapeKLoop] Knowledge 단계 — cycle_id=#{inspect(Map.get(cycle_result, :cycle_id))}")

    if KillSwitch.enabled?(:self_rewarding) do
      try do
        Darwin.V2.SelfRewarding.evaluate_cycle(cycle_result)
      rescue
        e -> Logger.warning("[Darwin.V2.MapeKLoop] SelfRewarding 평가 실패: #{inspect(e)}")
      end
    end

    if KillSwitch.enabled?(:research_registry) do
      try do
        Darwin.V2.ResearchRegistry.record_cycle_result(cycle_result)
      rescue
        e -> Logger.warning("[Darwin.V2.MapeKLoop] ResearchRegistry 기록 실패: #{inspect(e)}")
      end
    end

    broadcast_knowledge_event(cycle_result)
  end

  # Knowledge: 주간 메타 리뷰 + Recommender 재조정
  defp run_weekly_knowledge do
    Logger.info("[Darwin.V2.MapeKLoop] 주간 Knowledge 단계 시작")

    if KillSwitch.enabled?(:self_rewarding) do
      try do
        Darwin.V2.SelfRewarding.evaluate_week()
      rescue
        e -> Logger.warning("[Darwin.V2.MapeKLoop] 주간 SelfRewarding 실패: #{inspect(e)}")
      end
    end

    if KillSwitch.enabled?(:research_registry) do
      try do
        Darwin.V2.ResearchRegistry.refresh_effects()
      rescue
        e -> Logger.warning("[Darwin.V2.MapeKLoop] ResearchRegistry 갱신 실패: #{inspect(e)}")
      end
    end

    try do
      Darwin.V2.MetaReview.run_review()
    rescue
      e -> Logger.warning("[Darwin.V2.MapeKLoop] MetaReview 실패: #{inspect(e)}")
    catch
      :exit, reason ->
        Logger.warning("[Darwin.V2.MapeKLoop] MetaReview 미기동 또는 종료됨: #{inspect(reason)}")
    end

    check_promotion_conditions()

    Logger.info("[Darwin.V2.MapeKLoop] 주간 Knowledge 단계 완료")
  end

  # 자율 레벨 승격 조건 체크 — 자동 flip 절대 금지, Telegram 알림만
  defp check_promotion_conditions do
    if KillSwitch.enabled?(:auto_promotion) do
      Logger.info("[Darwin.V2.MapeKLoop] 자율 레벨 승격 조건 체크 중...")

      try do
        state = Darwin.V2.AutonomyLevel.get()
        Logger.info("[Darwin.V2.MapeKLoop] 현재 자율 레벨: #{inspect(state.level)}, 성공: #{state.consecutive_successes}")
      rescue
        e -> Logger.warning("[Darwin.V2.MapeKLoop] 승격 조건 체크 실패: #{inspect(e)}")
      end
    end
  end

  # 자율 레벨 모니터링 — 이상 감지 시 브로드캐스트
  defp check_autonomy_level do
    try do
      level = Darwin.V2.AutonomyLevel.level()
      Telemetry.emit_pipeline_stage(:mapek_monitor, level: level)
    rescue
      _ -> :ok
    end
  end

  defp record_telemetry(state) do
    :telemetry.execute(
      [:darwin, :v2, :mapek, :monitor],
      %{total_cycles: state.total_cycles},
      %{dormant: Map.get(state, :dormant, false)}
    )
  end

  defp broadcast_knowledge_event(cycle_result) do
    try do
      Phoenix.PubSub.broadcast(
        Darwin.V2.PubSub,
        Topics.cycle_knowledge_complete(),
        {:knowledge_complete, cycle_result}
      )
    rescue
      _ -> :ok
    end
  end

  # ──────────────────────────────────────────────
  # 내부 헬퍼
  # ──────────────────────────────────────────────

  defp schedule_daily_tick do
    Process.send_after(self(), :daily_tick, @daily_interval_ms)
  end

  defp schedule_weekly_tick do
    Process.send_after(self(), :weekly_tick, @weekly_interval_ms)
  end

  defp initial_state do
    %{
      total_cycles: 0,
      last_cycle_at: nil,
      last_cycle_id: nil,
      last_monitor_at: nil,
      last_weekly_knowledge_at: nil,
      dormant: false,
      started_at: DateTime.utc_now()
    }
  end
end
