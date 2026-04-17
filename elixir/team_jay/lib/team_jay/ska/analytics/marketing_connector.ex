defmodule TeamJay.Ska.Analytics.MarketingConnector do
  @moduledoc """
  스카팀 마케팅 연동 GenServer.

  매일 매출 데이터를 분석해 JayBus에 크로스팀 신호를 브로드캐스트:
    - 매출 15%+ 하락 감지 → :ska_to_blog (블로팀 프로모션 콘텐츠 요청)
    - 매출 현황 갱신 시 → :ska_to_luna (캐시플로우 → 루나 투자 강도 조정)

  GrowthCycle :growth_cycle_completed 이벤트를 구독해 자동 점검.
  하루 1회 이상 중복 트리거 방지 (last_triggered_date 보호).
  """

  use GenServer
  require Logger
  alias TeamJay.Jay.Topics

  @drop_threshold_pct 15.0          # 15% 이상 하락 시 블로팀 요청
  @fallback_check_ms 24 * 60 * 60 * 1_000   # GrowthCycle 미발행 시 fallback 타이머

  defstruct [
    last_triggered_date: nil,   # 오늘 이미 ska_to_blog 트리거했는지 체크
    last_checked_at: nil
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "즉시 마케팅 신호 점검 (수동 트리거)"
  def check_now do
    GenServer.cast(__MODULE__, :check_now)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[MarketingConnector] 스카 마케팅 연동 시작")
    Topics.subscribe(:growth_cycle_completed)
    # Dashboard가 초기화될 때까지 5분 대기 후 첫 점검
    Process.send_after(self(), :initial_check, 5 * 60 * 1_000)
    {:ok, %__MODULE__{}}
  end

  @impl true
  def handle_cast(:check_now, state) do
    {:noreply, do_check(state)}
  end

  @impl true
  def handle_info(:initial_check, state) do
    new_state = do_check(state)
    Process.send_after(self(), :fallback_check, @fallback_check_ms)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:fallback_check, state) do
    new_state = do_check(state)
    Process.send_after(self(), :fallback_check, @fallback_check_ms)
    {:noreply, new_state}
  end

  # GrowthCycle 완료 이벤트 수신 → 즉시 점검
  @impl true
  def handle_info({:jay_bus, :growth_cycle_completed, _payload}, state) do
    {:noreply, do_check(state)}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── 매출 점검 ────────────────────────────────────────────

  defp do_check(state) do
    with {:ok, current} <- fetch_current_revenue(),
         {:ok, prev_7d} <- fetch_previous_week_revenue() do

      current_7d = current[:revenue_7d] || 0

      # :ska_to_luna — 캐시플로우 항상 브로드캐스트
      broadcast_cashflow(current_7d)

      # :ska_to_blog — 하락 15%+ 시, 하루 1회만
      if should_trigger_promo?(current_7d, prev_7d, state) do
        drop_pct = calculate_drop_pct(prev_7d, current_7d)
        broadcast_promo_request(drop_pct, current)
        today = Date.utc_today()
        Logger.info("[MarketingConnector] ska→blog 트리거: 하락 #{drop_pct}%, 7d=#{current_7d}원")
        %{state | last_triggered_date: today, last_checked_at: DateTime.utc_now()}
      else
        Logger.debug("[MarketingConnector] 점검 완료: 7d=#{current_7d}원, 트리거 없음")
        %{state | last_checked_at: DateTime.utc_now()}
      end
    else
      {:error, reason} ->
        Logger.warning("[MarketingConnector] 점검 실패: #{inspect(reason)}")
        state
    end
  rescue
    e ->
      Logger.warning("[MarketingConnector] do_check 예외: #{inspect(e)}")
      state
  end

  # ─── 데이터 수집 ──────────────────────────────────────────

  defp fetch_current_revenue do
    jay_data = TeamJay.Ska.Analytics.Dashboard.get_jay_data()
    if map_size(jay_data) > 0 do
      {:ok, jay_data}
    else
      # Fallback: RevenueTracker 직접 조회
      case TeamJay.Ska.Analytics.RevenueTracker.get_weekly() do
        {:ok, summary} ->
          {:ok, %{revenue_7d: summary[:weekly_revenue] || 0,
                  revenue_30d: summary[:monthly_revenue] || 0}}
        err -> err
      end
    end
  rescue
    _ -> {:error, :revenue_unavailable}
  end

  defp fetch_previous_week_revenue do
    case Jay.Core.HubClient.pg_query("""
      SELECT COALESCE(SUM(actual_revenue), 0)::bigint AS prev_7d
      FROM ska.revenue_daily
      WHERE date >= CURRENT_DATE - INTERVAL '14 days'
        AND date < CURRENT_DATE - INTERVAL '7 days'
    """, "ska") do
      {:ok, %{"rows" => [row]}} -> {:ok, row["prev_7d"] || 0}
      {:ok, %{"rows" => []}}    -> {:ok, 0}
      {:error, reason}          -> {:error, reason}
    end
  rescue
    _ -> {:ok, 0}
  end

  # ─── 트리거 판단 ──────────────────────────────────────────

  defp should_trigger_promo?(current_7d, prev_7d, state) do
    # 이전 주 데이터가 없으면 비교 불가
    has_baseline = is_integer(prev_7d) and prev_7d > 0

    # 오늘 이미 트리거했으면 스킵
    already_today = state.last_triggered_date == Date.utc_today()

    drop_pct = calculate_drop_pct(prev_7d, current_7d)
    has_significant_drop = has_baseline and drop_pct >= @drop_threshold_pct

    has_significant_drop and not already_today
  end

  defp calculate_drop_pct(prev, current) when is_integer(prev) and prev > 0 do
    Float.round((prev - current) / prev * 100, 1)
  end
  defp calculate_drop_pct(_, _), do: 0.0

  # ─── JayBus 브로드캐스트 ──────────────────────────────────

  defp broadcast_cashflow(revenue_7d) do
    Topics.broadcast(:ska_to_luna, %{
      revenue_7d: revenue_7d,
      source: :ska_marketing_connector
    })
  rescue
    e -> Logger.warning("[MarketingConnector] ska_to_luna 브로드캐스트 실패: #{inspect(e)}")
  end

  defp broadcast_promo_request(drop_pct, revenue_data) do
    Topics.broadcast(:ska_to_blog, %{
      drop_pct: drop_pct,
      details: %{
        revenue_7d:  revenue_data[:revenue_7d] || 0,
        revenue_30d: revenue_data[:revenue_30d] || 0
      },
      triggered_at: DateTime.utc_now()
    })
    record_event(:ska_to_blog_triggered, %{drop_pct: drop_pct})
  rescue
    e -> Logger.warning("[MarketingConnector] ska_to_blog 브로드캐스트 실패: #{inspect(e)}")
  end

  # ─── EventLake 기록 ───────────────────────────────────────

  defp record_event(type, details) do
    Jay.Core.EventLake.record(%{
      source: "ska.marketing_connector",
      event_type: "cross_pipeline.#{type}",
      severity: "info",
      payload: details
    })
  rescue
    _ -> :ok
  end
end
