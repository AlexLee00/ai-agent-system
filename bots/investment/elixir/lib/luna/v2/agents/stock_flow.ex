defmodule Luna.V2.Agents.StockFlow do
  @moduledoc """
  Shadow/parallel stock and volume-flow agent.

  This agent observes KIS-style quote/volume context and writes a latest
  snapshot to L1 WorkingMemory. It never mutates orders or portfolio state.
  """

  use GenServer
  require Logger

  @agent "stock-flow"
  @memory_key "agent:stock-flow:latest"
  @default_interval_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def tick(server \\ __MODULE__, event \\ %{}) do
    GenServer.call(server, {:tick, event})
  end

  def snapshot(server \\ __MODULE__) do
    GenServer.call(server, :snapshot)
  end

  def analyze(event \\ %{}) do
    volume_ratio = number(get_value(event, :volume_ratio, 1.0), 1.0)
    quote_change = number(get_value(event, :quote_change_pct, 0.0), 0.0)
    scout_score = number(get_value(event, :scout_score, 0.0), 0.0)
    flow_score = clamp(quote_change * 1.4 + (volume_ratio - 1.0) * 0.25 + scout_score * 0.35, -1.0, 1.0)

    pressure =
      cond do
        flow_score >= 0.55 -> :accumulation_watch
        flow_score <= -0.55 -> :distribution_watch
        true -> :neutral
      end

    %{
      agent: @agent,
      shadow: true,
      mutate: false,
      pressure: pressure,
      signal: signal_from_score(flow_score),
      flow_score: round4(flow_score),
      confidence: round4(min(1.0, abs(flow_score) + min(0.3, volume_ratio / 10))),
      evidence: %{
        volume_ratio: round4(volume_ratio),
        quote_change_pct: round4(quote_change),
        scout_score: round4(scout_score)
      },
      computed_at: now_iso()
    }
  end

  @impl true
  def init(opts) do
    state = %{
      latest: analyze(%{}),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      auto_tick: Keyword.get(opts, :auto_tick, true)
    }

    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:tick, event}, _from, state) do
    latest = analyze(event)
    write_memory(latest)
    {:reply, latest, %{state | latest: latest}}
  end

  def handle_call(:snapshot, _from, state) do
    {:reply, state.latest, state}
  end

  @impl true
  def handle_info(:tick, state) do
    latest = analyze(%{})
    write_memory(latest)
    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:noreply, %{state | latest: latest}}
  end

  defp schedule_tick(interval_ms), do: Process.send_after(self(), :tick, max(1_000, interval_ms))

  defp write_memory(snapshot) do
    Luna.V2.Memory.WorkingMemory.put(@memory_key, snapshot)
  rescue
    _ -> :ok
  catch
    :exit, _ -> :ok
  end

  defp signal_from_score(score) when score >= 0.55, do: :BUY
  defp signal_from_score(score) when score <= -0.55, do: :SELL
  defp signal_from_score(_score), do: :HOLD

  defp get_value(map, key, fallback), do: Map.get(map, key, Map.get(map, Atom.to_string(key), fallback))
  defp number(value, _fallback) when is_number(value), do: value

  defp number(value, fallback) do
    case Float.parse(to_string(value)) do
      {parsed, _} -> parsed
      _ -> fallback
    end
  end

  defp clamp(value, min_value, max_value), do: max(min_value, min(max_value, value))
  defp round4(value), do: Float.round(value * 1.0, 4)
  defp now_iso, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
