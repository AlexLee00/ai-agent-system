defmodule Sigma.V2.Memory.L1 do
  @moduledoc """
  L1 세션 메모리 — ETS 기반 단기 컨텍스트 저장.
  현재 runDaily() 세션 내 분석 컨텍스트를 캐싱하고
  세션 종료 시 L2(pgvector)로 중요 항목 승격.
  """

  use GenServer

  @table :sigma_v2_session

  def start_link(_opts), do: GenServer.start_link(__MODULE__, nil, name: __MODULE__)

  def init(_) do
    table = :ets.new(@table, [:set, :public, :named_table, read_concurrency: true])
    {:ok, %{table: table}}
  end

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

  @doc "세션 전체 초기화."
  @spec clear() :: true
  def clear, do: :ets.delete_all_objects(@table)

  @doc "모든 엔트리 반환."
  @spec all() :: [{term(), term()}]
  def all, do: :ets.tab2list(@table)

  @doc "중요 항목을 L2로 승격 (importance >= threshold인 항목만)."
  @spec flush_to_l2(float()) :: {:ok, integer()}
  def flush_to_l2(threshold \\ 0.7) do
    items =
      all()
      |> Enum.filter(fn {_key, value} ->
        is_map(value) and (value[:importance] || 0.0) >= threshold
      end)

    Enum.each(items, fn {_key, value} ->
      content = value[:content] || inspect(value)
      team = value[:team] || "sigma"

      Sigma.V2.Memory.L2.run(
        %{operation: :store, content: content, team: team, top_k: 5},
        %{}
      )
    end)

    {:ok, length(items)}
  end
end
