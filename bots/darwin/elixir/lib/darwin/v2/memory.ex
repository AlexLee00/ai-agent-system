defmodule Darwin.V2.Memory do
  @moduledoc """
  다윈 V2 메모리 통합 인터페이스.
  L1(ETS 세션) + L2(pgvector 장기) 통합 접근.
  """

  @doc "L1 세션 메모리에 저장."
  def store(key, value, opts \\ []) do
    importance = Keyword.get(opts, :importance, 0.5)
    entry = if is_map(value), do: Map.put(value, :importance, importance), else: %{value: value, importance: importance}
    Darwin.V2.Memory.L1.put(key, entry)
  end

  @doc "L1에서 조회. 없으면 L2 semantic search."
  def recall(key, opts \\ []) do
    case Darwin.V2.Memory.L1.get(key) do
      {:ok, value} -> {:ok, value}
      :error ->
        top_k = Keyword.get(opts, :limit, 5)
        Darwin.V2.Memory.L2.run(%{operation: :retrieve, content: to_string(key), team: "darwin", top_k: top_k}, %{})
    end
  end

  @doc "중요 항목을 L1 → L2로 승격."
  def flush(threshold \\ 0.7), do: Darwin.V2.Memory.L1.flush_to_l2(threshold)
end
