defmodule TeamJay.HubClient do
  @moduledoc "Hub API HTTP 클라이언트"

  defp hub_url, do: TeamJay.Config.hub_url()
  defp hub_token, do: TeamJay.Config.hub_token()

  defp headers do
    base = [{"content-type", "application/json"}]

    case hub_token() do
      nil -> base
      "" -> base
      token -> [{"authorization", "Bearer #{token}"} | base]
    end
  end

  def health do
    case Req.get("#{hub_url()}/hub/health", headers: headers(), retry: false) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  def pg_query(sql, schema \\ "public") do
    case Req.post("#{hub_url()}/hub/pg/query",
           json: %{sql: sql, schema: schema},
           headers: headers(),
           retry: false
         ) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  def post_alarm(message, team \\ "system", from_bot \\ "elixir") do
    Req.post("#{hub_url()}/hub/alarm",
      json: %{message: message, team: team, fromBot: from_bot},
      headers: headers(),
      retry: false
    )
  end

  @doc """
  에이전트 기억 저장 (임베딩 포함).
  type: "episodic" | "semantic" | "procedural"
  opts: %{keywords, importance, metadata}
  """
  def memory_remember(agent_id, team, content, type \\ "episodic", opts \\ %{}) do
    body = Map.merge(%{agentId: agent_id, team: team, content: content, type: type}, opts)
    case Req.post("#{hub_url()}/hub/memory/remember", json: body, headers: headers(), retry: false) do
      {:ok, %{status: 200, body: body}} -> {:ok, body["memoryId"]}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  @doc """
  유사도 기반 기억 조회.
  opts: %{type, limit, threshold}
  """
  def memory_recall(agent_id, team, query, opts \\ %{}) do
    body = Map.merge(%{agentId: agent_id, team: team, query: query}, opts)
    case Req.post("#{hub_url()}/hub/memory/recall", json: body, headers: headers(), retry: false) do
      {:ok, %{status: 200, body: body}} -> {:ok, body["memories"] || []}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end
end
