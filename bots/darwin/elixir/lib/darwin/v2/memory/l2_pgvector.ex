defmodule Darwin.V2.Memory.L2 do
  @moduledoc """
  L2 장기 메모리 — pgvector 기반 논문/실패/학습 노트 + RAG 검색.
  Qwen3-Embedding-0.6B (1024차원) 임베딩, cosine similarity 검색.

  DB 테이블: darwin_agent_memory
  컬럼: id, team, content, embedding vector(1024), memory_type,
         importance, context, tags, inserted_at, expires_at

  연구 특화 메모리 타입:
    :paper_insight          — 논문 핵심 인사이트
    :evaluation_pattern     — 평가 패턴 학습
    :implementation_strategy — 구현 전략
    :failure_lesson         — 실패 교훈
    :keyword_signal         — 키워드 신호 패턴
    + 기본: :semantic, :episodic, :procedural

  sigma/v2/memory/l2_pgvector.ex 패턴 포팅 + darwin 특화.
  """

  use Jido.Action,
    name: "darwin_v2_memory_recall",
    description: "Store and retrieve R&D notes via pgvector similarity search",
    schema: Zoi.object(%{
      operation: Zoi.enum([:store, :retrieve]) |> Zoi.required(),
      content: Zoi.optional(Zoi.string()),
      team: Zoi.default(Zoi.string(), "darwin"),
      memory_type: Zoi.default(Zoi.string(), "semantic"),
      importance: Zoi.default(Zoi.float(), 0.5),
      context: Zoi.optional(Zoi.map()),
      tags: Zoi.optional(Zoi.list(Zoi.string())),
      top_k: Zoi.default(Zoi.integer(), 5),
      threshold: Zoi.default(Zoi.float(), 0.3)
    })

  require Logger

  # MLX-openai-server (OpenAI 호환, launchd ai.mlx.server, port 11434)
  @embed_model "qwen3-embed-0.6b"
  @table "darwin_agent_memory"

  @valid_memory_types [
    :semantic, :episodic, :procedural,
    :paper_insight, :evaluation_pattern, :implementation_strategy,
    :failure_lesson, :keyword_signal
  ]

  # ──────────────────────────────────────────────
  # Convenience public API (Jido.Action.run 을 래핑)
  # ──────────────────────────────────────────────

  @doc """
  콘텐츠를 장기 메모리에 저장.
  memory_type: :paper_insight | :evaluation_pattern | :implementation_strategy |
               :failure_lesson | :keyword_signal | :semantic | :episodic | :procedural
  opts: [importance: float, context: map, tags: [String.t]]
  """
  @spec store(String.t(), String.t(), atom(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def store(team, content, memory_type, opts \\ []) do
    memory_type_str =
      if memory_type in @valid_memory_types,
        do: to_string(memory_type),
        else: "semantic"

    params = %{
      operation: :store,
      content: content,
      team: team,
      memory_type: memory_type_str,
      importance: Keyword.get(opts, :importance, 0.5),
      context: Keyword.get(opts, :context, %{}),
      tags: Keyword.get(opts, :tags, [])
    }

    run(params, %{})
  end

  @doc """
  유사 메모리 검색.
  opts: [top_k: integer, threshold: float, memory_type: atom]
  """
  @spec retrieve(String.t(), String.t(), keyword()) ::
          {:ok, map()} | {:error, term()}
  def retrieve(query, team, opts \\ []) do
    params = %{
      operation: :retrieve,
      content: query,
      team: team,
      top_k: Keyword.get(opts, :top_k, 5),
      threshold: Keyword.get(opts, :threshold, 0.3),
      memory_type: Keyword.get(opts, :memory_type)
    }

    run(params, %{})
  end

  # ──────────────────────────────────────────────
  # Jido.Action callbacks
  # ──────────────────────────────────────────────

  @impl Jido.Action
  def run(%{operation: :store} = params, _ctx) do
    content = params[:content] || ""
    team = params[:team] || "darwin"
    memory_type = params[:memory_type] || "semantic"
    importance = params[:importance] || 0.5
    context = params[:context] || %{}
    tags = params[:tags] || []

    Logger.debug("[다윈V2 메모리L2] 저장 시작 — team=#{team} type=#{memory_type}")

    case encode(content) do
      {:ok, embedding} ->
        context_json = Jason.encode!(context)
        tags_json = Jason.encode!(tags)

        result =
          TeamJay.Repo.query(
            """
            INSERT INTO #{@table}
              (team, content, embedding, memory_type, importance, context, tags, inserted_at)
            VALUES ($1, $2, $3::vector, $4, $5, $6::jsonb, $7::jsonb, NOW())
            ON CONFLICT DO NOTHING
            RETURNING id
            """,
            [team, content, embedding, memory_type, importance, context_json, tags_json]
          )

        case result do
          {:ok, %{rows: [[id]]}} ->
            Logger.info("[다윈V2 메모리L2] 저장 완료 — id=#{id} type=#{memory_type}")
            {:ok, %{stored: true, id: id}}

          {:ok, %{rows: []}} ->
            {:ok, %{stored: false, reason: :conflict}}

          {:error, reason} ->
            Logger.error("[다윈V2 메모리L2] DB 저장 실패: #{inspect(reason)}")
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  def run(%{operation: :retrieve} = params, _ctx) do
    query = params[:content] || ""
    team = params[:team] || "darwin"
    top_k = params[:top_k] || 5
    threshold = params[:threshold] || 0.3
    memory_type_filter = params[:memory_type]

    Logger.debug("[다윈V2 메모리L2] 검색 시작 — team=#{team} top_k=#{top_k}")

    case encode(query) do
      {:ok, embedding} ->
        {where_extra, extra_params} =
          if memory_type_filter do
            {" AND memory_type = $4", [to_string(memory_type_filter)]}
          else
            {"", []}
          end

        sql = """
        SELECT content, importance, memory_type, context, tags,
               1 - (embedding <=> $1::vector) AS similarity
        FROM #{@table}
        WHERE team = $2
          AND 1 - (embedding <=> $1::vector) >= $3
          #{where_extra}
        ORDER BY embedding <=> $1::vector ASC
        LIMIT #{top_k}
        """

        query_params = [embedding, team, threshold] ++ extra_params

        case TeamJay.Repo.query(sql, query_params) do
          {:ok, %{rows: rows}} ->
            hits =
              Enum.map(rows, fn [content, importance, mem_type, context, tags, sim] ->
                %{
                  content: content,
                  importance: importance,
                  memory_type: mem_type,
                  context: context || %{},
                  tags: tags || [],
                  similarity: sim
                }
              end)

            Logger.info("[다윈V2 메모리L2] 검색 완료 — #{length(hits)}개 히트")
            {:ok, %{hits: hits}}

          {:error, reason} ->
            Logger.error("[다윈V2 메모리L2] DB 검색 실패: #{inspect(reason)}")
            {:error, reason}
        end

      {:error, reason} ->
        {:error, reason}
    end
  end

  # ──────────────────────────────────────────────
  # Embedding
  # ──────────────────────────────────────────────

  @doc """
  텍스트를 MLX Qwen3-Embedding-0.6B로 1024차원 벡터로 변환.
  OpenAI 호환 API (/v1/embeddings, input 키, data[0].embedding 응답).
  """
  @spec encode(String.t()) :: {:ok, [float()]} | {:error, term()}
  def encode(text) when is_binary(text) do
    embed_url =
      Application.get_env(:darwin, :mlx_base_url, "http://localhost:11434") <> "/v1/embeddings"

    body = Jason.encode!(%{model: @embed_model, input: text})

    case Req.post(embed_url,
           body: body,
           headers: [{"content-type", "application/json"}],
           receive_timeout: 10_000
         ) do
      # OpenAI 호환 형식: {"data": [{"embedding": [...]}]}
      {:ok, %{status: 200, body: %{"data" => [%{"embedding" => embedding} | _]}}}
      when is_list(embedding) ->
        {:ok, embedding}

      # 폴백: Ollama 형식
      {:ok, %{status: 200, body: %{"embedding" => embedding}}} when is_list(embedding) ->
        {:ok, embedding}

      {:ok, %{status: status, body: body}} ->
        {:error, "embed failed: status=#{status} body=#{inspect(body)}"}

      {:error, reason} ->
        {:error, "embed request failed: #{inspect(reason)}"}
    end
  end
end
