defmodule Luna.V2.Agents.Argos do
  @moduledoc """
  Shadow/parallel multi-signal screening agent.

  Scores candidates concurrently for observation and writes latest screening
  output to L1 WorkingMemory. It does not approve orders.
  """

  use GenServer

  @agent "argos"
  @memory_key "agent:argos:latest"
  @default_interval_ms 60_000

  def start_link(opts \\ []) do
    name = Keyword.get(opts, :name, __MODULE__)
    GenServer.start_link(__MODULE__, opts, name: name)
  end

  def tick(server \\ __MODULE__, candidates \\ []) do
    GenServer.call(server, {:tick, candidates})
  end

  def snapshot(server \\ __MODULE__), do: GenServer.call(server, :snapshot)

  def screen(candidates \\ []) do
    scored =
      candidates
      |> Task.async_stream(&score_candidate/1, max_concurrency: 8, timeout: 2_000)
      |> Enum.map(fn
        {:ok, result} -> result
        {:exit, _} -> %{symbol: nil, argos_score: 0.0, decision: :screen_error}
      end)
      |> Enum.sort_by(& &1.argos_score, :desc)

    %{
      agent: @agent,
      shadow: true,
      mutate: false,
      count: length(scored),
      accepted: Enum.count(scored, &(&1.decision == :watchlist_candidate)),
      candidates: scored,
      computed_at: now_iso()
    }
  end

  @impl true
  def init(opts) do
    state = %{
      latest: screen([]),
      interval_ms: Keyword.get(opts, :interval_ms, @default_interval_ms),
      auto_tick: Keyword.get(opts, :auto_tick, true)
    }

    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:ok, state}
  end

  @impl true
  def handle_call({:tick, candidates}, _from, state) do
    latest = screen(candidates)
    write_memory(latest)
    {:reply, latest, %{state | latest: latest}}
  end

  def handle_call(:snapshot, _from, state), do: {:reply, state.latest, state}

  @impl true
  def handle_info(:tick, state) do
    latest = screen([])
    write_memory(latest)
    if state.auto_tick, do: schedule_tick(state.interval_ms)
    {:noreply, %{state | latest: latest}}
  end

  defp score_candidate(candidate) do
    base = number(get_value(candidate, :score, 0.5), 0.5)
    confidence = number(get_value(candidate, :confidence, base), base)
    liquidity = number(get_value(candidate, :liquidity_score, 0.5), 0.5)
    risk = number(get_value(candidate, :risk_score, 0.0), 0.0)
    score = clamp(base * 0.45 + confidence * 0.3 + liquidity * 0.2 - risk * 0.25, 0.0, 1.0)

    candidate
    |> Map.put(:argos_score, Float.round(score, 4))
    |> Map.put(:decision, if(score >= 0.55, do: :watchlist_candidate, else: :reject))
    |> Map.put(:screened_by, @agent)
  end

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
  defp now_iso, do: DateTime.utc_now() |> DateTime.truncate(:second) |> DateTime.to_iso8601()
end
