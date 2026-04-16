defmodule TeamJay.Ska.Kiosk.KioskBlockFlow do
  @moduledoc """
  키오스크 차단 플로우 상태 머신

  Phase 1 역할:
    - 네이버 예약 → 픽코 차단 매핑 추적
    - 차단 상태 전이: :pending → :blocking → :blocked | :failed
    - 차단 해제 상태 전이: :blocked → :unblocking → :available | :failed
    - 미확인 차단(orphan) 감지 및 알림

  네이버에서 예약이 들어오면 픽코 키오스크 슬롯을
  자동으로 차단해야 합니다. 이 모듈이 그 흐름을 관리합니다.

  상태 전이:
    :pending    — 차단 대기 (네이버 예약 확인됨)
    :blocking   — 차단 진행중 (Playwright 실행중)
    :blocked    — 차단 완료
    :unblocking — 해제 진행중
    :available  — 해제 완료 (슬롯 사용 가능)
    :failed     — 실패 (수동 확인 필요)
  """

  use GenServer
  require Logger

  @orphan_check_interval_ms 300_000   # 5분마다 고아 차단 확인
  @orphan_threshold_minutes 30        # 30분 이상 :blocking 상태 = 고아

  defstruct [:blocks, :stats]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "신규 차단 요청 등록"
  def register_block(booking_id, slot_info) do
    GenServer.cast(__MODULE__, {:register_block, booking_id, slot_info})
  end

  @doc "차단 시작 보고"
  def report_blocking(booking_id) do
    GenServer.cast(__MODULE__, {:transition, booking_id, :blocking})
  end

  @doc "차단 완료 보고"
  def report_blocked(booking_id) do
    GenServer.cast(__MODULE__, {:transition, booking_id, :blocked})
  end

  @doc "차단 해제 시작"
  def request_unblock(booking_id) do
    GenServer.cast(__MODULE__, {:transition, booking_id, :unblocking})
  end

  @doc "해제 완료 보고"
  def report_available(booking_id) do
    GenServer.cast(__MODULE__, {:transition, booking_id, :available})
  end

  @doc "차단 실패 보고"
  def report_failed(booking_id, reason) do
    GenServer.cast(__MODULE__, {:failed, booking_id, reason})
  end

  @doc "특정 예약 차단 상태 조회"
  def get_block_status(booking_id) do
    GenServer.call(__MODULE__, {:get_block_status, booking_id})
  end

  @doc "전체 차단 현황 조회"
  def get_all_blocks do
    GenServer.call(__MODULE__, :get_all_blocks)
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[KioskBlockFlow] 시작! 차단 플로우 관리")
    TeamJay.Ska.PubSub.subscribe(:naver_new_bookings)
    Process.send_after(self(), :orphan_check, @orphan_check_interval_ms)

    {:ok, %__MODULE__{
      blocks: %{},
      stats: %{total: 0, blocked: 0, available: 0, failed: 0}
    }}
  end

  @impl true
  def handle_cast({:register_block, booking_id, slot_info}, state) do
    block = %{
      booking_id: booking_id,
      slot_info: slot_info,
      status: :pending,
      registered_at: DateTime.utc_now(),
      updated_at: DateTime.utc_now()
    }

    new_blocks = Map.put(state.blocks, booking_id, block)
    new_stats = %{state.stats | total: state.stats.total + 1}

    Logger.info("[KioskBlockFlow] 차단 등록: #{booking_id}")
    TeamJay.Ska.Kiosk.KioskAgent.enqueue_block(Map.put(slot_info, :booking_id, booking_id))

    {:noreply, %{state | blocks: new_blocks, stats: new_stats}}
  end

  @impl true
  def handle_cast({:transition, booking_id, new_status}, state) do
    case Map.get(state.blocks, booking_id) do
      nil ->
        Logger.warning("[KioskBlockFlow] 알 수 없는 booking_id: #{booking_id}")
        {:noreply, state}

      block ->
        updated = %{block | status: new_status, updated_at: DateTime.utc_now()}
        new_blocks = Map.put(state.blocks, booking_id, updated)
        new_stats = update_stats(state.stats, new_status)

        Logger.info("[KioskBlockFlow] #{booking_id}: #{block.status} → #{new_status}")
        {:noreply, %{state | blocks: new_blocks, stats: new_stats}}
    end
  end

  @impl true
  def handle_cast({:failed, booking_id, reason}, state) do
    case Map.get(state.blocks, booking_id) do
      nil -> {:noreply, state}
      block ->
        updated = %{block | status: :failed, updated_at: DateTime.utc_now(), failure_reason: reason}
        new_blocks = Map.put(state.blocks, booking_id, updated)
        new_stats = %{state.stats | failed: state.stats.failed + 1}

        Logger.error("[KioskBlockFlow] 차단 실패: #{booking_id} / #{inspect(reason)}")
        TeamJay.Ska.FailureTracker.report(%{
          agent: "jimmy",
          error_type: :selector_broken,
          message: "키오스크 차단 실패: #{booking_id}"
        })

        {:noreply, %{state | blocks: new_blocks, stats: new_stats}}
    end
  end

  @impl true
  def handle_info({:ska_event, :naver_new_bookings, %{bookings: bookings}}, state) do
    # 신규 네이버 예약 → 자동 차단 등록
    Enum.each(bookings, fn booking ->
      if booking_needs_block?(booking) do
        slot_info = extract_slot_info(booking)
        register_block(booking.booking_id, slot_info)
      end
    end)
    {:noreply, state}
  end

  @impl true
  def handle_info(:orphan_check, state) do
    Process.send_after(self(), :orphan_check, @orphan_check_interval_ms)
    now = DateTime.utc_now()

    orphans =
      state.blocks
      |> Enum.filter(fn {_id, block} ->
        block.status == :blocking and
          DateTime.diff(now, block.updated_at, :minute) >= @orphan_threshold_minutes
      end)

    unless Enum.empty?(orphans) do
      Logger.warning("[KioskBlockFlow] 고아 차단 #{length(orphans)}건 감지")
      TeamJay.HubClient.post_alarm(
        "⚠️ 키오스크 고아 차단 #{length(orphans)}건 (#{@orphan_threshold_minutes}분 이상 :blocking 상태)",
        "ska", "kiosk_block_flow"
      )
    end

    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call({:get_block_status, booking_id}, _from, state) do
    {:reply, Map.get(state.blocks, booking_id), state}
  end

  @impl true
  def handle_call(:get_all_blocks, _from, state) do
    {:reply, %{blocks: state.blocks, stats: state.stats}, state}
  end

  # ─── Private ─────────────────────────────────────────────

  defp booking_needs_block?(%{status: :new}), do: true
  defp booking_needs_block?(_), do: false

  defp extract_slot_info(booking) do
    %{
      date: Map.get(booking, :date),
      host: Map.get(booking, :host),
      guest_name: Map.get(booking, :guest_name)
    }
  end

  defp update_stats(stats, :blocked), do: %{stats | blocked: stats.blocked + 1}
  defp update_stats(stats, :available), do: %{stats | available: stats.available + 1,
                                                       blocked: max(stats.blocked - 1, 0)}
  defp update_stats(stats, _), do: stats
end
