defmodule Luna.V2.Memory.WorkingMemory do
  @moduledoc """
  Layer 1 Working Memory (GenServer).

  - put/get/delete API
  - TTL prune loop
  - kill switch: Luna.V2.KillSwitch.layer1_working_memory_enabled?/0
  """

  use GenServer
  require Logger

  alias Luna.V2.KillSwitch

  @default_ttl_ms 15 * 60 * 1000
  @default_prune_interval_ms 60 * 1000

  @type entry :: %{
          value: map(),
          expires_at_ms: non_neg_integer()
        }

  @spec start_link(keyword()) :: GenServer.on_start()
  def start_link(opts \\ []) do
    GenServer.start_link(__MODULE__, opts, name: __MODULE__)
  end

  @spec put(String.t(), map(), keyword()) :: :ok
  def put(key, value, opts \\ []) when is_binary(key) and is_map(value) do
    GenServer.call(__MODULE__, {:put, key, value, opts})
  end

  @spec get(String.t()) :: {:ok, map()} | :not_found
  def get(key) when is_binary(key) do
    GenServer.call(__MODULE__, {:get, key})
  end

  @spec delete(String.t()) :: :ok
  def delete(key) when is_binary(key) do
    GenServer.call(__MODULE__, {:delete, key})
  end

  @spec snapshot() :: map()
  def snapshot do
    GenServer.call(__MODULE__, :snapshot)
  end

  @impl true
  def init(_opts) do
    state = %{
      entries: %{},
      ttl_ms: KillSwitch.layer1_working_memory_ttl_ms() || @default_ttl_ms,
      prune_interval_ms:
        KillSwitch.layer1_working_memory_prune_interval_ms() || @default_prune_interval_ms
    }

    schedule_prune(state.prune_interval_ms)
    Logger.info("[working-memory] started ttl=#{state.ttl_ms}ms interval=#{state.prune_interval_ms}ms")
    {:ok, state}
  end

  @impl true
  def handle_call({:put, key, value, opts}, _from, state) do
    ttl_ms = normalize_ttl_ms(opts[:ttl_ms], state.ttl_ms)
    expires_at_ms = now_ms() + ttl_ms
    entry = %{value: value, expires_at_ms: expires_at_ms}
    next_entries = Map.put(state.entries, key, entry)
    {:reply, :ok, %{state | entries: next_entries}}
  end

  def handle_call({:get, key}, _from, state) do
    case Map.get(state.entries, key) do
      nil ->
        {:reply, :not_found, state}

      %{value: value, expires_at_ms: expires_at_ms} = _entry ->
        if expires_at_ms > now_ms() do
          {:reply, {:ok, value}, state}
        else
          {:reply, :not_found, %{state | entries: Map.delete(state.entries, key)}}
        end
    end
  end

  def handle_call({:delete, key}, _from, state) do
    {:reply, :ok, %{state | entries: Map.delete(state.entries, key)}}
  end

  def handle_call(:snapshot, _from, state) do
    live =
      state.entries
      |> Enum.filter(fn {_k, v} -> v.expires_at_ms > now_ms() end)
      |> Enum.into(%{}, fn {k, v} -> {k, v.value} end)

    {:reply, live, state}
  end

  @impl true
  def handle_info(:prune, state) do
    now = now_ms()
    next_entries =
      state.entries
      |> Enum.filter(fn {_k, v} -> v.expires_at_ms > now end)
      |> Enum.into(%{})

    schedule_prune(state.prune_interval_ms)
    {:noreply, %{state | entries: next_entries}}
  end

  defp schedule_prune(interval_ms) do
    Process.send_after(self(), :prune, max(1_000, interval_ms))
  end

  defp normalize_ttl_ms(nil, fallback), do: fallback
  defp normalize_ttl_ms(value, fallback) when is_integer(value), do: max(1_000, value)

  defp normalize_ttl_ms(value, fallback) do
    case Integer.parse(to_string(value)) do
      {parsed, _} -> max(1_000, parsed)
      _ -> fallback
    end
  end

  defp now_ms, do: System.system_time(:millisecond)
end

