defmodule TeamJay.Diagnostics do
  @moduledoc """
  BEAM 프로세스 상태 점검 + 이상 알림.
  """
  use GenServer
  require Logger

  @check_interval 30_000
  @msg_queue_warn 100
  @memory_warn 100_000_000

  defstruct [:checks, :alerts, :last_check]

  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @impl true
  def init(_opts) do
    Logger.info("[Diagnostics] BEAM 모니터링 시작!")
    schedule_check()
    {:ok, %__MODULE__{checks: [], alerts: [], last_check: nil}}
  end

  @impl true
  def handle_info(:check, state) do
    results = run_diagnostics()
    alerts = Enum.filter(results, &(&1.severity in [:warn, :error]))

    if length(alerts) > 0 do
      Logger.warning("[Diagnostics] #{length(alerts)}건 경고!")
      Enum.each(alerts, fn alert -> Logger.warning("  ⚠️ #{alert.name}: #{alert.message}") end)

      msg =
        alerts
        |> Enum.map(&("⚠️ #{&1.name}: #{&1.message}"))
        |> Enum.join("\n")

      _ = TeamJay.HubClient.post_alarm("🔍 Elixir 진단 경고!\n#{msg}", "claude", "diagnostics")
    end

    schedule_check()
    {:noreply, %{state | checks: results, alerts: alerts, last_check: DateTime.utc_now()}}
  end

  def get_status, do: GenServer.call(__MODULE__, :get_status)

  @impl true
  def handle_call(:get_status, _from, state), do: {:reply, state, state}

  defp run_diagnostics do
    [
      check_process_count(),
      check_memory(),
      check_supervisors(),
      check_message_queues()
    ]
    |> List.flatten()
  end

  defp check_process_count do
    count = :erlang.system_info(:process_count)
    limit = :erlang.system_info(:process_limit)

    %{
      name: "process_count",
      value: count,
      limit: limit,
      severity: if(count > limit * 0.8, do: :warn, else: :ok),
      message: "#{count}/#{limit} (#{Float.round(count / limit * 100, 1)}%)"
    }
  end

  defp check_memory do
    mem = :erlang.memory()
    total = mem[:total]

    %{
      name: "memory_total",
      value: total,
      severity: if(total > @memory_warn, do: :warn, else: :ok),
      message: "#{Float.round(total / 1_000_000, 1)}MB"
    }
  end

  defp check_supervisors do
    supervisors = [TeamJay.Teams.SkaSupervisor]

    Enum.map(supervisors, fn sup ->
      case Process.whereis(sup) do
        nil ->
          %{name: "supervisor_#{inspect(sup)}", severity: :error, message: "프로세스 없음!"}

        pid ->
          children = Supervisor.count_children(pid)

          %{
            name: "supervisor_#{inspect(sup)}",
            severity: :ok,
            message: "active=#{children[:active]} workers=#{children[:workers]}"
          }
      end
    end)
  end

  defp check_message_queues do
    processes = [
      TeamJay.EventLake,
      TeamJay.MarketRegime,
      TeamJay.Agents.Andy,
      TeamJay.Agents.Jimmy
    ]

    Enum.map(processes, fn mod ->
      case Process.whereis(mod) do
        nil ->
          %{name: "msgq_#{inspect(mod)}", severity: :warn, message: "프로세스 없음"}

        pid ->
          {:message_queue_len, len} = Process.info(pid, :message_queue_len)

          %{
            name: "msgq_#{inspect(mod)}",
            value: len,
            severity: if(len > @msg_queue_warn, do: :warn, else: :ok),
            message: "큐=#{len}"
          }
      end
    end)
  end

  defp schedule_check, do: Process.send_after(self(), :check, @check_interval)
end

