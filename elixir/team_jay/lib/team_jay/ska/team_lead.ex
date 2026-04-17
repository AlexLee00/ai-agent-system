defmodule TeamJay.Ska.TeamLead do
  @moduledoc """
  스카 팀장 GenServer — 운영 지능 + 자기 복구 조율자 + 매출 성장 촉매

  역할:
    1. 운영 지능 (Operations Intelligence)
       - 매출 이상 감지 (전일 대비 ±30% 이상)
       - 에러 빈도 상승 감지 → 클로드팀 자동 출동 요청
       - 에이전트 성과 추적 (KPI 히스토리)

    2. 자기 복구 조율자 (Self-Healing Orchestrator)
       - PubSub :failure_reported 구독 → 복구 전략 조율
       - :selector_deprecated 구독 → 재생성 지시
       - 에러 빈도 급등 시 클로드팀(doctor) 출동 요청

    3. 매출 성장 촉매 (Revenue Growth Catalyst)
       - 매출 데이터 → OperationsRag 누적
       - 블로팀 마케팅 연동 (매출 하락 시 프로모션 트리거)
       - 매출 하락 패턴 감지 → 자동 프로모션 트리거 이벤트

    4. 팀 진화 관리자
       - 에이전트 성과 추적 → 개선 방향 주간 리포트에 포함
       - Orchestrator가 Phase 전환 시 팀장도 함께 인지
  """

  use GenServer
  require Logger

  alias TeamJay.Ska.PubSub, as: SkaPubSub

  @hourly_ms 60 * 60 * 1_000
  @check_interval_ms 6 * @hourly_ms        # 6시간마다 점검
  @revenue_anomaly_threshold 0.30           # 전일 대비 30% 이상 변동
  @error_spike_threshold 10                 # 1시간 내 에러 10건 이상 → 스파이크

  defstruct [
    :phase,
    :last_revenue,
    :error_window,    # 최근 1시간 에러 카운트
    :agent_performance,
    :started_at
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def status do
    GenServer.call(__MODULE__, :status)
  end

  def set_phase(phase) when phase in [1, 2, 3] do
    GenServer.cast(__MODULE__, {:set_phase, phase})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[TeamLead] 스카 팀장 시작!")

    SkaPubSub.subscribe(:failure_reported)
    SkaPubSub.subscribe(:failure_resolved)
    SkaPubSub.subscribe(:selector_deprecated)
    SkaPubSub.subscribe(:phase_changed)

    # 6시간 후 첫 점검
    Process.send_after(self(), :periodic_check, @check_interval_ms)

    state = %__MODULE__{
      phase: 1,
      last_revenue: nil,
      error_window: [],
      agent_performance: %{},
      started_at: DateTime.utc_now()
    }

    {:ok, state}
  end

  @impl true
  def handle_call(:status, _from, state) do
    {:reply,
     %{
       phase: state.phase,
       error_window_count: length(state.error_window),
       agent_performance: state.agent_performance,
       started_at: state.started_at
     }, state}
  end

  @impl true
  def handle_cast({:set_phase, phase}, state) do
    Logger.info("[TeamLead] Phase #{state.phase} → #{phase} 동기화")
    {:noreply, %{state | phase: phase}}
  end

  # ─── PubSub 이벤트 핸들링 ─────────────────────────────────

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    agent = Map.get(payload, :agent, "unknown")
    now = DateTime.utc_now()

    # 1시간 슬라이딩 윈도우: 오래된 항목 제거
    cutoff = DateTime.add(now, -3600, :second)
    recent = Enum.filter(state.error_window, fn t ->
      DateTime.compare(t, cutoff) == :gt
    end)
    new_window = [now | recent]

    # 에러 스파이크 감지
    new_state = %{state | error_window: new_window}

    new_state = if length(new_window) >= @error_spike_threshold do
      handle_error_spike(new_state, length(new_window))
    else
      new_state
    end

    # 에이전트별 성과 추적
    new_perf = Map.update(new_state.agent_performance, agent, 1, &(&1 + 1))

    {:noreply, %{new_state | agent_performance: new_perf}}
  end

  @impl true
  def handle_info({:ska_event, :failure_resolved, payload}, state) do
    agent = Map.get(payload, :failure_id, "unknown")
    strategy = Map.get(payload, :strategy, :unknown)
    Logger.debug("[TeamLead] 복구 완료: #{agent} / #{strategy}")
    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :selector_deprecated, payload}, state) do
    target = Map.get(payload, :target, "unknown")
    Logger.warning("[TeamLead] 셀렉터 폐기 → ExceptionDetector에 새 예외 검토 요청: #{target}")
    TeamJay.Ska.ExceptionDetector.check_new_pattern(:selector_deprecated, %{
      target: target,
      deprecated_at: DateTime.utc_now()
    })
    {:noreply, state}
  end

  @impl true
  def handle_info({:ska_event, :phase_changed, payload}, state) do
    new_phase = Map.get(payload, :new_phase, state.phase)
    Logger.info("[TeamLead] Phase 전환 감지: #{state.phase} → #{new_phase}")
    {:noreply, %{state | phase: new_phase}}
  end

  @impl true
  def handle_info(:periodic_check, state) do
    Process.send_after(self(), :periodic_check, @check_interval_ms)
    new_state = do_periodic_check(state)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  # ─── Private: 에러 스파이크 처리 ─────────────────────────

  defp handle_error_spike(state, count) do
    Logger.error("[TeamLead] 🚨 에러 스파이크! 1시간 내 #{count}건")

    # 클로드팀(닥터) 자동 출동 요청
    Task.start(fn ->
      Jay.Core.HubClient.post_alarm(
        "🚨 스카팀 에러 스파이크!\n1시간 내 #{count}건 발생\n→ 닥터(클로드팀) 점검 요청",
        "ska",
        "team_lead"
      )
    end)

    Jay.Core.EventLake.record(%{
      event_type: "ska_error_spike",
      team: "ska",
      bot_name: "team_lead",
      severity: "critical",
      title: "에러 스파이크",
      message: "1시간 내 #{count}건",
      tags: ["team_lead", "spike", "phase#{state.phase}"],
      metadata: %{count: count, window_start: DateTime.utc_now() |> DateTime.to_iso8601()}
    })

    state
  end

  # ─── Private: 주기 점검 ───────────────────────────────────

  defp do_periodic_check(state) do
    # 매출 이상 감지
    new_state = check_revenue_anomaly(state)

    # 에이전트 성과 리포트 (Phase별)
    if state.phase in [1, 2] do
      report_agent_performance(state.agent_performance)
    end

    new_state
  end

  defp check_revenue_anomaly(state) do
    # ska.revenue_daily에서 최근 2일 데이터 조회
    sql = """
    SELECT DATE(created_at) AS day, SUM(revenue_krw) AS total
    FROM ska.revenue_daily
    WHERE created_at >= NOW() - INTERVAL '2 days'
    GROUP BY DATE(created_at)
    ORDER BY day DESC
    LIMIT 2
    """

    case Jay.Core.Repo.query(sql, []) do
      {:ok, %{rows: [[_today_date, today_rev], [_yesterday_date, yesterday_rev]]}} ->
        today = to_float(today_rev)
        yesterday = to_float(yesterday_rev)

        if yesterday > 0 do
          delta = abs(today - yesterday) / yesterday
          if delta >= @revenue_anomaly_threshold do
            direction = if today > yesterday, do: "↑급등", else: "↓급락"
            msg = "📊 [스카팀] 매출 이상 감지 #{direction}\n전일: #{format_krw(yesterday)}\n오늘: #{format_krw(today)}\n변동: #{Float.round(delta * 100, 1)}%"
            Logger.warning("[TeamLead] #{msg}")
            Task.start(fn ->
              Jay.Core.HubClient.post_alarm(msg, "ska", "team_lead")
            end)

            # 매출 하락 시 MarketingConnector 즉시 점검 트리거
            if today < yesterday do
              TeamJay.Ska.Analytics.MarketingConnector.check_now()
            end
          end
        end

        %{state | last_revenue: today}

      {:ok, _} ->
        state

      {:error, err} ->
        Logger.debug("[TeamLead] 매출 조회 실패 (테이블 없을 수 있음): #{inspect(err)}")
        state
    end
  rescue
    e ->
      Logger.debug("[TeamLead] check_revenue_anomaly 예외: #{inspect(e)}")
      state
  end

  defp report_agent_performance(perf) do
    if map_size(perf) > 0 do
      top = perf
            |> Enum.sort_by(fn {_, v} -> v end, :desc)
            |> Enum.take(5)
            |> Enum.map(fn {agent, count} -> "  #{agent}: #{count}건" end)
            |> Enum.join("\n")

      Logger.info("[TeamLead] 에이전트 실패 현황 (누적):\n#{top}")
    end
  end

  defp to_float(nil), do: 0.0
  defp to_float(v) when is_float(v), do: v
  defp to_float(v), do: v |> to_string() |> Float.parse() |> elem(0)

  defp format_krw(v) do
    v = round(v)
    "₩#{:erlang.integer_to_binary(v) |> to_string() |> String.reverse() |> String.graphemes() |> Enum.chunk_every(3) |> Enum.join(",") |> String.reverse()}"
  rescue
    _ -> "₩#{round(v)}"
  end
end
