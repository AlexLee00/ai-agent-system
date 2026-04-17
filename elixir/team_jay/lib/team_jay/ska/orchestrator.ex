defmodule TeamJay.Ska.Orchestrator do
  @moduledoc """
  스카팀 오케스트레이터
    - 일일 계획 브로드캐스트
    - 자율 단계 (Phase 1→2→3) 전환 관리
    - KPI 집계 + 주간 리포트 (Phase 3)

  자율 단계:
    Phase 1: 감시 모드 (복구율 50%+ 목표) — 모든 복구 텔레그램 알림
    Phase 2: 반자율 (복구율 80%+)         — 실패 복구만 알림
    Phase 3: 완전 자율 (복구율 95%+)      — 주간 리포트만

  KPI:
    파싱 성공률  Phase1: 90%+ | Phase2: 95%+ | Phase3: 99%+
    자동 복구율  Phase1: 50%+ | Phase2: 80%+ | Phase3: 95%+
    마스터 개입  매일     →    주 2회    →   월 0회
  """

  use GenServer
  require Logger

  @daily_check_interval_ms 86_400_000
  @weekly_report_interval_ms 604_800_000

  # Phase 전환 임계값 (복구율)
  @phase2_threshold 0.80
  @phase3_threshold 0.95

  defstruct [
    :phase,
    :phase_started_at,
    :kpi_history
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  def get_phase do
    GenServer.call(__MODULE__, :get_phase)
  end

  def get_kpi do
    GenServer.call(__MODULE__, :get_kpi)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[Orchestrator] 스카팀 오케스트레이터 시작!")
    # 2초 후 일일 브로드캐스트 (시작 알림)
    Process.send_after(self(), :daily_broadcast, 2_000)
    # 매일 KPI 체크
    Process.send_after(self(), :daily_kpi_check, @daily_check_interval_ms)

    state = %__MODULE__{
      phase: 1,
      phase_started_at: DateTime.utc_now(),
      kpi_history: []
    }
    {:ok, state}
  end

  @impl true
  def handle_info(:daily_broadcast, state) do
    broadcast_daily_status(state)
    Process.send_after(self(), :daily_broadcast, @daily_check_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_info(:daily_kpi_check, state) do
    new_state = check_phase_transition(state)
    Process.send_after(self(), :daily_kpi_check, @daily_check_interval_ms)
    {:noreply, new_state}
  end

  @impl true
  def handle_info(:weekly_report, state) do
    if state.phase == 3 do
      send_weekly_report(state)
    end
    Process.send_after(self(), :weekly_report, @weekly_report_interval_ms)
    {:noreply, state}
  end

  @impl true
  def handle_call(:get_phase, _from, state) do
    {:reply, state.phase, state}
  end

  @impl true
  def handle_call(:get_kpi, _from, state) do
    kpi = compute_kpi()
    {:reply, kpi, state}
  end

  # ─── Private: 일일 상태 브로드캐스트 ──────────────────────

  defp broadcast_daily_status(state) do
    kpi = compute_kpi()
    parse_rate = Float.round(kpi.parse_success_rate * 100, 1)
    recovery_rate = Float.round(kpi.recovery_rate * 100, 1)

    phase_emoji = case state.phase do
      1 -> "👁️ Phase 1 (감시)"
      2 -> "🤝 Phase 2 (반자율)"
      3 -> "🤖 Phase 3 (완전자율)"
    end

    msg = """
    ☀️ 스카팀 일일 브리핑 #{phase_emoji}
    📊 파싱 성공률: #{parse_rate}%
    🔄 자동 복구율: #{recovery_rate}%
    📅 #{Date.utc_today() |> Date.to_string()}
    """

    # Phase별 알림 전송
    case state.phase do
      1 -> Jay.Core.HubClient.post_alarm(msg, "ska", "orchestrator")
      2 -> Jay.Core.HubClient.post_alarm(msg, "ska", "orchestrator")
      3 -> :ok  # Phase 3: 주간 리포트만
    end

    Jay.Core.EventLake.record(%{
      event_type: "ska_daily_broadcast",
      team: "ska",
      bot_name: "orchestrator",
      severity: "info",
      title: "일일 브리핑",
      message: msg,
      tags: ["orchestrator", "daily", "phase#{state.phase}"],
      metadata: kpi
    })
  end

  # ─── Private: Phase 전환 체크 ─────────────────────────────

  defp check_phase_transition(state) do
    kpi = compute_kpi()

    cond do
      state.phase == 1 and kpi.recovery_rate >= @phase2_threshold ->
        Logger.info("[Orchestrator] Phase 1 → 2 전환! 복구율 #{kpi.recovery_rate}")
        do_phase_transition(state, 2, kpi)

      state.phase == 2 and kpi.recovery_rate >= @phase3_threshold ->
        Logger.info("[Orchestrator] Phase 2 → 3 전환! 복구율 #{kpi.recovery_rate}")
        # Phase 3 시작 시 주간 리포트 스케줄 등록
        Process.send_after(self(), :weekly_report, @weekly_report_interval_ms)
        do_phase_transition(state, 3, kpi)

      true ->
        %{state | kpi_history: [kpi | Enum.take(state.kpi_history, 29)]}
    end
  end

  defp do_phase_transition(state, new_phase, kpi) do
    TeamJay.Ska.PubSub.broadcast_phase_changed(state.phase, new_phase)
    TeamJay.Ska.FailureTracker.set_phase(new_phase)

    msg = """
    🎯 스카팀 Phase #{state.phase} → #{new_phase} 전환!
    복구율: #{Float.round(kpi.recovery_rate * 100, 1)}%
    파싱 성공률: #{Float.round(kpi.parse_success_rate * 100, 1)}%
    """
    Jay.Core.HubClient.post_alarm(msg, "ska", "orchestrator")

    %{state |
      phase: new_phase,
      phase_started_at: DateTime.utc_now(),
      kpi_history: [kpi | Enum.take(state.kpi_history, 29)]
    }
  end

  # ─── Private: 주간 리포트 (Phase 3) ──────────────────────

  defp send_weekly_report(_state) do
    kpi = compute_kpi()
    failure_stats = TeamJay.Ska.FailureTracker.get_stats()
    parse_stats = TeamJay.Ska.ParsingGuard.get_stats()

    msg = """
    📊 스카팀 주간 리포트 (Phase 3 완전자율)
    ─────────────────
    파싱 성공률: #{Float.round(kpi.parse_success_rate * 100, 1)}%
    자동 복구율: #{Float.round(kpi.recovery_rate * 100, 1)}%
    ─────────────────
    Level1 파싱: #{parse_stats.level1_ok}회 성공 / #{parse_stats.level1_fail}회 실패
    Level2 파싱: #{parse_stats.level2_ok}회 성공 / #{parse_stats.level2_fail}회 실패
    Level3(LLM): #{parse_stats.level3_ok}회 성공 / #{parse_stats.level3_fail}회 실패
    ─────────────────
    총 실패: #{failure_stats.total_failures}건
    자동 복구: #{failure_stats.auto_resolved}건
    ─────────────────
    #{Date.utc_today() |> Date.to_string()} 기준
    """

    Jay.Core.HubClient.post_alarm(msg, "ska", "orchestrator")
    Logger.info("[Orchestrator] 주간 리포트 발송 완료")
  end

  # ─── Private: KPI 계산 ────────────────────────────────────

  defp compute_kpi do
    stats = TeamJay.Ska.FailureTracker.get_stats()
    parse_stats = TeamJay.Ska.ParsingGuard.get_stats()

    total_parse = parse_stats.level1_ok + parse_stats.level1_fail +
                  parse_stats.level2_ok + parse_stats.level2_fail +
                  parse_stats.level3_ok + parse_stats.level3_fail

    ok_parse = parse_stats.level1_ok + parse_stats.level2_ok + parse_stats.level3_ok

    parse_success_rate = if total_parse > 0, do: ok_parse / total_parse, else: 1.0

    total_failures = stats.total_failures
    recovery_rate = if total_failures > 0 do
      stats.auto_resolved / total_failures
    else
      1.0
    end

    %{
      parse_success_rate: parse_success_rate,
      recovery_rate: recovery_rate,
      total_failures: total_failures,
      auto_resolved: stats.auto_resolved,
      by_type: stats.by_type,
      computed_at: DateTime.utc_now()
    }
  end
end
