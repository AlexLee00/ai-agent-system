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

  # Sigma V2 run-daily endpoint
  post "/sigma/v2/run-daily" do
    test_mode = get_in(conn.body_params, ["test"]) || false

    case Sigma.V2.Commander.run_daily(test: test_mode) do
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

  match _ do
    send_resp(conn, 404, Jason.encode!(%{error: "not found"}))
  end
end
