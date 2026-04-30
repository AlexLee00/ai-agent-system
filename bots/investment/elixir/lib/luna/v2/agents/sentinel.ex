defmodule Luna.V2.Agents.Sentinel do
  @moduledoc """
  Shadow/parallel anomaly guard agent.

  Detects system/trading/security anomaly patterns and records observations
  without suppressing, retrying, or mutating runtime state.
  """

  use GenServer
  import Kernel, except: [inspect: 1]

  @agent "sentinel"
  @memory_key "agent:sentinel:latest"
  @default_interval_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def tick(server \\ __MODULE__, metrics \\ %{}) do
    GenServer.call(server, {:tick, metrics})
  end

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  def inspect(metrics \\ %{}) do
    error_count = number(get_value(metrics, :error_count, 0), 0)
    latency_ms = number(get_value(metrics, :latency_ms, 0), 0)
    failed_orders = number(get_value(metrics, :failed_orders, 0), 0)
    auth_failures = number(get_value(metrics, :auth_failures, 0), 0)
    reconcile_blockers = number(get_value(metrics, :reconcile_blockers, 0), 0)

    findings =
      []
      |> maybe_add(error_count > 0, :runtime_error_detected)
      |> maybe_add(latency_ms > 10_000, :latency_spike)
      |> maybe_add(failed_orders > 0, :trade_failure_detected)
      |> maybe_add(auth_failures > 0, :security_auth_failure)
      |> maybe_add(reconcile_blockers > 0, :manual_reconcile_blocker)

    severity =
      cond do
        auth_failures > 0 or reconcile_blockers > 0 -> :critical
        failed_orders > 0 or error_count > 0 -> :warning
        latency_ms > 10_000 -> :warning
        true -> :ok
      end

    %{
      agent: @agent,
      shadow: true,
      mutate: false,
      anomaly: findings != [],
      severity: severity,
      findings: Enum.reverse(findings),
      evidence: %{
        error_count: error_count,
        latency_ms: latency_ms,
        failed_orders: failed_orders,
        auth_failures: auth_failures,
        reconcile_blockers: reconcile_blockers
      },
      computed_at: now_iso()
    }
  end

  @impl true
  def init(opts) do
    state = %{
      latest: inspect(%{}),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      auto_tick: Keyword.get(opts, :auto_tick, true)
    }

    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:tick, metrics}, _from, state) do
    latest = inspect(metrics)
    write_memory(latest)
    {:reply, latest, %{state | latest: latest}}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state.latest, state}

  @impl true
  def handle_info(:tick, state) do
    latest = inspect(%{})
    write_memory(latest)
    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:noreply, %{state | latest: latest}}
  end

  defp maybe_add(items, true, item), do: [item | items]
  defp maybe_add(items, false, _item), do: items
  defp schedule_tick(interval_ms), do: Process.send_after(self(), :tick, max(1_000, interval_ms))

  defp write_memory(snapshot) do
    Luna.V2.Memory.WorkingMemory.put(@memory_key, snapshot)
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  defp get_value(map, key, fallback), do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))
  defp number(value, _fallback) when is_number(value), do: value

  defp number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      _ -> fallback
    end
  end

  defp now_iso, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
