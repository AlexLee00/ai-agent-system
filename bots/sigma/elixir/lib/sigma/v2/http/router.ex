defmodule Sigma.V2.HTTP.Router do
  @moduledoc """
  Sigma V2 HTTP 라우터 — Plug 기반.
  포트 4000에서 /sigma/v2 와 /mcp/sigma 경로를 제공.
  """

  use Plug.Router

  plug Plug.Logger
  plug :match
  plug Plug.Parsers,
    parsers: [:json],
    pass: ["application/json"],
    json_decoder: Jason
  plug :dispatch

  get "/sigma/v2/health" do
    enabled = System.get_env("SIGMA_V2_ENABLED") == "true"
    http_port = System.get_env("SIGMA_HTTP_PORT")

    body = %{
      status: "ok",
      enabled: enabled,
      http_port: http_port,
      mailbox_pending: Sigma.V2.Mailbox.pending_count()
    }

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(body))
  end

  # Sigma V2 run-daily endpoint
  post "/sigma/v2/run-daily" do
    test_mode = get_in(conn.body_params, ["test"]) || false

    case Sigma.V2.ShadowRunner.run(%{test: test_mode}) do
      {:ok, result} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(200, Jason.encode!(result))

      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(500, Jason.encode!(%{error: inspect(reason)}))
    end
  end

  # MCP tool list
  get "/mcp/sigma/tools" do
    conn = Sigma.V2.MCP.Auth.call(conn, [])

    if conn.halted do
      conn
    else
      tools = Sigma.V2.MCP.Server.list_tools()

      conn
      |> put_resp_content_type("application/json")
      |> send_resp(200, Jason.encode!(%{tools: tools}))
    end
  end

  # MCP tool call
  post "/mcp/sigma/tools/:name/call" do
    conn = Sigma.V2.MCP.Auth.call(conn, [])

    if conn.halted do
      conn
    else
      params = conn.body_params || %{}

      case Sigma.V2.MCP.Server.call_tool(name, params) do
        {:ok, result} ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(200, Jason.encode!(result))

        {:error, :unknown_tool} ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(404, Jason.encode!(%{error: "unknown tool: #{name}"}))

        {:error, reason} ->
          conn
          |> put_resp_content_type("application/json")
          |> send_resp(500, Jason.encode!(%{error: inspect(reason)}))
      end
    end
  end

  # Phase 2: Shared advisory signal poll — team receiver가 호출: GET /sigma/signals?team=<team>&since=<ts>
  get "/sigma/signals" do
    team = conn.query_params["team"] || ""
    since = conn.query_params["since"] || DateTime.to_iso8601(DateTime.utc_now())

    signals = Sigma.V2.Archivist.recent_signals(team, since)

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{signals: signals}))
  end

  # Phase 2: Shared advisory signal ack — team receiver가 수용 카운트 기록: POST /sigma/signals/:id/ack
  post "/sigma/signals/:id/ack" do
    Sigma.V2.Archivist.record_acceptance(id)

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{ok: true}))
  end

  # Phase 4: Mailbox — 대기 중인 Tier 3 목록: GET /sigma/mailbox
  get "/sigma/mailbox" do
    pending = Sigma.V2.Mailbox.pending_items(limit: 20)

    conn
    |> put_resp_content_type("application/json")
    |> send_resp(200, Jason.encode!(%{pending: pending, count: length(pending)}))
  end

  # Phase 4: Mailbox 처리: POST /sigma/mailbox/:id/approve
  post "/sigma/mailbox/:id/approve" do
    decision = get_in(conn.body_params, ["decision"]) || "approve"
    patch_action = get_in(conn.body_params, ["patch_action"])

    result =
      case {decision, patch_action} do
        {"approve", nil} -> Sigma.V2.Mailbox.execute(id)
        {"approve", patch} -> Sigma.V2.Mailbox.execute_with_patch(id, patch)
        {"reject", _} -> Sigma.V2.Mailbox.reject(id, nil)
        _ -> {:error, :unknown_decision}
      end

    case result do
      :ok ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(200, Jason.encode!(%{ok: true}))

      {:error, reason} ->
        conn
        |> put_resp_content_type("application/json")
        |> send_resp(500, Jason.encode!(%{error: inspect(reason)}))
    end
  end

  match _ do
    send_resp(conn, 404, Jason.encode!(%{error: "not found"}))
  end
end
