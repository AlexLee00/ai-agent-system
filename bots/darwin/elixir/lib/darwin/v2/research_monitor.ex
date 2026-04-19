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
    with {:ok, cols} <- pipeline_audit_columns() do
      stage_col = stage_column(cols)
      id_col = discover_column(cols)
      score_expr = score_expression(cols)

      if is_nil(stage_col) do
        {:ok, %{discovered: 0, evaluated: 0, high_quality: 0}}
      else
        sql = """
        SELECT
          #{discover_expr(id_col)}::int AS discovered,
          COUNT(*) FILTER (WHERE #{stage_col} = 'paper_evaluated')::int AS evaluated,
          #{high_quality_expr(stage_col, score_expr)}::int AS high_quality
        FROM darwin_v2_pipeline_audit
        WHERE inserted_at >= NOW() - INTERVAL '24 hours'
        """

        case Jay.Core.Repo.query(sql, []) do
          {:ok, %{rows: [[discovered, evaluated, high_quality]]}} ->
            {:ok, %{
              discovered: discovered || 0,
              evaluated: evaluated || 0,
              high_quality: high_quality || 0
            }}

          error ->
            {:error, error}
        end
      end
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp fetch_7d_stats do
    with {:ok, cols} <- pipeline_audit_columns() do
      stage_col = stage_column(cols)
      score_expr = score_expression(cols)
      cost_expr = cost_expression(cols)

      if is_nil(stage_col) do
        {:ok, %{implemented: 0, verified: 0, applied: 0, avg_score: 0.0, avg_cost: 0.0}}
      else
        sql = """
        SELECT
          COUNT(*) FILTER (WHERE #{stage_col} = 'implementation_ready')::int AS implemented,
          COUNT(*) FILTER (WHERE #{stage_col} = 'verification_passed')::int AS verified,
          COUNT(*) FILTER (WHERE #{stage_col} = 'applied')::int AS applied,
          #{avg_score_expr(score_expr)}::numeric(4,1) AS avg_score,
          #{avg_cost_expr(cost_expr)}::float AS avg_cost
        FROM darwin_v2_pipeline_audit
        WHERE inserted_at >= NOW() - INTERVAL '7 days'
        """

        case Jay.Core.Repo.query(sql, []) do
          {:ok, %{rows: [[implemented, verified, applied, avg_score, avg_cost]]}} ->
            {:ok, %{
              implemented: implemented || 0,
              verified: verified || 0,
              applied: applied || 0,
              avg_score: avg_score || 0.0,
              avg_cost: avg_cost || 0.0
            }}

          error ->
            {:error, error}
        end
      end
    end
  rescue
    e -> {:error, Exception.message(e)}
  end

  defp pipeline_audit_columns do
    case Jay.Core.Repo.query("SELECT to_regclass('public.darwin_v2_pipeline_audit')", []) do
      {:ok, %{rows: [[nil]]}} ->
        {:ok, []}

      {:ok, %{rows: [[_rel]]}} ->
        case Jay.Core.Repo.query(
               """
               SELECT column_name
               FROM information_schema.columns
               WHERE table_schema = 'public'
                 AND table_name = 'darwin_v2_pipeline_audit'
               """,
               []
             ) do
          {:ok, %{rows: rows}} -> {:ok, Enum.map(rows, fn [name] -> to_string(name) end)}
          error -> error
        end

      error ->
        error
    end
  end

  defp stage_column(cols) when is_list(cols) do
    cond do
      "stage" in cols -> "stage"
      "pipeline_stage" in cols -> "pipeline_stage"
      true -> nil
    end
  end

  defp discover_column(cols) when is_list(cols) do
    cond do
      "paper_url" in cols -> "paper_url"
      "paper_id" in cols -> "paper_id"
      true -> nil
    end
  end

  defp score_expression(cols) when is_list(cols) do
    cond do
      "score" in cols ->
        "score"

      "result" in cols ->
        "NULLIF(result->>'score', '')::numeric"

      true ->
        nil
    end
  end

  defp cost_expression(cols) when is_list(cols) do
    cond do
      "cost_usd" in cols -> "cost_usd"
      true -> nil
    end
  end

  defp discover_expr(nil), do: "0"
  defp discover_expr(column), do: "COUNT(DISTINCT #{column})"

  defp high_quality_expr(_stage_col, nil), do: "0"
  defp high_quality_expr(stage_col, score_expr) do
    "COUNT(*) FILTER (WHERE #{stage_col} = 'paper_evaluated' AND #{score_expr} >= 6)"
  end

  defp avg_score_expr(nil), do: "0"
  defp avg_score_expr(score_expr), do: "COALESCE(AVG(#{score_expr}), 0)"

  defp avg_cost_expr(nil), do: "0.0"
  defp avg_cost_expr(cost_expr), do: "COALESCE(AVG(#{cost_expr}), 0.0)"

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
