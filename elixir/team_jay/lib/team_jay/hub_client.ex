defmodule TeamJay.HubClient do
  @moduledoc "Hub API HTTP 클라이언트"

  require Logger

  @command_retry_attempts 3
  @command_retry_sleep_ms 250

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

  def post_n8n_webhook(webhook_path, body \\ %{}) do
    case Req.post("#{hub_url()}/hub/n8n/webhook/#{webhook_path}",
      json: body,
      headers: headers(),
      retry: false,
      receive_timeout: 15_000
    ) do
      {:ok, %{status: status}} when status in 200..299 -> {:ok, status}
      {:ok, %{status: status, body: b}} -> {:error, "HTTP #{status}: #{inspect(b)}"}
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

  def command_inbox(target_team, opts \\ []) do
    params =
      opts
      |> Enum.into(%{})
      |> Map.put(:target_team, target_team)

    case Req.get("#{hub_url()}/hub/events/commands/inbox", headers: headers(), params: params, retry: false) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  def command_ack(command_id, target_team, opts \\ []) do
    command_lifecycle(command_id, "acknowledged", target_team, opts)
  end

  def command_complete(command_id, target_team, opts \\ []) do
    command_lifecycle(command_id, "completed", target_team, opts)
  end

  def command_fail(command_id, target_team, opts \\ []) do
    command_lifecycle(command_id, "failed", target_team, opts)
  end

  defp command_lifecycle(command_id, status, target_team, opts) do
    body =
      opts
      |> Enum.into(%{})
      |> Map.merge(%{
        command_id: command_id,
        status: status,
        target_team: target_team
      })

    do_command_lifecycle(body, @command_retry_attempts)
  end

  defp do_command_lifecycle(body, attempts_left) when attempts_left > 0 do
    case Req.post("#{hub_url()}/hub/events/commands/lifecycle", json: body, headers: headers(), retry: false) do
      {:ok, %{status: 200, body: response_body}} ->
        {:ok, response_body}

      {:ok, %{status: status, body: response_body}} ->
        {:error, "HTTP #{status}: #{inspect(response_body)}"}

      {:error, %Req.TransportError{reason: reason} = err} when reason in [:closed, :econnrefused] ->
        if attempts_left > 1 do
          Logger.debug(
            "[HubClient] command lifecycle retry #{status_label(body["status"])} " <>
              "(#{body["command_id"]}) reason=#{inspect(reason)} attempts_left=#{attempts_left - 1}"
          )

          Process.sleep(@command_retry_sleep_ms)
          do_command_lifecycle(body, attempts_left - 1)
        else
          {:error, err}
        end

      {:error, err} ->
        {:error, err}
    end
  end

  defp status_label("acknowledged"), do: "ack"
  defp status_label("completed"), do: "complete"
  defp status_label("failed"), do: "fail"
  defp status_label(status), do: to_string(status)

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
