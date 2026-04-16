defmodule TeamJay.Ska.Naver.NaverMonitor do
  @moduledoc """
  네이버 예약 모니터 GenServer

  Phase 1 역할:
    - PortAgent(:andy) 사이클 결과 수신 (PubSub)
    - 예약 상태 변화 감지 → SkaBus 브로드캐스트
    - 세션 상태 추적 → NaverSession 연동
    - 사이클 KPI 누적 (성공률, 응답시간)

  PortAgent(:andy)가 실행 완료 시 이벤트를 발행하면 여기서 수신.
  """

  use GenServer
  require Logger

  @cycle_window 20  # 최근 N 사이클 KPI 유지

  defstruct [
    :phase,
    :stats,
    :last_cycle_at,
    :session_status,
    :recent_cycles
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "최근 사이클 결과 목록"
  def get_recent_cycles(limit \\ 10) do
    GenServer.call(__MODULE__, {:get_recent_cycles, limit})
  end

  @doc "모니터 상태 조회"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @doc "사이클 완료 보고 (PortAgent에서 직접 호출 또는 PubSub 수신)"
  def report_cycle(result) when is_map(result) do
    GenServer.cast(__MODULE__, {:cycle_result, result})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[NaverMonitor] 시작! 네이버 예약 모니터링")
    # SkaBus에서 andy PortAgent 결과 구독
    TeamJay.Ska.PubSub.subscribe(:failure_reported)
    TeamJay.Ska.PubSub.subscribe(:phase_changed)

    {:ok, %__MODULE__{
      phase: 1,
      stats: %{
        total_cycles: 0,
        success_cycles: 0,
        failed_cycles: 0,
        new_bookings: 0,
        cancelled_bookings: 0
      },
      last_cycle_at: nil,
      session_status: :unknown,
      recent_cycles: []
    }}
  end

  @impl true
  def handle_cast({:cycle_result, result}, state) do
    success? = Map.get(result, :success, false)
    new_bookings = Map.get(result, :new_bookings, 0)
    cancelled = Map.get(result, :cancelled_bookings, 0)

    new_stats = %{state.stats |
      total_cycles: state.stats.total_cycles + 1,
      success_cycles: state.stats.success_cycles + (if success?, do: 1, else: 0),
      failed_cycles: state.stats.failed_cycles + (if success?, do: 0, else: 1),
      new_bookings: state.stats.new_bookings + new_bookings,
      cancelled_bookings: state.stats.cancelled_bookings + cancelled
    }

    cycle_entry = Map.merge(result, %{recorded_at: DateTime.utc_now()})
    recent = Enum.take([cycle_entry | state.recent_cycles], @cycle_window)

    if new_bookings > 0 do
      TeamJay.Ska.PubSub.broadcast(:naver_new_bookings, %{
        count: new_bookings,
        bookings: Map.get(result, :bookings, [])
      })
    end

    {:noreply, %{state |
      stats: new_stats,
      last_cycle_at: DateTime.utc_now(),
      recent_cycles: recent
    }}
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    if Map.get(payload, :agent) == "andy" do
      new_session_status = case Map.get(payload, :error_type) do
        :auth_expired -> :expired
        :network_error -> :degraded
        _ -> state.session_status
      end
      {:noreply, %{state | session_status: new_session_status}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({:ska_event, :phase_changed, %{new_phase: new_phase}}, state) do
    Logger.info("[NaverMonitor] Phase #{state.phase} → #{new_phase}")
    {:noreply, %{state | phase: new_phase}}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call({:get_recent_cycles, limit}, _from, state) do
    {:reply, Enum.take(state.recent_cycles, limit), state}
  end

  @impl true
  def handle_call(:get_status, _from, state) do
    success_rate =
      if state.stats.total_cycles > 0 do
        state.stats.success_cycles / state.stats.total_cycles
      else
        1.0
      end

    {:reply, %{
      phase: state.phase,
      stats: state.stats,
      success_rate: Float.round(success_rate, 3),
      session_status: state.session_status,
      last_cycle_at: state.last_cycle_at
    }, state}
  end
end
