defmodule Jay.V2.AutonomyController do
  @moduledoc """
  제이팀 자율화 단계 관리 GenServer.

  Phase 1 (감시):    일일 브리핑 + 모든 이벤트 텔레그램
  Phase 2 (반자율):  이상 시만 알림, 정상은 로그
  Phase 3 (자율):    주간 리포트만, 일일 완전 자율

  전환 조건:
    1 → 2: 7일 연속 이상 없음 (cross_pipeline 결정 escalate = 0)
    2 → 3: 30일 연속 마스터 개입 없음
  """

  use GenServer
  require Logger

  @phase_key "jay.autonomy_phase"
  @check_interval_ms 24 * 60 * 60 * 1_000  # 매일

  defstruct phase: 1,
            phase_since: nil,
            consecutive_clean_days: 0,
            last_escalation_at: nil,
            master_intervention_count: 0

  # ────────────────────────────────────────────────────────────────
  # 공개 API
  # ────────────────────────────────────────────────────────────────

  def start_link(_opts) do
    GenServer.start_link(__MODULE__, %{}, name: __MODULE__)
  end

  def get_phase, do: GenServer.call(__MODULE__, :get_phase)
  def get_status, do: GenServer.call(__MODULE__, :get_status)

  @doc "마스터 개입 기록 (수동 알람 응답 등)"
  def record_master_intervention do
    GenServer.cast(__MODULE__, :master_intervention)
  end

  @doc "이상 없는 하루 기록"
  def record_clean_day do
    GenServer.cast(__MODULE__, :clean_day)
  end

  @doc "일일 사이클에서 알림 발송 여부 결정"
  def should_send_daily_briefing? do
    GenServer.call(__MODULE__, :should_send_briefing)
  end

  @doc "크로스 파이프라인 이벤트 발송 여부 결정"
  def should_notify_pipeline?(decision) do
    GenServer.call(__MODULE__, {:should_notify_pipeline, decision})
  end

  # ────────────────────────────────────────────────────────────────
  # GenServer 콜백
  # ────────────────────────────────────────────────────────────────

  @impl true
  def init(_opts) do
    state = load_phase_from_db()
    Process.send_after(self(), :daily_check, @check_interval_ms)
    Logger.info("[AutonomyController] 시작! Phase #{state.phase} (#{phase_label(state.phase)})")
    {:ok, state}
  end

  @impl true
  def handle_call(:get_phase, _from, state) do
    {:reply, state.phase, state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, Map.from_struct(state), state}
  end

  @impl true
  def handle_call(:should_send_briefing, _from, state) do
    # Phase 1: 항상 발송
    # Phase 2: 항상 발송 (이상 여부는 내용으로 결정)
    # Phase 3: 월요일만 발송 (주간 리포트)
    send? = case state.phase do
      3 -> Date.day_of_week(Date.utc_today()) == 1  # 월요일
      _ -> true
    end
    {:reply, send?, state}
  end

  @impl true
  def handle_call({:should_notify_pipeline, decision}, _from, state) do
    notify? = case {state.phase, decision} do
      {1, _}          -> true                    # Phase 1: 모두 알림
      {2, :escalate}  -> true                    # Phase 2: escalate만
      {2, :block}     -> true                    # Phase 2: block만
      {3, :escalate}  -> true                    # Phase 3: escalate만
      _               -> false
    end
    {:reply, notify?, state}
  end

  @impl true
  def handle_cast(:master_intervention, state) do
    Logger.info("[AutonomyController] 마스터 개입 기록")
    new_state = %{state |
      master_intervention_count: state.master_intervention_count + 1,
      consecutive_clean_days: 0,
      last_escalation_at: DateTime.utc_now()
    }
    # Phase 3 → Phase 2 다운그레이드 검토
    new_state = if state.phase == 3 do
      Logger.warning("[AutonomyController] Phase 3 → Phase 2 다운그레이드 (마스터 개입)")
      broadcast_phase_change(3, 2)
      save_phase_to_db(2)
      %{new_state | phase: 2, phase_since: Date.utc_today()}
    else
      new_state
    end
    {:noreply, new_state}
  end

  @impl true
  def handle_cast(:clean_day, state) do
    days = state.consecutive_clean_days + 1
    new_state = %{state | consecutive_clean_days: days}

    # 전환 조건 체크
    new_state = cond do
      state.phase == 1 and days >= 7 ->
        Logger.info("[AutonomyController] Phase 1 → Phase 2 전환! (#{days}일 연속 이상 없음)")
        broadcast_phase_change(1, 2)
        save_phase_to_db(2)
        %{new_state | phase: 2, phase_since: Date.utc_today(), consecutive_clean_days: 0}

      state.phase == 2 and days >= 30 ->
        Logger.info("[AutonomyController] Phase 2 → Phase 3 전환! (#{days}일 연속 마스터 개입 없음)")
        broadcast_phase_change(2, 3)
        save_phase_to_db(3)
        %{new_state | phase: 3, phase_since: Date.utc_today(), consecutive_clean_days: 0}

      true -> new_state
    end

    {:noreply, new_state}
  end

  @impl true
  def handle_info(:daily_check, state) do
    check_and_maybe_advance(state)
    Process.send_after(self(), :daily_check, @check_interval_ms)
    {:noreply, state}
  end

  # ────────────────────────────────────────────────────────────────
  # 단계 전환 로직
  # ────────────────────────────────────────────────────────────────

  defp check_and_maybe_advance(_state) do
    # 오늘 escalation 없으면 clean_day 기록
    escalated_today = escalation_today?()
    unless escalated_today do
      record_clean_day()
    end
  end

  defp escalation_today? do
    today = Date.utc_today() |> Date.to_string()
    case Jay.Core.HubClient.pg_query("""
      SELECT COUNT(*)::int AS cnt
      FROM agent.event_lake
      WHERE event_type = 'decision.escalate'
        AND metadata->>'source' = 'jay.decision_engine'
        AND created_at >= '#{today}'::date
    """, "agent") do
      {:ok, %{"rows" => [%{"cnt" => n}]}} -> n > 0
      _ -> false
    end
  rescue
    _ -> false
  end

  # ────────────────────────────────────────────────────────────────
  # DB 영속화
  # ────────────────────────────────────────────────────────────────

  defp kv_store_available? do
    case Jay.Core.HubClient.pg_query("""
      SELECT to_regclass('agent.kv_store') AS table_name
    """, "agent") do
      {:ok, %{"rows" => [%{"table_name" => "agent.kv_store"}]}} -> true
      _ -> false
    end
  rescue
    _ -> false
  end

  defp load_phase_from_db do
    if not kv_store_available?() do
      %__MODULE__{phase: 1, phase_since: Date.utc_today()}
    else
      case Jay.Core.HubClient.pg_query("""
        SELECT value FROM agent.kv_store
        WHERE key = '#{@phase_key}'
        LIMIT 1
      """, "agent") do
        {:ok, %{"rows" => [%{"value" => v}]}} when is_integer(v) ->
          %__MODULE__{phase: v, phase_since: Date.utc_today()}
        _ ->
          %__MODULE__{phase: 1, phase_since: Date.utc_today()}
      end
    end
  rescue
    _ -> %__MODULE__{phase: 1, phase_since: Date.utc_today()}
  end

  defp save_phase_to_db(phase) do
    if not kv_store_available?() do
      :ok
    else
      Jay.Core.HubClient.pg_query("""
        INSERT INTO agent.kv_store (key, value, updated_at)
        VALUES ('#{@phase_key}', #{phase}, NOW())
        ON CONFLICT (key) DO UPDATE SET value = #{phase}, updated_at = NOW()
      """, "agent")
    end
  rescue
    _ -> :ok
  end

  defp broadcast_phase_change(from, to) do
    Jay.Core.HubClient.post_alarm(
      "🤖 [제이] 자율화 단계 전환!\n#{phase_label(from)} → #{phase_label(to)}",
      "jay", "autonomy_controller"
    )
    Jay.Core.EventLake.record(%{
      source: "jay.autonomy_controller",
      event_type: "autonomy.phase_changed",
      severity: "info",
      payload: %{from: from, to: to}
    })
  rescue
    _ -> :ok
  end

  defp phase_label(1), do: "Phase 1 감시"
  defp phase_label(2), do: "Phase 2 반자율"
  defp phase_label(3), do: "Phase 3 완전자율"
  defp phase_label(n), do: "Phase #{n}"
end
