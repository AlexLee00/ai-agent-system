defmodule TeamJay.Ska.Analytics.RevenueTracker do
  @moduledoc """
  스카팀 매출 추적 GenServer.

  ska.revenue_daily 테이블에서 매출 데이터를 조회·집계.
  GrowthCycle SENSE 단계에서 Jay의 ska.revenue_7d 제공.

  주요 기능:
    - get_daily/1    : 특정 날짜 매출 조회
    - get_weekly/0   : 최근 7일 합산 매출
    - get_monthly/0  : 최근 30일 합산 매출
    - get_trend/1    : N일 일별 매출 배열 (추세 분석용)
    - get_summary/0  : 전체 KPI 스냅샷
  """

  use GenServer
  require Logger

  @cache_ttl_ms 5 * 60 * 1_000  # 5분 캐시

  defstruct cache: %{}, cache_at: %{}

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "특정 날짜(YYYY-MM-DD) 실매출 조회"
  def get_daily(date_str) do
    GenServer.call(__MODULE__, {:get_daily, date_str})
  end

  @doc "최근 7일 합산 매출 (원)"
  def get_weekly do
    GenServer.call(__MODULE__, :get_weekly)
  end

  @doc "최근 30일 합산 매출 (원)"
  def get_monthly do
    GenServer.call(__MODULE__, :get_monthly)
  end

  @doc "최근 N일 일별 매출 목록 [{date, revenue}]"
  def get_trend(days \\ 14) do
    GenServer.call(__MODULE__, {:get_trend, days})
  end

  @doc "매출 KPI 전체 스냅샷"
  def get_summary do
    GenServer.call(__MODULE__, :get_summary)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[RevenueTracker] 스카팀 매출 추적 시작")
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_call({:get_daily, date_str}, _from, state) do
    {result, new_state} = cached(state, {:daily, date_str}, fn ->
      query_daily(date_str)
    end)
    {:reply, result, new_state}
  end

  @impl true
  def handle_call(:get_weekly, _from, state) do
    {result, new_state} = cached(state, :weekly, fn -> query_recent(7) end)
    {:reply, result, new_state}
  end

  @impl true
  def handle_call(:get_monthly, _from, state) do
    {result, new_state} = cached(state, :monthly, fn -> query_recent(30) end)
    {:reply, result, new_state}
  end

  @impl true
  def handle_call({:get_trend, days}, _from, state) do
    {result, new_state} = cached(state, {:trend, days}, fn -> query_trend(days) end)
    {:reply, result, new_state}
  end

  @impl true
  def handle_call(:get_summary, _from, state) do
    {result, new_state} = cached(state, :summary, fn -> build_summary() end)
    {:reply, result, new_state}
  end

  # ─── 쿼리 ────────────────────────────────────────────────

  defp query_daily(date_str) do
    case Jay.Core.HubClient.pg_query("""
      SELECT actual_revenue::bigint AS revenue
      FROM ska.revenue_daily
      WHERE date = '#{date_str}'::date
      LIMIT 1
    """, "ska") do
      {:ok, %{"rows" => [%{"revenue" => r}]}} -> {:ok, normalize_int(r)}
      {:ok, %{"rows" => []}} -> {:ok, 0}
      {:error, reason} ->
        Logger.warning("[RevenueTracker] query_daily 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.warning("[RevenueTracker] query_daily 예외: #{inspect(e)}")
      {:error, :query_failed}
  end

  defp query_recent(days) do
    case Jay.Core.HubClient.pg_query("""
      SELECT COALESCE(SUM(actual_revenue), 0)::bigint AS total
      FROM ska.revenue_daily
      WHERE date >= (CURRENT_DATE - INTERVAL '#{days} days')
        AND date < CURRENT_DATE
    """, "ska") do
      {:ok, %{"rows" => [%{"total" => t}]}} -> {:ok, normalize_int(t)}
      {:error, reason} ->
        Logger.warning("[RevenueTracker] query_recent(#{days}) 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.warning("[RevenueTracker] query_recent 예외: #{inspect(e)}")
      {:error, :query_failed}
  end

  defp query_trend(days) do
    case Jay.Core.HubClient.pg_query("""
      SELECT date::text, COALESCE(actual_revenue, 0)::bigint AS revenue
      FROM ska.revenue_daily
      WHERE date >= (CURRENT_DATE - INTERVAL '#{days} days')
        AND date < CURRENT_DATE
      ORDER BY date ASC
    """, "ska") do
      {:ok, %{"rows" => rows}} ->
        trend =
          Enum.map(rows, fn %{"date" => d, "revenue" => r} ->
            %{date: d, revenue: normalize_int(r)}
          end)

        {:ok, trend}
      {:error, reason} ->
        Logger.warning("[RevenueTracker] query_trend(#{days}) 실패: #{inspect(reason)}")
        {:error, reason}
    end
  rescue
    e ->
      Logger.warning("[RevenueTracker] query_trend 예외: #{inspect(e)}")
      {:error, :query_failed}
  end

  defp build_summary do
    with {:ok, weekly} <- query_recent(7),
         {:ok, monthly} <- query_recent(30),
         {:ok, trend} <- query_trend(7) do
      daily_avg = if length(trend) > 0 do
        Enum.sum(Enum.map(trend, & &1.revenue)) |> div(max(length(trend), 1))
      else
        0
      end

      {:ok, %{
        weekly_revenue: weekly,
        monthly_revenue: monthly,
        daily_avg_7d: daily_avg,
        trend_7d: trend,
        computed_at: DateTime.utc_now()
      }}
    else
      {:error, reason} -> {:error, reason}
    end
  end

  # ─── 캐시 헬퍼 ───────────────────────────────────────────

  defp cached(state, key, fetch_fn) do
    now = System.monotonic_time(:millisecond)
    cached_at = Map.get(state.cache_at, key, 0)

    if now - cached_at < @cache_ttl_ms and Map.has_key?(state.cache, key) do
      {Map.get(state.cache, key), state}
    else
      result = fetch_fn.()
      new_state = %{state |
        cache: Map.put(state.cache, key, result),
        cache_at: Map.put(state.cache_at, key, now)
      }
      {result, new_state}
    end
  end

  defp normalize_int(value) when is_integer(value), do: value
  defp normalize_int(value) when is_float(value), do: trunc(value)

  defp normalize_int(value) when is_binary(value) do
    value
    |> String.trim()
    |> case do
      "" -> 0
      trimmed ->
        case Integer.parse(trimmed) do
          {int, ""} -> int
          _ -> 0
        end
    end
  end

  defp normalize_int(nil), do: 0
  defp normalize_int(_), do: 0
end
