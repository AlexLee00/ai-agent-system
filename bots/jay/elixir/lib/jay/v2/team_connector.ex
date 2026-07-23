defmodule Jay.V2.TeamConnector do
  @moduledoc """
  Hub API를 통해 현역 팀 데이터를 수집하는 커넥터.
  growth_cycle.ex가 SENSE 단계에서 호출.
  """

  require Logger

  @active_teams [:sigma, :darwin, :luna, :blog, :ska, :claude]
  @metric_domains @active_teams ++ [:platform]

  def active_teams, do: @active_teams
  def all_teams, do: @metric_domains

  @doc """
  팀의 어제 KPI 데이터 수집.
  실패 시 nil 반환 (throw 금지).
  """
  def collect(team) when team in @metric_domains do
    try do
      do_collect(team)
    rescue
      e ->
        Logger.warning("[TeamConnector] #{team} 수집 실패: #{Exception.message(e)}")
        nil
    catch
      :exit, reason ->
        Logger.warning("[TeamConnector] #{team} 수집 프로세스 없음/종료: #{inspect(reason)}")
        nil
    end
  end

  def collect(team) do
    Logger.warning("[TeamConnector] 알 수 없는 팀: #{team}")
    nil
  end

  @doc "현역 팀과 플랫폼 지표를 병렬 수집. 실패 도메인은 nil로 포함."
  def collect_all do
    @metric_domains
    |> Task.async_stream(&{&1, collect(&1)}, timeout: 30_000, on_timeout: :kill_task)
    |> Enum.reduce(%{}, fn
      {:ok, {team, data}}, acc -> Map.put(acc, team, data)
      {:exit, :timeout}, acc -> acc
    end)
  end

  @doc "수집 시도/성공/실패 도메인을 일관된 형태로 요약한다."
  def collection_summary(team_data) when is_map(team_data) do
    failed =
      team_data
      |> Enum.filter(fn {_team, data} -> is_nil(data) end)
      |> Enum.map(&elem(&1, 0))
      |> Enum.sort()

    %{
      attempted: map_size(team_data),
      succeeded: map_size(team_data) - length(failed),
      failed: failed
    }
  end

  @doc false
  def build_knowledge_metrics(nil), do: nil

  def build_knowledge_metrics(vault) when is_map(vault) do
    %{
      metric_type: :knowledge_ops,
      total_entries: get_in(vault, ["total_entries"]) || 0,
      entries_7d: get_in(vault, ["entries_7d"]) || 0,
      validated: get_in(vault, ["validated"]) || 0,
      contradicted: get_in(vault, ["contradicted"]) || 0
    }
  end

  # ────────────────────────────────────────────────────────────────
  # 팀별 수집 로직
  # ────────────────────────────────────────────────────────────────

  defp do_collect(:luna) do
    trades =
      query_one(
        """
          SELECT
            COUNT(*)::int AS trades_7d,
            COALESCE(SUM(realized_pnl_usdt), 0.0) AS pnl_usdt_7d,
            COALESCE(SUM(total_usdt), 0.0) AS traded_usdt_7d,
            COUNT(*) FILTER (WHERE realized_pnl_usdt > 0)::int AS win_count,
            (
              SELECT COUNT(*)::int
              FROM investment.positions
              WHERE COALESCE(amount, 0) > 0
            ) AS live_positions
          FROM investment.trades
          WHERE executed_at >= NOW() - interval '7 days'
        """,
        "investment"
      )

    regime =
      query_one(
        "SELECT regime FROM investment.market_regime_snapshots ORDER BY captured_at DESC LIMIT 1",
        "investment"
      )

    %{
      metric_type: :trading_ops,
      trades_7d: get_in(trades, ["trades_7d"]) || 0,
      pnl_usdt_7d: get_in(trades, ["pnl_usdt_7d"]) || 0.0,
      traded_usdt_7d: get_in(trades, ["traded_usdt_7d"]) || 0.0,
      win_count: get_in(trades, ["win_count"]) || 0,
      live_positions: get_in(trades, ["live_positions"]) || 0,
      market_regime: get_in(regime, ["regime"]) || "unknown"
    }
  end

  defp do_collect(:ska) do
    # Dashboard GenServer에서 집계된 KPI 우선 사용 (빠름 + 캐시)
    jay_data = safe_ska_dashboard_data()

    if map_size(jay_data) > 0 do
      %{
        metric_type: :reservation_ops,
        revenue_7d: jay_data[:revenue_7d] || 0,
        revenue_30d: jay_data[:revenue_30d] || 0,
        parse_rate: jay_data[:parse_rate],
        recovery_rate: jay_data[:recovery_rate],
        failed: jay_data[:failed] || 0,
        pending: jay_data[:pending] || 0,
        forecast_mape: jay_data[:forecast_mape]
      }
    else
      # Fallback: DB 직접 조회
      today_bookings =
        query_one(
          """
            SELECT
              COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
            FROM reservation.reservations
            WHERE date ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND date::date >= CURRENT_DATE - 1
              AND date::date <= CURRENT_DATE
          """,
          "reservation"
        )

      revenue =
        query_one(
          """
            SELECT COALESCE(SUM(total_amount), 0)::int AS revenue_7d
            FROM reservation.daily_summary
            WHERE date ~ '^\\d{4}-\\d{2}-\\d{2}$'
              AND date::date >= CURRENT_DATE - 7
          """,
          "reservation"
        )

      %{
        metric_type: :reservation_ops,
        bookings_today: get_in(today_bookings, ["total"]) || 0,
        completed: get_in(today_bookings, ["completed"]) || 0,
        pending: get_in(today_bookings, ["pending"]) || 0,
        failed: get_in(today_bookings, ["failed"]) || 0,
        revenue_7d: get_in(revenue, ["revenue_7d"]) || 0
      }
    end
  end

  defp do_collect(:blog) do
    posts =
      query_one(
        """
          SELECT
            COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days' AND status IN ('ready','published'))::int AS published_7d,
            COUNT(*) FILTER (WHERE status = 'ready')::int  AS ready_count,
            COUNT(*) FILTER (WHERE status = 'draft')::int  AS draft_count,
            COALESCE(
              AVG(NULLIF(metadata->>'view_count', '')::numeric)
                FILTER (WHERE created_at >= NOW() - interval '7 days'
                  AND status IN ('ready','published')
                  AND metadata ? 'view_count'
                  AND metadata->>'view_count' ~ '^[0-9]+(\\.[0-9]+)?$'),
              0
            )::numeric(10,1) AS avg_views_7d
          FROM blog.posts
        """,
        "blog"
      )

    top_category =
      query_one(
        """
          SELECT category
          FROM blog.posts
          WHERE created_at >= NOW() - interval '7 days'
            AND status IN ('ready','published')
            AND category IS NOT NULL
          GROUP BY category
          ORDER BY COUNT(*) DESC
          LIMIT 1
        """,
        "blog"
      )

    insta =
      query_one(
        """
          SELECT
            COUNT(*) FILTER (WHERE status = 'ok')::int          AS ok_7d,
            COUNT(*) FILTER (WHERE status = 'failed')::int      AS fail_7d,
            COUNT(*) FILTER (WHERE status = 'token_error')::int AS token_error_7d
          FROM blog.instagram_crosspost
          WHERE created_at >= NOW() - interval '7 days'
            AND dry_run = false
        """,
        "blog"
      )

    %{
      metric_type: :content_ops,
      published_7d: get_in(posts, ["published_7d"]) || 0,
      ready_count: get_in(posts, ["ready_count"]) || 0,
      draft_count: get_in(posts, ["draft_count"]) || 0,
      avg_views_7d: get_in(posts, ["avg_views_7d"]) || 0.0,
      top_category_7d: get_in(top_category, ["category"]),
      insta_ok_7d: get_in(insta, ["ok_7d"]) || 0,
      insta_fail_7d: get_in(insta, ["fail_7d"]) || 0,
      insta_token_err_7d: get_in(insta, ["token_error_7d"]) || 0
    }
  end

  defp do_collect(:claude) do
    health =
      query_rows(
        """
          SELECT service, exit_code, checked_at
          FROM (
            SELECT
              service,
              exit_code,
              checked_at,
              ROW_NUMBER() OVER (PARTITION BY service ORDER BY checked_at DESC) AS rn
            FROM (
              SELECT
                agent_name AS service,
                CASE WHEN status IN ('ok','healthy','active','running') THEN 0 ELSE 1 END AS exit_code,
                last_heartbeat AS checked_at
              FROM claude.agent_heartbeats
              WHERE last_heartbeat >= NOW() - interval '1 hour'
            ) service_health
          ) latest
          WHERE rn = 1
          ORDER BY checked_at DESC
        """,
        "claude"
      )

    unhealthy = Enum.filter(health || [], &(&1["exit_code"] != 0))
    core_health = current_core_health()
    unhealthy = suppress_stale_core_aliases(unhealthy, core_health)

    %{
      metric_type: :system_health,
      total_services: length(health || []),
      unhealthy_count: length(unhealthy),
      unhealthy_services: Enum.map(unhealthy, &{&1["service"], &1["exit_code"]})
    }
  end

  defp do_collect(:darwin) do
    try do
      Darwin.V2.TeamConnector.collect_kpi()
    rescue
      _ ->
        # Fallback: rag_research 직접 조회
        research =
          query_one(
            """
              SELECT
                COUNT(*)::int AS papers_7d,
                COUNT(*) FILTER (WHERE score >= 6)::int AS high_quality_7d,
                COALESCE(AVG(score), 0)::numeric(4,1) AS avg_score
              FROM rag_research
              WHERE created_at >= NOW() - INTERVAL '7 days'
            """,
            "jay"
          )

        %{
          metric_type: :research_ops,
          papers_7d: get_in(research, ["papers_7d"]) || 0,
          high_quality_7d: get_in(research, ["high_quality_7d"]) || 0,
          avg_score: get_in(research, ["avg_score"]) || 0.0
        }
    end
  end

  defp do_collect(:sigma) do
    vault =
      query_one(
        """
          SELECT
            COUNT(*)::int AS total_entries,
            COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days')::int AS entries_7d,
            COUNT(*) FILTER (WHERE validation_state = 'validated')::int AS validated,
            COUNT(*) FILTER (WHERE validation_state = 'contradicted')::int AS contradicted
          FROM sigma.vault_entries
        """,
        "sigma"
      )

    build_knowledge_metrics(vault)
  end

  defp do_collect(team) when team == :platform do
    agents =
      query_one(
        """
          SELECT
            COUNT(*)::int AS active_agents,
            COALESCE(AVG(score), 0.0) AS avg_score,
            COUNT(*) FILTER (WHERE score < 5)::int AS low_score_agents
          FROM agent.registry
          WHERE team = '#{team}' AND status = 'active'
        """,
        "agent"
      )

    %{
      metric_type: :agent_health,
      team: team,
      active_agents: get_in(agents, ["active_agents"]) || 0,
      avg_score: get_in(agents, ["avg_score"]) || 0.0,
      low_score_agents: get_in(agents, ["low_score_agents"]) || 0
    }
  end

  # ────────────────────────────────────────────────────────────────
  # DB 헬퍼
  # ────────────────────────────────────────────────────────────────

  defp safe_ska_dashboard_data do
    try do
      TeamJay.Ska.Analytics.Dashboard.get_jay_data()
    rescue
      _ -> %{}
    catch
      :exit, _ -> %{}
    end
  end

  defp query_one(sql, schema) do
    case Jay.Core.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => [row | _]}} -> row
      {:ok, %{"rows" => []}} -> nil
      _ -> nil
    end
  end

  defp query_rows(sql, schema) do
    case Jay.Core.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => rows}} -> rows
      _ -> []
    end
  end

  defp current_core_health do
    case Jay.Core.HubClient.health() do
      {:ok, %{"resources" => resources}} when is_map(resources) -> resources
      _ -> %{}
    end
  end

  defp suppress_stale_core_aliases(unhealthy_services, resources)
       when is_list(unhealthy_services) do
    api_ok? = resource_ok?(resources, "core_services")
    db_ok? = resource_ok?(resources, "postgresql") and resource_ok?(resources, "pg_pool")

    Enum.reject(unhealthy_services, fn row ->
      service = row["service"] |> to_string() |> String.downcase()

      cond do
        api_ok? and service in ["api", "health-dashboard", "dashboard", "hub"] -> true
        db_ok? and service in ["db", "database", "postgres", "postgresql", "pg_pool"] -> true
        true -> false
      end
    end)
  end

  defp resource_ok?(resources, key) when is_map(resources) do
    case Map.get(resources, key) do
      %{"status" => "ok"} -> true
      _ -> false
    end
  end
end
