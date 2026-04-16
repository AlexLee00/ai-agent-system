defmodule TeamJay.Ska.Pickko.PickkoMonitor do
  @moduledoc """
  픽코 키오스크 모니터 GenServer

  Phase 1 역할:
    - PortAgent(:jimmy) 사이클 결과 수신 (PubSub)
    - 주문/결제 상태 변화 감지
    - 키오스크 슬롯 차단 이벤트 추적
    - 사이클 KPI 누적 (처리 주문 수, 차단 슬롯 수)

  jimmmy(픽코 키오스크 모니터)가 5분 간격으로 실행되고
  결과를 SkaBus에 발행하면 여기서 수신하여 상태를 추적합니다.
  """

  use GenServer
  require Logger

  @cycle_window 20

  defstruct [
    :phase,
    :stats,
    :last_cycle_at,
    :kiosk_status,
    :recent_cycles
  ]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "모니터 상태 조회"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @doc "최근 사이클 조회"
  def get_recent_cycles(limit \\ 10) do
    GenServer.call(__MODULE__, {:get_recent_cycles, limit})
  end

  @doc "사이클 완료 보고"
  def report_cycle(result) when is_map(result) do
    GenServer.cast(__MODULE__, {:cycle_result, result})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[PickkoMonitor] 시작! 픽코 키오스크 모니터링")
    TeamJay.Ska.PubSub.subscribe(:failure_reported)
    TeamJay.Ska.PubSub.subscribe(:phase_changed)

    {:ok, %__MODULE__{
      phase: 1,
      stats: %{
        total_cycles: 0,
        success_cycles: 0,
        failed_cycles: 0,
        orders_processed: 0,
        slots_blocked: 0,
        slots_unblocked: 0
      },
      last_cycle_at: nil,
      kiosk_status: :unknown,
      recent_cycles: []
    }}
  end

  @impl true
  def handle_cast({:cycle_result, result}, state) do
    success? = Map.get(result, :success, false)
    orders = Map.get(result, :orders_processed, 0)
    blocked = Map.get(result, :slots_blocked, 0)
    unblocked = Map.get(result, :slots_unblocked, 0)

    new_stats = %{state.stats |
      total_cycles: state.stats.total_cycles + 1,
      success_cycles: state.stats.success_cycles + (if success?, do: 1, else: 0),
      failed_cycles: state.stats.failed_cycles + (if success?, do: 0, else: 1),
      orders_processed: state.stats.orders_processed + orders,
      slots_blocked: state.stats.slots_blocked + blocked,
      slots_unblocked: state.stats.slots_unblocked + unblocked
    }

    cycle_entry = Map.merge(result, %{recorded_at: DateTime.utc_now()})
    recent = Enum.take([cycle_entry | state.recent_cycles], @cycle_window)

    if blocked > 0 do
      TeamJay.Ska.PubSub.broadcast(:kiosk_slots_blocked, %{count: blocked})
    end

    {:noreply, %{state |
      stats: new_stats,
      last_cycle_at: DateTime.utc_now(),
      kiosk_status: (if success?, do: :ok, else: :degraded),
      recent_cycles: recent
    }}
  end

  @impl true
  def handle_info({:ska_event, :failure_reported, payload}, state) do
    if Map.get(payload, :agent) == "jimmy" do
      new_status = case Map.get(payload, :error_type) do
        :auth_expired -> :auth_expired
        :network_error -> :network_error
        _ -> :degraded
      end
      {:noreply, %{state | kiosk_status: new_status}}
    else
      {:noreply, state}
    end
  end

  @impl true
  def handle_info({:ska_event, :phase_changed, %{new_phase: new_phase}}, state) do
    {:noreply, %{state | phase: new_phase}}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

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
      kiosk_status: state.kiosk_status,
      last_cycle_at: state.last_cycle_at
    }, state}
  end

  @impl true
  def handle_call({:get_recent_cycles, limit}, _from, state) do
    {:reply, Enum.take(state.recent_cycles, limit), state}
  end
end
