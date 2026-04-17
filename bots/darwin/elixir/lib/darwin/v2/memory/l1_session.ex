defmodule Darwin.V2.Memory.L1 do
  @moduledoc """
  L1 세션 메모리 — ETS 기반 단기 컨텍스트 저장.
  현재 연구 사이클 내 분석 컨텍스트를 캐싱하고
  사이클 완료 시 L2(pgvector)로 중요 항목 승격.

  sigma/v2/memory/l1_session.ex 패턴 + darwin 특화 API.
  """

  use GenServer
  require Logger

  @table :darwin_v2_session
  @max_entries 500

  # ──────────────────────────────────────────────
  # Public API
  # ──────────────────────────────────────────────

  def start_link(_opts \\ []), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  @doc "키-값 저장."
  @spec put(term(), term()) :: true
  def put(key, value), do: :ets.insert(@table, {key, value})

  @doc "키로 값 조회."
  @spec get(term()) :: {:ok, term()} | :error
  def get(key) do
    case :ets.lookup(@table, key) do
      [{_, value}] -> {:ok, value}
      [] -> :error
    end
  end

  @doc "모든 엔트리 반환."
  @spec all() :: [{term(), term()}]
  def all, do: :ets.tab2list(@table)

  @doc "세션 전체 초기화."
  @spec clear() :: true
  def clear, do: :ets.delete_all_objects(@table)

  @doc """
  중요 항목을 L2로 승격 (importance >= threshold인 항목만).
  값이 map이고 :importance 키를 가진 항목만 대상.
  """
  @spec flush_to_l2(float()) :: {:ok, integer()}
  def flush_to_l2(threshold \\ 0.7) do
    items =
      all()
      |> Enum.filter(fn {_key, value} ->
        is_map(value) and (value[:importance] || 0.0) >= threshold
      end)

    Enum.each(items, fn {_key, value} ->
      content = value[:content] || inspect(value)
      team = value[:team] || "darwin"
      memory_type = value[:memory_type] || :semantic
      importance = value[:importance] || threshold
      context = value[:context] || %{}
      tags = value[:tags] || []

      Logger.debug("[다윈V2 메모리L1] L2 승격 — importance=#{importance} type=#{memory_type}")

      Darwin.V2.Memory.L2.store(team, content, memory_type,
        importance: importance,
        context: context,
        tags: tags
      )
    end)

    Logger.info("[다윈V2 메모리L1] L2 flush 완료 — #{length(items)}개 승격 (threshold=#{threshold})")
    {:ok, length(items)}
  end

  @doc "타입별 항목 저장 (GenServer cast 경유, ETS에도 기록)."
  @spec store(atom(), map(), keyword()) :: :ok
  def store(type, content, opts \\ []) do
    GenServer.cast(__MODULE__, {:store, type, content, opts})
  end

  @doc "타입별 항목 조회."
  @spec recall(atom(), keyword()) :: [map()]
  def recall(type, opts \\ []) do
    GenServer.call(__MODULE__, {:recall, type, opts})
  end

  @doc "현재 사이클 상태 요약."
  @spec cycle_summary() :: map()
  def cycle_summary, do: GenServer.call(__MODULE__, :cycle_summary)

  @doc "새 사이클 시작 시 세션 초기화."
  @spec reset_cycle() :: :ok
  def reset_cycle, do: GenServer.cast(__MODULE__, :reset_cycle)

  # ──────────────────────────────────────────────
  # GenServer callbacks
  # ──────────────────────────────────────────────

  @impl GenServer
  def init(_) do
    :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    Logger.info("[다윈V2 메모리L1] ETS 테이블 초기화: #{@table}")
    {:ok, %{entries: [], cycle_start: DateTime.utc_now(), cycle_count: 0}}
  end

  @impl GenServer
  def handle_cast({:store, type, content, opts}, state) do
    importance = Keyword.get(opts, :importance, 0.5)
    entry = %{
      type: type,
      content: content,
      importance: importance,
      stored_at: DateTime.utc_now()
    }

    # ETS에도 동기화 (키 = {type, 타임스탬프})
    key = {type, System.monotonic_time()}
    :ets.insert(@table, {key, Map.merge(entry, %{team: "darwin", memory_type: type})})

    entries = [entry | state.entries] |> Enum.take(@max_entries)
    {:noreply, %{state | entries: entries}}
  end

  def handle_cast(:reset_cycle, state) do
    :ets.delete_all_objects(@table)
    Logger.info("[다윈V2 메모리L1] 사이클 초기화 (이전 #{length(state.entries)}개 항목 삭제)")
    {:noreply, %{state | entries: [], cycle_start: DateTime.utc_now(), cycle_count: state.cycle_count + 1}}
  end

  @impl GenServer
  def handle_call({:recall, type, opts}, _from, state) do
    limit = Keyword.get(opts, :limit, 50)
    min_importance = Keyword.get(opts, :min_importance, 0.0)

    results =
      state.entries
      |> Enum.filter(fn e -> e.type == type and e.importance >= min_importance end)
      |> Enum.take(limit)

    {:reply, results, state}
  end

  def handle_call(:cycle_summary, _from, state) do
    by_type = Enum.group_by(state.entries, & &1.type)
    summary = %{
      total: length(state.entries),
      by_type: Map.new(by_type, fn {k, v} -> {k, length(v)} end),
      cycle_start: state.cycle_start,
      cycle_count: state.cycle_count
    }
    {:reply, summary, state}
  end
end
