defmodule TeamJay.Jay.GrowthCycle do
  @moduledoc """
  9팀 일일 성장 환류 사이클 GenServer.
  매일 06:30 KST 자동 실행.

  SENSE → ANALYZE → DECIDE → ACT → MEASURE → LEARN
  """

  use GenServer
  require Logger
  alias TeamJay.Jay.{Topics, TeamConnector, DailyBriefing, DecisionEngine}

  @cycle_timeout_ms 30 * 60 * 1_000  # 30분 타임아웃

  # ────────────────────────────────────────────────────────────────
  # GenServer 생명주기
  # ────────────────────────────────────────────────────────────────

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  @impl true
  def init(state) do
    Logger.info("[GrowthCycle] 시작 — 매일 06:30 KST 사이클")
    {:ok, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 공개 API
  # ────────────────────────────────────────────────────────────────

  def run_cycle do
    GenServer.cast(__MODULE__, :run_cycle)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  # ────────────────────────────────────────────────────────────────
  # 핸들러
  # ────────────────────────────────────────────────────────────────

  @impl true
  def handle_cast(:run_cycle, state) do
    task = Task.async(fn -> execute_cycle() end)
    case Task.yield(task, @cycle_timeout_ms) || Task.shutdown(task, :brutal_kill) do
      {:ok, result} ->
        Logger.info("[GrowthCycle] 완료: #{inspect(result)}")
        {:noreply, Map.put(state, :last_result, result)}
      nil ->
        Logger.error("[GrowthCycle] 타임아웃 (30분)")
        {:noreply, Map.put(state, :last_error, :timeout)}
    end
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply, state, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 사이클 실행 (SENSE ~ LEARN)
  # ────────────────────────────────────────────────────────────────

  defp execute_cycle do
    date = Date.utc_today() |> Date.to_string()
    Logger.info("[GrowthCycle] ▶ #{date} 사이클 시작")
    Topics.broadcast_growth_cycle_started(date)

    # ── SENSE: 9팀 데이터 수집 ─────────────────────────────────
    team_data = sense(date)

    # ── ANALYZE: 성과 지표 분석 ───────────────────────────────
    analysis = analyze(team_data, date)

    # ── DECIDE: 팀 간 연동 판단 ──────────────────────────────
    decisions = decide(team_data, analysis)

    # ── ACT: PubSub 지시 + 팀 간 파이프라인 트리거 ──────────
    act(decisions, team_data)

    # ── MEASURE: KPI 저장 ────────────────────────────────────
    measure(date, team_data, analysis, decisions)

    # ── LEARN: 브리핑 생성 + 텔레그램 발송 ──────────────────
    briefing = learn(date, team_data, analysis)

    Topics.broadcast(:growth_cycle_completed, %{date: date, briefing: briefing})
    %{date: date, teams_collected: map_size(team_data), briefing_len: String.length(briefing)}
  end

  # ────────────────────────────────────────────────────────────────
  # 단계별 구현
  # ────────────────────────────────────────────────────────────────

  defp sense(_date) do
    Logger.info("[GrowthCycle] SENSE: 9팀 데이터 수집 중...")
    team_data = TeamConnector.collect_all()
    Enum.each(team_data, fn {team, data} ->
      Topics.broadcast_team_data_collected(team, data)
      Logger.debug("[GrowthCycle] SENSE #{team}: #{inspect(data, limit: 3)}")
    end)
    Logger.info("[GrowthCycle] SENSE 완료: #{map_size(team_data)}팀")
    team_data
  end

  defp analyze(team_data, _date) do
    ska_health = case team_data[:ska] do
      %{failed: f} when f >= 3 -> :degraded
      %{pending: p} when p >= 5 -> :backlogged
      nil -> :unknown
      _ -> :healthy
    end

    luna_regime = get_in(team_data, [:luna, :market_regime]) || "unknown"

    system_ok = case team_data[:claude] do
      %{unhealthy_count: 0} -> true
      nil -> true
      _ -> false
    end

    blog_output = get_in(team_data, [:blog, :published_7d]) || 0

    %{
      ska_health: ska_health,
      luna_regime: luna_regime,
      system_ok: system_ok,
      blog_output: blog_output,
      summary: build_analysis_summary(ska_health, luna_regime, system_ok, blog_output)
    }
  end

  defp build_analysis_summary(ska_health, _luna_regime, system_ok, blog_output) do
    issues = []
    issues = if ska_health != :healthy, do: ["스카 #{ska_health}" | issues], else: issues
    issues = if not system_ok, do: ["시스템 이상" | issues], else: issues
    issues = if blog_output == 0, do: ["블로 발행 0건" | issues], else: issues

    case issues do
      [] -> "정상 운영"
      _ -> Enum.join(issues, " | ")
    end
  end

  defp decide(team_data, analysis) do
    decisions = []

    # 스카 매출 하락 → 블로팀 프로모션
    decisions = case team_data[:ska] do
      %{revenue_7d: rev} when is_integer(rev) and rev < 300_000 ->
        drop_pct = 20  # 임시 — TODO: 전주 대비 계산
        decision = DecisionEngine.evaluate(:ska_revenue_drop, %{drop_pct: drop_pct, revenue: rev})
        [{:ska_to_blog, decision} | decisions]
      _ -> decisions
    end

    # 시스템 위험 → 워크로드 축소
    decisions = case team_data[:claude] do
      %{unhealthy_count: n, unhealthy_services: services} when n >= 3 ->
        if stale_core_system_risk?(services) do
          decisions
        else
          decision = DecisionEngine.evaluate(:system_risk, %{risk_level: min(n * 2, 10), count: n})
          [{:claude_to_all, decision} | decisions]
        end

      %{unhealthy_count: n} when n >= 3 ->
        decision = DecisionEngine.evaluate(:system_risk, %{risk_level: min(n * 2, 10), count: n})
        [{:claude_to_all, decision} | decisions]

      _ -> decisions
    end

    # 루나 시장 급변 → 블로 콘텐츠
    decisions = case analysis[:luna_regime] do
      r when r in ["volatile", "crisis"] ->
        decision = DecisionEngine.evaluate(:luna_market_shock, %{regime: r})
        [{:luna_to_blog, decision} | decisions]
      _ -> decisions
    end

    decisions
  end

  defp act(decisions, team_data) do
    Enum.each(decisions, fn {pipeline, decision} ->
      case decision do
        :allow ->
          Logger.info("[GrowthCycle] ACT: #{pipeline} ALLOW → 자동 실행")
          trigger_pipeline(pipeline, team_data)

        :escalate ->
          Logger.info("[GrowthCycle] ACT: #{pipeline} ESCALATE → 마스터 알림")
          Jay.Core.HubClient.post_alarm(
            "⚡ [제이] #{pipeline} 연동 판단: ESCALATE\n마스터 확인 필요",
            "jay", "growth_cycle"
          )

        :block ->
          Logger.info("[GrowthCycle] ACT: #{pipeline} BLOCK → 무시")

        :modify ->
          Logger.info("[GrowthCycle] ACT: #{pipeline} MODIFY → 컨텍스트 보강 후 실행")
          trigger_pipeline(pipeline, team_data)
      end
    end)
  end

  defp trigger_pipeline(:ska_to_blog, team_data) do
    rev = get_in(team_data, [:ska, :revenue_7d]) || 0
    Topics.broadcast_ska_revenue_drop(20, %{revenue_7d: rev})
  end

  defp trigger_pipeline(:luna_to_blog, team_data) do
    regime = get_in(team_data, [:luna, :market_regime]) || "unknown"
    Topics.broadcast_luna_market_shock(regime, %{})
  end

  defp trigger_pipeline(:claude_to_all, team_data) do
    n = get_in(team_data, [:claude, :unhealthy_count]) || 0
    services = get_in(team_data, [:claude, :unhealthy_services]) || []
    Topics.broadcast_system_risk(n * 2, services)
  end

  defp trigger_pipeline(_, _), do: :ok

  defp stale_core_system_risk?(services) when is_list(services) do
    normalized =
      services
      |> Enum.map(fn
        {service, _code} -> service
        service -> service
      end)
      |> Enum.map(&(&1 |> to_string() |> String.downcase()))
      |> Enum.reject(&(&1 == ""))

    normalized != [] and
      Enum.all?(normalized, &(&1 in ["api", "db", "database", "postgres", "postgresql", "pg_pool", "hub"])) and
      current_core_health_ok?()
  end

  defp stale_core_system_risk?(_), do: false

  defp current_core_health_ok? do
    case Jay.Core.HubClient.health() do
      {:ok, %{"resources" => resources}} when is_map(resources) ->
        resource_ok?(resources, "core_services") and
          resource_ok?(resources, "postgresql") and
          resource_ok?(resources, "pg_pool")

      _ ->
        false
    end
  end

  defp resource_ok?(resources, key) do
    case Map.get(resources, key) do
      %{"status" => "ok"} -> true
      _ -> false
    end
  end

  defp measure(date, team_data, analysis, decisions) do
    Jay.Core.EventLake.record(%{
      source: "jay.growth_cycle",
      event_type: "growth_cycle.measured",
      severity: "info",
      payload: %{
        date: date,
        teams: Map.keys(team_data),
        analysis: analysis,
        decision_count: length(decisions)
      }
    })
  rescue
    _ -> :ok
  end

  defp learn(date, team_data, _analysis) do
    Logger.info("[GrowthCycle] LEARN: 브리핑 생성 중...")
    briefing = DailyBriefing.generate(team_data, date)
    Topics.broadcast_briefing_ready(briefing)

    # 자율화 단계에 따라 발송 여부 결정
    if TeamJay.Jay.AutonomyController.should_send_daily_briefing?() do
      Jay.Core.HubClient.post_alarm(briefing, "jay", "growth_cycle")
      Logger.info("[GrowthCycle] LEARN: 브리핑 발송 완료 (#{String.length(briefing)}자)")
    else
      Logger.info("[GrowthCycle] LEARN: Phase 3 자율 — 브리핑 로그만 (발송 생략)")
    end

    # 이상 없는 날 기록 (자율화 단계 전환용)
    TeamJay.Jay.AutonomyController.record_clean_day()

    briefing
  end
end
