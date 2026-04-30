defmodule Luna.V2.Agents.Sweeper do
  @moduledoc """
  Shadow/parallel ledger and wallet parity agent.

  It classifies wallet-only balances, tiny dust, and external liquidation drift
  without applying reconciliation or dust conversion.
  """

  use GenServer

  @agent "sweeper"
  @memory_key "agent:sweeper:latest"
  @default_interval_ms 300_000
  @dust_threshold_usdt 10.0

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def tick(server \\ __MODULE__, ledger \\ %{}, wallet \\ %{}) do
    GenServer.call(server, {:tick, ledger, wallet})
  end

  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  def compare(ledger \\ %{}, wallet \\ %{}) do
    ledger_qty = number(get_value(ledger, :quantity, 0.0), 0.0)
    wallet_qty = number(get_value(wallet, :quantity, 0.0), 0.0)
    mark_price = number(get_value(wallet, :mark_price, get_value(ledger, :mark_price, 0.0)), 0.0)
    delta = wallet_qty - ledger_qty
    delta_value = abs(delta) * mark_price

    state =
      cond do
        abs(delta) <= 1.0e-8 -> :in_sync
        ledger_qty <= 1.0e-8 and wallet_qty > 0 and delta_value <= @dust_threshold_usdt -> :wallet_only_dust
        ledger_qty <= 1.0e-8 and wallet_qty > 0 -> :wallet_only_balance
        wallet_qty <= 1.0e-8 and ledger_qty > 0 -> :external_close_suspected
        true -> :drift_detected
      end

    %{
      agent: @agent,
      shadow: true,
      mutate: false,
      state: state,
      delta: Float.round(delta, 12),
      delta_value_usdt: Float.round(delta_value, 6),
      dust_threshold_usdt: @dust_threshold_usdt,
      action_plan: action_plan(state),
      computed_at: now_iso()
    }
  end

  @impl true
  def init(opts) do
    state = %{
      latest: compare(%{}, %{}),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      auto_tick: Keyword.get(opts, :auto_tick, true)
    }

    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:tick, ledger, wallet}, _from, state) do
    latest = compare(ledger, wallet)
    write_memory(latest)
    {:reply, latest, %{state | latest: latest}}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state.latest, state}

  @impl true
  def handle_info(:tick, state) do
    latest = compare(%{}, %{})
    write_memory(latest)
    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:noreply, %{state | latest: latest}}
  end

  defp action_plan(:in_sync), do: :none
  defp action_plan(:wallet_only_dust), do: :observe_or_manual_dust_sync
  defp action_plan(:wallet_only_balance), do: :manual_reconcile_required
  defp action_plan(:external_close_suspected), do: :manual_reconcile_required
  defp action_plan(:drift_detected), do: :manual_reconcile_required

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
