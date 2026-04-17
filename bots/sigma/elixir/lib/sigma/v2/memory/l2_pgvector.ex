defmodule Sigma.V2.Memory.L2 do
  @moduledoc """
  L2 장기 메모리 — pgvector 기반 Reflexion 노트 + RAG 검색.
  Qwen3-Embedding-0.6B (1024차원) 임베딩, cosine similarity 검색.
  """

  use Jido.Action,
    name: "sigma_v2_memory_recall",
    description: "Store and retrieve Reflexion notes via pgvector similarity search",
    schema: Zoi.object(%{
      operation: Zoi.enum([:store, :retrieve]) |> Zoi.required(),
      content: Zoi.optional(Zoi.string()),
      team: Zoi.optional(Zoi.string()),
      top_k: Zoi.default(Zoi.integer(), 5),
      threshold: Zoi.default(Zoi.float(), 0.3)
    })

  @embed_url "http://localhost:11434/api/embeddings"
  @embed_model "qwen3-embed-0.6b"

  @impl Jido.Action
  def run(%{operation: :store} = params, _ctx) do
    content = params.content || ""
    team = params.team || "sigma"

    case encode(content) do
      {:ok, embedding} ->
        result =
          TeamJay.Repo.query(
            """
            INSERT INTO agent_memory (team, content, embedding, memory_type, inserted_at, updated_at)
            VALUES ($1, $2, $3::vector, 'semantic', NOW(), NOW())
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            [team, content, embedding]
          )

        case result do
          {:ok, %{rows: [[id]]}} -> {:ok, %{stored: true, id: id}}
          _ -> {:ok, %{stored: false}}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  def run(%{operation: :retrieve} = params, _ctx) do
    query = params.content || ""
    top_k = params.top_k || 5
    threshold = params.threshold || 0.3

    case encode(query) do
      {:ok, embedding} ->
        sql = """
        SELECT content, metadata, 1 - (embedding <=> $1::vector) AS similarity
        FROM agent_memory
        WHERE 1 - (embedding <=> $1::vector) >= $2
        ORDER BY embedding <=> $1::vector ASC
        LIMIT $3
        """

        case TeamJay.Repo.query(sql, [embedding, threshold, top_k]) do
          {:ok, %{rows: rows}} ->
            hits =
              Enum.map(rows, fn [content, metadata, sim] ->
                %{content: content, metadata: metadata || %{}, similarity: sim}
              end)

            {:ok, %{hits: hits}}

          {:error, reason} ->
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  @doc "쿼리 텍스트를 Qwen3-Embedding-0.6B로 1024차원 벡터로 변환."
  @spec encode(String.t()) :: {:ok, [float()]} | {:error, term()}
  def encode(text) when is_binary(text) do
    body = Jason.encode!(%{model: @embed_model, prompt: text})

    case Req.post(@embed_url, body: body, headers: [{"content-type", "application/json"}], receive_timeout: 10_000) do
      {:ok, %{status: 200, body: %{"embedding" => embedding}}} when is_list(embedding) ->
        {:ok, embedding}

      {:ok, %{status: status, body: body}} ->
        {:error, "embed failed: status=#{status} body=#{inspect(body)}"}

      {:error, reason} ->
        {:error, "embed request failed: #{inspect(reason)}"}
    end
  end
end
