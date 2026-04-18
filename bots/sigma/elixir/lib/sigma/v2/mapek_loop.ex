defmodule Sigma.V2.MapeKLoop do
  @moduledoc """
  시그마팀 MAPE-K 완전자율 루프 (arXiv 2510.27051 영감).

  시그마 고유 매핑:
  - Monitor   → 팀 메트릭 수집 + launchd 건강 + Pod 부하 체크
  - Analyze   → Commander.decide_formation + Pod 분석 실행
  - Plan      → Directive 편성 (Principle Gate 통과 후 큐잉)
  - Execute   → Directive.Executor + Archivist 기록
  - Knowledge → Reflexion(실패분) + ESPL(주간) + SelfRewarding + RAG 업데이트

  Kill Switch:
  - SIGMA_V2_ENABLED=true 필수
  - SIGMA_MAPEK_ENABLED=true (기본 false, 명시적 활성화 필요)

  참조: Darwin.V2.MapeKLoop 패턴
  """
  use GenServer
  require Logger

  @daily_interval_ms 24 * 60 * 60 * 1_000
  @weekly_interval_ms 6 * 24 * 60 * 60 * 1_000

  # ─────────────────────────────────────────────────
  # Public API
  # ─────────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "현재 MAPE-K 루프 상태 조회."
  def status do
    GenServer.call(__MODULE__, :status)
  end

  @doc "사이클 완료 이벤트 수신 → Knowledge 단계 비동기 트리거."
  def on_cycle_complete(cycle_result) do
    GenServer.cast(__MODULE__, {:cycle_complete, cycle_result})
  end

  @doc "수동으로 주간 Knowledge 단계 트리거."
  def trigger_weekly_knowledge do
    GenServer.cast(__MODULE__, :weekly_knowledge)
  end

  @doc "수동으로 전체 MAPE-K 사이클 1회 즉시 실행 (디버그/테스트용)."
  def run_cycle_now do
    GenServer.cast(__MODULE__, :run_cycle_now)
  end

  # ─────────────────────────────────────────────────
  # GenServer callbacks
  # ─────────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    if mapek_enabled?() do
      schedule_daily_tick()
      schedule_weekly_tick()
      Logger.info("[Sigma.V2.MapeKLoop] MAPE-K 루프 기동 — 일일/주간 틱 예약 완료")
      {:ok, initial_state()}
    else
      Logger.info("[Sigma.V2.MapeKLoop] Kill switch OFF — 대기 모드 (SIGMA_MAPEK_ENABLED=false)")
      {:ok, Map.put(initial_state(), :dormant, true)}
    end
  end

  @impl GenServer
  def handle_info(:daily_tick, state) do
    new_state =
      if mapek_enabled?() do
        run_daily_cycle(state)
      else
        state
      end

    schedule_daily_tick()
    {:noreply, new_state}
  end

  @impl GenServer
  def handle_info(:weekly_tick, state) do
    Task.start(fn -> run_weekly_knowledge() end)
    schedule_weekly_tick()
    {:noreply, %{state | last_weekly_knowledge_at: DateTime.utc_now()}}
  end

  @impl GenServer
  def handle_cast({:cycle_complete, cycle_result}, state) do
    if mapek_enabled?() do
      Task.start(fn -> handle_knowledge_phase(cycle_result) end)
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
  def handle_cast(:run_cycle_now, state) do
    Task.start(fn -> run_full_cycle() end)
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  # ─────────────────────────────────────────────────
  # MAPE-K 단계별 실행
  # ─────────────────────────────────────────────────

  defp run_daily_cycle(state) do
    Logger.debug("[Sigma.V2.MapeKLoop] 일일 MAPE-K 사이클 예약")
    Task.start(fn -> run_full_cycle() end)
    %{state | last_monitor_at: DateTime.utc_now()}
  end

  defp run_full_cycle do
    cycle_id = Ecto.UUID.generate()
    Logger.info("[Sigma.V2.MapeKLoop] MAPE-K 전체 사이클 시작 cycle_id=#{cycle_id}")

    try do
      # Monitor — 팀 메트릭 + launchd 건강
      events = Sigma.V2.Commander.collect_yesterday_events()
      emit_telemetry(:monitor, %{event_count: map_size(events)})
      Logger.debug("[Sigma.V2.MapeKLoop] Monitor 완료")

      # Analyze + Plan — 편성 결정
      {:ok, formation} = Sigma.V2.Commander.decide_formation(Date.utc_today(), [], [], events)
      {:ok, analysis} = Sigma.V2.Commander.analyze_formation(formation)
      emit_telemetry(:analyze, %{feedback_count: length(analysis.feedbacks)})
      Logger.debug("[Sigma.V2.MapeKLoop] Analyze+Plan 완료: #{length(analysis.feedbacks)} feedbacks")

      # Execute — Directive 실행
      results =
        Enum.map(analysis.feedbacks, fn feedback ->
          directive = build_directive(feedback, cycle_id)

          case Sigma.V2.Commander.apply_directive(directive) do
            {:ok, result}       -> %{feedback: feedback, result: result, status: :ok}
            {:blocked, reasons} -> %{feedback: feedback, result: reasons, status: :blocked}
            {:error, reason}    -> %{feedback: feedback, result: reason, status: :error}
          end
        end)

      success_count = Enum.count(results, &(&1.status == :ok))
      error_count = Enum.count(results, &(&1.status == :error))
      emit_telemetry(:execute, %{success: success_count, error: error_count})

      # DirectiveTracker 기록
      record_directive_results(results, cycle_id)

      # Knowledge 비동기 트리거
      cycle_result = %{
        cycle_id: cycle_id,
        date: Date.to_iso8601(Date.utc_today()),
        formation: formation,
        feedbacks: analysis.feedbacks,
        results: results,
        success_count: success_count,
        error_count: error_count
      }

      handle_knowledge_phase(cycle_result)
      broadcast_cycle_complete(cycle_result)
      Logger.info("[Sigma.V2.MapeKLoop] MAPE-K 전체 사이클 완료 — 성공 #{success_count}, 실패 #{error_count}")
    rescue
      e ->
        Logger.error("[Sigma.V2.MapeKLoop] 사이클 실패: #{inspect(e)}")

        try do
          Sigma.V2.TelegramReporter.on_cycle_failure(%{cycle_id: cycle_id}, e)
        rescue
          _ -> :ok
        end
    end
  end

  # Knowledge — 사이클 후 SelfRewarding + Reflexion(실패분)
  defp handle_knowledge_phase(cycle_result) do
    cycle_id = Map.get(cycle_result, :cycle_id, "unknown")
    Logger.debug("[Sigma.V2.MapeKLoop] Knowledge 단계 — cycle_id=#{cycle_id}")

    if self_rewarding_enabled?() do
      try do
        Sigma.V2.SelfRewarding.evaluate_cycle(cycle_result)
      rescue
        e -> Logger.warning("[Sigma.V2.MapeKLoop] SelfRewarding 평가 실패: #{inspect(e)}")
      end
    end

    # 실패 Directive에만 Reflexion 적용
    results = Map.get(cycle_result, :results, [])

    results
    |> Enum.filter(&(&1.status == :error))
    |> Enum.each(fn %{feedback: feedback, result: reason} ->
      try do
        directive = build_directive(feedback, cycle_id)
        outcome = %{effectiveness: 0.0, metric_delta: %{error: inspect(reason)}}
        Sigma.V2.Reflexion.reflect(directive, outcome)
      rescue
        e -> Logger.warning("[Sigma.V2.MapeKLoop] Reflexion 실패: #{inspect(e)}")
      end
    end)

    broadcast_knowledge_event(cycle_result)
  end

  # Knowledge 주간 — ESPL + MetaReview + SelfRewarding 주간 + DirectiveTracker
  defp run_weekly_knowledge do
    Logger.info("[Sigma.V2.MapeKLoop] 주간 Knowledge 단계 시작")

    if gepa_enabled?() do
      try do
        Sigma.V2.ESPL.evolve_weekly()
      rescue
        e -> Logger.warning("[Sigma.V2.MapeKLoop] ESPL 진화 실패: #{inspect(e)}")
      end
    end

    if self_rewarding_enabled?() do
      try do
        Sigma.V2.SelfRewarding.evaluate_week()
      rescue
        e -> Logger.warning("[Sigma.V2.MapeKLoop] 주간 SelfRewarding 실패: #{inspect(e)}")
      end
    end

    try do
      Sigma.V2.MetaReview.weekly()
    rescue
      e -> Logger.warning("[Sigma.V2.MapeKLoop] MetaReview 실패: #{inspect(e)}")
    end

    try do
      Sigma.V2.DirectiveTracker.check_fulfillment_weekly()
    rescue
      e -> Logger.warning("[Sigma.V2.MapeKLoop] DirectiveTracker 주간 점검 실패: #{inspect(e)}")
    end

    try do
      Sigma.V2.Pod.Performance.evaluate_weekly()
    rescue
      e -> Logger.warning("[Sigma.V2.MapeKLoop] Pod.Performance 주간 평가 실패: #{inspect(e)}")
    end

    Logger.info("[Sigma.V2.MapeKLoop] 주간 Knowledge 단계 완료")
  end

  # ─────────────────────────────────────────────────
  # 내부 헬퍼
  # ─────────────────────────────────────────────────

  defp build_directive(feedback, cycle_id) do
    %{
      team: feedback[:target_team] || "unknown",
      analyst: feedback[:analyst_used] || "commander",
      action: %{
        feedback_type: feedback[:feedback_type] || "general_review",
        content: feedback[:content] || ""
      },
      tier: 1,
      rollback_spec: %{
        directive_id: "#{cycle_id}_#{feedback[:target_team] || "unknown"}"
      }
    }
  end

  defp record_directive_results(results, cycle_id) do
    try do
      Sigma.V2.DirectiveTracker.record_cycle(cycle_id, results)
    rescue
      _ -> :ok
    end
  end

  defp emit_telemetry(stage, measurements) do
    :telemetry.execute(
      [:sigma, :v2, :mapek, stage],
      measurements,
      %{}
    )
  rescue
    _ -> :ok
  end

  defp broadcast_cycle_complete(cycle_result) do
    try do
      Phoenix.PubSub.broadcast(
        Sigma.V2.PubSub,
        "sigma:mapek:cycle_complete",
        {:cycle_complete, cycle_result}
      )
    rescue
      _ -> :ok
    end
  end

  defp broadcast_knowledge_event(cycle_result) do
    try do
      Phoenix.PubSub.broadcast(
        Sigma.V2.PubSub,
        "sigma:mapek:knowledge_complete",
        {:knowledge_complete, cycle_result}
      )
    rescue
      _ -> :ok
    end
  end

  defp schedule_daily_tick do
    Process.send_after(self(), :daily_tick, @daily_interval_ms)
  end

  defp schedule_weekly_tick do
    Process.send_after(self(), :weekly_tick, @weekly_interval_ms)
  end

  defp mapek_enabled? do
    System.get_env("SIGMA_V2_ENABLED") == "true" and
      System.get_env("SIGMA_MAPEK_ENABLED") == "true"
  end

  defp self_rewarding_enabled? do
    System.get_env("SIGMA_SELF_REWARDING_ENABLED") == "true"
  end

  defp gepa_enabled? do
    System.get_env("SIGMA_GEPA_ENABLED") == "true"
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
