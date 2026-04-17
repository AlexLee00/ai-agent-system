defmodule TeamJay.Jay.TeamConnector do
  @moduledoc """
  Hub API를 통해 9팀 데이터를 수집하는 커넥터.
  growth_cycle.ex가 SENSE 단계에서 호출.
  """

  require Logger

  @teams [:luna, :ska, :blog, :claude, :worker, :platform, :darwin, :justin, :video]

  def all_teams, do: @teams

  @doc """
  팀의 어제 KPI 데이터 수집.
  실패 시 nil 반환 (throw 금지).
  """
  def collect(team) when team in @teams do
    try do
      do_collect(team)
    rescue
      e ->
        Logger.warning("[TeamConnector] #{team} 수집 실패: #{Exception.message(e)}")
        nil
    end
  end

  def collect(team) do
    Logger.warning("[TeamConnector] 알 수 없는 팀: #{team}")
    nil
  end

  @doc "9팀 병렬 수집. 실패 팀은 nil로 포함."
  def collect_all do
    @teams
    |> Task.async_stream(&{&1, collect(&1)}, timeout: 30_000, on_timeout: :kill_task)
    |> Enum.reduce(%{}, fn
      {:ok, {team, data}}, acc -> Map.put(acc, team, data)
      {:exit, :timeout}, acc -> acc
    end)
  end

  # ────────────────────────────────────────────────────────────────
  # 팀별 수집 로직
  # ────────────────────────────────────────────────────────────────

  defp do_collect(:luna) do
    trades = query_one("""
      SELECT
        COUNT(*)::int AS trades_7d,
        COALESCE(SUM(pnl_usdt), 0.0) AS pnl_usdt_7d,
        COALESCE(SUM(amount_usdt), 0.0) AS traded_usdt_7d,
        COUNT(*) FILTER (WHERE pnl_usdt > 0)::int AS win_count,
        COUNT(*) FILTER (WHERE status = 'active')::int AS live_positions
      FROM investment.trades
      WHERE executed_at >= NOW() - interval '7 days'
    """, "investment")

    regime = query_one("SELECT regime FROM investment.market_regimes ORDER BY recorded_at DESC LIMIT 1", "investment")

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
    jay_data = try do
      TeamJay.Ska.Analytics.Dashboard.get_jay_data()
    rescue
      _ -> %{}
    end

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
      today_bookings = query_one("""
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE status = 'completed')::int AS completed,
          COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
          COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
        FROM reservation.reservations
        WHERE date >= CURRENT_DATE - 1 AND date <= CURRENT_DATE
      """, "reservation")

      revenue = query_one("""
        SELECT COALESCE(SUM(amount), 0)::int AS revenue_7d
        FROM reservation.payments
        WHERE paid_at >= NOW() - interval '7 days' AND status = 'paid'
      """, "reservation")

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
    posts = query_one("""
      SELECT
        COUNT(*) FILTER (WHERE created_at >= NOW() - interval '7 days' AND status IN ('ready','published'))::int AS published_7d,
        COUNT(*) FILTER (WHERE status = 'ready')::int  AS ready_count,
        COUNT(*) FILTER (WHERE status = 'draft')::int  AS draft_count,
        COALESCE(AVG(view_count) FILTER (WHERE created_at >= NOW() - interval '7 days' AND status IN ('ready','published')), 0)::numeric(10,1) AS avg_views_7d
      FROM blog.posts
    """, "blog")

    top_category = query_one("""
      SELECT category
      FROM blog.posts
      WHERE created_at >= NOW() - interval '7 days'
        AND status IN ('ready','published')
        AND category IS NOT NULL
      GROUP BY category
      ORDER BY COUNT(*) DESC
      LIMIT 1
    """, "blog")

    insta = query_one("""
      SELECT
        COUNT(*) FILTER (WHERE status = 'ok')::int          AS ok_7d,
        COUNT(*) FILTER (WHERE status = 'failed')::int      AS fail_7d,
        COUNT(*) FILTER (WHERE status = 'token_error')::int AS token_error_7d
      FROM blog.instagram_crosspost
      WHERE created_at >= NOW() - interval '7 days'
        AND dry_run = false
    """, "blog")

    %{
      metric_type:       :content_ops,
      published_7d:      get_in(posts, ["published_7d"])  || 0,
      ready_count:       get_in(posts, ["ready_count"])   || 0,
      draft_count:       get_in(posts, ["draft_count"])   || 0,
      avg_views_7d:      get_in(posts, ["avg_views_7d"])  || 0.0,
      top_category_7d:   get_in(top_category, ["category"]),
      insta_ok_7d:       get_in(insta, ["ok_7d"])         || 0,
      insta_fail_7d:     get_in(insta, ["fail_7d"])       || 0,
      insta_token_err_7d: get_in(insta, ["token_error_7d"]) || 0
    }
  end

  defp do_collect(:claude) do
    health = query_rows("""
      SELECT service, exit_code, checked_at
      FROM (
        SELECT
          service,
          exit_code,
          checked_at,
          ROW_NUMBER() OVER (PARTITION BY service ORDER BY checked_at DESC) AS rn
        FROM claude.service_health
        WHERE checked_at >= NOW() - interval '1 hour'
      ) latest
      WHERE rn = 1
      ORDER BY checked_at DESC
    """, "claude")

    unhealthy = Enum.filter(health || [], &(&1["exit_code"] != 0))

    %{
      metric_type: :system_health,
      total_services: length(health || []),
      unhealthy_count: length(unhealthy),
      unhealthy_services: Enum.map(unhealthy, &{&1["service"], &1["exit_code"]})
    }
  end

  defp do_collect(:worker) do
    deploys = query_one("""
      SELECT COUNT(*)::int AS deploys_7d
      FROM worker.deployments
      WHERE deployed_at >= NOW() - interval '7 days' AND status = 'success'
    """, "worker")

    %{
      metric_type: :platform_ops,
      deploys_7d: get_in(deploys, ["deploys_7d"]) || 0
    }
  end

  defp do_collect(:darwin) do
    try do
      TeamJay.Darwin.TeamConnector.collect_kpi()
    rescue
      _ ->
        # Fallback: rag_research 직접 조회
        research = query_one("""
          SELECT
            COUNT(*)::int AS papers_7d,
            COUNT(*) FILTER (WHERE score >= 6)::int AS high_quality_7d,
            COALESCE(AVG(score), 0)::numeric(4,1) AS avg_score
          FROM rag_research
          WHERE created_at >= NOW() - INTERVAL '7 days'
        """, "jay")

        %{
          metric_type: :research_ops,
          papers_7d: get_in(research, ["papers_7d"]) || 0,
          high_quality_7d: get_in(research, ["high_quality_7d"]) || 0,
          avg_score: get_in(research, ["avg_score"]) || 0.0
        }
    end
  end

  defp do_collect(team) when team in [:platform, :justin, :video] do
    agents = query_one("""
      SELECT
        COUNT(*)::int AS active_agents,
        COALESCE(AVG(score), 0.0) AS avg_score,
        COUNT(*) FILTER (WHERE score < 5)::int AS low_score_agents
      FROM agent.registry
      WHERE team = '#{team}' AND status = 'active'
    """, "agent")

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

  defp query_one(sql, schema) do
    case TeamJay.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => [row | _]}} -> row
      {:ok, %{"rows" => []}} -> nil
      _ -> nil
    end
  end

  defp query_rows(sql, schema) do
    case TeamJay.HubClient.pg_query(sql, schema) do
      {:ok, %{"rows" => rows}} -> rows
      _ -> []
    end
  end
end
