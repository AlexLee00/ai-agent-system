defmodule TeamJay.Ska.MapeKLoop do
  @moduledoc """
  스카팀 MAPE-K 완전자율 루프.

  Monitor  : 스킬 실행 로그 + 에이전트 상태 관찰 (매시간)
  Analyze  : 스킬 성과 하락 / 에이전트 실패 패턴 분석
  Plan     : 복구 전략 + 스킬 버전 조정 계획
  Execute  : Telegram 경고 발행 (자동 스킬 교체는 마스터 승인 필요)
  Knowledge: FailureLibrary + SkillPerformanceLog 축적 (매일)

  Kill Switch: SKA_MAPEK_ENABLED=true (기본 false)
  """
  use GenServer
  require Logger

  alias TeamJay.Ska.{SkillPerformanceTracker, FailureLibrary}

  @hourly_ms 60 * 60 * 1_000
  @daily_ms 24 * 60 * 60 * 1_000

  # ─── 클라이언트 API ──────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "현재 MAPE-K 상태 조회"
  def status do
    GenServer.call(__MODULE__, :status)
  end

  @doc "수동 즉시 분석 트리거 (디버그용)"
  def trigger_analysis do
    GenServer.cast(__MODULE__, :trigger_analysis)
  end

  # ─── GenServer 콜백 ──────────────────────────────────────

  @impl true
  def init(_opts) do
    if enabled?() do
      Logger.info("[ska/mapek] MAPE-K 루프 기동 — 매시간 Monitor + 매일 Knowledge")
      schedule_hourly()
      schedule_daily()
      {:ok, initial_state()}
    else
      Logger.info("[ska/mapek] Kill Switch OFF — 대기 (SKA_MAPEK_ENABLED=true 로 활성화)")
      {:ok, %{dormant: true, enabled: false}}
    end
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  @impl true
  def handle_cast(:trigger_analysis, state) do
    Task.start(fn -> run_monitor_analyze() end)
    {:noreply, state}
  end

  # 매시간: Monitor + Analyze
  @impl true
  def handle_info(:hourly_tick, %{dormant: true} = state) do
    {:noreply, state}
  end

  def handle_info(:hourly_tick, state) do
    if enabled?() do
      Task.start(fn -> run_monitor_analyze() end)
    end

    schedule_hourly()
    {:noreply, %{state | hourly_cycles: state.hourly_cycles + 1, last_hourly_at: utc_now()}}
  end

  # 매일: Plan + Execute + Knowledge
  @impl true
  def handle_info(:daily_tick, %{dormant: true} = state) do
    {:noreply, state}
  end

  def handle_info(:daily_tick, state) do
    if enabled?() do
      Task.start(fn -> run_daily_mapek_cycle() end)
    end

    schedule_daily()
    {:noreply, %{state | daily_cycles: state.daily_cycles + 1, last_daily_at: utc_now()}}
  end

  # ─── Monitor + Analyze ───────────────────────────────────

  defp run_monitor_analyze do
    # Monitor: 성과 하락 스킬 감지
    case SkillPerformanceTracker.degrading_skills(days: 7, threshold: 0.8) do
      {:ok, []} ->
        :ok

      {:ok, degrading} ->
        names = Enum.map(degrading, & &1["skill_name"])
        Logger.warning("[ska/mapek] 성과 하락 스킬 #{length(degrading)}개: #{inspect(names)}")

        # Execute: Telegram 경고 (자동 교체 없이 마스터 알림만)
        TeamJay.Ska.SkillRegistry.execute(:notify_failure, %{
          agent: :mapek,
          severity: :warning,
          message: "⚠️ MAPE-K: 성과 하락 스킬 #{length(degrading)}개\n" <>
                   Enum.map_join(degrading, "\n", fn s ->
                     "  • #{s["skill_name"]}: #{s["recent_rate"]}% → baseline #{s["baseline_rate"]}%"
                   end)
        })

      {:error, _reason} ->
        :ok
    end
  end

  # ─── Daily MAPE-K Cycle ──────────────────────────────────

  defp run_daily_mapek_cycle do
    Logger.info("[ska/mapek] 일일 MAPE-K 사이클 시작")

    # 1. Monitor: 24h 스킬 성과 수집
    {:ok, skill_stats} = SkillPerformanceTracker.summary_24h()

    # 2. Analyze: 패턴 분석
    analysis = analyze_patterns(skill_stats)

    # 3. Plan: 조정 계획 (현재는 로깅 + 알림만)
    plan = plan_skill_adjustments(analysis)

    # 4. Execute: 승인 필요 사항은 Telegram 전송
    execute_plan(plan)

    # 5. Knowledge: FailureLibrary 축적
    FailureLibrary.ingest_mapek_cycle(analysis, plan)

    Logger.info("[ska/mapek] 일일 사이클 완료 — 스킬 #{length(skill_stats)}개 분석")
  end

  defp analyze_patterns(skill_stats) do
    total = length(skill_stats)
    low_success = Enum.filter(skill_stats, fn s ->
      rate = s["success_rate_pct"] || 100.0
      rate < 80.0
    end)
    high_latency = Enum.filter(skill_stats, fn s ->
      avg_ms = s["avg_ms"] || 0.0
      avg_ms > 5_000.0
    end)

    %{
      total_skills_active: total,
      low_success_skills: low_success,
      high_latency_skills: high_latency,
      analyzed_at: utc_now()
    }
  end

  defp plan_skill_adjustments(analysis) do
    actions =
      Enum.map(analysis.low_success_skills, fn s ->
        %{action: :alert_low_success, skill: s["skill_name"], rate: s["success_rate_pct"]}
      end) ++
      Enum.map(analysis.high_latency_skills, fn s ->
        %{action: :alert_high_latency, skill: s["skill_name"], avg_ms: s["avg_ms"]}
      end)

    %{actions: actions, requires_approval: length(actions) > 0}
  end

  defp execute_plan(%{requires_approval: false}), do: :ok

  defp execute_plan(%{actions: actions}) do
    summary = Enum.map_join(actions, "\n", fn
      %{action: :alert_low_success, skill: name, rate: rate} ->
        "  • #{name}: 성공률 #{rate}% (< 80%)"
      %{action: :alert_high_latency, skill: name, avg_ms: ms} ->
        "  • #{name}: 평균 #{ms}ms (> 5s)"
    end)

    TeamJay.Ska.SkillRegistry.execute(:notify_failure, %{
      agent: :mapek,
      severity: :warning,
      message: "📊 MAPE-K 일일 리포트:\n#{summary}"
    })
  end

  # ─── 스케줄 ──────────────────────────────────────────────

  defp schedule_hourly, do: Process.send_after(self(), :hourly_tick, @hourly_ms)
  defp schedule_daily, do: Process.send_after(self(), :daily_tick, @daily_ms)

  defp initial_state do
    %{
      enabled: true,
      hourly_cycles: 0,
      daily_cycles: 0,
      last_hourly_at: nil,
      last_daily_at: nil,
      started_at: utc_now()
    }
  end

  defp enabled?, do: System.get_env("SKA_MAPEK_ENABLED", "false") == "true"
  defp utc_now, do: DateTime.utc_now() |> DateTime.to_string()
end
