defmodule Sigma.V2.Memory do
  @moduledoc """
  Sigma V2 Memory 파사드 — L1(ETS 세션) + L2(pgvector 장기) 통합.
  Phase 3: Strict Write (effectiveness 기반 계층 분류).
  참조: bots/sigma/docs/PLAN.md §6 Phase 3
  """

  @doc "메모리 저장. type: :semantic | :episodic | :procedural"
  def store(type, content, opts \\ []) do
    importance = Keyword.get(opts, :importance, 0.5)
    key = "#{type}:#{Ecto.UUID.generate()}"

    Sigma.V2.Memory.L1.put(key, %{
      type: type,
      content: content,
      importance: importance,
      stored_at: DateTime.utc_now(),
      opts: opts
    })

    if importance >= 0.7 do
      Sigma.V2.Memory.L2.run(%{
        operation: :store,
        content: serialize_content(content),
        team: "sigma",
        top_k: 5
      }, %{})
    end

    :ok
  end

  @doc "store/3 별칭."
  def remember(content, type, opts \\ []), do: store(type, content, opts)

  @doc "메모리 회수. type 원자 또는 쿼리 맵."
  def recall(type_or_query, opts_or_map \\ [])

  def recall(type, opts) when is_atom(type) do
    query = Keyword.get(opts, :query, "")
    limit = Keyword.get(opts, :limit, 10)
    threshold = Keyword.get(opts, :threshold, 0.3)

    if query != "" do
      case Sigma.V2.Memory.L2.run(%{
             operation: :retrieve,
             content: query,
             team: "sigma",
             top_k: limit
           }, %{}) do
        {:ok, %{hits: hits}} ->
          Enum.filter(hits, fn h ->
            (h[:quality_score] || h["quality_score"] || 0.5) >= threshold
          end)
        _ -> []
      end
    else
      Sigma.V2.Memory.L1.all()
      |> Enum.filter(fn {_k, v} ->
        is_map(v) and v[:type] == type
      end)
      |> Enum.map(fn {_, v} -> v end)
      |> Enum.take(limit)
    end
  end

  def recall(query, opts) when is_binary(query) do
    limit = Keyword.get(opts, :limit, 10)
    threshold = Keyword.get(opts, :threshold, 0.3)

    case Sigma.V2.Memory.L2.run(%{
           operation: :retrieve,
           content: query,
           team: "sigma",
           top_k: limit,
           threshold: threshold
         }, %{}) do
      {:ok, %{hits: hits}} ->
        Enum.filter(hits, fn h ->
          (h[:quality_score] || h["quality_score"] || 0.5) >= threshold
        end)
      _ -> []
    end
  end

  def recall(_query_map, _opts), do: []

  @doc """
  Strict Write — effectiveness 기반 메모리 계층 분류.
  eff >= 0.3  → semantic (영구)
  eff 0~0.3  → episodic (30일)
  eff < 0    → procedural AVOID + Reflexion 트리거
  """
  def persist_to_memory(feedback, outcome) do
    eff = outcome[:effectiveness] || 0.0
    summary = summarize(feedback)

    cond do
      eff >= 0.3 ->
        store(:semantic, summary, importance: min(eff, 1.0))

      eff >= 0 ->
        store(:episodic, summary,
          importance: 0.3,
          expires_in: :timer.hours(24 * 30)
        )

      true ->
        # 실패 → procedural AVOID + Reflexion 자동 생성
        store(:procedural, "AVOID: #{summary}", importance: 0.75)
        # Reflexion은 RollbackScheduler가 호출하므로 여기서는 저장만
    end

    :ok
  end

  # ---

  defp summarize(feedback) when is_map(feedback) do
    team = feedback[:target_team] || feedback[:team] || "unknown"
    type = feedback[:feedback_type] || "general"
    content = feedback[:content] || inspect(feedback)
    "#{team}/#{type}: #{String.slice(serialize_content(content), 0, 200)}"
  end
  defp summarize(other), do: String.slice(serialize_content(other), 0, 200)

  defp serialize_content(value) when is_binary(value), do: value
  defp serialize_content(value) when is_atom(value), do: Atom.to_string(value)
  defp serialize_content(value) when is_number(value), do: to_string(value)
  defp serialize_content(value) when is_map(value) or is_list(value), do: inspect(value)
  defp serialize_content(value), do: inspect(value)
end
