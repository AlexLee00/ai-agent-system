defmodule Darwin.V2.ResearchMonitor do
  @moduledoc """
  다윈 V2 리서치 모니터 — 연구 파이프라인 헬스 + KPI 수집.

  TeamJay.Darwin.ResearchMonitor의 V2 포트. 확장된 메트릭 + V2 상태 추가.

  역할:
  - 연구 파이프라인 실시간 헬스 모니터링
  - Sigma 팀 어드바이저리용 KPI 수집
  - 10분 주기 DB 폴링
  - 크로스팀 가시성을 위한 JayBus 리포트

  KPI: papers_discovered_24h, papers_evaluated_24h, high_quality_24h,
       papers_implemented_7d, papers_verified_7d, papers_applied_7d,
       avg_score_7d, avg_implementation_cost_usd, autonomy_level,
       pipeline_health, daily_llm_cost_usd

  GenServer: 10분 폴 주기, ETS 캐시
  """

  use GenServer
  require Logger

  alias Darwin.V2.AutonomyLevel
  alias Jay.Core.HubClient

  @check_interval_ms  10 * 60 * 1000   # 10분
  @ets_table          :darwin_v2_monitor_cache

  defstruct [
    last_kpis:           %{},
    last_check_at:       nil,
    pipeline_health:     :healthy,
    consecutive_issues:  0
  ]

  # ──────────────────────────────────────────────
  # 공개 API
  # ──────────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "전체 KPI 맵 반환 (ETS 캐시)."
  @spec get_kpis() :: map()
  def get_kpis do
    case :ets.lookup(@ets_table, :kpis) do
      [{:kpis, kpis}] -> kpis
      [] ->
        GenServer.call(__MODULE__, :get_kpis)
    end
  rescue
    _ -> GenServer.call(__MODULE__, :get_kpis)
  end

  @doc "파이프라인 헬스 상태 반환."
  @spec get_health() :: :healthy | :degraded | :blocked
  def get_health do
    case :ets.lookup(@ets_table, :health) do
      [{:health, h}] -> h
      [] -> :healthy
    end
  rescue
    _ -> :healthy
  end

  @doc "Sigma 팀에 어드바이저리 전송."
  @spec report_to_sigma() :: :ok
  def report_to_sigma do
    GenServer.cast(__MODULE__, :report_to_sigma)
  end

  # ──────────────────────────────────────────────
  # GenServer 콜백
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_opts) do
    :ets.new(@ets_table, [:named_table, :public, read_concurrency: true])
    Process.send_after(self(), :poll, 60_000)  # 1분 후 첫 체크
    Logger.info("[다윈V2 모니터] 리서치 모니터 시작!")
    {:ok, %__MODULE__{}}
  end

  @impl GenServer
  def handle_info(:poll, state) do
    new_state = do_poll(state)
    Process.send_after(self(), :poll, @check_interval_ms)
    {:noreply, new_state}
  end

  def handle_info(_msg, state), do: {:noreply, state}

  @impl GenServer
  def handle_cast(:report_to_sigma, state) do
    Task.start(fn -> send_sigma_advisory(state.last_kpis, state.pipeline_health) end)
    {:noreply, state}
  end

  @impl GenServer
  def handle_call(:get_kpis, _from, state) do
    {:reply, state.last_kpis, state}
  end

  # ──────────────────────────────────────────────
  # 내부 — 폴링
  # ──────────────────────────────────────────────

  defp do_poll(state) do
    new_state = %{state | last_check_at: DateTime.utc_now()}

    case collect_kpis() do
      {:ok, kpis} ->
        health = assess_health(kpis, state.consecutive_issues)

        # ETS 캐시 업데이트
        :ets.insert(@ets_table, {:kpis, kpis})
        :ets.insert(@ets_table, {:health, health})

        # 헬스 상태 변경 시 알림
        if health != state.pipeline_health do
          Logger.info("[다윈V2 모니터] 파이프라인 헬스 변경: #{state.pipeline_health} → #{health}")
          broadcast_health_change(health, kpis)
        end

        # 주기적 Sigma 리포트 (6시간마다, 상태가 degraded 이상일 때)
        if health in [:degraded, :blocked] do
          Task.start(fn -> send_sigma_advisory(kpis, health) end)
        end

        new_issues = if health == :healthy, do: 0, else: state.consecutive_issues + 1
        %{new_state |
          last_kpis:          kpis,
          pipeline_health:    health,
          consecutive_issues: new_issues
        }

      {:error, reason} ->
        Logger.warning("[다윈V2 모니터] KPI 수집 실패: #{inspect(reason)}")
        new_state
    end
  end

  # ──────────────────────────────────────────────
  # 내부 — KPI 수집
  # ──────────────────────────────────────────────

  defp collect_kpis do
    with {:ok, stats_24h} <- fetch_24h_stats(),
         {:ok, stats_7d}  <- fetch_7d_stats(),
         {:ok, llm_cost}  <- fetch_daily_llm_cost() do
      autonomy = AutonomyLevel.get()

      kpis = %{
        papers_discovered_24h:       stats_24h.discovered,
        papers_evaluated_24h:        stats_24h.evaluated,
        high_quality_24h:            stats_24h.high_quality,
        papers_implemented_7d:       stats_7d.implemented,
        papers_verified_7d:          stats_7d.verified,
        papers_applied_7d:           stats_7d.applied,
        avg_score_7d:                stats_7d.avg_score,
        avg_implementation_cost_usd: stats_7d.avg_cost,
        autonomy_level:              autonomy.level,
        pipeline_health:             :unknown,
        daily_llm_cost_usd:          llm_cost,
        collected_at:                DateTime.utc_now()
      }

      {:ok, kpis}
    end
  end

  defp fetch_24h_stats do
    sql = """
    SELECT
      COUNT(DISTINCT paper_url)::int                                       AS discovered,
      COUNT(*) FILTER (WHERE stage = 'paper_evaluated')::int               AS evaluated,
      COUNT(*) FILTER (WHERE stage = 'paper_evaluated' AND score >= 6)::int AS high_quality
    FROM darwin_v2_pipeline_audit
    WHERE inserted_at >= NOW() - INTERVAL '24 hours'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[discovered, evaluated, high_quality]]}} ->
        {:ok, %{
          discovered:   discovered   || 0,
          evaluated:    evaluated    || 0,
          high_quality: high_quality || 0
        }}

      error ->
        {:error, error}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp fetch_7d_stats do
    sql = """
    SELECT
      COUNT(*) FILTER (WHERE stage = 'implementation_ready')::int AS implemented,
      COUNT(*) FILTER (WHERE stage = 'verification_passed')::int  AS verified,
      COUNT(*) FILTER (WHERE stage = 'applied')::int              AS applied,
      COALESCE(AVG(score) FILTER (WHERE score IS NOT NULL), 0)::numeric(4,1) AS avg_score,
      0.0::float                                                  AS avg_cost
    FROM darwin_v2_pipeline_audit
    WHERE inserted_at >= NOW() - INTERVAL '7 days'
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[implemented, verified, applied, avg_score, avg_cost]]}} ->
        {:ok, %{
          implemented: implemented || 0,
          verified:    verified    || 0,
          applied:     applied     || 0,
          avg_score:   avg_score   || 0.0,
          avg_cost:    avg_cost    || 0.0
        }}

      error ->
        {:error, error}
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp fetch_daily_llm_cost do
    case Darwin.V2.LLM.CostTracker.check_budget() do
      {:ok, budget_ratio} ->
        daily_limit =
          System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0")
          |> String.to_float()

        spent = Float.round((1.0 - budget_ratio) * daily_limit, 4)
        {:ok, spent}

      {:error, :budget_exceeded} ->
        daily_limit =
          System.get_env("DARWIN_LLM_DAILY_BUDGET_USD", "10.0")
          |> String.to_float()

        {:ok, daily_limit}
    end
  rescue
    _ -> {:ok, 0.0}
  end

  # ──────────────────────────────────────────────
  # 내부 — 헬스 평가
  # ──────────────────────────────────────────────

  defp assess_health(kpis, consecutive_issues) do
    cond do
      # 완전 블록: 24시간 논문 없음 + 연속 이슈 3회 이상
      kpis.papers_discovered_24h == 0 and consecutive_issues >= 3 ->
        :blocked

      # 저하: 평가율 낮음, 또는 연속 이슈 존재
      kpis.papers_evaluated_24h == 0 and kpis.papers_discovered_24h > 0 ->
        :degraded

      consecutive_issues >= 2 ->
        :degraded

      # 정상
      true ->
        :healthy
    end
  end

  defp broadcast_health_change(:healthy, _kpis) do
    Task.start(fn ->
      HubClient.post_alarm(
        "다윈팀 파이프라인 정상 복구!",
        "darwin-monitor", "darwin"
      )
    end)
  end

  defp broadcast_health_change(:degraded, kpis) do
    Task.start(fn ->
      HubClient.post_alarm(
        "다윈팀 파이프라인 저하!\n24h 발견: #{kpis.papers_discovered_24h}건 / 평가: #{kpis.papers_evaluated_24h}건\nLLM 비용: $#{kpis.daily_llm_cost_usd}",
        "darwin-monitor", "darwin"
      )
    end)
  end

  defp broadcast_health_change(:blocked, kpis) do
    Task.start(fn ->
      HubClient.post_alarm(
        "다윈팀 파이프라인 블록! 즉시 확인 필요\n24h 발견: #{kpis.papers_discovered_24h}건\n자율 레벨: L#{kpis.autonomy_level}",
        "darwin-monitor-critical", "darwin"
      )
    end)
  end

  defp broadcast_health_change(_health, _kpis), do: :ok

  defp send_sigma_advisory(kpis, health) do
    # JayBus를 통해 Sigma 팀에 어드바이저리 브로드캐스트
    payload = %{
      from:            "darwin.monitor",
      health:          health,
      kpis:            kpis,
      advisory_type:   "research_status",
      timestamp:       DateTime.utc_now()
    }

    Registry.dispatch(Jay.Core.JayBus, "sigma.advisory", fn entries ->
      for {pid, _} <- entries do
        send(pid, {:jay_event, "sigma.advisory", payload})
      end
    end)

    Logger.info("[다윈V2 모니터] Sigma 어드바이저리 전송 완료 (health=#{health})")
  rescue
    e -> Logger.warning("[다윈V2 모니터] Sigma 어드바이저리 실패: #{Exception.message(e)}")
  end

end
