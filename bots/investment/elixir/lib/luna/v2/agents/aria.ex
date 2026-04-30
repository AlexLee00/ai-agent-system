defmodule Luna.V2.Agents.Aria do
  @moduledoc """
  Shadow/parallel technical analysis agent.

  Uses deterministic indicator math only. No LLM calls and no trading mutation.
  """

  use GenServer

  @agent "aria"
  @memory_key "agent:aria:latest"
  @default_interval_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def tick(server \\ __MODULE__, indicators \\ %{}) do
    GenServer.call(server, {:tick, indicators})
  end

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  def score(indicators \\ %{}) do
    rsi = number(get_value(indicators, :rsi, 50), 50)
    macd = number(get_value(indicators, :macd_histogram, get_value(indicators, :macd, 0)), 0)
    bb_position = number(get_value(indicators, :bb_position, 0.5), 0.5)
    mtf = get_value(indicators, :timeframes, %{})
    mtf_score = multi_timeframe_score(mtf)
    raw_score = clamp((50 - rsi) / 50 * 0.35 + macd * 0.25 + (0.5 - bb_position) * 0.2 + mtf_score * 0.2, -1.0, 1.0)

    direction =
      cond do
        raw_score >= 0.35 -> :bullish_watch
        raw_score <= -0.35 -> :bearish_watch
        true -> :neutral
      end

    %{
      agent: @agent,
      shadow: true,
      mutate: false,
      direction: direction,
      score: round4(raw_score),
      confidence: round4(min(1.0, abs(raw_score) + 0.35)),
      evidence: %{
        rsi: round4(rsi),
        macd_histogram: round4(macd),
        bb_position: round4(bb_position),
        mtf_score: round4(mtf_score)
      },
      computed_at: now_iso()
    }
  end

  @impl true
  def init(opts) do
    state = %{
      latest: score(%{}),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      auto_tick: Keyword.get(opts, :auto_tick, true)
    }

    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:tick, indicators}, _from, state) do
    latest = score(indicators)
    write_memory(latest)
    {:reply, latest, %{state | latest: latest}}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state.latest, state}

  @impl true
  def handle_info(:tick, state) do
    latest = score(%{})
    write_memory(latest)
    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:noreply, %{state | latest: latest}}
  end

  defp multi_timeframe_score(map) when is_map(map) do
    values =
      map
      |> Map.values()
      |> Enum.map(fn
        :bullish -> 1.0
        "bullish" -> 1.0
        :bearish -> -1.0
        "bearish" -> -1.0
        value when is_number(value) -> value
        _ -> 0.0
      end)

    if length(values) == 0, do: 0.0, else: Enum.sum(values) / length(values)
  end

  defp multi_timeframe_score(_), do: 0.0
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

  defp clamp(value, min_value, max_value), do: max(min_value, min(max_value, value))
  defp round4(value), do: Float.round(value * 1.0, 4)
  defp now_iso, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
