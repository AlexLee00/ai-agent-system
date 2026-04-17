defmodule Darwin.V2.RollbackScheduler do
  @moduledoc """
  다윈 V2 롤백 스케줄러 — 비정상 상태 감지 시 자동 롤백 트리거.
  자율 레벨 강등 조건 모니터링.
  """

  use GenServer
  require Logger

  @check_interval_ms 300_000

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl GenServer
  def init(_opts) do
    schedule_check()
    Logger.info("[darwin/rollback] 롤백 스케줄러 시작")
    {:ok, %{checks: 0, rollbacks: 0}}
  end

  @impl GenServer
  def handle_info(:check, state) do
    new_state = do_health_check(state)
    schedule_check()
    {:noreply, new_state}
  end

  # ---

  defp do_health_check(state) do
    checks = state.checks + 1

    rollbacks =
      case Darwin.V2.LLM.CostTracker.check_budget() do
        {:error, :budget_exceeded} ->
          Logger.warning("[darwin/rollback] 예산 초과 감지 — L3 강등")
          Darwin.V2.AutonomyLevel.record_failure(:budget_exceeded)
          state.rollbacks + 1

        _ ->
          state.rollbacks
      end

    %{state | checks: checks, rollbacks: rollbacks}
  rescue
    _ -> state
  end

  defp schedule_check do
    Process.send_after(self(), :check, @check_interval_ms)
  end
end
