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
    case Req.get("#{hub_url()}/hub/health", headers: headers()) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  def pg_query(sql, schema \\ "public") do
    case Req.post("#{hub_url()}/hub/pg/query", json: %{sql: sql, schema: schema}, headers: headers()) do
      {:ok, %{status: 200, body: body}} -> {:ok, body}
      {:ok, %{status: status, body: body}} -> {:error, "HTTP #{status}: #{inspect(body)}"}
      {:error, err} -> {:error, err}
    end
  end

  def post_alarm(message, team \\ "system", from_bot \\ "elixir") do
    Req.post("#{hub_url()}/hub/alarm",
      json: %{message: message, team: team, fromBot: from_bot},
      headers: headers()
    )
  end
end

