defmodule TeamJay.Ska.Kiosk.KioskAgent do
  @moduledoc """
  키오스크 실행 GenServer

  Phase 1 역할:
    - 키오스크 슬롯 차단/해제 명령 큐 관리
    - 블록 플로우 상태 추적 (KioskBlockFlow 협력)
    - 실행 결과 기록 및 검증
    - 실패 시 FailureTracker 보고

  픽코 키오스크 관리 페이지에서 슬롯을 차단/해제하는
  Playwright 기반 Node.js PortAgent를 조율합니다.
  """

  use GenServer
  require Logger

  @queue_max 50

  defstruct [
    :command_queue,
    :current_command,
    :stats,
    :last_executed_at
  ]

  # 명령 타입
  @valid_commands [:block_slot, :unblock_slot, :verify_slot, :audit_today]

  # ─── Public API ──────────────────────────────────────────

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @doc "슬롯 차단 명령 큐에 추가"
  def enqueue_block(entry) when is_map(entry) do
    GenServer.cast(__MODULE__, {:enqueue, :block_slot, entry})
  end

  @doc "슬롯 해제 명령 큐에 추가"
  def enqueue_unblock(entry) when is_map(entry) do
    GenServer.cast(__MODULE__, {:enqueue, :unblock_slot, entry})
  end

  @doc "슬롯 검증 명령 큐에 추가"
  def enqueue_verify(entry) when is_map(entry) do
    GenServer.cast(__MODULE__, {:enqueue, :verify_slot, entry})
  end

  @doc "현재 상태 및 큐 조회"
  def get_status do
    GenServer.call(__MODULE__, :get_status)
  end

  @doc "명령 실행 결과 보고 (PortAgent 콜백)"
  def report_result(command_id, result) do
    GenServer.cast(__MODULE__, {:command_result, command_id, result})
  end

  # ─── Callbacks ───────────────────────────────────────────

  @impl true
  def init(_opts) do
    Logger.info("[KioskAgent] 시작! 키오스크 명령 큐 준비")
    TeamJay.Ska.PubSub.subscribe(:kiosk_slots_blocked)
    TeamJay.Ska.PubSub.subscribe(:audit_requested)

    {:ok, %__MODULE__{
      command_queue: :queue.new(),
      current_command: nil,
      stats: %{
        total_commands: 0,
        success: 0,
        failed: 0,
        blocks: 0,
        unblocks: 0
      },
      last_executed_at: nil
    }}
  end

  @impl true
  def handle_cast({:enqueue, type, entry}, state) when type in @valid_commands do
    if :queue.len(state.command_queue) >= @queue_max do
      Logger.warning("[KioskAgent] 명령 큐 초과! #{type} 드롭")
      {:noreply, state}
    else
      command = %{
        id: generate_command_id(),
        type: type,
        entry: entry,
        enqueued_at: DateTime.utc_now()
      }
      new_queue = :queue.in(command, state.command_queue)
      Logger.info("[KioskAgent] 명령 큐 추가: #{type} (#{:queue.len(new_queue)}개)")

      # 큐에 명령이 쌓이면 PortAgent에 실행 요청
      TeamJay.Ska.PubSub.broadcast(:kiosk_command_enqueued, %{
        command_id: command.id,
        type: type,
        agent: "jimmy"
      })

      {:noreply, %{state | command_queue: new_queue}}
    end
  end

  @impl true
  def handle_cast({:command_result, command_id, result}, state) do
    success? = Map.get(result, :success, false)
    command_type = Map.get(result, :type, :unknown)

    new_stats = %{state.stats |
      total_commands: state.stats.total_commands + 1,
      success: state.stats.success + (if success?, do: 1, else: 0),
      failed: state.stats.failed + (if success?, do: 0, else: 1),
      blocks: state.stats.blocks + (if command_type == :block_slot, do: 1, else: 0),
      unblocks: state.stats.unblocks + (if command_type == :unblock_slot, do: 1, else: 0)
    }

    unless success? do
      TeamJay.Ska.FailureTracker.report(%{
        agent: "jimmy",
        error_type: Map.get(result, :error_type, :unknown),
        message: "키오스크 명령 실패: #{command_type} / #{command_id}"
      })
    end

    {:noreply, %{state |
      stats: new_stats,
      current_command: nil,
      last_executed_at: DateTime.utc_now()
    }}
  end

  @impl true
  def handle_info({:ska_event, :audit_requested, %{type: :daily}}, state) do
    Logger.info("[KioskAgent] 일일 감사 요청 수신")
    # PortAgent에 감사 실행 요청
    TeamJay.Ska.PubSub.broadcast(:kiosk_command_enqueued, %{
      command_id: generate_command_id(),
      type: :audit_today,
      agent: "jimmy"
    })
    {:noreply, state}
  end

  @impl true
  def handle_info(_msg, state), do: {:noreply, state}

  @impl true
  def handle_call(:get_status, _from, state) do
    {:reply, %{
      queue_size: :queue.len(state.command_queue),
      current_command: state.current_command,
      stats: state.stats,
      last_executed_at: state.last_executed_at
    }, state}
  end

  # ─── Private ─────────────────────────────────────────────

  defp generate_command_id do
    :crypto.strong_rand_bytes(6) |> Base.encode16(case: :lower)
  end
end
