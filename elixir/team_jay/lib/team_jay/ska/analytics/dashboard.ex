defmodule TeamJay.Ska.Analytics.Dashboard do
  @moduledoc """
  스카팀 통합 대시보드 GenServer.

  RevenueTracker + Forecast + FailureTracker + ParsingGuard
  메트릭을 집계해 단일 스냅샷으로 제공.

  - GrowthCycle SENSE 단계에서 Jay의 ska 데이터 공급원
  - WeeklyReport용 집계 제공
  - 이상 감지 시 텔레그램 알림
  """

  use GenServer
  require Logger

  @refresh_interval_ms 10 * 60 * 1_000  # 10분마다 갱신
  @initial_refresh_delay_ms 20_000

  defstruct snapshot: nil, refreshed_at: nil

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "전체 스카팀 KPI 스냅샷"
  def get_snapshot do
    GenServer.call(__MODULE__, :get_snapshot)
  end

  @doc "GrowthCycle용 경량 데이터 (Jay TeamConnector가 호출)"
  def get_jay_data do
    GenServer.call(__MODULE__, :get_jay_data)
  end

  @doc "즉시 스냅샷 갱신 (수동 트리거)"
  def refresh do
    GenServer.cast(__MODULE__, :refresh)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[Dashboard] 스카팀 대시보드 시작")
    Process.send_after(self(), :initial_refresh, @initial_refresh_delay_ms)
    Process.send_after(self(), :periodic_refresh, @refresh_interval_ms)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_call(:get_snapshot, _from, state) do
    {:reply, state.snapshot || %{}, state}
  end

  @impl true
  def handle_call(:get_jay_data, _from, state) do
    jay_data = extract_jay_data(state.snapshot)
    {:reply, jay_data, state}
  end

  @impl true
  def handle_cast(:refresh, state) do
    new_state = do_refresh(state)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:initial_refresh, state) do
    {:noreply, do_refresh(state)}
  end

  @impl true
  def handle_info(:periodic_refresh, state) do
    new_state = do_refresh(state)
    Process.send_after(self(), :periodic_refresh, @refresh_interval_ms)
    {:noreply, new_state}
  end

  # ─── 스냅샷 빌드 ─────────────────────────────────────────

  defp do_refresh(state) do
    snapshot = build_snapshot()
    check_anomalies(snapshot)
    %{state | snapshot: snapshot, refreshed_at: DateTime.utc_now()}
  end

  defp build_snapshot do
    # 병렬 수집
    tasks = [
      Task.async(fn -> collect_revenue() end),
      Task.async(fn -> collect_forecast() end),
      Task.async(fn -> collect_parsing() end),
      Task.async(fn -> collect_failures() end),
      Task.async(fn -> collect_reservations() end)
    ]

    [revenue, forecast, parsing, failures, reservations] =
      Task.yield_many(tasks, 8_000)
      |> Enum.map(fn
        {_task, {:ok, result}} -> result
        {task, nil} ->
          Task.shutdown(task, :brutal_kill)
          %{error: :timeout}
        {_task, {:exit, reason}} ->
          %{error: reason}
      end)

    %{
      revenue: revenue,
      forecast: forecast,
      parsing: parsing,
      failures: failures,
      reservations: reservations,
      computed_at: DateTime.utc_now()
    }
  end

  defp collect_revenue do
    case TeamJay.Ska.Analytics.RevenueTracker.get_summary() do
      {:ok, summary} -> summary
      {:error, _}    -> %{weekly_revenue: nil, monthly_revenue: nil, daily_avg_7d: nil, trend_7d: [], unavailable: true}
    end
  rescue
    _ -> %{weekly_revenue: nil, monthly_revenue: nil, daily_avg_7d: nil, unavailable: true}
  end

  defp collect_forecast do
    case TeamJay.Ska.Analytics.Forecast.get_summary() do
      {:ok, summary} -> summary
      {:error, _}    -> %{latest_daily: nil, accuracy_7d_mape: nil, unavailable: true}
    end
  rescue
    _ -> %{latest_daily: nil, accuracy_7d_mape: nil, unavailable: true}
  end

  defp collect_parsing do
    stats = TeamJay.Ska.ParsingGuard.get_stats()
    total = stats.level1_ok + stats.level1_fail +
            stats.level2_ok + stats.level2_fail +
            stats.level3_ok + stats.level3_fail
    ok = stats.level1_ok + stats.level2_ok + stats.level3_ok

    %{
      success_rate: if(total > 0, do: Float.round(ok / total * 100, 1), else: 100.0),
      level1_ok: stats.level1_ok,
      level2_ok: stats.level2_ok,
      level3_ok: stats.level3_ok,
      total_attempts: total
    }
  rescue
    _ -> %{success_rate: nil, total_attempts: 0}
  end

  defp collect_failures do
    stats = TeamJay.Ska.FailureTracker.get_stats()
    recovery_rate = if stats.total_failures > 0 do
      Float.round(stats.auto_resolved / stats.total_failures * 100, 1)
    else
      100.0
    end

    %{
      total: stats.total_failures,
      auto_resolved: stats.auto_resolved,
      recovery_rate: recovery_rate,
      by_type: stats.by_type
    }
  rescue
    _ -> %{total: 0, auto_resolved: 0, recovery_rate: nil}
  end

  defp collect_reservations do
    today = Date.utc_today() |> Date.to_string()
    case TeamJay.HubClient.pg_query("""
      SELECT
        COUNT(*) FILTER (WHERE status = 'confirmed')::int AS confirmed,
        COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'failed')::int AS failed
      FROM reservations
      WHERE date = '#{today}'::date
    """, "reservation") do
      {:ok, %{"rows" => [row]}} ->
        %{
          confirmed: row["confirmed"] || 0,
          pending: row["pending"] || 0,
          failed: row["failed"] || 0,
          date: today
        }
      _ -> %{confirmed: 0, pending: 0, failed: 0, date: today}
    end
  rescue
    _ -> %{confirmed: 0, pending: 0, failed: 0}
  end

  # ─── Jay용 경량 데이터 ────────────────────────────────────

  defp extract_jay_data(nil), do: %{}
  defp extract_jay_data(snapshot) do
    %{
      revenue_7d:     get_in(snapshot, [:revenue, :weekly_revenue]) || 0,
      revenue_30d:    get_in(snapshot, [:revenue, :monthly_revenue]) || 0,
      parse_rate:     get_in(snapshot, [:parsing, :success_rate]),
      recovery_rate:  get_in(snapshot, [:failures, :recovery_rate]),
      failed:         get_in(snapshot, [:reservations, :failed]) || 0,
      pending:        get_in(snapshot, [:reservations, :pending]) || 0,
      forecast_mape:  get_in(snapshot, [:forecast, :accuracy_7d_mape]),
      computed_at:    snapshot[:computed_at]
    }
  end

  # ─── 이상 감지 ────────────────────────────────────────────

  defp check_anomalies(%{parsing: p, failures: f, revenue: r, forecast: forecast} = _snapshot) do
    p = ensure_map(p)
    f = ensure_map(f)
    r = ensure_map(r)
    forecast = ensure_map(forecast)

    alerts = []

    parsing_rate = numeric_value(Map.get(p, :success_rate))
    recovery_rate = numeric_value(Map.get(f, :recovery_rate))
    weekly_revenue = numeric_value(Map.get(r, :weekly_revenue))
    revenue_unavailable = truthy?(Map.get(r, :unavailable))
    forecast_unavailable = truthy?(Map.get(forecast, :unavailable))

    alerts = if is_number(parsing_rate) and parsing_rate < 90.0 do
      ["⚠️ 파싱 성공률 #{parsing_rate}% (기준 90%+)" | alerts]
    else
      alerts
    end

    alerts = if is_number(recovery_rate) and recovery_rate < 50.0 do
      ["⚠️ 자동 복구율 #{recovery_rate}% (기준 50%+)" | alerts]
    else
      alerts
    end

    alerts = if not revenue_unavailable and is_number(weekly_revenue) and weekly_revenue == 0 do
      ["🚨 최근 7일 매출 0원 — 데이터 수집 오류 가능" | alerts]
    else
      alerts
    end

    alerts = if revenue_unavailable or forecast_unavailable do
      Logger.debug("[Dashboard] 초기 데이터 수집 미완료 — anomaly alert 생략")
      []
    else
      alerts
    end

    if length(alerts) > 0 do
      msg = "📊 [스카 대시보드] 이상 감지\n#{Enum.join(alerts, "\n")}"
      TeamJay.HubClient.post_alarm(msg, "ska", "dashboard")
      Logger.warning("[Dashboard] 이상 감지: #{Enum.join(alerts, " | ")}")
    end
  rescue
    e -> Logger.warning("[Dashboard] check_anomalies 예외: #{inspect(e)}")
  end

  defp ensure_map(value) when is_map(value), do: value
  defp ensure_map(_), do: %{}

  defp truthy?(value), do: value in [true, "true", 1, "1"]

  defp numeric_value(value) when is_integer(value) or is_float(value), do: value

  defp numeric_value(value) when is_binary(value) do
    case Integer.parse(value) do
      {int, ""} -> int
      _ ->
        case Float.parse(value) do
          {float, ""} -> float
          _ -> nil
        end
    end
  end

  defp numeric_value(_), do: nil
end
